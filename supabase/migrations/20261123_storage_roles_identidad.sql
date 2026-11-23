-- Validada con Auth/Storage reales: 14/14 escenarios sintéticos y rollback probado.
-- Aplicada en producción el 23/11/2026: versión 20261123233445, storage_roles_identidad.
-- Evidencia y hash del SQL original: docs/VALIDACION_SUPABASE_20261123.md.
-- Requiere las migraciones de permisos por protocolo y contratos de 20260810/16.
-- No modifica filas ni binarios. Mantiene los permisos DML necesarios para las
-- RPC SECURITY INVOKER. Matriz de comprobación: docs/DATABASE_REVIEW_20261123.md.

-- Una ficha ya vinculada a Auth no debe conceder permisos a otra cuenta que
-- reutilice su dirección de email. El email solo identifica fichas históricas
-- que todavía no tienen authId, y nunca se acepta un email vacío.
create or replace function public.ec_is_own_user(p_data jsonb) returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select auth.uid() is not null
    and coalesce(
      nullif(btrim(p_data ->> 'authId'), '') = auth.uid()::text
      or (
        nullif(btrim(p_data ->> 'authId'), '') is null
        and nullif(lower(btrim(p_data ->> 'email')), '')
          = nullif(lower(btrim(auth.jwt() ->> 'email')), '')
      ),
      false
    )
$$;

create or replace function public.ec_user_study_ids() returns text[]
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(distinct s.id), array[]::text[])
  from public.ec_users u
  cross join lateral jsonb_array_elements_text(coalesce(u.data -> 'estudios', '[]'::jsonb)) s(id)
  where u.org_id = public.current_org()
    and coalesce((u.data ->> 'activo')::boolean, true)
    and public.ec_is_own_user(u.data)
$$;

create or replace function public.ec_can_facturacion() returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select public.es_superadmin()
    or public.current_rol() = 'admin'
    or exists (
      select 1 from public.ec_users u
      where u.org_id = public.current_org()
        and coalesce((u.data ->> 'activo')::boolean, true)
        and coalesce((u.data ->> 'facturacion')::boolean, false)
        and public.ec_is_own_user(u.data)
    )
$$;

revoke all on function public.ec_is_own_user(jsonb) from public, anon;
revoke all on function public.ec_user_study_ids() from public, anon;
revoke all on function public.ec_can_facturacion() from public, anon;
grant execute on function public.ec_is_own_user(jsonb) to authenticated;
grant execute on function public.ec_user_study_ids() to authenticated;
grant execute on function public.ec_can_facturacion() to authenticated;

-- La coordinadora conserva el borrado de contratos con permiso financiero y
-- puede compensar una carga propia fallida que aún no tenga ficha ec_docs.
-- La propiedad por sí sola nunca habilita borrar un documento clínico publicado.
-- owner_id es texto en el esquema actual de Supabase Storage; owner está obsoleto.
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
revoke all on function public.ec_can_delete_storage_object(text, text) from public, anon;
grant execute on function public.ec_can_delete_storage_object(text, text) to authenticated;

-- La política anterior FOR ALL convertía cualquier permiso de lectura en
-- permiso de subir, sobrescribir y borrar. Cada operación tiene ahora su rol.
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
