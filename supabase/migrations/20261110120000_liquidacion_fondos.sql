-- Liquidación (cierre) de fondos por rendir.
--
-- Hasta ahora un fondo aprobado quedaba abierto para siempre: si la persona
-- rendía de menos, el restante seguía en 1.01.11.05 Fondo por Rendir; si
-- rendía de más, el exceso quedaba en 2.01.07.29 Rendiciones por Pagar (ver
-- distribuir_fondos_csv), y no había forma de saldar ninguno de los dos.
--
-- Una liquidación toma uno o varios fondos abiertos de la MISMA persona y
-- empresa, sin rendiciones a medio revisar, y los deja en estado 'Cerrado':
--   · los excesos se cruzan con los restantes (2.01.07.29 contra 1.01.11.05);
--   · la diferencia neta se salda por banco: si sobra restante, la persona lo
--     DEVUELVE (Banco contra 1.01.11.05); si sobra exceso, la empresa le PAGA
--     (2.01.07.29 contra Banco); si cuadra, queda Compensado sin mover dinero.
-- Un solo fondo = liquidarlo por separado. El asiento para Kame se arma en el
-- cliente con lo guardado aquí (RindeCore.comprobanteLiquidacionFondos).
-- Una liquidación se puede anular (reabre los fondos) si se cometió un error.

-- 1. Estado nuevo y tablas -------------------------------------------------

alter table public.solicitudes_fondos drop constraint if exists solicitudes_fondos_estado_check;
alter table public.solicitudes_fondos add constraint solicitudes_fondos_estado_check
  check (estado in ('Pendiente', 'Aprobado', 'Rechazado', 'Cerrado'));

create table if not exists public.liquidaciones_fondos (
  id uuid primary key default gen_random_uuid(),
  folio bigint generated always as identity unique,
  created_at timestamptz not null default now(),
  empleado_id uuid not null references auth.users(id),
  empleado_nombre text,
  rut_empleado text,
  empresa text not null,
  fecha date not null,
  resultado text not null check (resultado in ('Devolucion', 'Pago', 'Compensado')),
  total_restante numeric(12,2) not null check (total_restante >= 0),
  total_exceso numeric(12,2) not null check (total_exceso >= 0),
  monto_neto numeric(12,2) not null check (monto_neto >= 0),
  cuenta_banco text,
  nombre_banco text,
  referencia text,
  observacion text,
  creado_por uuid not null references auth.users(id),
  creado_por_nombre text,
  kame_exportado_en timestamptz,
  kame_exportaciones integer not null default 0,
  anulada_en timestamptz,
  anulada_por_nombre text,
  motivo_anulacion text,
  constraint liquidacion_neto_cuadra check (monto_neto = abs(total_restante - total_exceso)),
  constraint liquidacion_resultado_cuadra check (
    (resultado = 'Compensado' and monto_neto = 0)
    or (resultado = 'Devolucion' and total_restante > total_exceso)
    or (resultado = 'Pago' and total_exceso > total_restante)),
  constraint liquidacion_banco check (resultado = 'Compensado' or (cuenta_banco is not null and nombre_banco is not null))
);

create table if not exists public.liquidacion_fondos_detalle (
  liquidacion_id uuid not null references public.liquidaciones_fondos(id) on delete restrict,
  solicitud_fondo_id uuid not null references public.solicitudes_fondos(id) on delete restrict,
  folio_fondo bigint not null,
  otorgado numeric(12,2) not null,
  aprobado numeric(12,2) not null,
  restante numeric(12,2) not null check (restante >= 0),
  exceso numeric(12,2) not null check (exceso >= 0),
  -- Exceso por rendición [{folio, monto}]: en Kame cada exceso quedó como un
  -- documento de 2.01.07.29 con el folio de la rendición, y se cancela igual.
  excesos jsonb not null default '[]'::jsonb,
  primary key (liquidacion_id, solicitud_fondo_id)
);
create index if not exists liquidacion_detalle_fondo_idx on public.liquidacion_fondos_detalle(solicitud_fondo_id);

