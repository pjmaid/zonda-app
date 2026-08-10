-- Zonda: configuraciones compartidas y permisos efectivos por protocolo.
-- Requiere las migraciones 20260809 y 20260810 anteriores.

create table if not exists ec_settings (
  id text primary key,
  org_id uuid not null default current_org() references ec_orgs(id) on delete cascade,
  data jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  setting_type text generated always as (data ->> 'settingType') stored,
  study_id text generated always as (data ->> 'estudioId') stored
);
create index if not exists ec_settings_org_type_idx on ec_settings(org_id, setting_type);
create index if not exists ec_settings_org_study_idx on ec_settings(org_id, study_id);
alter table ec_settings enable row level security;
grant select, insert, update, delete on ec_settings to authenticated;

create index if not exists ec_patients_org_study_json_idx on ec_patients(org_id, ((data ->> 'estudioId')));
create index if not exists ec_visits_org_study_json_idx on ec_visits(org_id, ((data ->> 'estudioId')));
create index if not exists ec_docs_org_study_json_idx on ec_docs(org_id, ((data ->> 'estudioId')));
create index if not exists ec_docs_org_patient_json_idx on ec_docs(org_id, ((data ->> 'pacienteId')));
create index if not exists ec_users_org_auth_json_idx on ec_users(org_id, ((data ->> 'authId')));
create index if not exists ec_users_org_email_json_idx on ec_users(org_id, (lower(data ->> 'email')));

-- La asignación se conserva en la ficha ec_users y se vincula con auth.users
-- mediante authId; el email es respaldo para fichas creadas antes de ese vínculo.
create or replace function ec_user_study_ids() returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct s.id), array[]::text[])
  from ec_users u
  cross join lateral jsonb_array_elements_text(coalesce(u.data -> 'estudios', '[]'::jsonb)) s(id)
  where u.org_id = current_org()
    and coalesce((u.data ->> 'activo')::boolean, true)
    and (
      u.data ->> 'authId' = auth.uid()::text
      or lower(u.data ->> 'email') = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
$$;

create or replace function ec_can_study(p_study_id text) returns boolean
language sql stable security definer set search_path = public
as $$
  select es_superadmin()
    or current_rol() = 'admin'
    or p_study_id = any(ec_user_study_ids())
$$;

create or replace function ec_data_study(p_data jsonb) returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    nullif(p_data ->> 'estudioId', ''),
    (select nullif(p.data ->> 'estudioId', '')
       from ec_patients p
      where p.org_id = current_org() and p.id = p_data ->> 'pacienteId'
      limit 1)
  )
$$;

create or replace function ec_is_own_user(p_data jsonb) returns boolean
language sql stable security definer set search_path = public
as $$
  select p_data ->> 'authId' = auth.uid()::text
      or lower(p_data ->> 'email') = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

revoke all on function ec_user_study_ids() from public;
revoke all on function ec_can_study(text) from public;
revoke all on function ec_data_study(jsonb) from public;
revoke all on function ec_is_own_user(jsonb) from public;
grant execute on function ec_user_study_ids() to authenticated;
grant execute on function ec_can_study(text) to authenticated;
grant execute on function ec_data_study(jsonb) to authenticated;
grant execute on function ec_is_own_user(jsonb) to authenticated;

-- Estudios: solo el administrador crea; médico edita únicamente los asignados.
drop policy if exists org_ver on ec_studies;
drop policy if exists org_ins on ec_studies;
drop policy if exists org_upd on ec_studies;
drop policy if exists org_del on ec_studies;
drop policy if exists protocol_ver on ec_studies;
drop policy if exists protocol_ins on ec_studies;
drop policy if exists protocol_upd on ec_studies;
drop policy if exists protocol_del on ec_studies;
create policy protocol_ver on ec_studies for select to authenticated
  using (org_id = current_org() and ec_can_study(id));
create policy protocol_ins on ec_studies for insert to authenticated
  with check (org_id = current_org() and (current_rol() = 'admin' or es_superadmin()));
create policy protocol_upd on ec_studies for update to authenticated
  using (org_id = current_org() and ec_can_study(id) and current_rol() in ('admin','medico'))
  with check (org_id = current_org() and ec_can_study(id) and current_rol() in ('admin','medico'));
create policy protocol_del on ec_studies for delete to authenticated
  using (org_id = current_org() and ec_can_study(id) and current_rol() in ('admin','medico'));

