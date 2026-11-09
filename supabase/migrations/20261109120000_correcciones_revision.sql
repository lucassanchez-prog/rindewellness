-- Correcciones de la revisión del 2026-11-09.
--
-- 1. Aprobar o rechazar un gasto ya NO borra su verificación contable.
-- 2. Se recupera, desde el historial, la verificación que se perdió así.
-- 3. Al cerrar una rendición, los comprobantes que esperaban lectura con IA
--    quedan "descartado" en vez de "pendiente" para siempre.
-- 4. Registro de qué rendiciones ya tienen su CSV para Kame descargado.
-- 5. Borrar una rendición deja un evento con una copia completa (cabecera e
--    ítems), aunque se borre desde el panel de Supabase.

-- ------------------------------------------------------------
-- 1. La verificación contable solo se invalida si cambia el DOCUMENTO
-- ------------------------------------------------------------
-- Antes, "new.estado is distinct from old.estado" contaba como cambio: cada
-- vez que se aprobaba un gasto se borraban existe_en_contabilidad,
-- comprobante_contable_encontrado, verificacion_contable y monto_verificado
-- (114 ítems lo perdieron hasta el 2026-11-09). Aprobar no cambia el documento.
create or replace function public.controlar_verificacion_contable()
returns trigger language plpgsql security invoker set search_path='' as $$
declare cambio boolean;
begin
  if tg_op='INSERT' then
    new.verificacion_contable:=null;
    return new;
  end if;
  cambio := new.monto is distinct from old.monto or new.rut_proveedor is distinct from old.rut_proveedor
    or new.nro_documento is distinct from old.nro_documento or new.tipo_documento is distinct from old.tipo_documento
    or new.tipo_item is distinct from old.tipo_item or new.adjunto_url is distinct from old.adjunto_url
    or new.empresa is distinct from old.empresa
    or (new.cuenta_contable is distinct from old.cuenta_contable and new.verificacion_contable is not distinct from old.verificacion_contable);
  if new.verificacion_contable is distinct from old.verificacion_contable and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador activo puede registrar una verificación contable.';
  end if;
  if new.verificacion_contable is distinct from old.verificacion_contable and new.verificacion_contable is not null then
    if jsonb_typeof(new.verificacion_contable)<>'object' then raise exception 'Verificación contable inválida.'; end if;
    if (new.verificacion_contable->>'monto_rendido')::numeric is distinct from new.monto
      or new.verificacion_contable->>'rut_proveedor' is distinct from new.rut_proveedor
      or new.verificacion_contable->>'nro_documento' is distinct from new.nro_documento
      or new.verificacion_contable->>'tipo_documento' is distinct from new.tipo_documento then
      raise exception 'El gasto cambió durante la verificación. Actualiza y verifica nuevamente.';
    end if;
    new.verificacion_contable := new.verificacion_contable || jsonb_build_object('verificado_en',now(),'verificado_por',auth.uid());
  end if;
  -- Se ejecuta después de los guards de permisos: editar un gasto propio
  -- puede invalidar una comprobación anterior sin conceder permiso para verificar.
  if cambio then
    new.verificacion_contable:=null;
    new.existe_en_contabilidad:=null;
    new.comprobante_contable_encontrado:=null;
    new.monto_verificado:=false;
  end if;
  return new;
end;
$$;
revoke all on function public.controlar_verificacion_contable() from public,anon,authenticated;

-- ------------------------------------------------------------
-- 2. Recuperar las marcas "existe en contabilidad" borradas al aprobar
-- ------------------------------------------------------------
-- El historial guardó el valor anterior en el mismo instante del cambio de
-- estado. Solo se recupera si después no cambió nada del documento (si cambió,
-- borrar la marca era lo correcto) y si hoy sigue vacía. verificacion_contable
-- (el detalle) y monto_verificado no se auditaban, así que no se pueden recuperar.
-- Los guards impiden tocar ítems de rendiciones cerradas: se apagan solo para
-- esta corrección, dentro de la misma transacción de la migración.
alter table public.rendicion_items disable trigger trg_00_integridad_item;
alter table public.rendicion_items disable trigger trg_proteger_aprobacion_item;
alter table public.rendicion_items disable trigger trg_zz_verificacion_contable;
alter table public.rendicion_items disable trigger trg_auditar_cambio_estado_item;

