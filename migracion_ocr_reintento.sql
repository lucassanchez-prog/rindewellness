-- ============================================================
-- Reintento en segundo plano del OCR de comprobantes ("el agente que vive
-- en Supabase" que pidió el usuario, 2026-09-22).
--
-- Motivo: el nivel gratuito de la API de Gemini viene sufriendo cortes
-- reales de "high demand" que pueden durar horas -- ocr-recibo (la llamada
-- EN VIVO cuando alguien adjunta un comprobante) ya prueba varios modelos
-- y deja un botón "Reintentar con IA", pero si la persona no vuelve a
-- intentarlo (o Gemini sigue caído en ese momento), el comprobante queda
-- sin leer para siempre. Esta migración agrega una cola: cuando el OCR en
-- vivo falla para un ítem "Con documento", queda marcado como pendiente, y
-- un job programado (pg_cron, cada 5 minutos) llama a la Edge Function
-- ocr-reintento-pendientes, que reintenta esos comprobantes SIN que nadie
-- tenga el navegador abierto. El resultado es una SUGERENCIA aparte
-- (ocr_reintento_resultado) -- nunca pisa lo que la persona ya completó a
-- mano ni lo que ya quedó guardado.
--
-- PASOS PARA APLICAR (en orden):
--   1. Correr este archivo completo en el SQL Editor de Supabase.
--   2. Generar un secreto random largo (ej. en una terminal:
--      openssl rand -hex 32, o cualquier generador de contraseñas largas) y
--      guardarlo en Vault -- NO en un archivo, corre esta línea directo en
--      el SQL Editor, reemplazando <TU-VALOR-RANDOM-LARGO>:
--        select vault.create_secret('<TU-VALOR-RANDOM-LARGO>', 'ocr_cron_secret');
--   3. Configurar el mismo valor como secret de la Edge Function:
--        supabase secrets set CRON_SECRET=<EL-MISMO-VALOR-RANDOM-LARGO>
--   4. Desplegar las funciones:
--        supabase functions deploy ocr-recibo
--        supabase functions deploy ocr-reintento-pendientes
-- ============================================================

-- ------------------------------------------------------------
-- Columnas nuevas en rendicion_items
-- ------------------------------------------------------------
alter table public.rendicion_items add column if not exists ocr_reintento_estado text
  check (ocr_reintento_estado in ('pendiente', 'listo', 'agotado'));
alter table public.rendicion_items add column if not exists ocr_reintento_resultado jsonb;
alter table public.rendicion_items add column if not exists ocr_reintento_intentos int not null default 0;
alter table public.rendicion_items add column if not exists ocr_reintento_ultimo timestamptz;

-- Índice parcial: el job solo consulta filas con estado='pendiente', y son
-- una fracción chica del total de ítems -- un índice completo desperdicia
-- espacio indexando también los que nunca se van a volver a buscar así
-- (null, 'listo', 'agotado').
create index if not exists idx_rendicion_items_ocr_reintento_pendiente
  on public.rendicion_items (ocr_reintento_ultimo)
  where ocr_reintento_estado = 'pendiente';

-- ------------------------------------------------------------
-- gemini_modelo_stats: la "memoria" que deja que ocr-recibo y
-- ocr-reintento-pendientes aprendan cuál modelo probar primero (ver
-- ordenarModelosPorRendimiento en _shared/gemini-ocr.ts). Sin RLS abierta a
-- nadie -- solo la tocan las Edge Functions con el service role, que
-- siempre se salta RLS igual; se deja RLS activada y sin policies como
-- postura por defecto de este proyecto (ver el resto de las tablas), no
-- porque haga falta acá.
-- ------------------------------------------------------------
create table if not exists public.gemini_modelo_stats (
  modelo text primary key,
  intentos_ok int not null default 0,
  intentos_fail int not null default 0,
  ultimo_resultado text check (ultimo_resultado in ('ok', 'fail')),
  ultimo_intento timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.gemini_modelo_stats enable row level security;

-- ------------------------------------------------------------
-- pg_cron + pg_net: si estos "create extension" fallan por permisos,
-- activalas primero desde el Dashboard de Supabase
-- (Database > Extensions > buscar "pg_cron" y "pg_net") y volvé a correr
-- este archivo.
-- ------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Idempotente: si esta migración se corre dos veces, no queda el job
-- duplicado corriendo cada 5 minutos por partida doble.
select cron.unschedule(jobid) from cron.job where jobname = 'ocr-reintento-pendientes';

select cron.schedule(
  'ocr-reintento-pendientes',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://rbmmwgndtrgdzherqxko.supabase.co/functions/v1/ocr-reintento-pendientes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ocr_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Verificación rápida: esto debería devolver una fila con
-- jobname='ocr-reintento-pendientes' y schedule='*/5 * * * *'.
-- select * from cron.job where jobname = 'ocr-reintento-pendientes';
