-- ============================================================
-- Mejoras de seguridad, confiabilidad y producto (revisión con 5
-- agentes de IA, sept. 2026)
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query
-- ============================================================

-- ------------------------------------------------------------
-- 1) Auto-aprobación: un aprobador/admin no puede aprobar ni
-- rechazar su PROPIA rendición/ítem/solicitud. Antes solo se exigía
-- "quien aprueba es aprobador o admin", sin comparar contra el dueño
-- de la fila -- un aprobador podía cargar su propio gasto y
-- aprobárselo a sí mismo, sin que nadie más lo revisara. Se cierra
-- tanto por UPDATE (flujo normal de la app) como por INSERT directo
-- (alguien insertando su propia fila ya "Aprobada" de entrada).
-- ------------------------------------------------------------

create or replace function public.proteger_aprobacion_rendicion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric(12,2);
begin
  if tg_op = 'INSERT' then
    -- Antes: solo se forzaba Pendiente si quien inserta NO es
    -- aprobador/admin. Un aprobador insertando SU PROPIA rendición ya
    -- "Aprobada" se saltaba esto por completo -- ahora también se
    -- fuerza Pendiente cuando la fila es del propio empleado, sin
    -- importar su rol.
    if not public.is_admin_or_aprobador() or new.empleado_id = auth.uid() then
      new.estado := 'Pendiente';
      new.aprobador_id := null;
      new.aprobador_nombre := null;
      new.fecha_aprobacion := null;
      new.numero_comprobante_kame := null;
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE' de acá para abajo.
  if (new.estado is distinct from old.estado
      or new.aprobador_id is distinct from old.aprobador_id
      or new.aprobador_nombre is distinct from old.aprobador_nombre
      or new.fecha_aprobacion is distinct from old.fecha_aprobacion
      or new.motivo_rechazo is distinct from old.motivo_rechazo
      or new.numero_comprobante_kame is distinct from old.numero_comprobante_kame)
     and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador o admin puede aprobar/rechazar una rendición.';
  end if;

  if new.estado is distinct from old.estado and old.estado = 'Pendiente'
     and new.estado in ('Aprobado', 'Rechazado') and old.empleado_id = auth.uid() then
    raise exception 'No puedes aprobar o rechazar tu propia rendición.';
  end if;

  if new.estado is distinct from old.estado and old.estado <> 'Pendiente' then
    raise exception 'Esta rendición ya fue procesada (estado actual: %).', old.estado;
  end if;

  -- Recalcula monto_total del lado del servidor cuando la rendición
  -- se termina de aprobar/rechazar -- antes se confiaba ciegamente en
  -- lo que mandara el cliente (finalizarAprobacionRendicion en
  -- app.js), así que una sesión de aprobador comprometida (o un POST
  -- directo a la API) podía aprobar con un total arbitrario, sin
  -- relación real con los ítems Aprobados. Se ignora lo que venga en
  -- new.monto_total y se pisa con la suma real.
  if new.estado is distinct from old.estado and old.estado = 'Pendiente' and new.estado in ('Aprobado', 'Rechazado') then
    select coalesce(sum(monto), 0) into v_total
    from public.rendicion_items
    where rendicion_id = new.id and estado = 'Aprobado';
    new.monto_total := v_total;
  end if;

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

create or replace function public.proteger_aprobacion_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  estado_rendicion text;
  empleado_rendicion uuid;
