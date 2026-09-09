-- ============================================================
-- Migración: Aprobación por ítem
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query > Run
-- (proyecto RindeWellness, el de lectura/escritura)
-- ============================================================

-- El aprobador puede aceptar o rechazar cada gasto por separado (ej. una
-- boleta ilegible) sin tener que rechazar toda la rendición. Los ítems
-- Rechazados quedan fuera del monto_total y del comprobante Kame; la
-- "Aprobación general" recién se puede cerrar cuando ningún ítem queda en
-- Pendiente.
alter table public.rendicion_items add column if not exists estado text not null default 'Pendiente' check (estado in ('Pendiente','Aprobado','Rechazado'));
alter table public.rendicion_items add column if not exists motivo_rechazo text;

-- Backfill: las rendiciones que ya estaban Aprobadas/Rechazadas antes de
-- este cambio dejan sus ítems reflejando el mismo estado final (si no,
-- quedarían mostrando "Pendiente" para siempre).
update public.rendicion_items ri
set estado = r.estado
from public.rendiciones r
where r.id = ri.rendicion_id and r.estado in ('Aprobado', 'Rechazado') and ri.estado = 'Pendiente';
