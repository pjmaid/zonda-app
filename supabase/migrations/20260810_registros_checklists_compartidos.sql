-- Zonda: registros operativos/clinicos y checklists compartidos.
-- Requiere 20260809_integridad_concurrencia_auditoria.sql.

create table if not exists ec_records (
  id text primary key,
  org_id uuid not null default current_org() references ec_orgs(id) on delete cascade,
  data jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  record_type text generated always as (data ->> 'recordType') stored,
  study_id text generated always as (data ->> 'estudioId') stored,
  patient_id text generated always as (data ->> 'pacienteId') stored
);

create table if not exists ec_checklists (
  id text primary key,
  org_id uuid not null default current_org() references ec_orgs(id) on delete cascade,
  data jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  study_id text generated always as (data ->> 'estudioId') stored,
  checklist_type text generated always as (data ->> 'plantilla') stored
);

create index if not exists ec_records_org_type_idx on ec_records(org_id, record_type);
create index if not exists ec_records_org_study_idx on ec_records(org_id, study_id);
create index if not exists ec_records_org_patient_idx on ec_records(org_id, patient_id);
create index if not exists ec_checklists_org_study_idx on ec_checklists(org_id, study_id);

alter table ec_records enable row level security;
alter table ec_checklists enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ec_records','ec_checklists']
  loop
    execute format('drop policy if exists org_ver on %I', t);
    execute format('create policy org_ver on %I for select to authenticated using (org_id = current_org())', t);
    execute format('drop policy if exists org_ins on %I', t);
    execute format('create policy org_ins on %I for insert to authenticated with check (org_id = current_org())', t);
    execute format('drop policy if exists org_upd on %I', t);
    execute format('create policy org_upd on %I for update to authenticated using (org_id = current_org()) with check (org_id = current_org())', t);
    execute format('drop policy if exists org_del on %I', t);
    execute format('create policy org_del on %I for delete to authenticated using (org_id = current_org())', t);
  end loop;
end $$;

grant select, insert, update, delete on ec_records, ec_checklists to authenticated;

create or replace function ec_save_record(
  p_kind text,
  p_id text,
  p_data jsonb,
  p_expected_rev bigint,
  p_event_id text,
  p_action text default null,
  p_detail text default null,
  p_motivo text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_table text;
  v_rev bigint;
  v_updated_at timestamptz;
  v_created boolean := p_expected_rev is null;
begin
  v_table := case p_kind
    when 'studies' then 'ec_studies'
    when 'patients' then 'ec_patients'
    when 'visits' then 'ec_visits'
    when 'docs' then 'ec_docs'
    when 'users' then 'ec_users'
    when 'records' then 'ec_records'
    when 'checklists' then 'ec_checklists'
    else null
  end;
  if v_table is null then
    raise exception using errcode = '22023', message = 'INVALID_RECORD_KIND';
  end if;

  if exists (
    select 1 from ec_audit
    where org_id = current_org() and event_id = p_event_id and ref_id = p_id
  ) then
    execute format(
      'select rev, updated_at from %I where id = $1 and org_id = current_org()',
      v_table
    ) using p_id into v_rev, v_updated_at;
    return jsonb_build_object(
      'rev', v_rev,
      'updated_at', v_updated_at,
      'created', v_created,
      'event_id', p_event_id,
      'replayed', true
    );
  end if;

  if v_created then
    begin
      execute format(
        'insert into %I (id, data, rev, updated_at, org_id) '
        'values ($1, $2, 1, now(), current_org()) returning rev, updated_at',
        v_table
      ) using p_id, p_data into v_rev, v_updated_at;
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end;
  else
    execute format(
      'update %I set data = $1, rev = rev + 1, updated_at = now() '
      'where id = $2 and org_id = current_org() and rev = $3 '
      'returning rev, updated_at',
      v_table
    ) using p_data, p_id, p_expected_rev into v_rev, v_updated_at;
    if not found then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
  end if;

  insert into ec_audit(event_id, usuario, rol, entidad, accion, ref_id, detalle, motivo)
  values (
    p_event_id,
    coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'usuario'),
    coalesce(current_rol(), ''),
    p_kind,
    coalesce(nullif(p_action, ''), case when v_created then 'alta' else 'modificacion' end),
    p_id,
    left(coalesce(p_detail, ''), 600),
    left(coalesce(p_motivo, ''), 300)
  );

  return jsonb_build_object(
    'rev', v_rev,
    'updated_at', v_updated_at,
    'created', v_created,
    'event_id', p_event_id
  );
end $$;

create or replace function ec_remove_record(
  p_kind text,
  p_id text,
  p_expected_rev bigint,
  p_event_id text,
  p_detail text default null,
  p_motivo text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_table text;
begin
  v_table := case p_kind
    when 'studies' then 'ec_studies'
    when 'patients' then 'ec_patients'
    when 'visits' then 'ec_visits'
    when 'docs' then 'ec_docs'
    when 'users' then 'ec_users'
    when 'records' then 'ec_records'
    when 'checklists' then 'ec_checklists'
    else null
  end;
  if v_table is null then
    raise exception using errcode = '22023', message = 'INVALID_RECORD_KIND';
  end if;

  if exists (
    select 1 from ec_audit
    where org_id = current_org() and event_id = p_event_id and ref_id = p_id
  ) then
    return jsonb_build_object('deleted', true, 'event_id', p_event_id, 'replayed', true);
  end if;

  execute format(
    'delete from %I where id = $1 and org_id = current_org() and rev = $2',
    v_table
  ) using p_id, p_expected_rev;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  insert into ec_audit(event_id, usuario, rol, entidad, accion, ref_id, detalle, motivo)
  values (
    p_event_id,
    coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'usuario'),
    coalesce(current_rol(), ''),
    p_kind,
    'baja',
    p_id,
    left(coalesce(p_detail, ''), 600),
    left(coalesce(p_motivo, ''), 300)
  );

  return jsonb_build_object('deleted', true, 'event_id', p_event_id);
end $$;

grant execute on function ec_save_record(text,text,jsonb,bigint,text,text,text,text) to authenticated;
grant execute on function ec_remove_record(text,text,bigint,text,text,text) to authenticated;
