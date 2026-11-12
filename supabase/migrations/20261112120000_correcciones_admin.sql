-- Correcciones de administrador dentro de la app.
-- Hasta ahora se hacían a mano en la base (N° 68, 69-74, 77, 78 en
-- noviembre de 2026), desactivando protecciones y dejando el registro a mano.
-- Cada función valida, aplica, deja historial y un evento en una sola
-- transacción: si algo falla, no queda nada a medias.
--
-- Las protecciones de rendiciones e ítems siguen igual para todo el resto.
-- Solo dentro de estas funciones se enciende la señal rinde.correccion_admin
-- (local a la transacción) y únicamente vale para un administrador activo.

create or replace function public.correccion_admin_activa()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(current_setting('rinde.correccion_admin', true), '') = '1'
    and auth.uid() is not null and public.is_activo() and public.is_admin();
$$;
revoke execute on function public.correccion_admin_activa() from public, anon;
grant execute on function public.correccion_admin_activa() to authenticated, service_role;

-- 1. Las protecciones dejan pasar a una corrección de administrador ---------
do $$
declare d text;
begin
  d := pg_get_functiondef('public.validar_integridad_cabecera()'::regprocedure);
  if position('correccion_admin_activa' in d) = 0 then
    d := replace(d,
      $a$if tg_op = 'UPDATE' and (new.empleado_id is distinct from old.empleado_id or new.id is distinct from old.id) then$a$,
      $b$if tg_op = 'UPDATE' and (new.id is distinct from old.id or (new.empleado_id is distinct from old.empleado_id and not public.correccion_admin_activa())) then$b$);
    if position('correccion_admin_activa' in d) = 0 then raise exception 'validar_integridad_cabecera cambió; revisar la migración.'; end if;
    execute d;
  end if;

  d := pg_get_functiondef('public.proteger_aprobacion_rendicion()'::regprocedure);
  if position('correccion_admin_activa' in d) = 0 then
    d := replace(d,
      E'  -- tg_op = ''UPDATE'' de acá para abajo.\r\n',
      E'  -- tg_op = ''UPDATE'' de acá para abajo.\r\n  -- Una corrección de administrador (anular una aprobación) ya validó todo.\r\n  if public.correccion_admin_activa() then\r\n    return new;\r\n  end if;\r\n');
    if position('correccion_admin_activa' in d) = 0 then raise exception 'proteger_aprobacion_rendicion cambió; revisar la migración.'; end if;
    execute d;
  end if;

  d := pg_get_functiondef('public.validar_integridad_item()'::regprocedure);
  if position('correccion_admin_activa' in d) = 0 then
    d := replace(d,
      $a$begin
  if tg_op = 'UPDATE' and (new.rendicion_id is distinct from old.rendicion_id or new.id is distinct from old.id) then$a$,
      $b$begin
  -- Unir rendiciones o anular una aprobación: lo valida la función de corrección.
  if tg_op = 'UPDATE' and new.id is not distinct from old.id and public.correccion_admin_activa() then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.rendicion_id is distinct from old.rendicion_id or new.id is distinct from old.id) then$b$);
    if position('correccion_admin_activa' in d) = 0 then raise exception 'validar_integridad_item cambió; revisar la migración.'; end if;
    execute d;
  end if;
end $$;

