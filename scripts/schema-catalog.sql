-- Solo metadatos de Zonda: no consulta filas clínicas, cuentas ni archivos.
-- Ejecutar únicamente como lectura. Este inventario no reemplaza un backup.
select jsonb_build_object(
  'tables', (
    select jsonb_agg(jsonb_build_object(
      'name', c.relname, 'rls', c.relrowsecurity,
      'force_rls', c.relforcerowsecurity, 'acl', c.relacl,
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname, 'type', format_type(a.atttypid,a.atttypmod),
          'notnull', a.attnotnull, 'identity', a.attidentity,
          'generated', a.attgenerated, 'default', pg_get_expr(d.adbin,d.adrelid)
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      ),
      'constraints', (
        select jsonb_agg(jsonb_build_object(
          'name', con.conname, 'definition', pg_get_constraintdef(con.oid), 'type', con.contype
        ) order by con.conname)
        from pg_constraint con where con.conrelid=c.oid
      ),
      'indexes', (
        select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text)
        from pg_index i where i.indrelid=c.oid
        and not exists(select 1 from pg_constraint con where con.conindid=i.indexrelid)
      ),
      'triggers', (
        select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname)
        from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal
      )
    ) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'ec_%' and c.relkind='r'
  ),
  'functions', (
    select jsonb_agg(jsonb_build_object(
      'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
      'definition', pg_get_functiondef(p.oid), 'acl', p.proacl
    ) order by p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and (p.proname like 'ec_%' or p.proname in ('current_org','current_rol','es_superadmin'))
  ),
  'policies', (
    select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname)
    from pg_policies p
    where (p.schemaname='public' and p.tablename like 'ec_%')
      or (p.schemaname='storage' and p.tablename in ('objects','buckets'))
  ),
  'auth_triggers', (
    select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname)
    from pg_trigger t where t.tgrelid='auth.users'::regclass and not t.tgisinternal
  ),
  'sequences', (
    select jsonb_agg(jsonb_build_object(
      'name', c.relname, 'acl', c.relacl,
      'start', s.seqstart::text, 'increment', s.seqincrement::text,
      'min', s.seqmin::text, 'max', s.seqmax::text,
      'cache', s.seqcache::text, 'cycle', s.seqcycle,
      'owned_by', a.attname, 'table', d.refobjid::regclass::text
    ) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_sequence s on s.seqrelid=c.oid
    left join pg_depend d on d.objid=c.oid and d.deptype='a'
    left join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
    where n.nspname='public' and c.relname like 'ec_%'
  ),
  'schema_acl', (select nspacl from pg_namespace where nspname='public'),
  'default_acl_global', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'role',pg_get_userbyid(d.defaclrole),'schema',null,
      'type',d.defaclobjtype,'acl',d.defaclacl
    ) order by pg_get_userbyid(d.defaclrole),d.defaclobjtype),'[]'::jsonb)
    from pg_default_acl d where d.defaclnamespace=0
      and pg_get_userbyid(d.defaclrole) in ('postgres','supabase_admin')
  ),
  'default_acl', (
    select jsonb_agg(jsonb_build_object(
      'role',pg_get_userbyid(d.defaclrole),'schema',n.nspname,
      'type',d.defaclobjtype,'acl',d.defaclacl
    ) order by pg_get_userbyid(d.defaclrole), d.defaclobjtype)
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
    where n.nspname='public'
  ),
  'extensions', (
    select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname) order by e.extname)
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  ),
  'bucket', (
    select jsonb_build_object('id',b.id,'name',b.name,'public',b.public,
      'file_size_limit',b.file_size_limit,'allowed_mime_types',b.allowed_mime_types)
    from storage.buckets b where b.id='ec-docs'
  )
) as schema_metadata;
