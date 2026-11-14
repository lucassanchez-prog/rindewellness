-- Herramientas de administrador para solicitudes de fondos (2026-11-14).
--
-- Caso real (13-11): Norma pidió un fondo por WhatsApp. La única forma de
-- cargarlo era "Registrar fondo ya entregado", que lo deja Aprobado. Para
-- dejarlo pendiente hubo que borrar S-20 y crear S-21 por SQL, porque una
-- solicitud aprobada no podía volver a Pendiente.
--
--   admin_crear_solicitud_fondos: un administrador carga una solicitud
--     PENDIENTE a nombre de un empleado; sigue la aprobación normal.
--   admin_devolver_solicitud_pendiente: un administrador devuelve a Pendiente
--     un fondo aprobado que todavía no tiene rendiciones ni liquidación.

-- 1. La protección de solicitudes deja pasar solo una corrección de administrador
do $$
declare d text;
begin
  d := pg_get_functiondef('public.proteger_aprobacion_solicitud()'::regprocedure);
  if position('correccion_admin_activa' in d) = 0 then
    d := replace(d,
      E'  if new.liquidacion_id is distinct from old.liquidacion_id and not v_liquidando then\n',
      E'  -- Devolver a pendiente (admin_devolver_solicitud_pendiente) ya validó todo.\n  if public.correccion_admin_activa() and new.liquidacion_id is not distinct from old.liquidacion_id then\n    return new;\n  end if;\n\n  if new.liquidacion_id is distinct from old.liquidacion_id and not v_liquidando then\n');
    if position('correccion_admin_activa' in d) = 0 then raise exception 'proteger_aprobacion_solicitud cambió; revisar la migración.'; end if;
    execute d;
  end if;
end $$;

-- 2. Solicitar fondos a nombre de un empleado ---------------------------------
create or replace function public.admin_crear_solicitud_fondos(
  p_empleado_id uuid,
  p_empresa text,
  p_centro_costo text,
  p_monto numeric,
  p_motivo text,
  p_fecha_necesaria date default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_empleado public.profiles;
  v_admin text;
  v_empresa text := nullif(trim(coalesce(p_empresa, '')), '');
  v_motivo text := nullif(regexp_replace(trim(coalesce(p_motivo, '')), '\s+', ' ', 'g'), '');
  v_id uuid;
  v_folio bigint;
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador puede solicitar fondos a nombre de otra persona.';
  end if;
  if p_empleado_id = auth.uid() then
    raise exception 'Para pedir un fondo para ti usa "Solicitar fondos".';
  end if;
  select * into v_empleado from public.profiles where id = p_empleado_id and activo;
  if not found then raise exception 'El empleado no existe o está desactivado.'; end if;
  if p_monto is null or p_monto <= 0 or p_monto <> trunc(p_monto) then
    raise exception 'El monto debe ser un entero positivo en pesos.';
  end if;
  if v_empresa is null then raise exception 'Indica la empresa del fondo.'; end if;
  if v_motivo is null or length(v_motivo) > 500 then raise exception 'Indica el motivo del fondo.'; end if;
  if p_fecha_necesaria is not null and p_fecha_necesaria < current_date - 1 then
    raise exception 'La fecha en que se necesita no puede ser pasada.';
  end if;
  if exists (
    select 1 from public.solicitudes_fondos
    where empleado_id = p_empleado_id and empresa = v_empresa
      and centro_costo is not distinct from p_centro_costo
      and monto_solicitado = p_monto
      and estado in ('Pendiente', 'Aprobado')
      and created_at > now() - interval '24 hours'
  ) then
    raise exception 'Ya hay una solicitud igual para este empleado en las últimas 24 horas.';
  end if;

  select nombre into v_admin from public.profiles where id = auth.uid();
  insert into public.solicitudes_fondos
    (empleado_id, empleado_nombre, rut_empleado, empresa, centro_costo, monto_solicitado, motivo, fecha_necesaria, estado)
  values
    (v_empleado.id, v_empleado.nombre, v_empleado.rut, v_empresa, p_centro_costo, p_monto, v_motivo, p_fecha_necesaria, 'Pendiente')
  returning id, folio into v_id, v_folio;

  insert into public.system_events (tipo, usuario_id, solicitud_id, detalle, metadata)
  values ('solicitud_creada_por_admin', auth.uid(), v_id,
          'Solicitud S-' || v_folio || ' cargada por ' || v_admin || ' a nombre de ' || v_empleado.nombre,
          jsonb_build_object('empleado_id', p_empleado_id, 'empresa', v_empresa,
                             'centro_costo', p_centro_costo, 'monto', p_monto));

  return jsonb_build_object('id', v_id, 'folio', v_folio);
end;
$$;
revoke execute on function public.admin_crear_solicitud_fondos(uuid, text, text, numeric, text, date) from public, anon;
grant execute on function public.admin_crear_solicitud_fondos(uuid, text, text, numeric, text, date) to authenticated;

-- 3. Devolver a pendiente un fondo aprobado sin movimientos ----------------------
create or replace function public.admin_devolver_solicitud_pendiente(p_solicitud uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.solicitudes_fondos; v_motivo text; v_admin text;
begin
  v_motivo := public.exigir_correccion_admin(p_motivo);
  select * into s from public.solicitudes_fondos where id = p_solicitud for update;
  if not found then raise exception 'La solicitud no existe.'; end if;
  if s.estado <> 'Aprobado' then
    raise exception 'Solo se devuelve a pendiente un fondo aprobado (está %).', s.estado;
  end if;
  if s.empleado_id = auth.uid() then
    raise exception 'No puedes devolver a pendiente tu propio fondo.';
  end if;
  if s.liquidacion_id is not null
     or exists (select 1 from public.liquidacion_fondos_detalle where solicitud_fondo_id = s.id) then
    raise exception 'El fondo S-% ya tiene una liquidación; anúlala primero.', s.folio;
  end if;
  if exists (select 1 from public.rendiciones where solicitud_fondo_id = s.id)
     or exists (select 1 from public.rendicion_fondos where solicitud_fondo_id = s.id) then
    raise exception 'El fondo S-% ya tiene rendiciones; no se puede devolver a pendiente.', s.folio;
  end if;

  select nombre into v_admin from public.profiles where id = auth.uid();
  perform pg_catalog.set_config('rinde.correccion_admin', '1', true);
  update public.solicitudes_fondos
     set estado = 'Pendiente', aprobador_id = null, aprobador_nombre = null, fecha_aprobacion = null
   where id = s.id;
  perform pg_catalog.set_config('rinde.correccion_admin', '', true);
  delete from public.avisos_fondos where solicitud_id = s.id;

  insert into public.system_events (tipo, usuario_id, solicitud_id, detalle, metadata)
  values ('correccion_datos', auth.uid(), s.id,
    'Fondo S-' || s.folio || ' (' || s.empleado_nombre || ', $' || s.monto_solicitado || ') devuelto a pendiente por ' || v_admin || ': ' || v_motivo,
    jsonb_build_object('accion', 'devolver_solicitud_pendiente', 'campo', 'estado', 'antes', 'Aprobado', 'despues', 'Pendiente',
      'aprobado_por', s.aprobador_nombre, 'fecha_aprobacion', s.fecha_aprobacion, 'monto', s.monto_solicitado, 'motivo', v_motivo));
  return jsonb_build_object('id', s.id, 'folio', s.folio);
end;
$$;
revoke execute on function public.admin_devolver_solicitud_pendiente(uuid, text) from public, anon;
grant execute on function public.admin_devolver_solicitud_pendiente(uuid, text) to authenticated;
