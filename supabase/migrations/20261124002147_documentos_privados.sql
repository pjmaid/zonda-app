-- PENDIENTE DE VALIDACIÓN LOCAL. No aplicado en producción.
-- Los binarios sin ficha exacta son staging privado del autor. No mueve ni
-- elimina objetos; los clientes anteriores conservan la carga antes de ficha.
begin;

do $$begin
  if to_regnamespace('zonda_private') is null then
    raise exception 'AUDITED_WRITES_MIGRATION_REQUIRED';
  end if;
end$$;

-- Registro permanente: retirar una ficha nunca libera su ruta para contenido
-- distinto. Sólo los triggers del servidor escriben esta tabla privada.
create table zonda_private.document_paths (
  org_id uuid not null,
  path text not null,
  doc_id text not null,
  study_id text not null,
  doc_type text not null,
  registered_at timestamptz not null default clock_timestamp(),
  registered_by uuid,
  retired_at timestamptz,
  retired_by uuid,
  cleaned_at timestamptz,
  cleaned_by uuid,
  primary key(org_id,path),
  unique(org_id,doc_id)
);
alter table zonda_private.document_paths owner to postgres;
alter table zonda_private.document_paths enable row level security;
revoke all on zonda_private.document_paths from public,anon,authenticated,service_role;

create unique index ec_docs_org_path_unique
  on public.ec_docs (org_id, (data ->> 'path'))
  where nullif(data ->> 'path', '') is not null;

insert into zonda_private.document_paths(org_id,path,doc_id,study_id,doc_type)
select org_id,data->>'path',id,coalesce(data->>'estudioId',''),coalesce(data->>'tipo','')
from public.ec_docs where nullif(data->>'path','') is not null;

