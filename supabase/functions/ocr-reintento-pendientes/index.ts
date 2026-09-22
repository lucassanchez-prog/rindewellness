// Edge Function: ocr-reintento-pendientes
// El "agente" que vive en Supabase que reintenta, en segundo plano, los
// comprobantes que ocr-recibo no pudo leer en el momento (ej. Gemini con
// "high demand" del nivel gratuito -- ver el historial de hoy). No hace
// falta que la persona tenga el navegador abierto ni que apriete
// "Reintentar con IA": esto corre solo, programado con pg_cron (ver
// migracion_ocr_reintento.sql), cada pocos minutos.
//
// "Aprende" cuál modelo de Gemini probar primero (ver _shared/gemini-ocr.ts,
// gemini_modelo_stats) y se auto-frena si detecta que la corrida anterior
// falló casi entera -- durante una caída generalizada de Gemini, insistir
// cada 5 minutos contra TODOS los pendientes solo gasta los MAX_INTENTOS de
// cada ítem sin ninguna chance real de éxito; mejor espaciar los intentos y
// guardarlos para cuando la capacidad vuelva.
//
// Solo procesa ítems "ConDocumento" (facturas/boletas de honorarios) de
// rendiciones que SIGUEN Pendiente -- son los que de verdad necesitan
// RUT/folio/monto correctos para Kame; en "Boleta" (SinDocumento) la
// categoría/CC las define la persona igual, y el monto/descripción casi
// siempre ya quedaron completados a mano si la IA falló la primera vez. Una
// rendición ya Aprobada/Rechazada no tiene sentido seguir reintentándola:
// nadie va a mirar una sugerencia de IA para algo que ya se resolvió.
//
// El resultado NUNCA pisa datos ya guardados: se guarda aparte
// (ocr_reintento_resultado) como una SUGERENCIA visible para quien revisa
// el ítem, igual que la sugerencia de cuenta contable que ya existía --
// aplicarlo o no queda a criterio humano, a través del flujo normal de
// edición (que ya respeta los bloqueos de contenido post-aprobación).
//
// No requiere sesión de usuario (no hay ninguna persona logueada disparando
// esto) -- en cambio, exige un secret compartido (CRON_SECRET) que solo
// conoce el propio job de pg_cron.
//
// Deploy: supabase functions deploy ocr-reintento-pendientes
// Secrets: supabase secrets set CRON_SECRET=<valor-random-largo>
//          (además de GEMINI_API_KEY, que ya debería estar configurado)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent } from "../_shared/logging.ts";
import { leerComprobante } from "../_shared/gemini-ocr.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Pocos ítems por corrida (no todos los pendientes de una sola vez): cada
// uno puede tardar hasta ~22s (ver TIEMPO_MAX_TOTAL_MS en gemini-ocr.ts), y
// las Edge Functions tienen su propio límite de tiempo total de ejecución.
// Con el cron corriendo cada 5 minutos, un lote chico igual vacía la cola
// rápido sin arriesgar que la función se corte a la mitad de un lote grande.
const LOTE = 5;
// Tope de reintentos por ítem -- si un comprobante lleva 6 pasadas sin
// éxito (con el cron cada 5 min, más de media hora de intentos reales, no
// solo un par de segundos), probablemente el problema es el documento en
// sí (ilegible, corrupto) y no la disponibilidad de Gemini. Se marca
// "agotado" para dejar de gastar cupo/tiempo en él para siempre.
const MAX_INTENTOS = 6;

// Auto-frenado: si la corrida anterior falló en un 80% o más (y procesó al
// menos 3 ítems, para no reaccionar a una muestra de 1), y fue hace menos
// de este tiempo, se salta esta corrida entera sin gastar ningún intento.
// Evita que una caída de Gemini de 40 minutos consuma los 6 MAX_INTENTOS de
// cada ítem en los primeros 25 minutos, sin dejar nada en reserva para
// cuando la capacidad realmente vuelva.
const PAUSA_SI_CAIDA_GENERALIZADA_MS = 6 * 60 * 1000; // 6 minutos