-- Validaciones comunes --------------------------------------------------------
create or replace function public.exigir_correccion_admin(p_motivo text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text := nullif(regexp_replace(trim(coalesce(p_motivo, '')), '\s+', ' ', 'g'), '');
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador activo puede hacer correcciones.';
  end if;
  if v is null or length(v) < 3 or length(v) > 500 then
    raise exception 'Explica el motivo de la corrección (entre 3 y 500 caracteres).';
  end if;
  return v;
end;
$$;
revoke execute on function public.exigir_correccion_admin(text) from public, anon, authenticated;

-- 2. Cambiar la empresa de una rendición pendiente ---------------------------
create or replace function public.admin_cambiar_empresa_rendicion(p_rendicion uuid, p_empresa text, p_motivo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; v_motivo text; v_empresa text := nullif(trim(coalesce(p_empresa, '')), '');
  v_admin text; n integer;
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  if v_empresa is null or length(v_empresa) > 100 then raise exception 'Indica la empresa nueva.'; end if;
  select * into r from public.rendiciones where id = p_rendicion for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if r.estado <> 'Pendiente' then raise exception 'Solo se puede cambiar la empresa de una rendición pendiente (está %).', r.estado; end if;
  if r.kame_exportado_en is not null then raise exception 'Esta rendición ya se descargó para Kame; no se cambia la empresa.'; end if;
  if r.empresa = v_empresa then raise exception 'La rendición ya es de %.', v_empresa; end if;
  -- El fondo es de una empresa: cambiarla rompería el fondo y borraría el reparto.
  if r.solicitud_fondo_id is not null or exists (select 1 from public.rendicion_fondos where rendicion_id = r.id) then
    raise exception 'Esta rendición está asociada a un fondo de %; el fondo no se puede cambiar de empresa desde aquí.', r.empresa;
  end if;
  update public.rendiciones set empresa = v_empresa where id = r.id;
  update public.rendicion_items set empresa = v_empresa where rendicion_id = r.id;
  get diagnostics n = row_count;
  select nombre into v_admin from public.profiles where id = auth.uid();
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), r.id,
    'Rendición N° ' || r.folio || ' cambiada de ' || r.empresa || ' a ' || v_empresa || ' por ' || v_admin || ': ' || v_motivo,
    jsonb_build_object('accion', 'cambiar_empresa', 'antes', r.empresa, 'despues', v_empresa, 'gastos', n, 'motivo', v_motivo));
  return jsonb_build_object('id', r.id, 'folio', r.folio, 'empresa', v_empresa, 'gastos', n);
end;
$$;

-- 3. Traspasar una rendición pendiente a otro empleado -----------------------
create or replace function public.admin_cambiar_empleado_rendicion(p_rendicion uuid, p_empleado uuid, p_motivo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; v_motivo text; p public.profiles; v_admin text;
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  select * into r from public.rendiciones where id = p_rendicion for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if r.estado <> 'Pendiente' then raise exception 'Solo se puede traspasar una rendición pendiente (está %).', r.estado; end if;
  if r.kame_exportado_en is not null then raise exception 'Esta rendición ya se descargó para Kame; no se traspasa.'; end if;
  if r.solicitud_fondo_id is not null or exists (select 1 from public.rendicion_fondos where rendicion_id = r.id) then
    raise exception 'Esta rendición se rinde contra un fondo de %; el fondo es de esa persona y no se traspasa.', r.empleado_nombre;
  end if;
  select * into p from public.profiles where id = p_empleado and activo;
  if not found then raise exception 'El empleado no existe o está desactivado.'; end if;
  if p.id = r.empleado_id then raise exception 'La rendición ya es de %.', p.nombre; end if;
  if p.id = auth.uid() then raise exception 'No puedes traspasarte una rendición a ti mismo: no podrías aprobarla.'; end if;
  perform pg_catalog.set_config('rinde.correccion_admin', '1', true);
  update public.rendiciones set empleado_id = p.id, empleado_nombre = p.nombre, rut_empleado = p.rut where id = r.id;
  perform pg_catalog.set_config('rinde.correccion_admin', '', true);
  select nombre into v_admin from public.profiles where id = auth.uid();
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), r.id,
    'Rendición N° ' || r.folio || ' traspasada de ' || r.empleado_nombre || ' a ' || p.nombre || ' por ' || v_admin || ': ' || v_motivo,
    jsonb_build_object('accion', 'cambiar_empleado', 'campo', 'empleado',
      'antes', jsonb_build_object('id', r.empleado_id, 'nombre', r.empleado_nombre, 'rut', r.rut_empleado),
      'despues', jsonb_build_object('id', p.id, 'nombre', p.nombre, 'rut', p.rut), 'motivo', v_motivo));
  return jsonb_build_object('id', r.id, 'folio', r.folio, 'empleado', p.nombre);
