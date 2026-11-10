-- La liquidación solo compensa excesos con restantes (TRASPASO en Kame).
-- No mueve dinero: lo que queda a favor de la persona sigue en Rendiciones
-- por Pagar (2.01.07.29) con el folio de su rendición y Finanzas lo paga como
-- cualquier reembolso; lo que la persona debe sigue en Fondo por Rendir
-- (1.01.11.05) con el folio del fondo hasta que deposite. Por eso ya no se
-- pide cuenta bancaria, banco ni referencia. Los parámetros se mantienen
-- (se ignoran) para no romper una pestaña abierta con la versión anterior.

alter table public.liquidaciones_fondos drop constraint if exists liquidacion_banco;

-- p_neto_esperado es el neto que vio quien liquida: si los saldos cambiaron
-- entre la vista previa y la confirmación, no se cierra nada.
create or replace function public.liquidar_fondos(
  p_fondos uuid[], p_fecha date, p_neto_esperado numeric,
  p_cuenta_banco text default null, p_nombre_banco text default null,
  p_referencia text default null, p_observacion text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c jsonb; v_neto numeric; v_resultado text; v_id uuid; v_folio bigint; v_admin public.profiles;
  v_obs text := nullif(trim(coalesce(p_observacion, '')), '');
  v_hoy date := (now() at time zone 'America/Santiago')::date;
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador puede liquidar fondos.';
  end if;
  -- Bloquea los fondos: una rendición nueva contra ellos espera y luego los ve cerrados.
  perform 1 from public.solicitudes_fondos where id = any(p_fondos) order by id for update;
  c := public.calcular_liquidacion_fondos(p_fondos);
  if (c->>'empleado_id')::uuid = auth.uid() then raise exception 'No puedes liquidar tus propios fondos.'; end if;
  v_neto := (c->>'neto')::numeric;
  if p_neto_esperado is null or p_neto_esperado <> v_neto then
    raise exception 'Los saldos de los fondos cambiaron mientras revisabas. Vuelve a revisar la liquidación.';
  end if;
  if p_fecha is null or p_fecha > v_hoy then raise exception 'Indica una fecha de liquidación válida, que no esté en el futuro.'; end if;
  if p_fecha < v_hoy - 400 then raise exception 'La fecha de liquidación es demasiado antigua.'; end if;
  v_resultado := case when v_neto > 0 then 'Devolucion' when v_neto < 0 then 'Pago' else 'Compensado' end;
  if length(coalesce(v_obs, '')) > 500 then raise exception 'La observación admite hasta 500 caracteres.'; end if;

  select * into v_admin from public.profiles where id = auth.uid();
  insert into public.liquidaciones_fondos (empleado_id, empleado_nombre, rut_empleado, empresa, fecha, resultado,
      total_restante, total_exceso, monto_neto, cuenta_banco, nombre_banco, referencia, observacion, creado_por, creado_por_nombre)
  values ((c->>'empleado_id')::uuid, c->>'empleado_nombre', c->>'rut_empleado', c->>'empresa', p_fecha, v_resultado,
      (c->>'total_restante')::numeric, (c->>'total_exceso')::numeric, abs(v_neto), null, null, null, v_obs,
      auth.uid(), v_admin.nombre)
  returning id, folio into v_id, v_folio;

  insert into public.liquidacion_fondos_detalle (liquidacion_id, solicitud_fondo_id, folio_fondo, otorgado, aprobado, restante, exceso, excesos)
  select v_id, (d->>'solicitud_fondo_id')::uuid, (d->>'folio_fondo')::bigint, (d->>'otorgado')::numeric,
    (d->>'aprobado')::numeric, (d->>'restante')::numeric, (d->>'exceso')::numeric, d->'excesos'
  from jsonb_array_elements(c->'detalle') d;

  perform pg_catalog.set_config('rinde.liquidando_fondos', '1', true);
  update public.solicitudes_fondos set estado = 'Cerrado', liquidacion_id = v_id where id = any(p_fondos);
  perform pg_catalog.set_config('rinde.liquidando_fondos', '', true);

  insert into public.system_events (tipo, usuario_id, solicitud_id, detalle, metadata)
  values ('fondos_liquidados', auth.uid(), p_fondos[1],
    'Liquidación L-' || v_folio || ' de ' || (c->>'empleado_nombre') || ': ' ||
      (select string_agg('S-' || (d->>'folio_fondo'), ', ') from jsonb_array_elements(c->'detalle') d) || ' · ' ||
      case v_resultado when 'Devolucion' then 'queda por devolver $' || abs(v_neto) when 'Pago' then 'queda por pagarle $' || abs(v_neto) else 'compensado' end,
    jsonb_build_object('liquidacion_id', v_id, 'fondos', to_jsonb(p_fondos), 'resultado', v_resultado,
      'total_restante', c->'total_restante', 'total_exceso', c->'total_exceso', 'neto', v_neto));

  return jsonb_build_object('id', v_id, 'folio', v_folio, 'resultado', v_resultado, 'monto_neto', abs(v_neto));
end;
$$;
revoke execute on function public.liquidar_fondos(uuid[], date, numeric, text, text, text, text) from public, anon;
grant execute on function public.liquidar_fondos(uuid[], date, numeric, text, text, text, text) to authenticated;