alter table public.solicitudes_fondos add column if not exists liquidacion_id uuid references public.liquidaciones_fondos(id);

alter table public.liquidaciones_fondos enable row level security;
alter table public.liquidacion_fondos_detalle enable row level security;
drop policy if exists liquidaciones_fondos_select on public.liquidaciones_fondos;
create policy liquidaciones_fondos_select on public.liquidaciones_fondos for select to authenticated
  using ((select public.is_activo()) and ((select public.is_admin_or_aprobador()) or empleado_id = (select auth.uid())));
drop policy if exists liquidacion_fondos_detalle_select on public.liquidacion_fondos_detalle;
create policy liquidacion_fondos_detalle_select on public.liquidacion_fondos_detalle for select to authenticated
  using (exists (select 1 from public.liquidaciones_fondos l where l.id = liquidacion_fondos_detalle.liquidacion_id));
-- Solo se escriben a través de las funciones de abajo.
revoke all on public.liquidaciones_fondos, public.liquidacion_fondos_detalle from public, anon, authenticated;
grant select on public.liquidaciones_fondos, public.liquidacion_fondos_detalle to authenticated;

-- 2. Cálculo (compartido por la vista previa y el cierre) ------------------

-- Valida los fondos y calcula, por fondo, otorgado / aprobado / restante /
-- exceso, y el exceso de cada rendición en el mismo orden de aprobación que
-- usó el CSV de cada rendición (distribuir_fondos_csv).
create or replace function public.calcular_liquidacion_fondos(p_fondos uuid[])
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  n integer := coalesce(cardinality(p_fondos), 0);
  v_no text; v_pend text; v_det jsonb; v_rest numeric; v_exc numeric;
  v_emp uuid; v_empresa text; v_perfil public.profiles; v_nombre text; v_rut text;
begin
  if n < 1 or n > 20 then raise exception 'Elige entre 1 y 20 fondos.'; end if;
  if (select count(distinct x) from unnest(p_fondos) x) <> n then raise exception 'El mismo fondo aparece dos veces.'; end if;
  if (select count(*) from public.solicitudes_fondos where id = any(p_fondos)) <> n then
    raise exception 'Uno de los fondos no existe.';
  end if;
  select string_agg('S-' || folio || ' (' || estado || ')', ', ' order by folio) into v_no
    from public.solicitudes_fondos where id = any(p_fondos) and estado <> 'Aprobado';
  if v_no is not null then
    raise exception 'Solo se pueden liquidar fondos aprobados que sigan abiertos: %.', v_no;
  end if;
  if (select count(distinct empleado_id) from public.solicitudes_fondos where id = any(p_fondos)) <> 1
     or (select count(distinct empresa) from public.solicitudes_fondos where id = any(p_fondos)) <> 1 then
    raise exception 'Los fondos que se liquidan juntos deben ser de la misma persona y la misma empresa.';
  end if;
  select string_agg(distinct 'N° ' || v.folio, ', ') into v_pend
    from public.rendiciones_por_fondo v where v.solicitud_fondo_id = any(p_fondos) and v.estado not in ('Aprobado', 'Rechazado');
  if v_pend is not null then
    raise exception 'Hay rendiciones de estos fondos sin terminar de revisar (%). Apruébalas o recházalas antes de liquidar.', v_pend;
  end if;

  with porciones as (
    select v.solicitud_fondo_id, v.folio, v.monto_total as porcion, s.monto_solicitado as otorgado,
      coalesce(sum(v.monto_total) over (partition by v.solicitud_fondo_id
        order by v.fecha_aprobacion nulls last, v.id rows between unbounded preceding and 1 preceding), 0) as antes
    from public.rendiciones_por_fondo v join public.solicitudes_fondos s on s.id = v.solicitud_fondo_id
    where v.solicitud_fondo_id = any(p_fondos) and v.estado = 'Aprobado'
  ),
  excesos as (
    select solicitud_fondo_id, folio, porcion - least(porcion, greatest(0, otorgado - antes)) as monto from porciones
  ),
  det as (
    select s.id, s.folio, s.monto_solicitado as otorgado, coalesce(sum(p.porcion), 0) as aprobado
    from public.solicitudes_fondos s left join porciones p on p.solicitud_fondo_id = s.id
    where s.id = any(p_fondos) group by s.id, s.folio, s.monto_solicitado
  )
  select jsonb_agg(jsonb_build_object(
      'solicitud_fondo_id', d.id, 'folio_fondo', d.folio, 'otorgado', d.otorgado, 'aprobado', d.aprobado,
      'restante', greatest(0, d.otorgado - d.aprobado), 'exceso', greatest(0, d.aprobado - d.otorgado),
      'excesos', coalesce((select jsonb_agg(jsonb_build_object('folio', e.folio, 'monto', e.monto) order by e.folio)
                           from excesos e where e.solicitud_fondo_id = d.id and e.monto > 0), '[]'::jsonb))
      order by d.folio),
    sum(greatest(0, d.otorgado - d.aprobado)), sum(greatest(0, d.aprobado - d.otorgado))
    into v_det, v_rest, v_exc from det d;

  select empleado_id, empresa, empleado_nombre, rut_empleado into v_emp, v_empresa, v_nombre, v_rut
    from public.solicitudes_fondos where id = p_fondos[1];
  select * into v_perfil from public.profiles where id = v_emp;
  return jsonb_build_object(
    'empleado_id', v_emp, 'empleado_nombre', coalesce(v_perfil.nombre, v_nombre),
    'rut_empleado', coalesce(nullif(v_perfil.rut, ''), v_rut), 'empresa', v_empresa,
    'total_restante', v_rest, 'total_exceso', v_exc, 'neto', v_rest - v_exc, 'detalle', v_det);
