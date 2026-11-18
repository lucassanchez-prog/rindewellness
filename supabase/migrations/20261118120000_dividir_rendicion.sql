-- Dividir una rendición entre dos empresas (2026-11-18).
--
-- Caso real: N° 99 (Matias Rabat), un voucher de notaría por $16.000 por los
-- finiquitos de dos personas, una de Dmoov SpA y otra de Dmoov Corp SpA. Cada
-- rendición se importa en Kame a una sola empresa, así que el gasto se reparte
-- en dos rendiciones pendientes: la original queda con una parte y se crea otra,
-- a nombre del mismo empleado y con el mismo comprobante, con el resto.
--
-- Solo para reembolsos pendientes, sin descargar para Kame, con todos los gastos
-- pendientes, en pesos y sin documentos electrónicos (una factura está emitida a
-- una sola empresa y no se reparte).

create or replace function public.admin_dividir_rendicion(
  p_rendicion uuid,
  p_empresa_actual text, p_cc_actual text,
  p_empresa_nueva text, p_cc_nueva text,
  p_porcentaje_nueva numeric,
  p_motivo text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; v_motivo text; v_admin text; it public.rendicion_items;
  v_ea text := nullif(trim(coalesce(p_empresa_actual, '')), ''); v_ca text := nullif(trim(coalesce(p_cc_actual, '')), '');
  v_en text := nullif(trim(coalesce(p_empresa_nueva, '')), ''); v_cn text := nullif(trim(coalesce(p_cc_nueva, '')), '');
  v_parte numeric; v_nuevo_id uuid; v_nuevo_folio bigint; v_total_actual numeric := 0; v_total_nueva numeric := 0; n integer := 0;
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  if v_ea is null or v_ca is null or v_en is null or v_cn is null then raise exception 'Indica empresa y centro de costo de las dos partes.'; end if;
  if v_ea = v_en and v_ca = v_cn then raise exception 'Las dos partes quedarían en la misma empresa y centro de costo.'; end if;
  if p_porcentaje_nueva is null or p_porcentaje_nueva <= 0 or p_porcentaje_nueva >= 100 then
    raise exception 'El porcentaje de la nueva rendición debe estar entre 1 y 99.';
  end if;

  select * into r from public.rendiciones where id = p_rendicion for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if r.estado <> 'Pendiente' then raise exception 'Solo se divide una rendición pendiente (está %).', r.estado; end if;
  if r.empleado_id = auth.uid() then raise exception 'No puedes dividir tu propia rendición.'; end if;
  if r.kame_exportado_en is not null then raise exception 'Esta rendición ya se descargó para Kame; no se divide.'; end if;
  if r.tipo_rendicion <> 'Reembolso' or r.solicitud_fondo_id is not null or exists (select 1 from public.rendicion_fondos where rendicion_id = r.id) then
    raise exception 'Solo se dividen reembolsos; un fondo es de una sola empresa.';
  end if;
  if not exists (select 1 from public.rendicion_items where rendicion_id = r.id) then raise exception 'La rendición no tiene gastos.'; end if;
  if exists (select 1 from public.rendicion_items where rendicion_id = r.id and estado <> 'Pendiente') then
    raise exception 'Hay gastos ya revisados; divide antes de aprobar o rechazar.';
  end if;
  if exists (select 1 from public.rendicion_items where rendicion_id = r.id and tipo_item = 'ConDocumento') then
    raise exception 'Una factura o boleta de honorarios está emitida a una sola empresa; no se divide.';
  end if;
  if exists (select 1 from public.rendicion_items where rendicion_id = r.id and coalesce(moneda, 'CLP') <> 'CLP') then
    raise exception 'Hay gastos en dólares; no se dividen.';
  end if;
  if exists (select 1 from public.rendicion_items where rendicion_id = r.id
             and (round(monto * p_porcentaje_nueva / 100) <= 0 or monto - round(monto * p_porcentaje_nueva / 100) <= 0)) then
    raise exception 'Algún gasto es demasiado chico para dividirlo con ese porcentaje.';
  end if;

  insert into public.rendiciones (empleado_id, empleado_nombre, rut_empleado, tipo_rendicion, estado, comentario, empresa, fecha_rendicion)
  values (r.empleado_id, r.empleado_nombre, r.rut_empleado, 'Reembolso', 'Pendiente',
          left(trim(coalesce(r.comentario, '') || ' (parte de la N° ' || r.folio || ')'), 500), v_en, r.fecha_rendicion)
  returning id, folio into v_nuevo_id, v_nuevo_folio;

  for it in select * from public.rendicion_items where rendicion_id = r.id order by orden, id for update loop
    v_parte := round(it.monto * p_porcentaje_nueva / 100);
    insert into public.rendicion_items (rendicion_id, tipo_item, rut_proveedor, tipo_documento, nro_documento, fecha_vencimiento,
      cuenta_contable, categoria, empresa, monto, descripcion, adjunto_url, nombre_proveedor, centro_costo, estado, orden, moneda)
    values (v_nuevo_id, it.tipo_item, it.rut_proveedor, it.tipo_documento, it.nro_documento, it.fecha_vencimiento,
      it.cuenta_contable, it.categoria, v_en, v_parte, it.descripcion, it.adjunto_url, it.nombre_proveedor, v_cn, 'Pendiente', it.orden, 'CLP');
    update public.rendicion_items set monto = it.monto - v_parte, empresa = v_ea, centro_costo = v_ca where id = it.id;
    v_total_nueva := v_total_nueva + v_parte;
    v_total_actual := v_total_actual + it.monto - v_parte;
    n := n + 1;
  end loop;

  update public.rendiciones set empresa = v_ea,
    comentario = left(trim(coalesce(r.comentario, '') || ' (parte de la N° ' || r.folio || ', otra parte en la N° ' || v_nuevo_folio || ')'), 500)
   where id = r.id;

  select nombre into v_admin from public.profiles where id = auth.uid();
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), r.id,
    'Rendición N° ' || r.folio || ' (' || r.empleado_nombre || ', $' || r.monto_total || ') dividida por ' || v_admin || ': $' || v_total_actual
      || ' en ' || v_ea || ' (' || v_ca || ') y $' || v_total_nueva || ' en ' || v_en || ' (' || v_cn || ', N° ' || v_nuevo_folio || '): ' || v_motivo,
    jsonb_build_object('accion', 'dividir_rendicion', 'antes', jsonb_build_object('empresa', r.empresa, 'monto', r.monto_total),
      'despues', jsonb_build_array(
        jsonb_build_object('folio', r.folio, 'empresa', v_ea, 'centro_costo', v_ca, 'monto', v_total_actual),
        jsonb_build_object('folio', v_nuevo_folio, 'id', v_nuevo_id, 'empresa', v_en, 'centro_costo', v_cn, 'monto', v_total_nueva)),
      'porcentaje_nueva', p_porcentaje_nueva, 'gastos', n, 'motivo', v_motivo));
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), v_nuevo_id,
    'Rendición N° ' || v_nuevo_folio || ' creada por ' || v_admin || ' al dividir la N° ' || r.folio || ': ' || v_motivo,
    jsonb_build_object('accion', 'dividir_rendicion', 'origen', r.folio, 'motivo', v_motivo));

  return jsonb_build_object('folio', r.folio, 'monto', v_total_actual, 'nueva_id', v_nuevo_id, 'nueva_folio', v_nuevo_folio, 'nueva_monto', v_total_nueva);
end;
$$;
revoke execute on function public.admin_dividir_rendicion(uuid, text, text, text, text, numeric, text) from public, anon;
grant execute on function public.admin_dividir_rendicion(uuid, text, text, text, text, numeric, text) to authenticated;
