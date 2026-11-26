-- Vía de escritura auditada. Probar junto con membresias_seguras en un entorno
-- separado antes de producción. No contiene filas clínicas ni credenciales.
begin;

do $$
begin
  if not exists(select 1 from pg_roles where rolname='zonda_rpc_writer') then
    create role zonda_rpc_writer nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists(select 1 from pg_roles where rolname='zonda_audit_writer') then
    create role zonda_audit_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if exists(select 1 from pg_roles where rolname in ('zonda_rpc_writer','zonda_audit_writer')
    and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)) then
    raise exception 'UNSAFE_AUDIT_ROLE';
  end if;
end $$;
grant authenticated to zonda_rpc_writer with inherit true, set false;
-- Solo el administrador de migraciones puede administrar los propietarios.
-- INHERIT permite ALTER/DROP del DDL propio aunque postgres no sea superusuario
-- en un servicio gestionado. La membresía nunca se concede en sentido inverso.
grant zonda_rpc_writer, zonda_audit_writer to postgres with inherit true, set true;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','authenticator','service_role'] loop
    if pg_has_role(r,'zonda_rpc_writer','MEMBER') or pg_has_role(r,'zonda_audit_writer','MEMBER') then
      raise exception 'AUDIT_ROLE_EXPOSED_TO_CLIENT: %',r;
    end if;
  end loop;
  if exists(select 1 from pg_auth_members m join pg_roles child on child.oid=m.member join pg_roles parent on parent.oid=m.roleid
    where child.rolname in ('zonda_rpc_writer','zonda_audit_writer')
      and not(child.rolname='zonda_rpc_writer' and parent.rolname='authenticated')) then
    raise exception 'UNEXPECTED_AUDIT_ROLE_MEMBERSHIP';
  end if;
  if exists(select 1 from pg_class c join pg_roles r on r.oid=c.relowner
    where r.rolname in ('zonda_rpc_writer','zonda_audit_writer')) then
    raise exception 'AUDIT_ROLE_MUST_NOT_OWN_RELATIONS';
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'ec_%'
      and (pg_has_role('zonda_rpc_writer',c.relowner,'MEMBER') or pg_has_role('zonda_audit_writer',c.relowner,'MEMBER'))) then
    raise exception 'AUDIT_ROLE_INHERITS_RELATION_OWNER';
  end if;
  if exists(select 1 from pg_roles powerful where (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)
    and (pg_has_role('zonda_rpc_writer',powerful.oid,'MEMBER') or pg_has_role('zonda_audit_writer',powerful.oid,'MEMBER'))) then
    raise exception 'AUDIT_ROLE_INHERITS_PRIVILEGED_ROLE';
  end if;
end $$;

create schema if not exists zonda_private authorization postgres;
do $$ begin
  if (select pg_get_userbyid(nspowner) from pg_namespace where nspname='zonda_private')<>'postgres' then
    raise exception 'UNSAFE_PRIVATE_SCHEMA_OWNER';
  end if;
end $$;
revoke all on schema zonda_private from public, anon, authenticated, service_role;
grant usage on schema public, auth to zonda_rpc_writer, zonda_audit_writer;
grant usage, create on schema zonda_private to zonda_rpc_writer, zonda_audit_writer;
grant create on schema public to zonda_rpc_writer;
grant execute on function public.current_org(), public.current_rol(), public.es_superadmin() to zonda_audit_writer;
grant execute on function auth.uid(), auth.jwt() to zonda_audit_writer;

