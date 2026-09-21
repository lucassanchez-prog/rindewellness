-- ============================================================
-- Migración: cierra el hueco de auto-aprobación por INSERT directo, y
-- bloquea editar el contenido/monto de algo ya procesado
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query > Run
-- (proyecto RindeWellness, el de lectura/escritura)
-- ============================================================
--
-- Problema real, encontrado por dos revisiones de seguridad independientes:
-- los triggers "proteger_aprobacion_*" (rendiciones, rendicion_items,
-- solicitudes_fondos) solo corren "before UPDATE", nunca "before INSERT".
-- Las policies de INSERT ("rendiciones_insert_own", "items_insert_own",
-- "solicitudes_fondos_insert_own") solo exigen que la fila sea "propia" --
-- no revisan estado/aprobador/fecha_aprobacion/numero_comprobante_kame.
-- Resultado: cualquier autenticado podía, con un solo POST directo a la
-- API REST (sin pasar por la app), crear una rendición/solicitud/ítem que
-- naciera YA "Aprobado", con un aprobador y folio Kame auto-asignados,
-- sin que nadie la hubiera revisado nunca.
--
-- Además, aun por UPDATE, los triggers solo protegían los campos de
-- "flujo de aprobación" (estado, aprobador_*, fecha_aprobacion,
-- motivo_rechazo) pero nunca los de CONTENIDO/MONTO (monto_total, monto,
-- descripcion, empresa, etc.) -- una vez aprobada, el dueño podía seguir
-- reescribiendo el monto de su propia rendición indefinidamente (incluso
-- ya desactivado, porque is_activo() solo se exigía en INSERT).

-- ------------------------------------------------------------
-- rendiciones
-- ------------------------------------------------------------
create or replace function public.proteger_aprobacion_rendicion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin_or_aprobador() then
      new.estado := 'Pendiente';
      new.aprobador_id := null;
      new.aprobador_nombre := null;
      new.fecha_aprobacion := null;
      new.numero_comprobante_kame := null;
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE' de acá para abajo (comportamiento previo, sin tocar).
  if (new.estado is distinct from old.estado
      or new.aprobador_id is distinct from old.aprobador_id
      or new.aprobador_nombre is distinct from old.aprobador_nombre
      or new.fecha_aprobacion is distinct from old.fecha_aprobacion
      or new.motivo_rechazo is distinct from old.motivo_rechazo
      or new.numero_comprobante_kame is distinct from old.numero_comprobante_kame)
     and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador o admin puede aprobar/rechazar una rendición.';
  end if;

  if new.estado is distinct from old.estado and old.estado <> 'Pendiente' then
    raise exception 'Esta rendición ya fue procesada (estado actual: %).', old.estado;
  end if;

  -- Nuevo: una vez que salió de Pendiente, ningún campo de contenido/monto
  -- puede volver a cambiar -- ni el dueño ni un aprobador tienen ninguna
  -- pantalla para hacerlo (puedeEditarItems en app.js ya lo bloquea en la
  -- UI; esto lo hace real del lado del servidor, incluso para un dueño
  -- desactivado con una sesión todavía viva).
  if old.estado <> 'Pendiente' and (
    new.monto_total is distinct from old.monto_total
    or new.comentario is distinct from old.comentario
    or new.empresa is distinct from old.empresa
    or new.tipo_rendicion is distinct from old.tipo_rendicion
    or new.solicitud_fondo_id is distinct from old.solicitud_fondo_id
  ) then
    raise exception 'Esta rendición ya fue procesada y no se puede modificar (estado actual: %).', old.estado;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_proteger_aprobacion_rendicion on public.rendiciones;
create trigger trg_proteger_aprobacion_rendicion
  before insert or update on public.rendiciones
  for each row execute function public.proteger_aprobacion_rendicion();