with borrados as (
  select b.item_id, b.campo, b.valor_anterior, b.created_at
  from public.rendicion_items_historial b
  join public.rendicion_items_historial a on a.item_id=b.item_id and a.campo='estado'
    and abs(extract(epoch from (b.created_at-a.created_at))) < 1
  where b.campo in ('existe_en_contabilidad','comprobante_contable_encontrado')
    and b.valor_anterior is not null and b.valor_nuevo is null
    and not exists (select 1 from public.rendicion_items_historial c
      where c.item_id=b.item_id and c.created_at > b.created_at + interval '1 second'
        and c.campo in ('existe_en_contabilidad','comprobante_contable_encontrado','monto','rut_proveedor',
          'nro_documento','tipo_documento','tipo_item','adjunto_url','empresa'))
), ultimo as (
  select distinct on (item_id, campo) item_id, campo, valor_anterior from borrados order by item_id, campo, created_at desc
)
update public.rendicion_items i set
  existe_en_contabilidad = coalesce((select u.valor_anterior::boolean from ultimo u where u.item_id=i.id and u.campo='existe_en_contabilidad'), i.existe_en_contabilidad),
  comprobante_contable_encontrado = coalesce((select u.valor_anterior from ultimo u where u.item_id=i.id and u.campo='comprobante_contable_encontrado'), i.comprobante_contable_encontrado)
where i.id in (select item_id from ultimo) and i.existe_en_contabilidad is null;

alter table public.rendicion_items enable trigger trg_00_integridad_item;
alter table public.rendicion_items enable trigger trg_proteger_aprobacion_item;
alter table public.rendicion_items enable trigger trg_zz_verificacion_contable;
alter table public.rendicion_items enable trigger trg_auditar_cambio_estado_item;

-- ------------------------------------------------------------
-- 3. Lectura con IA descartada al cerrar la rendición
-- ------------------------------------------------------------
-- El bot ya salta las rendiciones cerradas, pero sus ítems quedaban
-- "pendiente" para siempre (16 al 2026-11-09).
alter table public.rendicion_items drop constraint if exists rendicion_items_ocr_reintento_estado_check;
alter table public.rendicion_items add constraint rendicion_items_ocr_reintento_estado_check
  check (ocr_reintento_estado = any (array['pendiente','listo','agotado','descartado']));

-- Igual que antes, más una excepción: el cierre de rendición (y solo él, vía
-- rinde.cierre_rendicion) puede descartar la lectura pendiente.
create or replace function public.validar_integridad_item()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare r public.rendiciones; permitido text[];
begin
  if tg_op = 'UPDATE' and (new.rendicion_id is distinct from old.rendicion_id or new.id is distinct from old.id) then
    raise exception 'No se puede trasladar un ítem a otra rendición.';
  end if;
  select * into r from public.rendiciones where id = new.rendicion_id for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if (tg_op = 'INSERT' or new.adjunto_url is distinct from old.adjunto_url)
     and not public.ruta_comprobante_propia(new.adjunto_url, r.empleado_id) then
    raise exception 'El comprobante debe pertenecer al empleado de la rendición.';
  end if;
  if tg_op = 'INSERT' and r.estado <> 'Pendiente' then
    raise exception 'No se pueden agregar ítems a una rendición procesada.';
  end if;
  if tg_op = 'UPDATE' and r.estado <> 'Pendiente' then
    permitido := array['verificacion_contable','cuenta_contable','existe_en_contabilidad','comprobante_contable_encontrado',
      'ocr_reintento_estado','ocr_reintento_resultado','ocr_reintento_intentos','ocr_reintento_ultimo','ocr_lease_token','ocr_lease_hasta'];
    if (to_jsonb(new) - permitido) is distinct from (to_jsonb(old) - permitido) then
      raise exception 'La rendición ya fue procesada; no se puede modificar este gasto.';
    end if;
    if (new.cuenta_contable is distinct from old.cuenta_contable
      or new.existe_en_contabilidad is distinct from old.existe_en_contabilidad
      or new.comprobante_contable_encontrado is distinct from old.comprobante_contable_encontrado)
      and not public.is_admin_or_aprobador() then
      raise exception 'Solo un aprobador puede corregir la verificación contable.';
    end if;
  end if;
  -- La reserva OCR no puede ser alterada por llamadas directas del cliente.
  if tg_op = 'UPDATE' and auth.uid() is not null and auth.role() <> 'service_role'
    and coalesce(current_setting('rinde.cierre_rendicion', true), '') <> '1' and (
    new.ocr_lease_token is distinct from old.ocr_lease_token or new.ocr_lease_hasta is distinct from old.ocr_lease_hasta
    or new.ocr_reintento_intentos is distinct from old.ocr_reintento_intentos
    or new.ocr_reintento_resultado is distinct from old.ocr_reintento_resultado
    or new.ocr_reintento_estado is distinct from old.ocr_reintento_estado) then
    raise exception 'Solo el procesador OCR puede actualizar su resultado.';
  end if;
  return new;
