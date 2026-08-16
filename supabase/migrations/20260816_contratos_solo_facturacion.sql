-- Contratos visibles y administrables únicamente desde Facturación.
-- Conserva las copias existentes: la protección se aplica por data.tipo = 'contrato'.

create or replace function ec_can_facturacion() returns boolean
language sql stable security definer set search_path = public
as $$
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
$$;
revoke all on function ec_can_facturacion() from public;
grant execute on function ec_can_facturacion() to authenticated;

create or replace function ec_can_document(p_data jsonb) returns boolean
language sql stable security definer set search_path = public
as $$
  select ec_can_study(ec_data_study(p_data))
    and (
      not (
        coalesce(p_data ->> 'tipo', '') = 'contrato'
        or coalesce(p_data ->> 'tipo', '') ~ '^gasto_(remis|medicamentos)_comprobante$'
      )
      or ec_can_facturacion()
    )
$$;
revoke all on function ec_can_document(jsonb) from public;
grant execute on function ec_can_document(jsonb) to authenticated;

create or replace function ec_can_record(p_data jsonb) returns boolean
language sql stable security definer set search_path = public
as $$
  select ec_can_study(ec_data_study(p_data))
    and (
      coalesce(p_data ->> 'recordType', '') not in ('gasto_remis','gasto_medicamentos')
      or ec_can_facturacion()
    )
$$;
revoke all on function ec_can_record(jsonb) from public;
grant execute on function ec_can_record(jsonb) to authenticated;

-- ec_docs deja de compartir los contratos con todo el equipo asignado al protocolo.
drop policy if exists org_ver on ec_docs;
drop policy if exists org_ins on ec_docs;
drop policy if exists org_upd on ec_docs;
drop policy if exists org_del on ec_docs;
drop policy if exists protocol_ver on ec_docs;
drop policy if exists protocol_ins on ec_docs;
drop policy if exists protocol_upd on ec_docs;
drop policy if exists protocol_del on ec_docs;
drop policy if exists contracts_ver on ec_docs;
drop policy if exists contracts_ins on ec_docs;
drop policy if exists contracts_upd on ec_docs;
drop policy if exists contracts_del on ec_docs;

create policy contracts_ver on ec_docs for select to authenticated
  using (org_id = current_org() and ec_can_document(data));

create policy contracts_ins on ec_docs for insert to authenticated
  with check (
    org_id = current_org()
    and current_rol() in ('admin','medico','coord')
    and ec_can_document(data)
  );

create policy contracts_upd on ec_docs for update to authenticated
  using (
    org_id = current_org()
    and current_rol() in ('admin','medico','coord')
    and ec_can_document(data)
  )
  with check (
    org_id = current_org()
    and current_rol() in ('admin','medico','coord')
    and ec_can_document(data)
  );

create policy contracts_del on ec_docs for delete to authenticated
  using (
    org_id = current_org()
    and ec_can_document(data)
    and (
      current_rol() in ('admin','medico')
      or (data ->> 'tipo' = 'contrato' and ec_can_facturacion())
    )
  );

-- Los gastos de remís y medicamentos también son información financiera.
drop policy if exists org_ver on ec_records;
drop policy if exists org_ins on ec_records;
drop policy if exists org_upd on ec_records;
drop policy if exists org_del on ec_records;
drop policy if exists protocol_ver on ec_records;
drop policy if exists protocol_ins on ec_records;
drop policy if exists protocol_upd on ec_records;
drop policy if exists protocol_del on ec_records;
drop policy if exists finance_records_ver on ec_records;
drop policy if exists finance_records_ins on ec_records;
drop policy if exists finance_records_upd on ec_records;
drop policy if exists finance_records_del on ec_records;

create policy finance_records_ver on ec_records for select to authenticated
  using (org_id = current_org() and ec_can_record(data));

create policy finance_records_ins on ec_records for insert to authenticated
  with check (
    org_id = current_org()
    and current_rol() in ('admin','medico','coord')
    and ec_can_record(data)
  );

create policy finance_records_upd on ec_records for update to authenticated
  using (
    org_id = current_org()
    and current_rol() in ('admin','medico','coord')
    and ec_can_record(data)
  )
  with check (
    org_id = current_org()
    and current_rol() in ('admin','medico','coord')
    and ec_can_record(data)
  );

create policy finance_records_del on ec_records for delete to authenticated
  using (
    org_id = current_org()
    and ec_can_record(data)
    and (
      current_rol() in ('admin','medico')
      or (data ->> 'recordType' in ('gasto_remis','gasto_medicamentos') and ec_can_facturacion())
    )
  );

-- Para rutas actuales (organización/protocolo/documento/archivo) se resuelve
-- el documento por el tercer segmento. Las rutas históricas usan el segundo.
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
revoke all on function ec_can_storage_object(text) from public;
grant execute on function ec_can_storage_object(text) to authenticated;

drop policy if exists ec_docs_org on storage.objects;
drop policy if exists ec_docs_protocol on storage.objects;
create policy ec_docs_protocol on storage.objects for all to authenticated
  using (bucket_id = 'ec-docs' and ec_can_storage_object(name))
  with check (bucket_id = 'ec-docs' and ec_can_storage_object(name));