async function debePausarPorCaidaGeneralizada(admin: ReturnType<typeof createClient>): Promise<boolean> {
  try {
    const { data: ultimaCorrida } = await admin
      .from("system_events")
      .select("created_at, metadata")
      .eq("tipo", "ocr_reintento_run")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ultimaCorrida?.metadata) return false;
    const { procesados, exitosos } = ultimaCorrida.metadata as { procesados?: number; exitosos?: number };
    if (!procesados || procesados < 3) return false;
    const tasaFallo = 1 - (exitosos || 0) / procesados;
    const haceCuanto = Date.now() - new Date(ultimaCorrida.created_at as string).getTime();
    return tasaFallo >= 0.8 && haceCuanto < PAUSA_SI_CAIDA_GENERALIZADA_MS;
  } catch (err) {
    console.error("No se pudo evaluar caída generalizada, se sigue de largo:", err);
    return false; // ante la duda, no bloquear la corrida por esto
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // De a pedazos: String.fromCharCode(...bytes) con un array grande entero
  // revienta el límite de argumentos de la función en V8/Deno.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function mimeTypeDesdeNombre(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    // Comparación simple de string -- alcanza acá porque el secret solo lo
    // conocen el propio proyecto (env var) y el job de pg_cron que se
    // configura con el mismo valor, no hay usuarios de por medio.
    const authHeader = req.headers.get("Authorization") || "";
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      throw new Error("No autorizado.");
    }

    if (await debePausarPorCaidaGeneralizada(admin)) {
      return new Response(JSON.stringify({ ok: true, procesados: 0, exitosos: 0, nota: "Pausado: la corrida anterior falló casi entera, se espera antes de reintentar." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // !inner con rendiciones.estado: una rendición ya Aprobada/Rechazada no
    // necesita seguir reintentando su OCR -- nadie va a revisar la
    // sugerencia de un ítem que ya quedó resuelto. tipo_item=ConDocumento:
    // ver el comentario de arriba del archivo sobre por qué solo estos.
    const { data: pendientes, error: errPend } = await admin
      .from("rendicion_items")
      .select("id, adjunto_url, ocr_reintento_intentos, rendiciones!inner(estado)")
      .eq("ocr_reintento_estado", "pendiente")
      .eq("tipo_item", "ConDocumento")
      .eq("rendiciones.estado", "Pendiente")
      .not("adjunto_url", "is", null)
      .order("ocr_reintento_ultimo", { ascending: true, nullsFirst: true })
      .limit(LOTE);
    if (errPend) throw errPend;

    let procesados = 0;
    let exitosos = 0;
    for (const item of pendientes || []) {
      procesados++;
      const intentosPrevios = (item.ocr_reintento_intentos as number) || 0;
      try {
        const { data: archivo, error: errDescarga } = await admin.storage.from("comprobantes").download(item.adjunto_url as string);
        // Comprobante ya no está en Storage (ej. "Limpiar archivos
        // huérfanos" lo borró, o se editó el ítem y se reemplazó) --
        // reintentar no tiene sentido, se agota de una sola vez en vez de
        // esperar MAX_INTENTOS corridas para darse cuenta de lo mismo.
        if (errDescarga || !archivo) {
          await admin.from("rendicion_items").update({
            ocr_reintento_estado: "agotado",
            ocr_reintento_intentos: MAX_INTENTOS,
            ocr_reintento_ultimo: new Date().toISOString(),
          }).eq("id", item.id);
          console.error(`ocr-reintento-pendientes: comprobante no encontrado para ítem ${item.id}, se agota sin reintentar.`);
          continue;
        }
        const base64 = arrayBufferToBase64(await archivo.arrayBuffer());
        const mimeType = archivo.type || mimeTypeDesdeNombre(item.adjunto_url as string);

        const resultado = await leerComprobante(admin, base64, mimeType);

        await admin.from("rendicion_items").update({
          ocr_reintento_estado: "listo",
          ocr_reintento_resultado: resultado,
          ocr_reintento_intentos: intentosPrevios + 1,
          ocr_reintento_ultimo: new Date().toISOString(),
        }).eq("id", item.id);
        exitosos++;
      } catch (errItem) {
        const intentos = intentosPrevios + 1;
        await admin.from("rendicion_items").update({
          ocr_reintento_estado: intentos >= MAX_INTENTOS ? "agotado" : "pendiente",
          ocr_reintento_intentos: intentos,
          ocr_reintento_ultimo: new Date().toISOString(),
        }).eq("id", item.id);
        console.error(`ocr-reintento-pendientes: ítem ${item.id} falló (intento ${intentos}):`, errItem);
      }
    }

    // Un solo evento por corrida (no uno por ítem) -- corre cada 5 min sin
    // que nadie lo esté mirando; un resumen agregado alcanza para el
    // registro y para el auto-frenado de arriba, y no infla system_events
    // con docenas de filas por hora.
    await logEvent(admin, "ocr_reintento_run", { metadata: { procesados, exitosos } });
    return new Response(JSON.stringify({ ok: true, procesados, exitosos }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    if (!/No autorizado/i.test(mensaje)) {
      await logEvent(admin, "ocr_reintento_fail", { detalle: mensaje });
    }
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
