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

-- Estas dos se agregaron después, en caliente y directo sobre producción
-- mientras se diagnosticaba el incidente de cuota del 2026-09-22, y por eso
-- faltaban acá: el esquema real y este archivo quedaron desincronizados, así
-- que reconstruir el proyecto desde el repositorio daba una instalación rota
-- (el código escribe estas columnas, PostgREST rechaza el insert entero si no
-- existen, y el error se traga un try/catch). Van como ALTER idempotente para
-- que sirva tanto en una base nueva como en la que ya las tiene.
--   ultimo_error:     mensaje crudo del último fallo, POR MODELO. Sin esto
--                     hubo que deducir qué fallaba mirando los tiempos entre
--                     intentos (horas de diagnóstico a ciegas).
--   disponible_desde: hasta cuándo no vale la pena volver a llamar a este
--                     modelo por cuota agotada. Es lo que evita gastar
--                     solicitudes para recibir el mismo rechazo.
alter table public.gemini_modelo_stats add column if not exists ultimo_error text;
alter table public.gemini_modelo_stats add column if not exists disponible_desde timestamptz;

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

-- ------------------------------------------------------------
-- registrar_intento_gemini: el incremento de estadística, atómico.
--
-- Antes esto se hacía desde la Edge Function con un select seguido de un
-- upsert, y tenía dos problemas:
--   1. Dos invocaciones concurrentes (la lectura en vivo y el agente de
--      segundo plano corren a la vez de forma rutinaria) leían el mismo
--      contador y se pisaban el incremento.
--   2. disponible_desde se escribía SIEMPRE, con null cuando el fallo no era
--      de cuota -- o sea que un timeout cualquiera BORRABA el enfriamiento de
--      un modelo que estaba sin cuota, y volvía a la lista a gastar
--      solicitudes para recibir el mismo rechazo.
--
-- Acá el éxito limpia el enfriamiento, un fallo de cuota lo fija, y cualquier
-- otro fallo lo deja como estaba.
-- ------------------------------------------------------------
create or replace function public.registrar_intento_gemini(
  p_modelo text,
  p_exito boolean,
  p_error text,
  p_enfriamiento timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.gemini_modelo_stats as g (
    modelo, intentos_ok, intentos_fail, ultimo_resultado, ultimo_intento,
    ultimo_error, disponible_desde, updated_at
  ) values (
    p_modelo,
    case when p_exito then 1 else 0 end,
    case when p_exito then 0 else 1 end,
    case when p_exito then 'ok' else 'fail' end,
    now(),
    case when p_exito then null else p_error end,
    p_enfriamiento,
    now()
  )
  on conflict (modelo) do update set
    intentos_ok   = g.intentos_ok   + case when p_exito then 1 else 0 end,
    intentos_fail = g.intentos_fail + case when p_exito then 0 else 1 end,
    ultimo_resultado = case when p_exito then 'ok' else 'fail' end,
    ultimo_intento = now(),
    ultimo_error = case when p_exito then null else p_error end,
    disponible_desde = case
      when p_exito then null                      -- respondió: ya no hay por qué enfriarlo
      when p_enfriamiento is not null then p_enfriamiento
      else g.disponible_desde                     -- fallo NO de cuota: no tocar
    end,
    updated_at = now();
$$;

-- Solo las Edge Functions (service role) la llaman; nadie más necesita poder
-- escribir estadística de modelos.
revoke execute on function public.registrar_intento_gemini(text, boolean, text, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Procedencia y confiabilidad del dato, guardadas junto al ítem.
--
--   monto_verificado: el total se confirmó con la aritmética del propio
--     documento (neto + IVA = total, IVA 19%). Quien aprueba necesita poder
--     distinguir eso de un monto deducido por heurística; hasta ahora se
--     mostraba en pantalla al cargar y se perdía.
--   ocr_origen: de dónde salieron los datos ('local', 'ia', 'local+ia').
--     Sin esto no había forma de notar que el parser local se degradó (ej.
--     un proveedor cambió el formato de su factura): simplemente empezarían
--     a llegar más comprobantes a la IA, se acabaría la cuota antes y nadie
--     sabría por qué. Se guarda acá, junto al ítem, en vez de con una
--     llamada de red aparte: no cuesta ninguna solicitud extra.
-- ------------------------------------------------------------
alter table public.rendicion_items add column if not exists monto_verificado boolean;
alter table public.rendicion_items add column if not exists ocr_origen text
  check (ocr_origen in ('local', 'ia', 'local+ia'));