-- Recibos privados, nunca deducidos de texto/eventos de la pista pública.
create table zonda_private.write_receipts(
  org_id uuid not null, event_id text not null, actor_id uuid not null,
  request_hash text not null, result jsonb, created_at timestamptz not null default clock_timestamp(),
  primary key(org_id,event_id)
);
create table zonda_private.write_context(
  backend_pid integer primary key, transaction_id bigint not null,
  table_name text not null, record_id text not null, org_id uuid not null,
  operation text not null, event_id text not null,
  action_label text, detail text, reason text
);
-- Un slot privado por PID, reemplazado al cambiar de transacción. Preserva al
-- actor antes de que una baja de organización elimine su propia membresía.
create table zonda_private.actor_context(
  backend_pid integer primary key, transaction_id bigint not null,
  actor_id uuid, actor_email text, actor_role text, database_role text
);
revoke all on all tables in schema zonda_private from public, anon, authenticated, service_role;
grant select, insert, update on zonda_private.write_receipts to zonda_rpc_writer;
grant select, insert, update, delete on zonda_private.write_context to zonda_rpc_writer;
grant select, delete on zonda_private.write_context to zonda_audit_writer;
grant select, insert, update on zonda_private.actor_context to zonda_audit_writer;

alter table public.ec_audit
  add column actor_id uuid,
  add column source text not null default 'legacy',
  add column operation text,
  add column action_label text,
  add column client_event_id text,
  add column database_role text,
  add column record_rev bigint,
  add column before_hash text,
  add column after_hash text;
alter table public.ec_audit add constraint ec_audit_source_check
  check(source in ('legacy','database','client','service','maintenance'));
-- La organización de origen es un identificador histórico inmutable. No debe
-- desaparecer por cascada ni quedar nula al eliminar una organización. No se
-- cambian los demás FK de negocio ni el contenido de los eventos anteriores.
alter table public.ec_audit drop constraint ec_audit_org_id_fkey;

create or replace function zonda_private.capture_actor() returns trigger
language plpgsql security definer set search_path=pg_catalog, public, pg_temp
as $$
declare v_actor uuid:=auth.uid(); v_xid bigint:=txid_current(); v_cached zonda_private.actor_context%rowtype;
  v_database_role text:=coalesce(nullif(nullif(current_setting('role',true),'none'),''),session_user);
begin
  select * into v_cached from zonda_private.actor_context where backend_pid=pg_backend_pid();
  if found and v_cached.transaction_id=v_xid then
    if v_cached.actor_id is distinct from v_actor then raise exception 'AUDIT_ACTOR_CHANGED'; end if;
  else
    insert into zonda_private.actor_context values(pg_backend_pid(),v_xid,v_actor,
      coalesce(nullif(auth.jwt()->>'email',''),case when v_actor is not null then v_actor::text else v_database_role end),
      coalesce(public.current_rol(),auth.jwt()->>'role',session_user),
      v_database_role)
    on conflict(backend_pid) do update set transaction_id=excluded.transaction_id,
      actor_id=excluded.actor_id,actor_email=excluded.actor_email,
      actor_role=excluded.actor_role,database_role=excluded.database_role;
  end if;
  return null;
end $$;
alter function zonda_private.capture_actor() owner to zonda_audit_writer;

create or replace function zonda_private.audit_record_change() returns trigger
language plpgsql security definer set search_path=pg_catalog, public, pg_temp
as $$
declare
  v_before jsonb; v_after jsonb; v_row jsonb; v_org uuid; v_id text; v_event text;
  v_actor zonda_private.actor_context%rowtype; v_context zonda_private.write_context%rowtype;
