-- Reversión exclusiva de 20261123_storage_roles_identidad.sql.

-- Restaura funciones y políticas capturadas el 23/11/2026 DESPUÉS del endurecimiento

-- de funciones aplicado ese día. No modifica filas, archivos ni las otras políticas.

-- Ejecutar solo tras verificar que no existen cambios posteriores incompatibles.

begin;

set local search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.ec_is_own_user(p_data jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_data ->> 'authId' = auth.uid()::text
      or lower(p_data ->> 'email') = lower(coalesce(auth.jwt() ->> 'email', ''))
$function$;

revoke all on function public.ec_is_own_user(p_data jsonb) from public, anon;

grant execute on function public.ec_is_own_user(p_data jsonb) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ec_user_study_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(distinct s.id), array[]::text[])
  from ec_users u
  cross join lateral jsonb_array_elements_text(coalesce(u.data -> 'estudios', '[]'::jsonb)) s(id)
  where u.org_id = current_org()
    and coalesce((u.data ->> 'activo')::boolean, true)
    and (
      u.data ->> 'authId' = auth.uid()::text
      or lower(u.data ->> 'email') = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
$function$;

revoke all on function public.ec_user_study_ids() from public, anon;

grant execute on function public.ec_user_study_ids() to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ec_can_facturacion()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select es_superadmin()
    or current_rol() = 'admin'
    or exists (
      select 1
      from ec_users u
      where u.org_id = current_org()
        and coalesce((u.data ->> 'activo')::boolean, true)
        and coalesce((u.data ->> 'facturacion')::boolean, false)
        and (
          u.data ->> 'authId' = auth.uid()::text
          or lower(u.data ->> 'email') = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    )
$function$;

revoke all on function public.ec_can_facturacion() from public, anon;

grant execute on function public.ec_can_facturacion() to authenticated, service_role;

drop policy if exists ec_docs_read on storage.objects;

drop policy if exists ec_docs_insert on storage.objects;

drop policy if exists ec_docs_update on storage.objects;

drop policy if exists ec_docs_delete on storage.objects;

drop policy if exists ec_docs_protocol on storage.objects;

create policy ec_docs_protocol on storage.objects as PERMISSIVE for ALL to authenticated using (((bucket_id = 'ec-docs'::text) AND ec_can_storage_object(name))) with check (((bucket_id = 'ec-docs'::text) AND ec_can_storage_object(name)));

drop function if exists public.ec_can_delete_storage_object(text, text);

commit;
