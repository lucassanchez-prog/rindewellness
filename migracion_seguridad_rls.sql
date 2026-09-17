-- ============================================================
-- Migración de seguridad: cierra huecos de RLS detectados en revisión.
-- Ejecutar completo en el SQL Editor de Supabase.
--
-- Problema real: las policies de RLS existentes permiten a CUALQUIER
-- usuario autenticado hacer un UPDATE directo vía la API REST de
-- Supabase (sin pasar por la app) y:
--   1) cambiar su propio "rol" a admin,
--   2) auto-aprobar su propia rendición / ítem / solicitud de fondos,
--      sin que ningún aprobador la revise.
-- Estos triggers cierran ambos huecos del lado del servidor (no basta
-- con que la UI no muestre el botón: RLS es el único gate real).
--
-- De paso corrigen una condición de carrera (dos aprobadores procesando
-- la misma rendición/ítem casi al mismo tiempo) y agregan el registro
-- de auditoría que faltaba para la aprobación/rechazo por ítem.
-- ============================================================

-- ------------------------------------------------------------
-- 1) profiles.rol: solo un admin puede cambiar el rol de alguien.
-- ------------------------------------------------------------
create or replace function public.proteger_rol_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.rol is distinct from 'empleado' and not public.is_admin() then
      new.rol := 'empleado';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.rol is distinct from old.rol and not public.is_admin() then
      new.rol := old.rol;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_proteger_rol_profile on public.profiles;
create trigger trg_proteger_rol_profile
  before insert or update on public.profiles
  for each row execute function public.proteger_rol_profile();

-- ------------------------------------------------------------
-- 2) rendiciones: solo aprobador/admin puede tocar los campos de
--    aprobación, y el estado solo puede salir de "Pendiente" una vez
--    (evita doble-aprobación si dos aprobadores hacen clic a la vez).
-- ------------------------------------------------------------
create or replace function public.proteger_aprobacion_rendicion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

  return new;
end;
$$;

drop trigger if exists trg_proteger_aprobacion_rendicion on public.rendiciones;
create trigger trg_proteger_aprobacion_rendicion
  before update on public.rendiciones
  for each row execute function public.proteger_aprobacion_rendicion();

-- ------------------------------------------------------------
-- 3) rendicion_items: mismo criterio para el estado / verificación
--    contable de cada ítem individual.
-- ------------------------------------------------------------
-- OJO: a diferencia de rendiciones/solicitudes, acá NO se bloquea volver a
-- cambiar el estado una vez que salió de "Pendiente": mientras la rendición
-- completa siga Pendiente, el aprobador puede aprobar/rechazar cada ítem
-- las veces que quiera antes de pulsar "Finalizar aprobación" (es el
-- comportamiento ya existente de la app). Lo único que se cierra acá es
-- que solo un aprobador/admin puede tocar estos campos.
create or replace function public.proteger_aprobacion_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.estado is distinct from old.estado
      or new.motivo_rechazo is distinct from old.motivo_rechazo
      or new.existe_en_contabilidad is distinct from old.existe_en_contabilidad
      or new.comprobante_contable_encontrado is distinct from old.comprobante_contable_encontrado)
     and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador o admin puede aprobar/rechazar o verificar un ítem.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_proteger_aprobacion_item on public.rendicion_items;
create trigger trg_proteger_aprobacion_item
  before update on public.rendicion_items
  for each row execute function public.proteger_aprobacion_item();

-- 3b) Deja rastro en el historial de auditoría cuando un ítem cambia de
--     estado (antes solo quedaba el estado final, sin registro de quién
--     aprobó/rechazó y cuándo).
create or replace function public.auditar_cambio_estado_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.estado is distinct from old.estado then
    insert into public.rendicion_items_historial
      (item_id, rendicion_id, usuario_id, usuario_nombre, campo, valor_anterior, valor_nuevo)
    select new.id, new.rendicion_id, auth.uid(),
           (select nombre from public.profiles where id = auth.uid()),
           'estado', old.estado, new.estado;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_auditar_cambio_estado_item on public.rendicion_items;
create trigger trg_auditar_cambio_estado_item
  after update on public.rendicion_items
  for each row execute function public.auditar_cambio_estado_item();

-- ------------------------------------------------------------
-- 4) solicitudes_fondos: mismo criterio que rendiciones.
-- ------------------------------------------------------------
create or replace function public.proteger_aprobacion_solicitud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

  return new;
end;
$$;

drop trigger if exists trg_proteger_aprobacion_solicitud on public.solicitudes_fondos;
create trigger trg_proteger_aprobacion_solicitud
  before update on public.solicitudes_fondos
  for each row execute function public.proteger_aprobacion_solicitud();

-- ------------------------------------------------------------
-- 5) Cuentas contables permitidas por perfil: la restricción de
--    "cuentas permitidas" hoy solo se aplica en el navegador (filtra el
--    <select>). Este trigger repite la misma regla del lado del
--    servidor para un ítem "Gasto directo" (SinDocumento) cargado por
--    su propio dueño, para que no se pueda saltar llamando directo a
--    la API. Un aprobador/admin corrigiendo la cuenta al verificar en
--    contabilidad NO está sujeto a esta restricción.
-- ------------------------------------------------------------
create or replace function public.validar_cuenta_permitida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  es_propio boolean;
  tiene_restricciones boolean;
  cuenta_permitida boolean;
begin
  if new.tipo_item <> 'SinDocumento' or new.cuenta_contable is null or new.cuenta_contable = '' then
    return new;
  end if;

  select exists (
    select 1 from public.rendiciones r
    where r.id = new.rendicion_id and r.empleado_id = auth.uid()
  ) into es_propio;

  if not es_propio then
    return new;
  end if;

  select exists (
    select 1 from public.perfil_cuentas where profile_id = auth.uid()
  ) into tiene_restricciones;

  if not tiene_restricciones then
    return new;
  end if;

  select exists (
    select 1 from public.perfil_cuentas
    where profile_id = auth.uid() and cuenta_cod = new.cuenta_contable
  ) into cuenta_permitida;

  if not cuenta_permitida then
    raise exception 'La cuenta % no está habilitada para tu perfil.', new.cuenta_contable;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validar_cuenta_permitida on public.rendicion_items;
create trigger trg_validar_cuenta_permitida
  before insert or update on public.rendicion_items
  for each row execute function public.validar_cuenta_permitida();

-- ------------------------------------------------------------
-- 6) Integridad de datos: montos siempre positivos.
-- ------------------------------------------------------------
alter table public.rendicion_items drop constraint if exists rendicion_items_monto_positivo;
alter table public.rendicion_items add constraint rendicion_items_monto_positivo check (monto > 0);

alter table public.rendiciones drop constraint if exists rendiciones_monto_total_no_negativo;
alter table public.rendiciones add constraint rendiciones_monto_total_no_negativo check (monto_total >= 0);

alter table public.solicitudes_fondos drop constraint if exists solicitudes_fondos_monto_positivo;
alter table public.solicitudes_fondos add constraint solicitudes_fondos_monto_positivo check (monto_solicitado > 0);