begin
  if TG_TABLE_SCHEMA<>'public' or TG_TABLE_NAME not in
    ('ec_studies','ec_patients','ec_visits','ec_docs','ec_users','ec_records','ec_checklists','ec_settings','ec_members','ec_orgs')
    then raise exception 'INVALID_AUDIT_TABLE'; end if;
  if TG_OP<>'INSERT' then v_before:=to_jsonb(OLD); end if;
  if TG_OP<>'DELETE' then v_after:=to_jsonb(NEW); end if;
  v_row:=coalesce(v_after,v_before);
  v_org:=case when TG_TABLE_NAME='ec_orgs' then (v_row->>'id')::uuid else (v_row->>'org_id')::uuid end;
  v_id:=case when TG_TABLE_NAME='ec_members' then v_row->>'user_id' else v_row->>'id' end;
  select * into v_actor from zonda_private.actor_context
    where backend_pid=pg_backend_pid() and transaction_id=txid_current();
  if not found then raise exception 'AUDIT_ACTOR_CONTEXT_MISSING'; end if;
  delete from zonda_private.write_context
    where backend_pid=pg_backend_pid() and transaction_id=txid_current()
      and table_name=TG_TABLE_NAME and record_id=v_id and org_id=v_org and operation=TG_OP
    returning * into v_context;
  v_event:=coalesce(v_context.event_id,'db:'||gen_random_uuid()::text);
  insert into public.ec_audit(org_id,event_id,actor_id,usuario,rol,entidad,accion,operation,source,
    action_label,ref_id,detalle,motivo,database_role,record_rev,before_hash,after_hash)
  values(v_org,v_event,v_actor.actor_id,v_actor.actor_email,v_actor.actor_role,substr(TG_TABLE_NAME,4),
    case TG_OP when 'INSERT' then 'alta' when 'UPDATE' then 'modificación' else 'baja' end,
    TG_OP,'database',v_context.action_label,v_id,coalesce(v_context.detail,''),coalesce(v_context.reason,''),
    v_actor.database_role,nullif(v_row->>'rev','')::bigint,
    case when v_before is not null then encode(sha256(convert_to(v_before::text,'UTF8')),'hex') end,
    case when v_after is not null then encode(sha256(convert_to(v_after::text,'UTF8')),'hex') end);
  return null;
end $$;
alter function zonda_private.audit_record_change() owner to zonda_audit_writer;

-- Normalizador estrecho para eventos declarados por un servidor de confianza.
-- No los presenta como prueba de una mutación: las mutaciones tienen su evento
-- transaccional source=database independiente. No acepta actor humano ficticio.
create or replace function zonda_private.normalize_service_audit(p_row public.ec_audit)
returns public.ec_audit language plpgsql security definer set search_path=pg_catalog, public, pg_temp
as $$
declare v_email text; v_org uuid; v_role text; v_super boolean;
begin
  if p_row.actor_id is not null then
    select u.email,m.org_id,m.rol,m.superadmin into v_email,v_org,v_role,v_super
      from auth.users u join public.ec_members m on m.user_id=u.id where u.id=p_row.actor_id;
    if not found or (p_row.org_id is not null and p_row.org_id<>v_org and not v_super) then
      raise exception 'INVALID_SERVICE_AUDIT_ACTOR';
    end if;
    p_row.org_id:=coalesce(p_row.org_id,v_org); p_row.usuario:=v_email; p_row.rol:=v_role;
  else
    p_row.usuario:='service_role'; p_row.rol:='service_role';
  end if;
  p_row.ts:=clock_timestamp(); p_row.source:='service'; p_row.operation:='EVENT';
  p_row.action_label:=left(coalesce(p_row.action_label,p_row.accion,''),120);
  p_row.accion:='evento de servicio'; p_row.database_role:='service_role';
  p_row.event_id:='service:'||coalesce(nullif(p_row.event_id,''),gen_random_uuid()::text);
  p_row.client_event_id:=null; p_row.record_rev:=null; p_row.before_hash:=null; p_row.after_hash:=null;
  p_row.detalle:=left(coalesce(p_row.detalle,''),600); p_row.motivo:=left(coalesce(p_row.motivo,''),300);
  return p_row;
end $$;

create or replace function zonda_private.audit_append_only() returns trigger
language plpgsql security invoker set search_path=pg_catalog, public, pg_temp
as $$
begin
  if TG_OP<>'INSERT' then raise exception 'AUDIT_APPEND_ONLY'; end if;
  if current_user in ('zonda_rpc_writer','zonda_audit_writer') then return NEW; end if;
  if current_user in ('service_role','postgres','supabase_admin') then
    return zonda_private.normalize_service_audit(NEW);
  end if;
  raise exception 'AUDIT_INSERT_REQUIRES_TRUSTED_PATH';
end $$;
create trigger ec_audit_append_only before insert or update or delete on public.ec_audit
  for each row execute function zonda_private.audit_append_only();