-- ------------------------------------------------------------
-- rendicion_items
-- ------------------------------------------------------------
create or replace function public.proteger_aprobacion_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  estado_rendicion text;
begin
  if tg_op = 'INSERT' then
    if not public.is_admin_or_aprobador() then
      new.estado := 'Pendiente';
      new.motivo_rechazo := null;
      new.existe_en_contabilidad := null;
      new.comprobante_contable_encontrado := null;
    end if;
    -- Un ítem nuevo solo se puede insertar mientras la rendición padre
    -- siga Pendiente -- sin esto, se podía agregar un ítem nunca revisado
    -- por nadie a una rendición YA aprobada.
    select r.estado into estado_rendicion from public.rendiciones r where r.id = new.rendicion_id;
    if estado_rendicion is distinct from 'Pendiente' and not public.is_admin_or_aprobador() then
      raise exception 'No se pueden agregar ítems a una rendición ya procesada (estado actual: %).', estado_rendicion;
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE' de acá para abajo (comportamiento previo, sin tocar
  -- en este primer bloque).
  if (new.estado is distinct from old.estado
      or new.motivo_rechazo is distinct from old.motivo_rechazo
      or new.existe_en_contabilidad is distinct from old.existe_en_contabilidad
      or new.comprobante_contable_encontrado is distinct from old.comprobante_contable_encontrado)
     and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador o admin puede aprobar/rechazar o verificar un ítem.';
  end if;

  -- Nuevo: una vez que la rendición completa salió de Pendiente, ningún
  -- campo de contenido/monto del ítem puede volver a cambiar. OJO:
  -- cuenta_contable, existe_en_contabilidad y comprobante_contable_encontrado
  -- quedan AFUERA de esta lista a propósito -- son justo lo que usa
  -- "Verificar en contabilidad", que un aprobador/admin puede seguir
  -- corrigiendo después de aprobar (comportamiento existente, no se toca).
  if (new.monto is distinct from old.monto
      or new.descripcion is distinct from old.descripcion
      or new.nombre_proveedor is distinct from old.nombre_proveedor
      or new.rut_proveedor is distinct from old.rut_proveedor
      or new.tipo_documento is distinct from old.tipo_documento
      or new.nro_documento is distinct from old.nro_documento
      or new.fecha_vencimiento is distinct from old.fecha_vencimiento
      or new.centro_costo is distinct from old.centro_costo
      or new.categoria is distinct from old.categoria
      or new.tipo_item is distinct from old.tipo_item) then
    select r.estado into estado_rendicion from public.rendiciones r where r.id = old.rendicion_id;
    if estado_rendicion is distinct from 'Pendiente' then
      raise exception 'La rendición de este ítem ya fue procesada y no se puede modificar (estado actual: %).', estado_rendicion;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_proteger_aprobacion_item on public.rendicion_items;
create trigger trg_proteger_aprobacion_item
  before insert or update on public.rendicion_items
  for each row execute function public.proteger_aprobacion_item();

-- Defensa en profundidad (además del trigger de arriba): la propia policy
-- de INSERT ya exige que la rendición padre siga Pendiente.
drop policy if exists "items_insert_own" on public.rendicion_items;
create policy "items_insert_own" on public.rendicion_items
  for insert with check (
    public.is_activo()
    and exists (
      select 1 from public.rendiciones r
      where r.id = rendicion_items.rendicion_id and r.empleado_id = auth.uid() and r.estado = 'Pendiente'
    )
  );

-- ------------------------------------------------------------
-- solicitudes_fondos
-- ------------------------------------------------------------
create or replace function public.proteger_aprobacion_solicitud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin_or_aprobador() then
      new.estado := 'Pendiente';
      new.aprobador_id := null;
      new.aprobador_nombre := null;
      new.fecha_aprobacion := null;
    end if;
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

  if new.estado is distinct from old.estado and old.estado <> 'Pendiente' then
    raise exception 'Esta solicitud ya fue procesada (estado actual: %).', old.estado;
  end if;

  -- Nuevo: mismo criterio que rendiciones -- ver comentario arriba. Un
  -- fondo Aprobado dispara una transferencia real hecha por Finanzas fuera
  -- de la app, así que este campo importa tanto o más que el de rendiciones.
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

drop trigger if exists trg_proteger_aprobacion_solicitud on public.solicitudes_fondos;
create trigger trg_proteger_aprobacion_solicitud
  before insert or update on public.solicitudes_fondos
  for each row execute function public.proteger_aprobacion_solicitud();

-- ------------------------------------------------------------
-- rendicion_items_historial: el INSERT solo exigía usuario_id = auth.uid(),
-- sin ninguna relación real con la rendición/ítem -- cualquier autenticado
-- podía insertar una entrada de historial falsa ("Aprobado por María Pérez")
-- sobre una rendición ajena, contaminando el registro de auditoría que
-- "Ver historial de cambios" muestra como si fuera la fuente de verdad.
-- ------------------------------------------------------------
drop policy if exists "historial_insert" on public.rendicion_items_historial;
create policy "historial_insert" on public.rendicion_items_historial
  for insert with check (
    usuario_id = auth.uid()
    and exists (
      select 1 from public.rendiciones r
      where r.id = rendicion_items_historial.rendicion_id
      and (r.empleado_id = auth.uid() or public.is_admin_or_aprobador())
    )
  );
