-- Registra un fondo por rendir que Finanzas ya entregó fuera de la app.
-- Antes se cargaba a mano con SQL, sin aprobador real ni auditoría.
-- Solo admin; el fondo queda Aprobado a nombre de quien lo registra.

create or replace function public.registrar_fondo_entregado(
  p_empleado_id uuid,
  p_empresa text,
  p_centro_costo text,
  p_monto numeric,
  p_motivo text
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_empleado public.profiles;
  v_admin public.profiles;
  v_id uuid;
  v_folio bigint;
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador puede registrar un fondo entregado.';
  end if;
  if p_empleado_id = auth.uid() then
    raise exception 'No puedes registrarte un fondo a ti mismo.';
  end if;

  select * into v_empleado from public.profiles where id = p_empleado_id and activo;
  if not found then
    raise exception 'El empleado no existe o está desactivado.';
  end if;
  if p_monto is null or p_monto <= 0 or p_monto <> trunc(p_monto) then
    raise exception 'El monto debe ser un entero positivo en pesos.';
  end if;
  if coalesce(trim(p_empresa), '') = '' then
    raise exception 'Indica la empresa del fondo.';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'Indica el motivo del fondo.';
  end if;

  if exists (
    select 1 from public.solicitudes_fondos
    where empleado_id = p_empleado_id and empresa = p_empresa
      and centro_costo is not distinct from p_centro_costo
      and monto_solicitado = p_monto
      and created_at > now() - interval '24 hours'
  ) then
    raise exception 'Ya hay un fondo igual registrado para este empleado en las últimas 24 horas.';
  end if;

  select * into v_admin from public.profiles where id = auth.uid();

  insert into public.solicitudes_fondos
    (empleado_id, empleado_nombre, rut_empleado, empresa, centro_costo,
     monto_solicitado, motivo, estado, aprobador_id, aprobador_nombre, fecha_aprobacion)
  values
    (v_empleado.id, v_empleado.nombre, v_empleado.rut, trim(p_empresa), p_centro_costo,
     p_monto, trim(p_motivo), 'Aprobado', auth.uid(), v_admin.nombre, now())
  returning id, folio into v_id, v_folio;

  insert into public.system_events (tipo, usuario_id, solicitud_id, detalle, metadata)
  values ('fondo_registrado_manual', auth.uid(), v_id,
          'Fondo S-' || v_folio || ' registrado por ' || v_admin.nombre || ' para ' || v_empleado.nombre,
          jsonb_build_object('empleado_id', p_empleado_id, 'empresa', trim(p_empresa),
                             'centro_costo', p_centro_costo, 'monto', p_monto));

  return v_folio;
end;
$$;

revoke execute on function public.registrar_fondo_entregado(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.registrar_fondo_entregado(uuid, text, text, numeric, text) to authenticated;
