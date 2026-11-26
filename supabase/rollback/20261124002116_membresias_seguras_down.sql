-- Revierte 20261124002116 con definiciones exactas del catálogo 20261124.
-- No altera datos ni deshace otras migraciones.
begin;
drop trigger if exists ec_members_write_lock_trg on public.ec_members;
drop function if exists public.ec_members_write_lock();
drop trigger if exists ec_members_guard_trg on public.ec_members;

CREATE OR REPLACE FUNCTION public.ec_members_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  /* sin sesion de usuario = acceso directo por SQL Editor o service_role:
     es el dueno del proyecto o la Edge Function, no se restringe */
  if auth.uid() is null then return new; end if;
  if es_superadmin() then return new; end if;

  if tg_op = 'INSERT' and new.superadmin then
    raise exception 'Solo un superadministrador puede otorgar ese permiso';
  end if;

  if tg_op = 'UPDATE' then
    if new.superadmin is distinct from old.superadmin then
      raise exception 'Solo un superadministrador puede otorgar ese permiso';
    end if;
    if new.org_id is distinct from old.org_id then
      raise exception 'No se puede mover un usuario a otra organizacion';
    end if;
    if new.user_id = auth.uid() and new.rol is distinct from old.rol then
      raise exception 'No podes cambiar tu propio rol';
    end if;
  end if;

  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.current_org()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select org_id from ec_members where user_id = auth.uid() and activo
$function$;

CREATE OR REPLACE FUNCTION public.current_rol()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select rol from ec_members where user_id = auth.uid() and activo
$function$;

CREATE OR REPLACE FUNCTION public.es_superadmin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select superadmin from ec_members
                   where user_id = auth.uid() and activo), false)
$function$;

CREATE TRIGGER ec_members_guard_trg BEFORE INSERT OR UPDATE ON public.ec_members FOR EACH ROW EXECUTE FUNCTION ec_members_guard();

grant all on public.ec_members to anon;
grant truncate, references, trigger on public.ec_members to authenticated, service_role;
grant execute on function public.ec_members_guard() to authenticated, service_role;
commit;