end;
$$;

-- 4. Unir rendiciones pendientes en una --------------------------------------
create or replace function public.admin_unir_rendiciones(p_destino uuid, p_origenes uuid[], p_motivo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.rendiciones; v_motivo text; v_admin text; v_base integer; n_items integer; v_folios text; v_total numeric;
  v_origenes uuid[];
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  v_origenes := array(select distinct x from unnest(coalesce(p_origenes, '{}')) x where x is not null and x <> p_destino);
  if cardinality(v_origenes) < 1 or cardinality(v_origenes) > 20 then raise exception 'Elige entre 1 y 20 rendiciones para unir.'; end if;
  -- Bloquea todas en orden fijo para que dos uniones a la vez no se crucen.
  perform 1 from public.rendiciones where id = any(v_origenes || p_destino) order by id for update;
  select * into d from public.rendiciones where id = p_destino;
  if not found then raise exception 'La rendición de destino no existe.'; end if;
  if (select count(*) from public.rendiciones where id = any(v_origenes)) <> cardinality(v_origenes) then
    raise exception 'Alguna de las rendiciones elegidas ya no existe.';
  end if;
  if exists (select 1 from public.rendiciones r where r.id = any(v_origenes || p_destino) and (
      r.estado <> 'Pendiente' or r.kame_exportado_en is not null or r.empleado_id <> d.empleado_id
      or r.empresa is distinct from d.empresa or r.tipo_rendicion is distinct from d.tipo_rendicion
      or r.solicitud_fondo_id is distinct from d.solicitud_fondo_id)) then
    raise exception 'Solo se unen rendiciones pendientes, sin exportar, de la misma persona, empresa, tipo y fondo.';
  end if;
  if exists (select 1 from public.rendicion_fondos where rendicion_id = any(v_origenes || p_destino)) then
    raise exception 'Una de las rendiciones se reparte entre varios fondos; esas no se unen desde aquí.';
  end if;
  if exists (select 1 from public.rendicion_items where rendicion_id = any(v_origenes || p_destino) and estado <> 'Pendiente') then
    raise exception 'Alguna rendición ya tiene gastos aprobados o rechazados; termina o deshaz esa revisión antes de unir.';
  end if;

  select coalesce(max(orden), -1) + 1 into v_base from public.rendicion_items where rendicion_id = d.id;
  select string_agg('N° ' || folio, ', ' order by folio) into v_folios from public.rendiciones where id = any(v_origenes);
  perform pg_catalog.set_config('rinde.correccion_admin', '1', true);
  -- Los gastos llegan al final, en el orden en que se enviaron (folio y posición).
  with movidos as (
    select i.id, v_base + row_number() over (order by r.folio, i.orden nulls last, i.id) - 1 as nuevo_orden
    from public.rendicion_items i join public.rendiciones r on r.id = i.rendicion_id
    where i.rendicion_id = any(v_origenes))
  update public.rendicion_items i set rendicion_id = d.id, orden = m.nuevo_orden from movidos m where i.id = m.id;
  get diagnostics n_items = row_count;
  update public.rendicion_items_historial set rendicion_id = d.id where rendicion_id = any(v_origenes);
  update public.system_events set rendicion_id = d.id where rendicion_id = any(v_origenes);
  select coalesce(sum(monto), 0) into v_total from public.rendicion_items where rendicion_id = d.id and estado <> 'Rechazado';
  update public.rendiciones set monto_total = v_total where id = d.id;
  delete from public.rendiciones where id = any(v_origenes);
  perform pg_catalog.set_config('rinde.correccion_admin', '', true);

  select nombre into v_admin from public.profiles where id = auth.uid();
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), d.id,
    'Rendiciones ' || v_folios || ' de ' || d.empleado_nombre || ' unidas en la N° ' || d.folio || ' (' || n_items || ' gastos) por ' || v_admin || ': ' || v_motivo,
    jsonb_build_object('accion', 'unir_rendiciones', 'destino', d.folio, 'origenes', v_folios, 'gastos_movidos', n_items, 'total', v_total, 'motivo', v_motivo));
  return jsonb_build_object('id', d.id, 'folio', d.folio, 'gastos_movidos', n_items, 'total', v_total, 'unidas', v_folios);