-- Datos clínicos u operativos siempre ligados a un protocolo.
do $$
declare t text;
begin
  foreach t in array array['ec_patients','ec_visits','ec_docs','ec_records']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_ver on %I', t);
    execute format('drop policy if exists org_ins on %I', t);
    execute format('drop policy if exists org_upd on %I', t);
    execute format('drop policy if exists org_del on %I', t);
    execute format('drop policy if exists protocol_ver on %I', t);
    execute format('drop policy if exists protocol_ins on %I', t);
    execute format('drop policy if exists protocol_upd on %I', t);
    execute format('drop policy if exists protocol_del on %I', t);
    execute format(
      'create policy protocol_ver on %I for select to authenticated using (org_id = current_org() and ec_can_study(ec_data_study(data)))', t);
    execute format(
      'create policy protocol_ins on %I for insert to authenticated with check (org_id = current_org() and current_rol() in (''admin'',''medico'',''coord'') and ec_can_study(ec_data_study(data)))', t);
    execute format(
      'create policy protocol_upd on %I for update to authenticated using (org_id = current_org() and current_rol() in (''admin'',''medico'',''coord'') and ec_can_study(ec_data_study(data))) with check (org_id = current_org() and current_rol() in (''admin'',''medico'',''coord'') and ec_can_study(ec_data_study(data)))', t);
    execute format(
      'create policy protocol_del on %I for delete to authenticated using (org_id = current_org() and current_rol() in (''admin'',''medico'') and ec_can_study(ec_data_study(data)))', t);
  end loop;
end $$;