create trigger ec_audit_no_truncate before truncate on public.ec_audit
  for each statement execute function zonda_private.audit_append_only();

create or replace function zonda_private.reject_data_truncate() returns trigger
language plpgsql security invoker set search_path=pg_catalog, public, pg_temp
as $$ begin raise exception 'USE_AUDITED_DELETE'; end $$;

do $$
declare t text; cols text;
begin
  foreach t in array array['ec_studies','ec_patients','ec_visits','ec_docs','ec_users','ec_records','ec_checklists','ec_settings','ec_members','ec_orgs'] loop
    execute format('create trigger zonda_capture_actor before insert or update or delete on public.%I for each statement execute function zonda_private.capture_actor()',t);
    execute format('create trigger zonda_audit_change after insert or update or delete on public.%I for each row execute function zonda_private.audit_record_change()',t);
    execute format('create trigger zonda_no_truncate before truncate on public.%I for each statement execute function zonda_private.reject_data_truncate()',t);
    execute format('revoke all on public.%I from anon',t);
    execute format('revoke truncate, references, trigger, maintain on public.%I from anon, authenticated, service_role',t);
  end loop;
  foreach t in array array['ec_studies','ec_patients','ec_visits','ec_docs','ec_users','ec_records','ec_checklists','ec_settings'] loop
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute
      where attrelid=format('public.%I',t)::regclass and attnum>0 and not attisdropped;
    execute format('revoke insert(%s),update(%s),references(%s) on public.%I from public,anon,authenticated',cols,cols,cols,t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to zonda_rpc_writer,service_role',t);
    if has_any_column_privilege('authenticated',format('public.%I',t),'INSERT')
      or has_any_column_privilege('authenticated',format('public.%I',t),'UPDATE')
      or has_table_privilege('authenticated',format('public.%I',t),'DELETE') then
      raise exception 'CLIENT_INHERITS_DIRECT_WRITE: %',t;
    end if;
  end loop;
end $$;
revoke all on public.ec_audit from public, anon, authenticated, service_role;
grant select on public.ec_audit to authenticated;
grant select,insert on public.ec_audit to service_role;
grant select,insert on public.ec_audit to zonda_rpc_writer;
grant insert on public.ec_audit to zonda_audit_writer;
revoke all on sequence public.ec_audit_id_seq from public, anon, authenticated, service_role;
grant usage on sequence public.ec_audit_id_seq to service_role,zonda_rpc_writer,zonda_audit_writer;
drop policy if exists aud_ins on public.ec_audit;
drop policy if exists aud_ver on public.ec_audit;
create policy aud_rpc_insert on public.ec_audit for insert to zonda_rpc_writer
  with check(org_id=public.current_org() and actor_id=auth.uid() and source='client');
create policy aud_database_insert on public.ec_audit for insert to zonda_audit_writer with check(true);
create policy aud_ver on public.ec_audit for select to authenticated using(
  public.es_superadmin() or (org_id=public.current_org() and (public.current_rol()='admin' or actor_id=auth.uid()))
);

create or replace function public.ec_save_record(
  p_kind text,p_id text,p_data jsonb,p_expected_rev bigint,p_event_id text,
  p_action text default null,p_detail text default null,p_motivo text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog, public, pg_temp
as $$
declare
  v_table text; v_org uuid:=public.current_org(); v_actor uuid:=auth.uid(); v_hash text;
  v_receipt zonda_private.write_receipts%rowtype; v_new bigint; v_rev bigint; v_updated timestamptz;
  v_result jsonb; v_audit_ts timestamptz;
begin
  if v_actor is null or v_org is null then raise exception 'ACTIVE_MEMBERSHIP_REQUIRED'; end if;
  v_table:=case p_kind when 'studies' then 'ec_studies' when 'patients' then 'ec_patients'
    when 'visits' then 'ec_visits' when 'docs' then 'ec_docs' when 'users' then 'ec_users'
    when 'records' then 'ec_records' when 'checklists' then 'ec_checklists' when 'settings' then 'ec_settings' end;
  if v_table is null or p_id is null or length(p_id) not between 1 and 1024
    or jsonb_typeof(p_data)<>'object' or p_data->>'id' is distinct from p_id
    or (p_expected_rev is not null and p_expected_rev<1) then raise exception 'INVALID_RECORD'; end if;
  if p_event_id is null or length(btrim(p_event_id)) not between 1 and 200 or p_event_id~'^(client|db|service):' then
    raise exception 'INVALID_EVENT_ID'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('op','save','kind',p_kind,'id',p_id,'data',p_data,
    'expected',p_expected_rev,'action',coalesce(p_action,''),'detail',coalesce(p_detail,''),'reason',coalesce(p_motivo,''))::text,'UTF8')),'hex');
  insert into zonda_private.write_receipts(org_id,event_id,actor_id,request_hash) values(v_org,p_event_id,v_actor,v_hash)
    on conflict(org_id,event_id) do nothing;
  get diagnostics v_new=row_count;
  if v_new=0 then
    select * into v_receipt from zonda_private.write_receipts where org_id=v_org and event_id=p_event_id for update;
    if v_receipt.actor_id<>v_actor or v_receipt.request_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    if v_receipt.result is null then raise exception 'INCOMPLETE_WRITE_RECEIPT'; end if;
    return v_receipt.result||jsonb_build_object('replayed',true);
  end if;
  insert into zonda_private.write_context values(pg_backend_pid(),txid_current(),v_table,p_id,v_org,
    case when p_expected_rev is null then 'INSERT' else 'UPDATE' end,p_event_id,
    left(coalesce(p_action,''),120),left(coalesce(p_detail,''),600),left(coalesce(p_motivo,''),300))
    on conflict(backend_pid) do update set transaction_id=excluded.transaction_id,table_name=excluded.table_name,
      record_id=excluded.record_id,org_id=excluded.org_id,operation=excluded.operation,event_id=excluded.event_id,
      action_label=excluded.action_label,detail=excluded.detail,reason=excluded.reason;
  if p_expected_rev is null then
    begin
      execute format('insert into public.%I(id,org_id,data,rev,updated_at) values($1,$2,$3,1,clock_timestamp()) returning rev,updated_at',v_table)
        using p_id,v_org,p_data into v_rev,v_updated;
    exception when unique_violation then raise exception 'VERSION_CONFLICT'; end;
  else
    execute format('update public.%I set data=$1,rev=rev+1,updated_at=clock_timestamp() where id=$2 and org_id=$3 and rev=$4 returning rev,updated_at',v_table)
      using p_data,p_id,v_org,p_expected_rev into v_rev,v_updated;
    if v_rev is null then raise exception 'VERSION_CONFLICT'; end if;
  end if;
  if exists(select 1 from zonda_private.write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()) then
    raise exception 'AUDIT_CONTEXT_NOT_CONSUMED'; end if;
  select ts into v_audit_ts from public.ec_audit where org_id=v_org and event_id=p_event_id and actor_id=v_actor and source='database';
  if v_audit_ts is null then raise exception 'AUDIT_WRITE_MISSING'; end if;
  v_result:=jsonb_build_object('rev',v_rev,'updated_at',v_updated,'audit_ts',v_audit_ts,'created',p_expected_rev is null,'event_id',p_event_id);
  update zonda_private.write_receipts set result=v_result where org_id=v_org and event_id=p_event_id;
  return v_result;
