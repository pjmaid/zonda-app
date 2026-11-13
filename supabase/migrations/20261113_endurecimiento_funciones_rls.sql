-- Endurecimiento de funciones SECURITY DEFINER y políticas señaladas por asesores.
-- Las funciones siguen disponibles para usuarios autenticados porque las usan las RLS.
revoke execute on function public.current_org() from public, anon;
revoke execute on function public.current_rol() from public, anon;
revoke execute on function public.ec_can_document(jsonb) from public, anon;
revoke execute on function public.ec_can_facturacion() from public, anon;
revoke execute on function public.ec_can_record(jsonb) from public, anon;
revoke execute on function public.ec_can_storage_object(text) from public, anon;
revoke execute on function public.ec_can_study(text) from public, anon;
revoke execute on function public.ec_data_study(jsonb) from public, anon;
revoke execute on function public.ec_is_own_user(jsonb) from public, anon;
revoke execute on function public.ec_members_guard() from public, anon;
revoke execute on function public.ec_user_study_ids() from public, anon;
revoke execute on function public.es_superadmin() from public, anon;

drop policy if exists mem_del on public.ec_members;
create policy mem_del on public.ec_members for delete to authenticated
using (((org_id = (select public.current_org())) and ((select public.current_rol()) = 'admin')
        and (user_id <> (select auth.uid()))) or (select public.es_superadmin()));

-- Evita dos políticas permisivas superpuestas para SELECT en ec_orgs.
drop policy if exists orgs_super on public.ec_orgs;
drop policy if exists orgs_ver on public.ec_orgs;
create policy orgs_ver on public.ec_orgs for select to authenticated
using ((id = (select public.current_org())) or (select public.es_superadmin()));
create policy orgs_super_insert on public.ec_orgs for insert to authenticated
with check ((select public.es_superadmin()));
create policy orgs_super_update on public.ec_orgs for update to authenticated
using ((select public.es_superadmin())) with check ((select public.es_superadmin()));
create policy orgs_super_delete on public.ec_orgs for delete to authenticated
using ((select public.es_superadmin()));