end;
$function$;

create or replace function public.descartar_ocr_al_cerrar()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.set_config('rinde.cierre_rendicion', '1', true);
  update public.rendicion_items set ocr_reintento_estado = 'descartado', ocr_lease_token = null, ocr_lease_hasta = null
    where rendicion_id = new.id and ocr_reintento_estado = 'pendiente';
  perform pg_catalog.set_config('rinde.cierre_rendicion', '', true);
  return null;
end;
$$;
revoke execute on function public.descartar_ocr_al_cerrar() from public, anon, authenticated;
drop trigger if exists descartar_ocr_al_cerrar on public.rendiciones;
create trigger descartar_ocr_al_cerrar after update of estado on public.rendiciones
  for each row when (old.estado = 'Pendiente' and new.estado <> 'Pendiente')
  execute function public.descartar_ocr_al_cerrar();

-- Los que ya quedaron colgados.
select pg_catalog.set_config('rinde.cierre_rendicion', '1', true);
update public.rendicion_items i set ocr_reintento_estado = 'descartado', ocr_lease_token = null, ocr_lease_hasta = null
  from public.rendiciones r where r.id = i.rendicion_id and r.estado <> 'Pendiente' and i.ocr_reintento_estado = 'pendiente';
select pg_catalog.set_config('rinde.cierre_rendicion', '', true);

-- ------------------------------------------------------------
-- 4. Registro del CSV para Kame
-- ------------------------------------------------------------
-- La app no sabía qué rendiciones ya se habían bajado para importar a Kame
-- (numero_comprobante_kame nunca se llenó): era fácil importar una dos veces
-- u olvidar alguna. Se registra la primera descarga y cuántas hubo.
alter table public.rendiciones add column if not exists kame_exportado_en timestamptz;
alter table public.rendiciones add column if not exists kame_exportado_por_nombre text;
alter table public.rendiciones add column if not exists kame_exportaciones integer not null default 0;

create or replace function public.marcar_exportado_kame(p_rendiciones uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer; v_nombre text;
begin
  if auth.uid() is null or not public.is_activo() or not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador puede registrar la exportación a Kame.';
  end if;
  if coalesce(cardinality(p_rendiciones), 0) = 0 or cardinality(p_rendiciones) > 500 then
    raise exception 'Indica entre 1 y 500 rendiciones.';
  end if;
  select nombre into v_nombre from public.profiles where id = auth.uid();
  update public.rendiciones set
    kame_exportado_en = coalesce(kame_exportado_en, now()),
    kame_exportado_por_nombre = coalesce(kame_exportado_por_nombre, v_nombre),
    kame_exportaciones = kame_exportaciones + 1
  where id = any(p_rendiciones) and estado = 'Aprobado';
  get diagnostics n = row_count;
  insert into public.system_events (tipo, usuario_id, detalle, metadata)
  values ('kame_exportado', auth.uid(), n || ' rendición(es) con CSV para Kame descargado',
    jsonb_build_object('rendiciones', to_jsonb(p_rendiciones)));
  return n;
end;
$$;
revoke execute on function public.marcar_exportado_kame(uuid[]) from public, anon;
grant execute on function public.marcar_exportado_kame(uuid[]) to authenticated;

-- ------------------------------------------------------------
-- 5. Borrar una rendición deja rastro y copia
-- ------------------------------------------------------------
-- La app no puede borrar rendiciones con gastos, pero desde el panel de
-- Supabase sí, y sin rastro (así desaparecieron la N° 64 y la N° 65). Antes del
-- borrado se guarda un evento con la cabecera y los ítems completos: sirve para
-- saber qué pasó y para reconstruirla si fue un error.
create or replace function public.auditar_borrado_rendicion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.system_events (tipo, usuario_id, detalle, metadata)
  values ('rendicion_borrada', auth.uid(),
    'Rendición N° ' || coalesce(old.folio::text, '?') || ' de ' || coalesce(old.empleado_nombre, '?') || ' borrada',
    jsonb_build_object('rol_bd', current_user, 'rendicion', to_jsonb(old),
      'items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) from public.rendicion_items i where i.rendicion_id = old.id),
      'fondos', (select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) from public.rendicion_fondos f where f.rendicion_id = old.id)));
  return old;
end;
$$;
revoke execute on function public.auditar_borrado_rendicion() from public, anon, authenticated;
drop trigger if exists auditar_borrado_rendicion on public.rendiciones;
create trigger auditar_borrado_rendicion before delete on public.rendiciones
  for each row execute function public.auditar_borrado_rendicion();
