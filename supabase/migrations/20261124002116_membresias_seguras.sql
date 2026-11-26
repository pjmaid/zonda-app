-- Identificador generado por Supabase CLI 3.3.0; requiere esquema y RLS 20261113.
-- No corrige filas existentes ni crea administradores. Bootstrap por SQL/servicio
-- mantiene INSERT; la pérdida del último administrador activo queda prohibida
-- incluso en sitios desactivados y en cascadas desde Auth.
begin;

create or replace function public.current_org() returns uuid
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.org_id from public.ec_members m join public.ec_orgs o on o.id=m.org_id
  where m.user_id=auth.uid() and m.activo and o.activo
$$;

create or replace function public.current_rol() returns text
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.rol from public.ec_members m join public.ec_orgs o on o.id=m.org_id
  where m.user_id=auth.uid() and m.activo and o.activo
$$;

create or replace function public.es_superadmin() returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce((select m.superadmin from public.ec_members m
    join public.ec_orgs o on o.id=m.org_id
    where m.user_id=auth.uid() and m.activo and o.activo), false)
$$;

-- BEFORE STATEMENT toma el lock antes de bloquear filas objetivo. Se usa un
-- único lock para evitar inversiones entre organizaciones en UPDATE masivos.
-- La consulta de autorización/conteo es OTRA sentencia SPI VOLATILE: en READ
-- COMMITTED obtiene una snapshot posterior a la espera. No usar un helper
-- STABLE ni el snapshot de la sentencia que inició el UPDATE para ese conteo.
create or replace function public.ec_members_write_lock() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, public
as $$
begin
  -- En REPEATABLE READ la snapshot de transacción no se renueva tras esperar.
  -- La API usa READ COMMITTED; otros modos deben reintentar explícitamente con
  -- ese aislamiento, nunca validar una reducción sobre una vista antigua.
  if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
    raise exception using errcode='0A000', message='MEMBERSHIP_ISOLATION_UNSUPPORTED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1919247475, 20261124);
  return null;
end
$$;

create or replace function public.ec_members_guard() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.ec_members%rowtype;
  v_role text := coalesce(current_setting('role', true), 'none');
  v_trusted boolean;
begin
  -- Una cascada por eliminación AUTORIZADA de la organización elimina su
  -- membresía completa. RLS/privilegios de ec_orgs autorizan el DELETE padre.
  -- No aplica a Auth: en esa cascada la organización sigue existiendo.
  if tg_op='DELETE' and not exists(select 1 from public.ec_orgs where id=old.org_id) then
    return old;
  end if;

  -- SECURITY DEFINER cambia current_user. El rol efectivo pedido por SET ROLE
  -- y session_user distinguen PostgREST service_role, Auth y SQL administrativo
  -- de un cliente authenticated sin sub. auth.uid() IS NULL no es un permiso.
  v_trusted := v_role='service_role' or
    (v_role in ('none','') and session_user in ('postgres','supabase_admin','supabase_auth_admin'));
  if not v_trusted then
    select m.* into v_actor from public.ec_members m
      join public.ec_orgs o on o.id=m.org_id
      where m.user_id=auth.uid() and m.activo and o.activo;
    if v_actor.user_id is null or (v_actor.rol<>'admin' and not v_actor.superadmin) then
      raise exception using errcode='42501', message='MEMBERSHIP_ADMIN_REQUIRED';
    end if;
    if not v_actor.superadmin then
      if tg_op='INSERT' then
        raise exception using errcode='42501', message='SUPERADMIN_REQUIRED';
      end if;
      if old.org_id<>v_actor.org_id then
        raise exception using errcode='42501', message='MEMBER_OUTSIDE_SITE';
      end if;
      -- Toda la fila está protegida, incluso cambios a creado_en o no-op.
      if old.superadmin or (tg_op='UPDATE' and new.superadmin) then
        raise exception using errcode='42501', message='SUPERADMIN_TARGET_FORBIDDEN';
      end if;
      if tg_op='UPDATE' then
        if new.user_id is distinct from old.user_id or new.org_id is distinct from old.org_id then
          raise exception using errcode='42501', message='MEMBER_IDENTITY_IMMUTABLE';
        end if;
        if old.user_id=v_actor.user_id and new.rol is distinct from old.rol then
          raise exception using errcode='42501', message='SELF_ROLE_CHANGE_FORBIDDEN';
        end if;
      elsif old.user_id=v_actor.user_id then
        raise exception using errcode='42501', message='SELF_DELETE_FORBIDDEN';
      end if;
    end if;
  end if;

  if tg_op in ('UPDATE','DELETE') and old.rol='admin' and old.activo then
    if tg_op='DELETE' or not new.activo or new.rol<>'admin' or new.org_id is distinct from old.org_id then
      if not exists(select 1 from public.ec_members m
        where m.org_id=old.org_id and m.user_id<>old.user_id and m.rol='admin' and m.activo) then
        raise exception using errcode='23514', message='LAST_ADMIN_FORBIDDEN';
      end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end
$$;

drop trigger if exists ec_members_write_lock_trg on public.ec_members;
create trigger ec_members_write_lock_trg before insert or update or delete on public.ec_members
for each statement execute function public.ec_members_write_lock();
drop trigger if exists ec_members_guard_trg on public.ec_members;
create trigger ec_members_guard_trg before insert or update or delete on public.ec_members
for each row execute function public.ec_members_guard();

-- TRUNCATE ignora RLS y triggers por fila; no forma parte de la API de acceso.
revoke all on public.ec_members from anon;
revoke truncate, references, trigger on public.ec_members from authenticated, service_role;
revoke all on function public.ec_members_write_lock() from public, anon, authenticated, service_role;
revoke all on function public.ec_members_guard() from public, anon, authenticated, service_role;
revoke all on function public.current_org() from public, anon;
revoke all on function public.current_rol() from public, anon;
revoke all on function public.es_superadmin() from public, anon;
grant execute on function public.current_org(), public.current_rol(), public.es_superadmin() to authenticated, service_role;

commit;
