-- Reversión SOLO después de revisión: restaura permisos anteriores y reabre
-- el acceso por protocolo durante cargas sin ficha. No elimina filas/binarios.
-- Se bloquea si existe historial publicado, aun cuando ya se retiró el archivo.
-- En ese caso se requiere un plan explícito que preserve el registro permanente;
-- nunca eliminar la tabla para forzar esta reversión.
-- Revertir primero documentos, luego auditoría, luego membresías.
begin;
set local search_path=public,extensions;
do $$begin
  if exists(select 1 from zonda_private.document_paths) then
    raise exception 'DOCUMENT_HISTORY_ROLLBACK_BLOCKED';
  end if;
end$$;
drop trigger if exists ec_docs_storage_cleaned on storage.objects;
drop trigger if exists ec_docs_storage_insert_guard on storage.objects;
drop trigger if exists ec_docs_storage_update_guard on storage.objects;
drop trigger if exists ec_docs_storage_history on public.ec_docs;
drop trigger if exists ec_docs_storage_delete_guard on storage.objects;
drop trigger if exists ec_docs_storage_guard on public.ec_docs;
drop policy if exists ec_docs_read on storage.objects;
drop policy if exists ec_docs_insert on storage.objects;
drop policy if exists ec_docs_update on storage.objects;
drop policy if exists ec_docs_delete on storage.objects;
create or replace function ec_can_storage_object(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, storage
as $$
declare
  v_org text := split_part(p_name, '/', 1);
  v_scope text := split_part(p_name, '/', 2);
  v_doc_id text := nullif(split_part(p_name, '/', 3), '');
  v_doc_data jsonb;
begin
  if v_org <> current_org()::text then return false; end if;

  if v_doc_id is not null then
    select d.data into v_doc_data
      from ec_docs d
      where d.org_id = current_org() and d.id = v_doc_id
      limit 1;
  end if;

  if v_doc_data is null then
    select d.data into v_doc_data
      from ec_docs d
      where d.org_id = current_org() and d.id = v_scope
      limit 1;
  end if;

  if v_doc_data is not null then
    return ec_can_document(v_doc_data);
  end if;

  -- Durante una carga nueva el objeto se crea antes que su ficha ec_docs.
  -- La inserción posterior de la ficha vuelve a validar tipo y facturación.
  if exists (select 1 from ec_studies s where s.org_id = current_org() and s.id = v_scope) then
    return ec_can_study(v_scope);
  end if;
  return false;
end $$;
create or replace function public.ec_can_delete_storage_object(p_name text, p_owner_id text)
returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.current_org();
  v_role text := public.current_rol();
  v_scope text := split_part(p_name, '/', 2);
  v_doc_id text := nullif(split_part(p_name, '/', 3), '');
  v_path text;
begin
  if v_org is null or split_part(p_name, '/', 1) <> v_org::text then return false; end if;
  if not coalesce(public.ec_can_storage_object(p_name), false) then return false; end if;
  if v_role in ('admin', 'medico') then return true; end if;
  if v_role is distinct from 'coord' then return false; end if;
  v_path := substr(p_name, length(v_org::text) + 2);

  if public.ec_can_facturacion() and exists (
    select 1 from public.ec_docs d
    where d.org_id = v_org
      and d.data ->> 'path' = v_path
      and d.data ->> 'tipo' = 'contrato'
      and public.ec_can_document(d.data)
  ) then return true; end if;

  -- La excepción de compensación está limitada al creador, al protocolo
  -- autorizado y a un objeto sin ninguna referencia actual o histórica.
  return coalesce(p_owner_id = auth.uid()::text, false)
    and exists (
      select 1 from public.ec_studies s
      where s.org_id = v_org and s.id = v_scope and public.ec_can_study(s.id)
    )
    and not exists (
      select 1 from public.ec_docs d
      where d.org_id = v_org
        and (d.data ->> 'path' = v_path or d.id = v_scope or d.id = v_doc_id)
    );
end
$$;
drop function if exists public.ec_guard_storage_delete();
drop function if exists public.ec_guard_document_storage();
drop function if exists public.ec_record_storage_cleanup();
drop function if exists public.ec_guard_published_storage_update();
drop function if exists public.ec_guard_retired_storage_insert();
drop function if exists public.ec_record_document_path();
drop function if exists public.ec_pending_document_cleanup(text);
drop function if exists public.ec_document_cleanup_status(text);
drop function if exists public.ec_confirm_document_cleanup(text);
drop function if exists public.ec_can_insert_storage_object(text,text);
drop function if exists public.ec_storage_private_owner(text,text);
drop function if exists public.ec_storage_new_path(text);
drop function if exists public.ec_storage_cleanup_allowed(text);
drop index if exists public.ec_docs_org_path_unique;
drop table zonda_private.document_paths;
revoke all on function public.ec_can_storage_object(text) from public,anon;
revoke all on function public.ec_can_delete_storage_object(text,text) from public,anon;
grant execute on function public.ec_can_storage_object(text) to authenticated;
grant execute on function public.ec_can_delete_storage_object(text,text) to authenticated;
drop policy if exists ec_docs_org on storage.objects;
drop policy if exists ec_docs_protocol on storage.objects;
drop policy if exists ec_docs_read on storage.objects;
drop policy if exists ec_docs_insert on storage.objects;
drop policy if exists ec_docs_update on storage.objects;
drop policy if exists ec_docs_delete on storage.objects;

create policy ec_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'ec-docs' and public.ec_can_storage_object(name));
create policy ec_docs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ec-docs'
    and (select public.current_rol()) in ('admin', 'medico', 'coord')
    and public.ec_can_storage_object(name)
  );
create policy ec_docs_update on storage.objects for update to authenticated
  using (
    bucket_id = 'ec-docs'
    and (select public.current_rol()) in ('admin', 'medico', 'coord')
    and public.ec_can_storage_object(name)
  )
  with check (
    bucket_id = 'ec-docs'
    and (select public.current_rol()) in ('admin', 'medico', 'coord')
    and public.ec_can_storage_object(name)
  );
create policy ec_docs_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'ec-docs'
    and public.ec_can_delete_storage_object(name, owner_id)
  );

commit;