end $$;
alter function public.ec_save_record(text,text,jsonb,bigint,text,text,text,text) owner to zonda_rpc_writer;

create or replace function public.ec_remove_record(
  p_kind text,p_id text,p_expected_rev bigint,p_event_id text,p_detail text default null,p_motivo text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog, public, pg_temp
as $$
declare v_table text; v_org uuid:=public.current_org(); v_actor uuid:=auth.uid(); v_hash text;
  v_receipt zonda_private.write_receipts%rowtype; v_new bigint; v_rows bigint; v_exists boolean; v_result jsonb; v_audit_ts timestamptz;
begin
  if v_actor is null or v_org is null then raise exception 'ACTIVE_MEMBERSHIP_REQUIRED'; end if;
  v_table:=case p_kind when 'studies' then 'ec_studies' when 'patients' then 'ec_patients'
    when 'visits' then 'ec_visits' when 'docs' then 'ec_docs' when 'users' then 'ec_users'
    when 'records' then 'ec_records' when 'checklists' then 'ec_checklists' when 'settings' then 'ec_settings' end;
  if v_table is null or p_id is null or length(p_id) not between 1 and 1024 or p_expected_rev is null or p_expected_rev<1 then raise exception 'INVALID_RECORD'; end if;
  if p_event_id is null or length(btrim(p_event_id)) not between 1 and 200 or p_event_id~'^(client|db|service):' then raise exception 'INVALID_EVENT_ID'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('op','remove','kind',p_kind,'id',p_id,'expected',p_expected_rev,
    'detail',coalesce(p_detail,''),'reason',coalesce(p_motivo,''))::text,'UTF8')),'hex');
  insert into zonda_private.write_receipts(org_id,event_id,actor_id,request_hash) values(v_org,p_event_id,v_actor,v_hash)
    on conflict(org_id,event_id) do nothing;
  get diagnostics v_new=row_count;
  if v_new=0 then
    select * into v_receipt from zonda_private.write_receipts where org_id=v_org and event_id=p_event_id for update;
    if v_receipt.actor_id<>v_actor or v_receipt.request_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    if v_receipt.result is null then raise exception 'INCOMPLETE_WRITE_RECEIPT'; end if;
    execute format('select exists(select 1 from public.%I where id=$1 and org_id=$2)',v_table) using p_id,v_org into v_exists;
    if v_exists then raise exception 'VERSION_CONFLICT'; end if;
    return v_receipt.result||jsonb_build_object('replayed',true);
  end if;
  insert into zonda_private.write_context values(pg_backend_pid(),txid_current(),v_table,p_id,v_org,'DELETE',p_event_id,
    null,left(coalesce(p_detail,''),600),left(coalesce(p_motivo,''),300))
    on conflict(backend_pid) do update set transaction_id=excluded.transaction_id,table_name=excluded.table_name,
      record_id=excluded.record_id,org_id=excluded.org_id,operation=excluded.operation,event_id=excluded.event_id,
      action_label=excluded.action_label,detail=excluded.detail,reason=excluded.reason;
  execute format('delete from public.%I where id=$1 and org_id=$2 and rev=$3',v_table) using p_id,v_org,p_expected_rev;
  get diagnostics v_rows=row_count;
  if v_rows=0 then raise exception 'VERSION_CONFLICT'; end if;
  if exists(select 1 from zonda_private.write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()) then raise exception 'AUDIT_CONTEXT_NOT_CONSUMED'; end if;
  select ts into v_audit_ts from public.ec_audit where org_id=v_org and event_id=p_event_id and actor_id=v_actor and source='database';
  if v_audit_ts is null then raise exception 'AUDIT_WRITE_MISSING'; end if;
  v_result:=jsonb_build_object('deleted',true,'event_id',p_event_id,'audit_ts',v_audit_ts);
  update zonda_private.write_receipts set result=v_result where org_id=v_org and event_id=p_event_id;
  return v_result;