end;
$$;
revoke execute on function public.calcular_liquidacion_fondos(uuid[]) from public, anon, authenticated;

-- Vista previa para el formulario (no escribe nada).
create or replace function public.preparar_liquidacion_fondos(p_fondos uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador puede liquidar fondos.';
  end if;
  return public.calcular_liquidacion_fondos(p_fondos);
end;
$$;
revoke execute on function public.preparar_liquidacion_fondos(uuid[]) from public, anon;
grant execute on function public.preparar_liquidacion_fondos(uuid[]) to authenticated;

-- 3. Liquidar -------------------------------------------------------------

-- p_neto_esperado es el neto que vio quien liquida: si los saldos cambiaron
-- entre la vista previa y la confirmación, no se cierra nada.
create or replace function public.liquidar_fondos(
  p_fondos uuid[], p_fecha date, p_neto_esperado numeric,
  p_cuenta_banco text default null, p_nombre_banco text default null,
  p_referencia text default null, p_observacion text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c jsonb; v_neto numeric; v_resultado text; v_id uuid; v_folio bigint; v_admin public.profiles;
  v_cuenta text := nullif(trim(coalesce(p_cuenta_banco, '')), '');
  v_banco text := nullif(regexp_replace(trim(coalesce(p_nombre_banco, '')), '\s+', ' ', 'g'), '');
  v_ref text := nullif(regexp_replace(trim(coalesce(p_referencia, '')), '\s+', ' ', 'g'), '');
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
  if v_resultado <> 'Compensado' then
    if v_cuenta is null or v_cuenta !~ '^\d+(\.\d+){2,5}$' or v_cuenta in ('1.01.11.05', '2.01.07.29') then
      raise exception 'Indica el código en Kame de la cuenta bancaria (distinto de Fondo por Rendir y de Rendiciones por Pagar).';
    end if;
    if v_banco is null or length(v_banco) > 100 then raise exception 'Indica el nombre de la cuenta bancaria (máximo 100 caracteres).'; end if;
  else
    v_cuenta := null; v_banco := null;
  end if;
  if length(coalesce(v_ref, '')) > 100 then raise exception 'La referencia admite hasta 100 caracteres.'; end if;
  if length(coalesce(v_obs, '')) > 500 then raise exception 'La observación admite hasta 500 caracteres.'; end if;

  select * into v_admin from public.profiles where id = auth.uid();
  insert into public.liquidaciones_fondos (empleado_id, empleado_nombre, rut_empleado, empresa, fecha, resultado,
      total_restante, total_exceso, monto_neto, cuenta_banco, nombre_banco, referencia, observacion, creado_por, creado_por_nombre)
  values ((c->>'empleado_id')::uuid, c->>'empleado_nombre', c->>'rut_empleado', c->>'empresa', p_fecha, v_resultado,
      (c->>'total_restante')::numeric, (c->>'total_exceso')::numeric, abs(v_neto), v_cuenta, v_banco, v_ref, v_obs,
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
      case v_resultado when 'Devolucion' then 'devuelve $' || abs(v_neto) when 'Pago' then 'se le paga $' || abs(v_neto) else 'compensado' end,
    jsonb_build_object('liquidacion_id', v_id, 'fondos', to_jsonb(p_fondos), 'resultado', v_resultado,
      'total_restante', c->'total_restante', 'total_exceso', c->'total_exceso', 'neto', v_neto));

  return jsonb_build_object('id', v_id, 'folio', v_folio, 'resultado', v_resultado, 'monto_neto', abs(v_neto));
end;
$$;
revoke execute on function public.liquidar_fondos(uuid[], date, numeric, text, text, text, text) from public, anon;
grant execute on function public.liquidar_fondos(uuid[], date, numeric, text, text, text, text) to authenticated;

-- 4. Anular (reabre los fondos) -------------------------------------------

create or replace function public.anular_liquidacion_fondos(p_liquidacion uuid, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.liquidaciones_fondos; v_admin public.profiles; v_motivo text := nullif(trim(coalesce(p_motivo, '')), '');
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador puede anular una liquidación.';
  end if;
  if v_motivo is null or length(v_motivo) > 500 then raise exception 'Explica por qué se anula (máximo 500 caracteres).'; end if;
  select * into l from public.liquidaciones_fondos where id = p_liquidacion for update;
  if not found then raise exception 'La liquidación no existe.'; end if;
  if l.anulada_en is not null then raise exception 'Esta liquidación ya estaba anulada.'; end if;
  select * into v_admin from public.profiles where id = auth.uid();
  update public.liquidaciones_fondos set anulada_en = now(), anulada_por_nombre = v_admin.nombre, motivo_anulacion = v_motivo
    where id = l.id;
  perform pg_catalog.set_config('rinde.liquidando_fondos', '1', true);
  update public.solicitudes_fondos set estado = 'Aprobado', liquidacion_id = null where liquidacion_id = l.id;
  perform pg_catalog.set_config('rinde.liquidando_fondos', '', true);
  insert into public.system_events (tipo, usuario_id, detalle, metadata)
  values ('liquidacion_anulada', auth.uid(), 'Liquidación L-' || l.folio || ' anulada por ' || v_admin.nombre || ': ' || v_motivo,
    jsonb_build_object('liquidacion_id', l.id, 'kame_exportado_en', l.kame_exportado_en));
end;
$$;
revoke execute on function public.anular_liquidacion_fondos(uuid, text) from public, anon;
grant execute on function public.anular_liquidacion_fondos(uuid, text) to authenticated;

-- Registro de la descarga del CSV para Kame (importarlo dos veces lo duplica).
create or replace function public.marcar_liquidacion_exportada_kame(p_liquidacion uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin() then
    raise exception 'Solo un administrador puede registrar la descarga.';
  end if;
  update public.liquidaciones_fondos set kame_exportado_en = now(), kame_exportaciones = kame_exportaciones + 1
    where id = p_liquidacion and anulada_en is null;
end;
$$;
revoke execute on function public.marcar_liquidacion_exportada_kame(uuid) from public, anon;
grant execute on function public.marcar_liquidacion_exportada_kame(uuid) to authenticated;

-- 5. Controles existentes que deben conocer el estado 'Cerrado' -------------

-- Un fondo solo pasa de Aprobado a Cerrado (y vuelve) a través de las
-- funciones de arriba; nadie puede tocar liquidacion_id directamente.
create or replace function public.proteger_aprobacion_solicitud()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_liquidando boolean := coalesce(current_setting('rinde.liquidando_fondos', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    if not public.is_admin_or_aprobador() or new.empleado_id = auth.uid() then
      new.estado := 'Pendiente';
      new.aprobador_id := null;
      new.aprobador_nombre := null;
      new.fecha_aprobacion := null;
    end if;
    if new.estado = 'Cerrado' or new.liquidacion_id is not null then
      raise exception 'Un fondo solo se cierra liquidándolo.';
    end if;
    return new;
  end if;

  if new.liquidacion_id is distinct from old.liquidacion_id and not v_liquidando then
    raise exception 'La liquidación de un fondo solo se cambia liquidándolo o anulando la liquidación.';
  end if;
  if v_liquidando and new.estado is distinct from old.estado
     and ((old.estado = 'Aprobado' and new.estado = 'Cerrado') or (old.estado = 'Cerrado' and new.estado = 'Aprobado')) then
    return new;
  end if;

  if (new.estado is distinct from old.estado
      or new.aprobador_id is distinct from old.aprobador_id
      or new.aprobador_nombre is distinct from old.aprobador_nombre
      or new.fecha_aprobacion is distinct from old.fecha_aprobacion
      or new.motivo_rechazo is distinct from old.motivo_rechazo)
     and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador o admin puede aprobar/rechazar una solicitud de fondos.';
  end if;

  if new.estado is distinct from old.estado and old.estado = 'Pendiente'
     and new.estado in ('Aprobado', 'Rechazado') and old.empleado_id = auth.uid() then
    raise exception 'No puedes aprobar o rechazar tu propia solicitud de fondos.';
  end if;

  if new.estado is distinct from old.estado and old.estado = 'Pendiente' and new.estado = 'Cerrado' then
    raise exception 'Un fondo solo se cierra liquidándolo.';
  end if;

  if new.estado is distinct from old.estado and old.estado <> 'Pendiente' then
    raise exception 'Esta solicitud ya fue procesada (estado actual: %).', old.estado;
  end if;

  if old.estado <> 'Pendiente' and (
    new.monto_solicitado is distinct from old.monto_solicitado
    or new.empresa is distinct from old.empresa
    or new.centro_costo is distinct from old.centro_costo
    or new.motivo is distinct from old.motivo
    or new.fecha_necesaria is distinct from old.fecha_necesaria
  ) then
    raise exception 'Esta solicitud ya fue procesada y no se puede modificar (estado actual: %).', old.estado;
  end if;

  return new;
end;
$$;

-- Igual que antes, con un mensaje claro si el fondo ya fue liquidado.
create or replace function public.validar_integridad_cabecera()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.solicitudes_fondos; v_total numeric; v_aprobados integer;
begin
  if tg_op = 'UPDATE' and (new.empleado_id is distinct from old.empleado_id or new.id is distinct from old.id) then
    raise exception 'No se puede cambiar el dueño de una rendición.';
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and (
    new.solicitud_fondo_id is distinct from old.solicitud_fondo_id or new.tipo_rendicion is distinct from old.tipo_rendicion
    or new.empresa is distinct from old.empresa or new.estado is distinct from old.estado)) then
    if new.tipo_rendicion = 'FondoPorRendir' then
      select * into s from public.solicitudes_fondos where id = new.solicitud_fondo_id for share;
      if found and s.estado = 'Cerrado' then
        raise exception 'El fondo S-% ya fue liquidado y cerrado; no admite más rendiciones.', s.folio;
      end if;
      if not found or s.empleado_id <> new.empleado_id or s.estado <> 'Aprobado' or s.empresa is distinct from new.empresa then
        raise exception 'Selecciona un fondo aprobado propio de la misma empresa.';
      end if;
    elsif new.solicitud_fondo_id is not null then
      raise exception 'Solo FondoPorRendir puede estar asociado a un fondo.';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.estado is distinct from old.estado and old.estado = 'Pendiente' then
    if auth.uid() is null or not public.is_admin_or_aprobador() or new.empleado_id = auth.uid() then
      raise exception 'Otro aprobador activo debe finalizar esta rendición.';
    end if;
    if not exists(select 1 from public.rendicion_items where rendicion_id = new.id) then
      raise exception 'No se puede finalizar una rendición vacía.';
    end if;
    if exists(select 1 from public.rendicion_items where rendicion_id = new.id and estado = 'Pendiente') then
      raise exception 'Faltan gastos por aprobar o rechazar.';
    end if;
    select coalesce(sum(monto),0),count(*) into v_total,v_aprobados
      from public.rendicion_items where rendicion_id = new.id and estado = 'Aprobado';
    new.estado := case when v_aprobados > 0 then 'Aprobado' else 'Rechazado' end;
    new.monto_total := v_total;
    new.aprobador_id := auth.uid();
    new.aprobador_nombre := (select nombre from public.profiles where id = auth.uid());
    new.fecha_aprobacion := now();
  end if;
  -- Ambos importes se derivan de los ítems; el cliente no puede falsificarlos.
  select coalesce(sum(monto),0), coalesce(sum(monto) filter(where estado='Aprobado'),0)
    into new.monto_rendido,new.monto_aprobado from public.rendicion_items where rendicion_id=new.id;
  return new;
end;
$$;

-- El CSV de una rendición aprobada se puede volver a descargar aunque su fondo
-- ya esté liquidado (antes exigía fondo 'Aprobado' y habría fallado).
create or replace function public.distribuir_fondos_csv(p_rendiciones uuid[])
returns jsonb language plpgsql stable set search_path = '' as $$
declare salida jsonb; n integer;
begin
  if auth.uid() is null or not public.is_activo() then raise exception 'Se requiere un usuario activo.'; end if;
  if cardinality(p_rendiciones)>500 or cardinality(p_rendiciones)=0 then raise exception 'Selecciona entre 1 y 500 rendiciones.'; end if;
  select count(*) into n from public.rendiciones r join public.solicitudes_fondos s on s.id=r.solicitud_fondo_id
  where r.id=any(p_rendiciones) and r.estado='Aprobado' and r.tipo_rendicion='FondoPorRendir' and s.estado in ('Aprobado','Cerrado');
  if n <> (select count(distinct x) from unnest(p_rendiciones) x) then raise exception 'No se pudo comprobar el fondo de todas las rendiciones seleccionadas.'; end if;
  with fondos as (select distinct solicitud_fondo_id from public.rendiciones_por_fondo where id=any(p_rendiciones)),
  porciones as (
    select v.id, v.orden, v.monto_total as porcion, s.monto_solicitado, s.folio,
      coalesce(sum(v.monto_total) over(partition by v.solicitud_fondo_id order by v.fecha_aprobacion nulls last, v.id rows between unbounded preceding and 1 preceding),0) as antes
    from public.rendiciones_por_fondo v join fondos f on f.solicitud_fondo_id=v.solicitud_fondo_id
    join public.solicitudes_fondos s on s.id=v.solicitud_fondo_id where v.estado='Aprobado'
  ),
  por_rendicion as (
    select id, sum(least(porcion, greatest(0, monto_solicitado-antes))) as dentro,
      string_agg(folio::text, ' / S-' order by orden) as folios
    from porciones where id=any(p_rendiciones) group by id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'dentroDelFondo',p.dentro,
    'excedente',greatest(0,r.monto_total-p.dentro),'fondoFolio',p.folios)),'[]'::jsonb)
    into salida from por_rendicion p join public.rendiciones r on r.id=p.id;
  return salida;
end;
$$;
