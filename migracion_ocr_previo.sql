-- ============================================================
-- Cola de OCR PRE-envío ("el agente toma el rol de inmediato, no al
-- momento de enviar" -- pedido del usuario, 2026-09-22).
--
-- Motivo: migracion_ocr_reintento.sql ya deja que el agente reintente en
-- segundo plano, pero recién a partir de que la rendición se envía --
-- antes de eso el comprobante solo vive en el navegador, así que no hay
-- nada que un proceso del servidor pueda leer. Esta tabla es el lugar
-- donde el comprobante queda apenas falla la lectura en vivo (ocr-recibo),
-- ANTES de que exista ninguna rendición: el agente empieza a trabajar en
-- el archivo mientras la persona sigue llenando el resto del formulario,
-- no recién cuando aprieta "Enviar a aprobación".
--
-- Si el resultado llega mientras el formulario sigue abierto, se aplica
-- directo a los campos (igual que una lectura en vivo exitosa -- en esta
-- etapa nada se ha guardado ni decidido todavía, así que no hace falta
-- tratarlo como sugerencia no vinculante). Si la persona ya envió la
-- rendición antes de que el agente termine, esta fila queda huérfana a
-- propósito -- el ítem ya guardado usa su PROPIA cola
-- (rendicion_items.ocr_reintento_estado, ver la otra migración) desde
-- cero; limpiar-storage-huerfano barre estas filas viejas junto con sus
-- archivos.
-- ============================================================

create table if not exists public.ocr_previos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'listo', 'agotado')),
  resultado jsonb,
  intentos int not null default 0,
  ultimo_intento timestamptz,
  created_at timestamptz not null default now()
);

alter table public.ocr_previos enable row level security;

drop policy if exists "ocr_previos_select_propio" on public.ocr_previos;
drop policy if exists "ocr_previos_insert_propio" on public.ocr_previos;

-- Cada persona ve y crea solo sus propias filas -- nadie más necesita verlas
-- (no hay ningún flujo de aprobación acá, es puramente interno al propio
-- formulario de quien está creando la rendición). Ni UPDATE ni DELETE para
-- usuarios normales: solo el service role (la Edge Function) escribe el
-- resultado.
create policy "ocr_previos_select_propio" on public.ocr_previos
  for select using (usuario_id = auth.uid());

create policy "ocr_previos_insert_propio" on public.ocr_previos
  for insert with check (usuario_id = auth.uid());

create index if not exists idx_ocr_previos_pendiente
  on public.ocr_previos (ultimo_intento)
  where estado = 'pendiente';

-- Deploy después de correr esto:
--   supabase functions deploy ocr-recibo
--   supabase functions deploy ocr-reintento-pendientes
-- (ocr-recibo ahora sube el archivo a Storage y crea esta fila cuando falla
-- en vivo; ocr-reintento-pendientes ahora también procesa esta cola.)

-- ------------------------------------------------------------
-- datos_parciales: lo que la lectura LOCAL (pdf.js en el navegador) alcanzó
-- a sacar del documento antes de que fallara la llamada a la IA.
--
-- Sin esto, el agente en segundo plano reprocesaba el comprobante entero
-- desde cero aunque el RUT, el folio y el monto ya se supieran con certeza
-- -- gastaba una solicitud completa de Gemini (de las ~20 por modelo al día
-- que hay) para volver a averiguar lo ya averiguado, y encima su resultado,
-- que sale de interpretar una imagen, podía contradecir un dato que se había
-- leído del TEXTO del documento. Ahora arranca desde acá: le pide a Gemini
-- solo los campos que faltan y fusiona sin pisar lo determinista.
-- ------------------------------------------------------------
alter table public.ocr_previos add column if not exists datos_parciales jsonb;

-- ------------------------------------------------------------
-- contenido_hash: SHA-256 del contenido del archivo, para no encolar el
-- mismo comprobante más de una vez.
--
-- Antes, cada "Reintentar con IA" que volvía a fallar insertaba una fila
-- nueva con OTRA copia del archivo en Storage, y el agente en segundo plano
-- reintentaba cada una por separado: la misma factura leída N veces, una por
-- cada vez que la persona insistió. Contra una cuota de ~20 solicitudes por
-- modelo AL DÍA, un solo comprobante difícil podía consumir el cupo de toda
-- la empresa.
--
-- El índice es PARCIAL (solo estado='pendiente') a propósito: dos lecturas
-- del mismo archivo en momentos distintos son legítimas si la primera ya se
-- resolvió o se agotó; lo que no tiene sentido es tener dos EN COLA a la vez.
-- ------------------------------------------------------------
alter table public.ocr_previos add column if not exists contenido_hash text;

create unique index if not exists idx_ocr_previos_dedup_pendiente
  on public.ocr_previos (usuario_id, contenido_hash)
  where estado = 'pendiente' and contenido_hash is not null;