end $$;
alter function public.ec_remove_record(text,text,bigint,text,text,text) owner to zonda_rpc_writer;

create or replace function public.ec_append_audit_events(p_events jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog, public, pg_temp
as $$
declare v_org uuid:=public.current_org(); v_actor uuid:=auth.uid(); v_event jsonb; v_id text; v_key text;
  v_hash text; v_receipt zonda_private.write_receipts%rowtype; v_new bigint; v_accepted jsonb:='[]'::jsonb;
begin
  if v_actor is null or v_org is null then raise exception 'ACTIVE_MEMBERSHIP_REQUIRED'; end if;
  if jsonb_typeof(p_events) is distinct from 'array' then raise exception 'INVALID_AUDIT_BATCH'; end if;
  if jsonb_array_length(p_events)>100 then raise exception 'INVALID_AUDIT_BATCH'; end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    v_id:=v_event->>'event_id';
    if jsonb_typeof(v_event)<>'object' or v_id is null or length(btrim(v_id)) not between 1 and 200 then raise exception 'INVALID_EVENT_ID'; end if;
    if (nullif(v_event->>'org_id','') is not null and v_event->>'org_id'<>v_org::text)
      or (nullif(v_event->>'auth_user_id','') is not null and v_event->>'auth_user_id'<>v_actor::text) then raise exception 'AUDIT_SCOPE_MISMATCH'; end if;
    v_key:='client:'||v_actor::text||':'||v_id;
    v_hash:=encode(sha256(convert_to((v_event-'usuario'-'rol'-'actor_id'-'source'-'operation')::text,'UTF8')),'hex');
    insert into zonda_private.write_receipts(org_id,event_id,actor_id,request_hash) values(v_org,v_key,v_actor,v_hash)
      on conflict(org_id,event_id) do nothing;
    get diagnostics v_new=row_count;
    if v_new=0 then
      select * into v_receipt from zonda_private.write_receipts where org_id=v_org and event_id=v_key for update;
      if v_receipt.actor_id<>v_actor or v_receipt.request_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    else
      insert into public.ec_audit(org_id,event_id,client_event_id,actor_id,usuario,rol,entidad,accion,action_label,
        ref_id,detalle,motivo,client_ts,source,operation,database_role)
      values(v_org,v_key,v_id,v_actor,coalesce(nullif(auth.jwt()->>'email',''),v_actor::text),public.current_rol(),
        left(coalesce(v_event->>'entidad',''),80),'evento de cliente',left(coalesce(v_event->>'accion',''),120),
        left(coalesce(v_event->>'ref_id',v_event->>'id',''),1024),left(coalesce(v_event->>'detalle',''),600),
        left(coalesce(v_event->>'motivo',''),300),nullif(v_event->>'client_ts','')::timestamptz,'client','EVENT','authenticated');
      update zonda_private.write_receipts set result=jsonb_build_object('accepted',v_id) where org_id=v_org and event_id=v_key;
    end if;
    v_accepted:=v_accepted||jsonb_build_array(v_id);
  end loop;
  return jsonb_build_object('accepted',v_accepted);
end $$;
alter function public.ec_append_audit_events(jsonb) owner to zonda_rpc_writer;

revoke all on all functions in schema zonda_private from public, anon, authenticated, service_role;
grant usage on schema zonda_private to service_role;
grant execute on function zonda_private.normalize_service_audit(public.ec_audit) to service_role;
revoke all on function public.ec_save_record(text,text,jsonb,bigint,text,text,text,text) from public, anon, service_role;
revoke all on function public.ec_remove_record(text,text,bigint,text,text,text) from public, anon, service_role;
revoke all on function public.ec_append_audit_events(jsonb) from public, anon, service_role;
grant execute on function public.ec_save_record(text,text,jsonb,bigint,text,text,text,text) to authenticated;
grant execute on function public.ec_remove_record(text,text,bigint,text,text,text) to authenticated;
grant execute on function public.ec_append_audit_events(jsonb) to authenticated;
revoke create on schema public from zonda_rpc_writer;
revoke create on schema zonda_private from zonda_rpc_writer,zonda_audit_writer;
-- Evitar que tablas futuras propiedad de postgres vuelvan a conceder DML
-- cliente o privilegios administrativos por defecto. service_role conserva DML.
alter default privileges for role postgres in schema public revoke all on tables from anon,authenticated;
alter default privileges for role postgres in schema public grant select on tables to authenticated;
alter default privileges for role postgres in schema public revoke truncate,references,trigger,maintain on tables from service_role;
commit;
