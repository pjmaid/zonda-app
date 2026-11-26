-- Reversión únicamente ANTES de usar la nueva vía auditada.
-- Después de cualquier evento/recibo nuevo se aborta: preservar el ledger y
-- corregir hacia adelante. No desactivar triggers ni purgar historia para forzarla.
-- Derivada de schema-baseline-20261124; mantener la migración de membresías.
begin;
do $$
begin
  if exists(select 1 from public.ec_audit where source<>'legacy')
    or exists(select 1 from zonda_private.write_receipts)
    or exists(select 1 from public.ec_audit a where a.org_id is not null
      and not exists(select 1 from public.ec_orgs o where o.id=a.org_id)) then
    raise exception 'AUDIT_ROLLBACK_REQUIRES_FORWARD_FIX';
  end if;
end $$;
drop trigger "zonda_capture_actor" on public."ec_checklists";
drop trigger "zonda_audit_change" on public."ec_checklists";
drop trigger "zonda_no_truncate" on public."ec_checklists";
drop trigger "zonda_capture_actor" on public."ec_docs";
drop trigger "zonda_audit_change" on public."ec_docs";
drop trigger "zonda_no_truncate" on public."ec_docs";
drop trigger "zonda_capture_actor" on public."ec_members";
drop trigger "zonda_audit_change" on public."ec_members";
drop trigger "zonda_no_truncate" on public."ec_members";
drop trigger "zonda_capture_actor" on public."ec_orgs";
drop trigger "zonda_audit_change" on public."ec_orgs";
drop trigger "zonda_no_truncate" on public."ec_orgs";
drop trigger "zonda_capture_actor" on public."ec_patients";
drop trigger "zonda_audit_change" on public."ec_patients";
drop trigger "zonda_no_truncate" on public."ec_patients";
drop trigger "zonda_capture_actor" on public."ec_records";
drop trigger "zonda_audit_change" on public."ec_records";
drop trigger "zonda_no_truncate" on public."ec_records";
drop trigger "zonda_capture_actor" on public."ec_settings";
drop trigger "zonda_audit_change" on public."ec_settings";
drop trigger "zonda_no_truncate" on public."ec_settings";
drop trigger "zonda_capture_actor" on public."ec_studies";
drop trigger "zonda_audit_change" on public."ec_studies";
drop trigger "zonda_no_truncate" on public."ec_studies";
drop trigger "zonda_capture_actor" on public."ec_users";
drop trigger "zonda_audit_change" on public."ec_users";
drop trigger "zonda_no_truncate" on public."ec_users";
drop trigger "zonda_capture_actor" on public."ec_visits";
drop trigger "zonda_audit_change" on public."ec_visits";
drop trigger "zonda_no_truncate" on public."ec_visits";
drop trigger ec_audit_append_only on public.ec_audit;
drop trigger ec_audit_no_truncate on public.ec_audit;
drop policy aud_rpc_insert on public.ec_audit;
drop policy aud_database_insert on public.ec_audit;
drop policy aud_ver on public.ec_audit;
create policy "aud_ins" on public.ec_audit for INSERT to "authenticated" with check ((org_id = current_org()));
create policy "aud_ver" on public.ec_audit for SELECT to "authenticated" using (((org_id = current_org()) OR es_superadmin()));
alter function public."ec_remove_record"(text,text,bigint,text,text,text) owner to postgres;
CREATE OR REPLACE FUNCTION public.ec_remove_record(p_kind text, p_id text, p_expected_rev bigint, p_event_id text, p_detail text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_table text; v_rows bigint;
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
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  insert into ec_audit(event_id,usuario,rol,entidad,accion,ref_id,detalle,motivo)
  values(p_event_id,coalesce(auth.jwt()->>'email',auth.uid()::text,'usuario'),coalesce(current_rol(),''),p_kind,'baja',p_id,
    left(coalesce(p_detail,''),600),left(coalesce(p_motivo,''),300));
  return jsonb_build_object('deleted',true,'event_id',p_event_id);
end $function$;
revoke all on function public."ec_remove_record"(text,text,bigint,text,text,text) from public,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant execute on function public."ec_remove_record"(text,text,bigint,text,text,text) to PUBLIC;
grant execute on function public."ec_remove_record"(text,text,bigint,text,text,text) to "postgres";
grant execute on function public."ec_remove_record"(text,text,bigint,text,text,text) to "anon";
grant execute on function public."ec_remove_record"(text,text,bigint,text,text,text) to "authenticated";
grant execute on function public."ec_remove_record"(text,text,bigint,text,text,text) to "service_role";
alter function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) owner to postgres;
CREATE OR REPLACE FUNCTION public.ec_save_record(p_kind text, p_id text, p_data jsonb, p_expected_rev bigint, p_event_id text, p_action text DEFAULT NULL::text, p_detail text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_table text; v_rev bigint; v_updated_at timestamptz; v_rows bigint;
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
    get diagnostics v_rows = row_count;
    if v_rows = 0 then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  end if;
  insert into ec_audit(event_id,usuario,rol,entidad,accion,ref_id,detalle,motivo)
  values(p_event_id,coalesce(auth.jwt()->>'email',auth.uid()::text,'usuario'),coalesce(current_rol(),''),p_kind,
    coalesce(nullif(p_action,''),case when v_created then 'alta' else 'modificacion' end),p_id,
    left(coalesce(p_detail,''),600),left(coalesce(p_motivo,''),300));
  return jsonb_build_object('rev',v_rev,'updated_at',v_updated_at,'created',v_created,'event_id',p_event_id);
end $function$;
revoke all on function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) from public,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant execute on function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) to PUBLIC;
grant execute on function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) to "postgres";
grant execute on function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) to "anon";
grant execute on function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) to "authenticated";
grant execute on function public."ec_save_record"(text,text,jsonb,bigint,text,text,text,text) to "service_role";
drop function public.ec_append_audit_events(jsonb);
drop function zonda_private.capture_actor();
drop function zonda_private.audit_record_change();
drop function zonda_private.audit_append_only();
drop function zonda_private.normalize_service_audit(public.ec_audit);
drop function zonda_private.reject_data_truncate();
drop table zonda_private.write_context;
drop table zonda_private.actor_context;
drop table zonda_private.write_receipts;
revoke all on public."ec_audit" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_audit" to "postgres";
grant INSERT,SELECT,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_audit" to "anon";
grant INSERT,SELECT,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_audit" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_audit" to "service_role";
revoke all on public."ec_checklists" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_checklists" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_checklists" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_checklists" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_checklists" to "service_role";
revoke all on public."ec_docs" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_docs" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_docs" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_docs" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_docs" to "service_role";
-- Membresías ya había retirado otros privilegios antes de esta migración.
grant maintain on public.ec_members to authenticated,service_role;
revoke all on public."ec_orgs" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_orgs" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_orgs" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_orgs" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_orgs" to "service_role";
revoke all on public."ec_patients" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_patients" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_patients" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_patients" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_patients" to "service_role";
revoke all on public."ec_records" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_records" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_records" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_records" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_records" to "service_role";
revoke all on public."ec_settings" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_settings" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_settings" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_settings" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_settings" to "service_role";
revoke all on public."ec_studies" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_studies" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_studies" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_studies" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_studies" to "service_role";
revoke all on public."ec_users" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_users" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_users" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_users" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_users" to "service_role";
revoke all on public."ec_visits" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_visits" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_visits" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_visits" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on public."ec_visits" to "service_role";
revoke all on sequence public."ec_audit_id_seq" from public,postgres,anon,authenticated,service_role,zonda_rpc_writer,zonda_audit_writer;
grant SELECT,UPDATE,USAGE on sequence public."ec_audit_id_seq" to "postgres";
grant SELECT,UPDATE,USAGE on sequence public."ec_audit_id_seq" to "anon";
grant SELECT,UPDATE,USAGE on sequence public."ec_audit_id_seq" to "authenticated";
grant SELECT,UPDATE,USAGE on sequence public."ec_audit_id_seq" to "service_role";
alter table public.ec_audit drop constraint ec_audit_source_check;
alter table public.ec_audit
 drop column actor_id, drop column source, drop column operation,
 drop column action_label, drop column client_event_id, drop column database_role,
 drop column record_rev, drop column before_hash, drop column after_hash;
alter table public.ec_audit add constraint ec_audit_org_id_fkey
 foreign key(org_id) references public.ec_orgs(id) on delete cascade;
alter default privileges for role postgres in schema public revoke all on tables from anon,authenticated,service_role;
alter default privileges for role postgres in schema public grant select,insert,update,delete,truncate,references,trigger,maintain on tables to anon,authenticated,service_role;
revoke execute on function public.current_org(),public.current_rol(),public.es_superadmin(),auth.uid(),auth.jwt() from zonda_audit_writer;
revoke usage on schema public,auth from zonda_rpc_writer,zonda_audit_writer;
-- RESTRICT: si otra migración utiliza el esquema privado, no se borra en cascada.
drop schema zonda_private restrict;
drop role zonda_rpc_writer;
drop role zonda_audit_writer;
commit;