begin
  -- OJO: "old" no existe todavía durante un INSERT (ni siquiera dentro de
  -- un coalesce(new.x, old.x) -- plpgsql igual intenta resolver ambos lados
  -- antes de evaluar la función, y revienta con "record old is not
  -- assigned yet"). Por eso la consulta va DENTRO de cada rama, usando new
  -- o old según corresponda, en vez de una sola consulta compartida arriba.
  if tg_op = 'INSERT' then
    select r.estado, r.empleado_id into estado_rendicion, empleado_rendicion
    from public.rendiciones r where r.id = new.rendicion_id;
    if not public.is_admin_or_aprobador() or empleado_rendicion = auth.uid() then
      new.estado := 'Pendiente';
      new.motivo_rechazo := null;
      new.existe_en_contabilidad := null;
      new.comprobante_contable_encontrado := null;
    end if;
    if estado_rendicion is distinct from 'Pendiente' and not public.is_admin_or_aprobador() then
      raise exception 'No se pueden agregar ítems a una rendición ya procesada (estado actual: %).', estado_rendicion;
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE' de acá para abajo -- acá "old" ya existe, así que la
  -- consulta usa old.rendicion_id (nunca cambia entre new/old de todas
  -- formas, rendicion_id no es editable).
  select r.estado, r.empleado_id into estado_rendicion, empleado_rendicion
  from public.rendiciones r where r.id = old.rendicion_id;

  if (new.estado is distinct from old.estado
      or new.motivo_rechazo is distinct from old.motivo_rechazo
      or new.existe_en_contabilidad is distinct from old.existe_en_contabilidad
      or new.comprobante_contable_encontrado is distinct from old.comprobante_contable_encontrado)
     and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador o admin puede aprobar/rechazar o verificar un ítem.';
  end if;

  if new.estado is distinct from old.estado and new.estado in ('Aprobado', 'Rechazado') and empleado_rendicion = auth.uid() then
    raise exception 'No puedes aprobar o rechazar ítems de tu propia rendición.';
  end if;

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
    if estado_rendicion is distinct from 'Pendiente' then
      raise exception 'La rendición de este ítem ya fue procesada y no se puede modificar (estado actual: %).', estado_rendicion;
    end if;
  end if;

  -- cuenta_contable queda AFUERA de la lista de arriba a propósito -- un
  -- aprobador/admin puede seguir corrigiéndola después de aprobar (la usa
  -- "Verificar en contabilidad"). Pero la policy items_update_approver deja
  -- actualizar la fila a SU DUEÑO en cualquier momento (sin mirar el estado
  -- de la rendición) -- sin este chequeo aparte, el propio empleado podía
  -- reescribir la cuenta contable de su gasto YA aprobado con un UPDATE
  -- directo a la API, sin pasar por "Verificar en contabilidad" ni dejar
  -- rastro (encontrado en una revisión de seguridad posterior al deploy).
  if new.cuenta_contable is distinct from old.cuenta_contable
     and estado_rendicion is distinct from 'Pendiente'
     and not public.is_admin_or_aprobador() then
    raise exception 'La rendición de este ítem ya fue procesada y no se puede modificar (estado actual: %).', estado_rendicion;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_proteger_aprobacion_item on public.rendicion_items;
create trigger trg_proteger_aprobacion_item
  before insert or update on public.rendicion_items
  for each row execute function public.proteger_aprobacion_item();

create or replace function public.proteger_aprobacion_solicitud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin_or_aprobador() or new.empleado_id = auth.uid() then
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

  if new.estado is distinct from old.estado and old.estado = 'Pendiente'
     and new.estado in ('Aprobado', 'Rechazado') and old.empleado_id = auth.uid() then
    raise exception 'No puedes aprobar o rechazar tu propia solicitud de fondos.';
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

drop trigger if exists trg_proteger_aprobacion_solicitud on public.solicitudes_fondos;
create trigger trg_proteger_aprobacion_solicitud
  before insert or update on public.solicitudes_fondos
  for each row execute function public.proteger_aprobacion_solicitud();

-- ------------------------------------------------------------
-- 2) is_activo() también en UPDATE: antes solo se exigía al crear
-- filas nuevas (INSERT). Una persona desactivada, con sesión viva,
-- podía seguir editando el contenido de sus propias rendiciones/
-- ítems/solicitudes mientras siguieran Pendientes.
-- ------------------------------------------------------------
drop policy if exists "rendiciones_update_approver" on public.rendiciones;
create policy "rendiciones_update_approver" on public.rendiciones
  for update using (
    (empleado_id = auth.uid() and public.is_activo()) or public.is_admin_or_aprobador()
  );

drop policy if exists "items_update_approver" on public.rendicion_items;
create policy "items_update_approver" on public.rendicion_items
  for update using (
    exists (
      select 1 from public.rendiciones r
      where r.id = rendicion_items.rendicion_id
      and ((r.empleado_id = auth.uid() and public.is_activo()) or public.is_admin_or_aprobador())
    )
  );

drop policy if exists "solicitudes_fondos_update_approver" on public.solicitudes_fondos;
create policy "solicitudes_fondos_update_approver" on public.solicitudes_fondos
  for update using (
    (empleado_id = auth.uid() and public.is_activo()) or public.is_admin_or_aprobador()
  );

-- ------------------------------------------------------------
-- 3) Límites del bucket de comprobantes: antes "accept" en el
-- <input type=file> era solo un filtro de UI (app.js), sin nada
-- real del lado del servidor -- cualquiera podía subir un archivo de
-- cualquier tipo/tamaño directo a la API de Storage.
-- ------------------------------------------------------------
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
    file_size_limit = 15728640 -- 15 MB
where id = 'comprobantes';

-- ------------------------------------------------------------
-- 4) Registro de eventos del sistema: hasta ahora, si fallaba un
-- envío de correo (Resend) o una llamada a OCR (Gemini), quedaba
-- solo en la consola del navegador de quien lo disparó -- nadie en
-- el equipo se enteraba hasta que alguien reclamara "nunca me llegó
-- el correo". Esta tabla la usan las Edge Functions (con el service
-- role, que salta RLS) para dejar registro de fallos, y también como
-- límite simple de frecuencia (ver rate-limit en ocr-recibo /
-- notificar-*). Solo el admin puede leerla desde la app.
-- ------------------------------------------------------------
create table if not exists public.system_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tipo text not null,
  usuario_id uuid references auth.users(id) on delete set null,
  rendicion_id uuid references public.rendiciones(id) on delete set null,
  detalle text,
  metadata jsonb
);

