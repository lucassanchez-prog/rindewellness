-- Cambiar a Comprobante/Boleta un gasto ya aprobado (2026-11-17).
--
-- Caso real: en la N° 87 (Andrés Villablanca, Neo Gym Chile SpA) dos tickets de
-- estacionamiento de Saba ($9.950 y $1.450) quedaron como "Factura Electrónica"
-- con la cuenta 2.01.07.01 Proveedores. La rendición ya estaba aprobada y
-- descargada para Kame, así que no se podía editar. La app arma un ajuste para
-- Kame (sale de Proveedores, entra al gasto) y esta función corrige el gasto.

-- 1. La protección de ítems deja pasar solo una corrección de administrador
do $$
declare d text;
begin
  d := pg_get_functiondef('public.proteger_aprobacion_item()'::regprocedure);
  if position('correccion_admin_activa' in d) = 0 then
    d := replace(d,
      E'  select r.estado, r.empleado_id into estado_rendicion, empleado_rendicion\r\n  from public.rendiciones r where r.id = old.rendicion_id;\r\n',
      E'  select r.estado, r.empleado_id into estado_rendicion, empleado_rendicion\r\n  from public.rendiciones r where r.id = old.rendicion_id;\r\n\r\n  -- Corrección de administrador (p. ej. cambiar a Comprobante/Boleta): ya validó todo.\r\n  if public.correccion_admin_activa() then\r\n    return new;\r\n  end if;\r\n');
    if position('correccion_admin_activa' in d) = 0 then raise exception 'proteger_aprobacion_item cambió; revisar la migración.'; end if;
    execute d;
  end if;
end $$;

-- 2. Cambiar gastos "Documento electrónico" a "Comprobante/Boleta" -------------
-- p_cambios: [{"item": uuid, "cuenta": "4.01.03.xx"}, ...]
create or replace function public.admin_cambiar_a_comprobante(p_rendicion uuid, p_cambios jsonb, p_motivo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; v_motivo text; v_admin text; c jsonb; it public.rendicion_items;
  v_cuenta text; v_detalle jsonb := '[]'::jsonb; v_ids uuid[] := '{}';
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  select * into r from public.rendiciones where id = p_rendicion for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if r.estado <> 'Aprobado' then
    raise exception 'Esta corrección es para rendiciones aprobadas (está %). Si está pendiente, edita el gasto.', r.estado;
  end if;
  if r.empleado_id = auth.uid() then raise exception 'No puedes corregir tu propia rendición.'; end if;
  if jsonb_typeof(p_cambios) is distinct from 'array' or jsonb_array_length(p_cambios) = 0 or jsonb_array_length(p_cambios) > 50 then
    raise exception 'Elige al menos un gasto.';
  end if;

  for c in select * from jsonb_array_elements(p_cambios) loop
    v_cuenta := trim(coalesce(c->>'cuenta', ''));
    if v_cuenta !~ '^4\.01\.03\.[0-9]{2}$' then raise exception 'La cuenta % no es una cuenta de gasto.', v_cuenta; end if;
    select * into it from public.rendicion_items where id = (c->>'item')::uuid and rendicion_id = r.id for update;
    if not found then raise exception 'Uno de los gastos no es de esta rendición.'; end if;
    if (c->>'item')::uuid = any(v_ids) then raise exception 'Un gasto viene repetido.'; end if;
    if it.estado <> 'Aprobado' then raise exception 'Solo se corrigen gastos aprobados.'; end if;
    if it.tipo_item <> 'ConDocumento' then raise exception 'Ese gasto ya es Comprobante/Boleta.'; end if;
    v_ids := v_ids || it.id;
    v_detalle := v_detalle || jsonb_build_object('item', it.id, 'monto', it.monto, 'proveedor', it.nombre_proveedor,
      'documento', it.tipo_documento || ' #' || coalesce(it.nro_documento, ''),
      'cuenta_antes', it.cuenta_contable, 'cuenta_despues', v_cuenta);

    perform pg_catalog.set_config('rinde.correccion_admin', '1', true);
    -- RUT, folio y fecha se conservan: siguen identificando el comprobante original.
    update public.rendicion_items set tipo_item = 'SinDocumento', cuenta_contable = v_cuenta where id = it.id;
    perform pg_catalog.set_config('rinde.correccion_admin', '', true);
  end loop;

  select nombre into v_admin from public.profiles where id = auth.uid();
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), r.id,
    jsonb_array_length(v_detalle) || ' gasto(s) de la rendición N° ' || r.folio || ' cambiados a Comprobante/Boleta por ' || v_admin || ': ' || v_motivo,
    jsonb_build_object('accion', 'cambiar_a_comprobante', 'campo', 'tipo_item', 'antes', 'ConDocumento', 'despues', 'SinDocumento',
      'gastos', v_detalle, 'kame_exportado_en', r.kame_exportado_en, 'motivo', v_motivo));
  return jsonb_build_object('id', r.id, 'folio', r.folio, 'gastos', jsonb_array_length(v_detalle), 'kame_exportado_en', r.kame_exportado_en);
end;
$$;
revoke execute on function public.admin_cambiar_a_comprobante(uuid, jsonb, text) from public, anon;
grant execute on function public.admin_cambiar_a_comprobante(uuid, jsonb, text) to authenticated;