-- Checklists y configuraciones pueden ser generales del sitio. Cuando tienen
-- protocolo, también se limita su alcance; vacío significa configuración común.
do $$
declare t text;
begin
  foreach t in array array['ec_checklists','ec_settings']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_ver on %I', t);
    execute format('drop policy if exists org_ins on %I', t);
    execute format('drop policy if exists org_upd on %I', t);
    execute format('drop policy if exists org_del on %I', t);
    execute format('drop policy if exists protocol_ver on %I', t);
    execute format('drop policy if exists protocol_ins on %I', t);
    execute format('drop policy if exists protocol_upd on %I', t);
    execute format('drop policy if exists protocol_del on %I', t);
    execute format(
      'create policy protocol_ver on %I for select to authenticated using (org_id=current_org() and (nullif(ec_data_study(data),'''') is null or ec_can_study(ec_data_study(data))))', t);
    execute format(
      'create policy protocol_ins on %I for insert to authenticated with check (org_id=current_org() and current_rol() in (''admin'',''medico'',''coord'') and (nullif(ec_data_study(data),'''') is null or ec_can_study(ec_data_study(data))))', t);
    execute format(
      'create policy protocol_upd on %I for update to authenticated using (org_id=current_org() and current_rol() in (''admin'',''medico'',''coord'') and (nullif(ec_data_study(data),'''') is null or ec_can_study(ec_data_study(data)))) with check (org_id=current_org() and current_rol() in (''admin'',''medico'',''coord'') and (nullif(ec_data_study(data),'''') is null or ec_can_study(ec_data_study(data))))', t);
    execute format(
      'create policy protocol_del on %I for delete to authenticated using (org_id=current_org() and current_rol() in (''admin'',''medico'') and (nullif(ec_data_study(data),'''') is null or ec_can_study(ec_data_study(data))))', t);
  end loop;
end $$;

-- Cada usuario no administrador solo recibe su propia ficha; el administrador
-- conserva la gestión de todo el equipo del sitio.
drop policy if exists org_ver on ec_users;
drop policy if exists org_ins on ec_users;
drop policy if exists org_upd on ec_users;
drop policy if exists org_del on ec_users;
drop policy if exists users_ver on ec_users;
drop policy if exists users_ins on ec_users;
drop policy if exists users_upd on ec_users;
drop policy if exists users_del on ec_users;
create policy users_ver on ec_users for select to authenticated
  using (org_id = current_org() and (current_rol() = 'admin' or es_superadmin() or ec_is_own_user(data)));
create policy users_ins on ec_users for insert to authenticated
  with check (org_id = current_org() and (current_rol() = 'admin' or es_superadmin()));
create policy users_upd on ec_users for update to authenticated
  using (org_id = current_org() and (current_rol() = 'admin' or es_superadmin()))
  with check (org_id = current_org() and (current_rol() = 'admin' or es_superadmin()));
create policy users_del on ec_users for delete to authenticated
  using (org_id = current_org() and (current_rol() = 'admin' or es_superadmin()));

-- Los objetos nuevos incluyen el protocolo en la ruta:
--   organizacion/protocolo/documento/archivo
-- Para objetos antiguos se resuelve el documento por su ID.
create or replace function ec_can_storage_object(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, storage
as $$
declare
  v_org text := split_part(p_name, '/', 1);
  v_scope text := split_part(p_name, '/', 2);
  v_study text;
begin
  if v_org <> current_org()::text then return false; end if;
  if exists (select 1 from ec_studies s where s.org_id=current_org() and s.id=v_scope) then
    return ec_can_study(v_scope);
  end if;
  select ec_data_study(d.data) into v_study
    from ec_docs d where d.org_id=current_org() and d.id=v_scope limit 1;
  return v_study is not null and ec_can_study(v_study);
end $$;
revoke all on function ec_can_storage_object(text) from public;
grant execute on function ec_can_storage_object(text) to authenticated;

drop policy if exists ec_docs_org on storage.objects;
drop policy if exists ec_docs_protocol on storage.objects;
create policy ec_docs_protocol on storage.objects for all to authenticated
  using (bucket_id = 'ec-docs' and ec_can_storage_object(name))
  with check (bucket_id = 'ec-docs' and ec_can_storage_object(name));

-- Amplía la operación transaccional para incluir configuraciones.
create or replace function ec_save_record(
  p_kind text, p_id text, p_data jsonb, p_expected_rev bigint,
  p_event_id text, p_action text default null, p_detail text default null, p_motivo text default null
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare
  v_table text; v_rev bigint; v_updated_at timestamptz;
  v_created boolean := p_expected_rev is null;
begin
  v_table := case p_kind
    when 'studies' then 'ec_studies' when 'patients' then 'ec_patients'
    when 'visits' then 'ec_visits' when 'docs' then 'ec_docs'
    when 'users' then 'ec_users' when 'records' then 'ec_records'
    when 'checklists' then 'ec_checklists' when 'settings' then 'ec_settings'
    else null end;
  if v_table is null then raise exception using errcode='22023', message='INVALID_RECORD_KIND'; end if;
  if exists (select 1 from ec_audit where org_id=current_org() and event_id=p_event_id and ref_id=p_id) then
    execute format('select rev, updated_at from %I where id=$1 and org_id=current_org()',v_table)
      using p_id into v_rev,v_updated_at;
    return jsonb_build_object('rev',v_rev,'updated_at',v_updated_at,'created',v_created,'event_id',p_event_id,'replayed',true);
  end if;
  if v_created then
    begin
      execute format('insert into %I (id,data,rev,updated_at,org_id) values ($1,$2,1,now(),current_org()) returning rev,updated_at',v_table)
        using p_id,p_data into v_rev,v_updated_at;
    exception when unique_violation then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end;
  else
    execute format('update %I set data=$1,rev=rev+1,updated_at=now() where id=$2 and org_id=current_org() and rev=$3 returning rev,updated_at',v_table)
      using p_data,p_id,p_expected_rev into v_rev,v_updated_at;
    if not found then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  end if;
  insert into ec_audit(event_id,usuario,rol,entidad,accion,ref_id,detalle,motivo)
  values(p_event_id,coalesce(auth.jwt()->>'email',auth.uid()::text,'usuario'),coalesce(current_rol(),''),p_kind,
    coalesce(nullif(p_action,''),case when v_created then 'alta' else 'modificacion' end),p_id,
    left(coalesce(p_detail,''),600),left(coalesce(p_motivo,''),300));
  return jsonb_build_object('rev',v_rev,'updated_at',v_updated_at,'created',v_created,'event_id',p_event_id);
end $$;

create or replace function ec_remove_record(
  p_kind text, p_id text, p_expected_rev bigint, p_event_id text,
  p_detail text default null, p_motivo text default null
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare v_table text;
begin
  v_table := case p_kind
    when 'studies' then 'ec_studies' when 'patients' then 'ec_patients'
    when 'visits' then 'ec_visits' when 'docs' then 'ec_docs'
    when 'users' then 'ec_users' when 'records' then 'ec_records'
    when 'checklists' then 'ec_checklists' when 'settings' then 'ec_settings'
    else null end;
  if v_table is null then raise exception using errcode='22023',message='INVALID_RECORD_KIND'; end if;
  if exists (select 1 from ec_audit where org_id=current_org() and event_id=p_event_id and ref_id=p_id) then
    return jsonb_build_object('deleted',true,'event_id',p_event_id,'replayed',true);
  end if;
  execute format('delete from %I where id=$1 and org_id=current_org() and rev=$2',v_table) using p_id,p_expected_rev;
  if not found then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  insert into ec_audit(event_id,usuario,rol,entidad,accion,ref_id,detalle,motivo)
  values(p_event_id,coalesce(auth.jwt()->>'email',auth.uid()::text,'usuario'),coalesce(current_rol(),''),p_kind,'baja',p_id,
    left(coalesce(p_detail,''),600),left(coalesce(p_motivo,''),300));
  return jsonb_build_object('deleted',true,'event_id',p_event_id);
end $$;

grant execute on function ec_save_record(text,text,jsonb,bigint,text,text,text,text) to authenticated;
grant execute on function ec_remove_record(text,text,bigint,text,text,text) to authenticated;