create index if not exists idx_system_events_tipo_created on public.system_events(tipo, created_at desc);
create index if not exists idx_system_events_usuario on public.system_events(usuario_id, tipo, created_at desc);

alter table public.system_events enable row level security;

drop policy if exists "system_events_select_admin" on public.system_events;
drop policy if exists "system_events_insert_own" on public.system_events;
drop policy if exists "system_events_insert_admin" on public.system_events;

create policy "system_events_select_admin" on public.system_events
  for select using (public.is_admin());

-- Las Edge Functions insertan con el service role (salta RLS, así que esta
-- policy no las afecta). El frontend NUNCA inserta acá directo (no llegó a
-- implementarse esa parte) -- así que "usuario_id = auth.uid()" quedaba
-- como una policy de insert abierta a cualquier autenticado, sin relación
-- real con la fila, sin ningún llamador legítimo que la necesitara. Un
-- authenticated cualquiera podía insertar un evento falso (ej.
-- "notificar_aprobador_ok" para el rendicion_id de otra persona) y usarlo
-- para pisar el límite de frecuencia y suprimir el aviso real por correo
-- (encontrado en una revisión de seguridad posterior al deploy). Se cierra
-- del todo: solo el service role (que salta RLS) puede insertar.
create policy "system_events_insert_admin" on public.system_events
  for insert with check (public.is_admin());

-- ------------------------------------------------------------
-- 5) Detector de comprobantes duplicados: mismo RUT proveedor + N°
-- de documento ya registrado en otra rendición no rechazada. Un
-- empleado normal no podría ver esto por su cuenta (RLS solo le deja
-- ver SUS PROPIAS rendiciones) -- esta función SECURITY DEFINER
-- expone la mínima información necesaria (folio, estado, quién la
-- rindió) para avisar "esto ya se cargó antes", sin exponer el resto
-- del contenido de una rendición ajena.
-- ------------------------------------------------------------
create or replace function public.buscar_documento_duplicado(p_rut text, p_nro text)
returns table(folio bigint, rendicion_id uuid, estado text, empleado_nombre text)
language sql
security definer
set search_path = public
stable
as $$
  select r.folio, r.id, r.estado, r.empleado_nombre
  from public.rendicion_items ri
  join public.rendiciones r on r.id = ri.rendicion_id
  where p_rut is not null and p_rut <> ''
    and p_nro is not null and p_nro <> ''
    and ri.rut_proveedor = p_rut
    and ri.nro_documento = p_nro
    and ri.estado <> 'Rechazado'
  order by r.created_at desc
  limit 5;
$$;

grant execute on function public.buscar_documento_duplicado(text, text) to authenticated;

-- ------------------------------------------------------------
-- 6) Delegación temporal de aprobación: para cuando el único
-- aprobador/admin de turno está de vacaciones o con licencia. Solo
-- un admin puede activar/desactivar la delegación de otra persona
-- (mismo patrón que "rol"/"plantilla_id"/"activo" -- protegido por
-- trigger, no confiado a RLS de columna). Mientras está activa y no
-- vencida, esa persona cuenta como aprobador para todo efecto
-- (is_admin_or_aprobador), incluida la notificación de nuevas
-- rendiciones/solicitudes pendientes.
-- ------------------------------------------------------------
alter table public.profiles add column if not exists delegado_activo boolean not null default false;
alter table public.profiles add column if not exists delegado_hasta timestamptz;

create or replace function public.is_admin_or_aprobador()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.activo and (
      p.rol in ('aprobador', 'admin')
      or (p.delegado_activo and (p.delegado_hasta is null or p.delegado_hasta > now()))
    )
  );
$$;

create or replace function public.proteger_plantilla_activo_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      new.plantilla_id := null;
      new.activo := true;
      new.delegado_activo := false;
      new.delegado_hasta := null;
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.plantilla_id is distinct from old.plantilla_id
        or new.activo is distinct from old.activo
        or new.delegado_activo is distinct from old.delegado_activo
        or new.delegado_hasta is distinct from old.delegado_hasta)
       and not public.is_admin() then
      new.plantilla_id := old.plantilla_id;
      new.activo := old.activo;
      new.delegado_activo := old.delegado_activo;
      new.delegado_hasta := old.delegado_hasta;
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 7) Recordatorios de pendientes: columna para no reenviar el mismo
-- aviso todos los días (ver Edge Function recordatorios-pendientes).
-- ------------------------------------------------------------
alter table public.rendiciones add column if not exists ultimo_recordatorio timestamptz;
alter table public.solicitudes_fondos add column if not exists ultimo_recordatorio timestamptz;
