-- Las claves de configuración son lógicas y se repiten entre centros.
-- La RPC ya delimita sus lecturas, actualizaciones y bajas por org_id e id.
do $$
declare
  pk_name name;
  pk_columns name[];
begin
  perform set_config('lock_timeout', '5s', true);
  lock table public.ec_settings in access exclusive mode;

  select c.conname, array(
    select a.attname from unnest(c.conkey) with ordinality as k(attnum, pos)
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
    order by k.pos
  ) into pk_name, pk_columns
  from pg_constraint c
  where c.conrelid='public.ec_settings'::regclass and c.contype='p';

  if pk_columns = array['org_id','id']::name[] then return; end if;
  if pk_columns is distinct from array['id']::name[] then
    raise exception 'Clave primaria inesperada en public.ec_settings';
  end if;

  execute format('alter table public.ec_settings drop constraint %I, add constraint %I primary key (org_id, id)', pk_name, pk_name);
  perform pg_notify('pgrst', 'reload schema');
end $$;
