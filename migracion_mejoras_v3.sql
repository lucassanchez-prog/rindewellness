-- ============================================================
-- Mejoras de rendimiento, presupuestos y limpieza (ronda 3, sept. 2026)
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query
-- ============================================================

-- ------------------------------------------------------------
-- 1) Índices que faltaban -- sin ellos, el detector de duplicados
-- (buscar_documento_duplicado) y "Ver historial de cambios" van a
-- hacer un escaneo secuencial completo de la tabla apenas crezca el
-- histórico (hoy no se nota con pocos cientos de filas, pero es
-- justo el tipo de cosa que hay que dejar resuelta antes de que
-- empiece a doler).
-- ------------------------------------------------------------
create index if not exists idx_rendicion_items_rut_nro
  on public.rendicion_items(rut_proveedor, nro_documento)
  where estado <> 'Rechazado';

create index if not exists idx_historial_rendicion_id
  on public.rendicion_items_historial(rendicion_id, created_at desc);

-- ------------------------------------------------------------
-- 2) Presupuestos: límite mensual de gasto por empresa, para poder
-- avisar ANTES de pasarse (en vez de enterarse recién al mirar el
-- reporte del mes siguiente). Simple a propósito -- un monto por
-- empresa, sin desglosar por centro de costo/categoría todavía; si
-- se necesita más granularidad se puede agregar después sin romper
-- esto.
-- ------------------------------------------------------------
create table if not exists public.presupuestos (
  id uuid primary key default gen_random_uuid(),
  empresa text not null unique,
  monto_limite_mensual numeric(12,2) not null check (monto_limite_mensual > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.presupuestos enable row level security;

drop policy if exists "presupuestos_select" on public.presupuestos;
drop policy if exists "presupuestos_admin_write" on public.presupuestos;

-- Cualquier aprobador/admin/delegado lo necesita para ver el aviso al
-- crear una rendición o revisar Reportes -- solo el admin lo edita.
create policy "presupuestos_select" on public.presupuestos
  for select using (public.is_admin_or_aprobador());

create policy "presupuestos_admin_write" on public.presupuestos
  for all using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 3) system_events: falta un índice para el nuevo panel de "salud
-- del sistema" (cuenta eventos de los últimos 7 días agrupados por
-- tipo) -- ya existe idx_system_events_tipo_created de la migración
-- anterior, que cubre exactamente esta consulta, así que no hace
-- falta nada nuevo acá. Se deja el comentario para que quede
-- documentado por qué esta sección no agrega un índice.
-- ------------------------------------------------------------
