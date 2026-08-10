-- Zonda: control de concurrencia y auditoria transaccional.
-- Aplicar en Supabase antes de desplegar la version que consume estas RPC.

do $$
declare
  t text;
begin
  foreach t in array array['ec_studies','ec_patients','ec_visits','ec_docs','ec_users']
  loop
    execute format('alter table %I add column if not exists rev bigint not null default 1', t);
    execute format('alter table %I alter column updated_at set default now()', t);
  end loop;
end $$;

alter table ec_audit add column if not exists event_id text;
alter table ec_audit add column if not exists client_ts timestamptz;
create unique index if not exists ec_audit_org_event_idx
  on ec_audit(org_id, event_id) where event_id is not null;

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
    else null
  end;
  if v_table is null then
    raise exception using errcode = '22023', message = 'INVALID_RECORD_KIND';
  end if;

  -- Reintento idempotente: si el servidor confirmó la transacción pero la
  -- respuesta se perdió en la red, el mismo event_id devuelve el resultado.
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