-- Una referencia exacta es la única publicación de un archivo. Ni compartir
-- estudio ni reconocer un segmento de la ruta concede lectura de un huérfano.
create or replace function public.ec_can_storage_object(p_name text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select public.current_org() is not null
    and split_part(p_name, '/', 1) = public.current_org()::text
    and exists (
      select 1 from public.ec_docs d
      where d.org_id = public.current_org()
        and d.org_id::text || '/' || (d.data ->> 'path') = p_name
        and coalesce(d.data ->> 'storage', 'supabase') = 'supabase'
        and public.ec_can_document(d.data)
    )
$$;

create function public.ec_storage_new_path(p_name text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.current_org();
  v_parts text[] := string_to_array(p_name, '/');
begin
  if v_org is null or auth.uid() is null
    or v_parts[1] is distinct from v_org::text
    or cardinality(v_parts) <> 4
    or v_parts[2] !~ '^[A-Za-z0-9_-]{1,128}$'
    or v_parts[3] !~ '^[A-Za-z0-9_-]{1,128}$'
    or nullif(v_parts[4], '') is null or v_parts[4] in ('.', '..')
    or p_name ~ '[[:cntrl:]\\]' then return false; end if;
  return public.current_rol() in ('admin','medico','coord')
    and public.ec_can_study(v_parts[2])
    and exists (select 1 from public.ec_studies s where s.org_id=v_org and s.id=v_parts[2])
    and not exists (
      select 1 from zonda_private.document_paths h where h.org_id=v_org
        and (h.org_id::text || '/' || h.path=p_name or h.doc_id=v_parts[3])
    )
    and not exists (
      select 1 from public.ec_docs d
      where d.org_id=v_org and (
        d.org_id::text || '/' || (d.data ->> 'path') = p_name
        or d.id=v_parts[2] or d.id=v_parts[3]
      )
    );
end
$$;

create function public.ec_storage_private_owner(p_name text,p_owner_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select coalesce(p_owner_id=auth.uid()::text,false)
    and public.ec_storage_new_path(p_name)
$$;

create function public.ec_storage_cleanup_allowed(p_name text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select auth.uid() is not null and exists (
    select 1 from zonda_private.document_paths h
    where h.org_id=public.current_org() and h.org_id::text || '/' || h.path=p_name
      and h.retired_at is not null
      and not exists(select 1 from public.ec_docs d where d.org_id=h.org_id
        and (d.id=h.doc_id or d.data->>'path'=h.path))
      and (public.current_rol()='admin' or (
        h.retired_by=auth.uid() and public.current_rol() in ('medico','coord')
        and public.ec_can_study(h.study_id)
        and (h.doc_type not in ('contrato','gasto_remis_comprobante','gasto_medicamentos_comprobante')
          or public.ec_can_facturacion())
      ))
  )
$$;

create or replace function public.ec_can_delete_storage_object(p_name text,p_owner_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select public.ec_storage_private_owner(p_name,p_owner_id)
    or public.ec_storage_cleanup_allowed(p_name)
$$;

create function public.ec_can_insert_storage_object(p_name text,p_owner_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select coalesce(p_owner_id=auth.uid()::text,false)
    and public.current_rol() in ('admin','medico','coord')
    and public.ec_storage_new_path(p_name)
$$;

-- Se ejecuta también dentro de las RPC auditadas. La excepción de creación
-- para service_role/SQL administrativo permite restaurar metadatos históricos;
-- no autoriza cambiar identidad de una ficha ya existente.
create function public.ec_guard_document_storage()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_path text := nullif(new.data ->> 'path','');
  v_uid uuid := auth.uid();
  v_owner text;
  v_exists boolean;
  v_server boolean := coalesce(auth.role()='service_role',false)
    or (session_user in ('postgres','supabase_admin')
      and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')='{}'
      and current_setting('role',true) in ('none','postgres','supabase_admin'));
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.org_id is distinct from old.org_id then
      raise exception 'DOCUMENT_STORAGE_IDENTITY_IMMUTABLE';
    end if;
    foreach v_key in array array['path','storage','tipo','estudioId','pacienteId','gastoId'] loop
      if new.data -> v_key is distinct from old.data -> v_key then
        raise exception 'DOCUMENT_STORAGE_IDENTITY_IMMUTABLE: %',v_key;
      end if;
    end loop;
    return new;
  end if;
  if v_path is null then
    if new.data ->> 'storage'='supabase' then raise exception 'DOCUMENT_STORAGE_PATH_REQUIRED'; end if;
    return new;
  end if;
  if coalesce(new.data ->> 'storage','supabase') <> 'supabase' then
    raise exception 'DOCUMENT_STORAGE_PATH_INVALID';
  end if;
  if v_path ~ '(^/|/$|//|[[:cntrl:]\\])' or '..'=any(string_to_array(v_path,'/'))
    or '.'=any(string_to_array(v_path,'/')) then raise exception 'DOCUMENT_STORAGE_PATH_INVALID'; end if;
  if exists(select 1 from zonda_private.document_paths h where h.org_id=new.org_id
    and (h.path=v_path or h.doc_id=new.id)) then
    raise exception 'DOCUMENT_STORAGE_PATH_ALREADY_PUBLISHED';
  end if;
  if v_server then return new; end if;
  if v_uid is null or new.org_id is distinct from public.current_org()
    or split_part(v_path,'/',1) is distinct from new.data ->> 'estudioId'
    or split_part(v_path,'/',2) is distinct from new.id
    or cardinality(string_to_array(v_path,'/')) <> 3 then
    raise exception 'DOCUMENT_STORAGE_PATH_INVALID';
  end if;
  -- La publicación espera una eliminación anterior; el borrado posterior
  -- vuelve a validar permisos después de adquirir el bloqueo de fila.
  select o.owner_id into v_owner from storage.objects o
    where o.bucket_id='ec-docs' and o.name=new.org_id::text || '/' || v_path
    for key share;
  v_exists := found;
  if not v_exists or v_owner is distinct from v_uid::text then
    raise exception 'DOCUMENT_STORAGE_OWNER_REQUIRED';
  end if;
  return new;
end
$$;

create trigger ec_docs_storage_guard before insert or update on public.ec_docs
  for each row execute function public.ec_guard_document_storage();

create function public.ec_record_document_path()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_path text;
begin
  if tg_op='INSERT' then
    v_path:=nullif(new.data->>'path','');
    if v_path is not null then
      insert into zonda_private.document_paths(org_id,path,doc_id,study_id,doc_type,registered_by)
        values(new.org_id,v_path,new.id,coalesce(new.data->>'estudioId',''),coalesce(new.data->>'tipo',''),auth.uid());
    end if;
    return new;
  end if;
  v_path:=nullif(old.data->>'path','');
  if v_path is not null then
    update zonda_private.document_paths set retired_at=clock_timestamp(),retired_by=auth.uid(),
      cleaned_at=case when exists(select 1 from storage.objects o where o.bucket_id='ec-docs'
        and o.name=old.org_id::text || '/' || v_path) then null else clock_timestamp() end,
      cleaned_by=null
      where org_id=old.org_id and path=v_path and doc_id=old.id and retired_at is null;
    if not found then raise exception 'DOCUMENT_STORAGE_HISTORY_MISSING'; end if;
  end if;
  return old;
end
$$;
create trigger ec_docs_storage_history after insert or delete on public.ec_docs
  for each row execute function public.ec_record_document_path();

-- La política RLS puede haber sido evaluada antes de que otra transacción
-- publicara la ficha. Este trigger VOLATILE revalida después del bloqueo del
-- objeto para impedir que una compensación antigua borre un archivo publicado.
create function public.ec_guard_storage_delete()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_server boolean := coalesce(auth.role()='service_role',false)
    or (session_user in ('postgres','supabase_admin')
      and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')='{}'
      and current_setting('role',true) in ('none','postgres','supabase_admin'));
begin
  if old.bucket_id='ec-docs' then
    -- Incluso service_role debe retirar primero la ficha con auditoría.
    if exists(select 1 from public.ec_docs d where d.org_id::text || '/' || (d.data->>'path')=old.name) then
      raise exception 'DOCUMENT_METADATA_DELETE_REQUIRED' using errcode='42501';
    end if;
    if not v_server and not public.ec_can_delete_storage_object(old.name,old.owner_id) then
      raise exception 'DOCUMENT_STORAGE_DELETE_ACCESS_REQUIRED' using errcode='42501';
    end if;
  end if;
  return old;
end
$$;
create trigger ec_docs_storage_delete_guard before delete on storage.objects
  for each row execute function public.ec_guard_storage_delete();

create function public.ec_record_storage_cleanup()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public
as $$begin
  if old.bucket_id='ec-docs' then
    update zonda_private.document_paths set cleaned_at=clock_timestamp(),cleaned_by=auth.uid()
      where org_id::text || '/' || path=old.name and retired_at is not null;
  end if;
  return old;
end$$;
create trigger ec_docs_storage_cleaned after delete on storage.objects
  for each row execute function public.ec_record_storage_cleanup();

create function public.ec_guard_retired_storage_insert()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public
as $$begin
  if new.bucket_id='ec-docs' and exists(select 1 from zonda_private.document_paths h
    where h.org_id::text || '/' || h.path=new.name and h.retired_at is not null) then
    raise exception 'DOCUMENT_STORAGE_PATH_RETIRED' using errcode='42501';
  end if;
  return new;
end$$;
create trigger ec_docs_storage_insert_guard before insert on storage.objects
  for each row execute function public.ec_guard_retired_storage_insert();

-- Storage puede actualizar last_accessed_at al leer. La versión, el contenido,
-- propietario o ubicación de un archivo registrado no se reemplazan por API,
-- tampoco con service_role. La restauración administrativa usa INSERT sobre un
-- destino vacío después de restaurar la base; no reescribe un objeto presente.
create function public.ec_guard_published_storage_update()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public
as $$begin
  if exists(select 1 from zonda_private.document_paths h
    where (old.bucket_id='ec-docs' and h.org_id::text || '/' || h.path=old.name)
      or (new.bucket_id='ec-docs' and h.org_id::text || '/' || h.path=new.name))
    and (to_jsonb(new)-array['last_accessed_at','updated_at'])
      is distinct from (to_jsonb(old)-array['last_accessed_at','updated_at']) then
    raise exception 'DOCUMENT_STORAGE_CONTENT_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end$$;
create trigger ec_docs_storage_update_guard before update on storage.objects
  for each row execute function public.ec_guard_published_storage_update();

create function public.ec_pending_document_cleanup(p_estudio_id text default null)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public
as $$begin
  if auth.uid() is null or public.current_org() is null then raise exception 'ACTIVE_MEMBERSHIP_REQUIRED'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('doc_id',h.doc_id,'path',h.path,'estudio_id',h.study_id,
      'retired_at',h.retired_at) order by h.retired_at,h.path)
    from zonda_private.document_paths h where h.org_id=public.current_org()
      and h.retired_at is not null and h.cleaned_at is null
      and (p_estudio_id is null or h.study_id=p_estudio_id)
      and public.ec_storage_cleanup_allowed(h.org_id::text || '/' || h.path)),'[]'::jsonb);
end$$;

create function public.ec_document_cleanup_status(p_path text)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public
as $$
declare h zonda_private.document_paths%rowtype;
begin
  select * into h from zonda_private.document_paths where org_id=public.current_org() and path=p_path;
  if not found or auth.uid() is null then raise exception 'DOCUMENT_CLEANUP_ACCESS_REQUIRED'; end if;
  if h.retired_at is null then
    if not public.ec_can_storage_object(h.org_id::text || '/' || h.path) then raise exception 'DOCUMENT_CLEANUP_ACCESS_REQUIRED'; end if;
    return jsonb_build_object('deleted',false,'doc_id',h.doc_id);
  end if;
  if not public.ec_storage_cleanup_allowed(h.org_id::text || '/' || h.path) then raise exception 'DOCUMENT_CLEANUP_ACCESS_REQUIRED'; end if;
  return jsonb_build_object('deleted',true,'doc_id',h.doc_id,'cleaned',h.cleaned_at is not null);
end$$;

create function public.ec_confirm_document_cleanup(p_path text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare h zonda_private.document_paths%rowtype;
begin
  select * into h from zonda_private.document_paths where org_id=public.current_org() and path=p_path for update;
  if not found or not public.ec_storage_cleanup_allowed(h.org_id::text || '/' || h.path) then
    raise exception 'DOCUMENT_CLEANUP_ACCESS_REQUIRED';
  end if;
  if exists(select 1 from storage.objects where bucket_id='ec-docs' and name=h.org_id::text || '/' || h.path) then
    raise exception 'DOCUMENT_STORAGE_CLEANUP_PENDING';
  end if;
  update zonda_private.document_paths set cleaned_at=coalesce(cleaned_at,clock_timestamp()),
    cleaned_by=coalesce(cleaned_by,auth.uid()) where org_id=h.org_id and path=h.path;
  return jsonb_build_object('ok',true,'doc_id',h.doc_id);
end$$;

revoke all on function public.ec_can_storage_object(text) from public,anon;
revoke all on function public.ec_storage_new_path(text) from public,anon;
revoke all on function public.ec_storage_private_owner(text,text) from public,anon;
revoke all on function public.ec_can_delete_storage_object(text,text) from public,anon;
revoke all on function public.ec_can_insert_storage_object(text,text) from public,anon;
revoke all on function public.ec_storage_cleanup_allowed(text) from public,anon;
revoke all on function public.ec_guard_document_storage() from public,anon,authenticated;
revoke all on function public.ec_guard_storage_delete() from public,anon,authenticated;
revoke all on function public.ec_record_document_path() from public,anon,authenticated;
revoke all on function public.ec_record_storage_cleanup() from public,anon,authenticated;
revoke all on function public.ec_guard_published_storage_update() from public,anon,authenticated;
revoke all on function public.ec_guard_retired_storage_insert() from public,anon,authenticated;
revoke all on function public.ec_pending_document_cleanup(text) from public,anon,service_role;
revoke all on function public.ec_document_cleanup_status(text) from public,anon,service_role;
revoke all on function public.ec_confirm_document_cleanup(text) from public,anon,service_role;
grant execute on function public.ec_can_storage_object(text) to authenticated;
grant execute on function public.ec_storage_new_path(text) to authenticated;
grant execute on function public.ec_storage_private_owner(text,text) to authenticated;
grant execute on function public.ec_can_delete_storage_object(text,text) to authenticated;
grant execute on function public.ec_can_insert_storage_object(text,text) to authenticated;
grant execute on function public.ec_storage_cleanup_allowed(text) to authenticated;
grant execute on function public.ec_pending_document_cleanup(text) to authenticated;
grant execute on function public.ec_document_cleanup_status(text) to authenticated;
grant execute on function public.ec_confirm_document_cleanup(text) to authenticated;

drop policy if exists ec_docs_org on storage.objects;
drop policy if exists ec_docs_protocol on storage.objects;
drop policy if exists ec_docs_read on storage.objects;
drop policy if exists ec_docs_insert on storage.objects;
drop policy if exists ec_docs_update on storage.objects;
drop policy if exists ec_docs_delete on storage.objects;
create policy ec_docs_read on storage.objects for select to authenticated using (
  bucket_id='ec-docs' and (
    public.ec_can_storage_object(name)
    or public.ec_storage_private_owner(name,owner_id)
    or public.ec_storage_cleanup_allowed(name)
  )
);
create policy ec_docs_insert on storage.objects for insert to authenticated with check (
  bucket_id='ec-docs' and public.ec_can_insert_storage_object(name,owner_id)
);
-- Sin política UPDATE: ningún cliente puede sobrescribir un binario, publicado
-- o privado. Los reintentos del cliente nuevo verifican igualdad, sin upsert.
create policy ec_docs_delete on storage.objects for delete to authenticated using (
  bucket_id='ec-docs' and public.ec_can_delete_storage_object(name,owner_id)
);
commit;