end;
$$;

-- 5. Anular la aprobación de una rendición -----------------------------------
-- Pasa a Rechazada con el motivo (para la persona y para Kame). Si su CSV ya
-- se descargó, la app genera antes el reverso para importarlo en Kame.
create or replace function public.admin_anular_aprobacion(p_rendicion uuid, p_motivo text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; v_motivo text; v_admin text; v_cerrado bigint; n integer;
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  select * into r from public.rendiciones where id = p_rendicion for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if r.estado <> 'Aprobado' then raise exception 'Solo se anula una rendición aprobada (está %).', r.estado; end if;
  if r.empleado_id = auth.uid() then raise exception 'No puedes anular la aprobación de tu propia rendición.'; end if;
  select s.folio into v_cerrado from public.solicitudes_fondos s
   where s.estado = 'Cerrado' and (s.id = r.solicitud_fondo_id or s.id in (select solicitud_fondo_id from public.rendicion_fondos where rendicion_id = r.id))
   limit 1;
  if v_cerrado is not null then
    raise exception 'El fondo S-% ya está liquidado. Anula primero la liquidación del fondo.', v_cerrado;
  end if;
  select nombre into v_admin from public.profiles where id = auth.uid();
  perform pg_catalog.set_config('rinde.correccion_admin', '1', true);
  update public.rendicion_items set estado = 'Rechazado', motivo_rechazo = v_motivo
   where rendicion_id = r.id and estado = 'Aprobado';
  get diagnostics n = row_count;
  update public.rendiciones set estado = 'Rechazado', motivo_rechazo = v_motivo, monto_total = 0,
    aprobador_id = auth.uid(), aprobador_nombre = v_admin, fecha_aprobacion = now()
   where id = r.id;
  perform pg_catalog.set_config('rinde.correccion_admin', '', true);
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), r.id,
    'Aprobación de la rendición N° ' || r.folio || ' (' || r.empleado_nombre || ', $' || r.monto_total || ') anulada por ' || v_admin || ': ' || v_motivo,
    jsonb_build_object('accion', 'anular_aprobacion', 'campo', 'estado', 'antes', 'Aprobado', 'despues', 'Rechazado',
      'aprobado_por', r.aprobador_nombre, 'monto', r.monto_total, 'gastos', n,
      'kame_exportado_en', r.kame_exportado_en, 'motivo', v_motivo));
  return jsonb_build_object('id', r.id, 'folio', r.folio, 'kame_exportado_en', r.kame_exportado_en, 'gastos', n);
end;
$$;

revoke execute on function public.admin_cambiar_empresa_rendicion(uuid, text, text) from public, anon;
revoke execute on function public.admin_cambiar_empleado_rendicion(uuid, uuid, text) from public, anon;
revoke execute on function public.admin_unir_rendiciones(uuid, uuid[], text) from public, anon;
revoke execute on function public.admin_anular_aprobacion(uuid, text) from public, anon;
grant execute on function public.admin_cambiar_empresa_rendicion(uuid, text, text) to authenticated;
grant execute on function public.admin_cambiar_empleado_rendicion(uuid, uuid, text) to authenticated;
grant execute on function public.admin_unir_rendiciones(uuid, uuid[], text) to authenticated;
grant execute on function public.admin_anular_aprobacion(uuid, text) to authenticated;
