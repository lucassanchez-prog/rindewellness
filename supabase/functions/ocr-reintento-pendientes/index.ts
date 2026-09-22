// Edge Function: ocr-reintento-pendientes
// El "agente" que vive en Supabase que reintenta, en segundo plano, los
// comprobantes que ocr-recibo no pudo leer en el momento (ej. Gemini con
// "high demand" del nivel gratuito -- ver el historial de hoy). No hace
// falta que la persona tenga el navegador abierto ni que apriete
// "Reintentar con IA": esto corre solo, programado con pg_cron (ver
// migracion_ocr_reintento.sql), cada pocos minutos.
//
// Procesa DOS colas distintas, con la misma lógica:
//   - ocr_previos: comprobantes que fallaron ANTES de que exista ninguna
//     rendición (ocr-recibo los sube y encola ahí mismo apenas falla la
//     lectura en vivo -- ver migracion_ocr_previo.sql). El "agente toma el
//     rol" desde el primer fallo, no recién cuando se envía el formulario.
//   - rendicion_items: comprobantes de ítems que YA se guardaron (la
//     persona envió la rendición sin que el OCR hubiera tenido éxito).
//
// "Aprende" cuál modelo de Gemini probar primero (ver _shared/gemini-ocr.ts,
// gemini_modelo_stats) y se auto-frena si detecta que la corrida anterior
// falló casi entera -- durante una caída generalizada de Gemini, insistir
// cada 5 minutos contra TODOS los pendientes solo gasta los MAX_INTENTOS de
// cada ítem sin ninguna chance real de éxito; mejor espaciar los intentos y
// guardarlos para cuando la capacidad vuelva.
//
// Para rendicion_items: solo de rendiciones que SIGUEN Pendiente -- da lo
// mismo el tipo (ConDocumento o SinDocumento), mientras haya un comprobante
// adjunto que el OCR en vivo no haya logrado leer. Una rendición ya
// Aprobada/Rechazada no tiene sentido seguir reintentándola: nadie va a
// mirar una sugerencia de IA para algo que ya se resolvió.
//
// El resultado NUNCA pisa datos ya guardados: en rendicion_items se guarda
// aparte (ocr_reintento_resultado) como una SUGERENCIA visible para quien
// revisa el ítem, igual que la sugerencia de cuenta contable que ya
// existía -- aplicarlo o no queda a criterio humano. En ocr_previos, en
// cambio, el frontend SÍ aplica el resultado directo a los campos del
// formulario si todavía sigue abierto -- en esa etapa nada se ha guardado
// ni decidido todavía, no hace falta tratarlo como sugerencia.
//
// Dos formas de disparar esta función:
//   1. pg_cron, cada 5 minutos, con un secret compartido (CRON_SECRET) --
//      procesa el lote más viejo de CUALQUIER usuario. Es la red de
//      seguridad: agarra lo que sea que quedó pendiente sin importar por
//      qué (el navegador se cerró antes del disparo inmediato de abajo,
//      ese disparo falló, etc).
//   2. Con una sesión de usuario real, justo después de un fallo de OCR en
//      vivo (ocr-recibo) o de que submitRendicion (app.js) termina de
//      guardar una rendición -- así el "agente" se pone a trabajar altiro
//      en los comprobantes de esa persona, en vez de que tengan que
//      esperar hasta 5 minutos al próximo tick del cron. Acá se filtra a
//      los del usuario que llama (RLS no aplica -- se usa el service role
//      igual que en modo cron -- así que el filtro por usuario/empleado_id
//      es lo único que evita que una persona dispare el reintento de
//      comprobantes ajenos).
//
// Deploy: supabase functions deploy ocr-reintento-pendientes
// Secrets: supabase secrets set CRON_SECRET=<valor-random-largo>
//          (además de GEMINI_API_KEY, que ya debería estar configurado)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent } from "../_shared/logging.ts";
import { leerComprobante, PRESUPUESTO_SEGUNDO_PLANO } from "../_shared/gemini-ocr.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

type Autorizacion = { modo: "cron" } | { modo: "usuario"; usuarioId: string };

async function autorizar(req: Request): Promise<Autorizacion> {
  const authHeader = req.headers.get("Authorization") || "";
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) {
    return { modo: "cron" };
  }
  // No es el secret del cron -- se acepta también un JWT de usuario real
  // (ver punto 2 más arriba). Si no es ninguno de los dos, no autorizado.
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autorizado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anon.auth.getUser(jwt);
  if (error || !data?.user) throw new Error("No autorizado.");
  return { modo: "usuario", usuarioId: data.user.id };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Pocos comprobantes por corrida y por cola: ahora cada uno puede tardar
// hasta ~100s (presupuesto de segundo plano, ver PresupuestoTiempo en
// gemini-ocr.ts -- deliberadamente generoso, porque el presupuesto corto
// anterior era justamente lo que hacía fallar todo), y las Edge Functions
// tienen su propio límite de tiempo total de ejecución. Estos números son
// solo el tope de la consulta; el freno real es TIEMPO_MAX_FUNCION_MS de
// abajo, que corta antes de EMPEZAR un comprobante más si ya no queda
// margen -- así la corrida nunca muere a la mitad de uno (que lo dejaría
// contado como intento sin haberlo procesado de verdad).
const LOTE_ITEMS = 2;
const LOTE_PREVIOS = 2;
const TIEMPO_MAX_FUNCION_MS = 110_000;
// Tope de reintentos por comprobante. OJO con subir este número: la cuota
// gratuita de Gemini es de ~20 solicitudes por modelo, así que con 6
// intentos × 4 modelos candidatos UN SOLO comprobante podía consumir 24
// solicitudes -- más que la cuota diaria completa de un modelo. Eso fue
// exactamente lo que pasó el 2026-09-22: la propia máquina de reintentos
// agotó la cuota y después culpamos a Google por horas. Con 2, y con el
// enfriamiento por modelo de gemini-ocr.ts, el gasto queda acotado.
const MAX_INTENTOS = 2;

// Auto-frenado: si la corrida anterior falló en un 80% o más (y procesó al
// menos 3 comprobantes, para no reaccionar a una muestra de 1), y fue hace
// menos de este tiempo, se salta esta corrida entera sin gastar ningún
// intento. Evita que una caída de Gemini de 40 minutos consuma los 6
// MAX_INTENTOS de cada comprobante en los primeros 25 minutos, sin dejar
// nada en reserva para cuando la capacidad realmente vuelva. Solo aplica en
// modo cron -- ver el comentario donde se usa, más abajo.
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

// Misma lógica de descarga+lectura+actualización para las dos colas
// (ocr_previos y rendicion_items) -- solo cambian la tabla y los nombres de
// columna. Devuelve true si tuvo éxito.
async function procesarPendiente(
  admin: ReturnType<typeof createClient>,
  tabla: string,
  id: string,
  storagePath: string,
  intentosPrevios: number,
  col: { estado: string; resultado: string; intentos: string; ultimo: string },
): Promise<boolean> {
  try {
    const { data: archivo, error: errDescarga } = await admin.storage.from("comprobantes").download(storagePath);
    // Comprobante ya no está en Storage (ej. "Limpiar archivos huérfanos"
    // lo borró, o se editó/reemplazó) -- reintentar no tiene sentido, se
    // agota de una sola vez en vez de esperar MAX_INTENTOS corridas para
    // darse cuenta de lo mismo.
    if (errDescarga || !archivo) {
      await admin.from(tabla).update({
        [col.estado]: "agotado",
        [col.intentos]: MAX_INTENTOS,
        [col.ultimo]: new Date().toISOString(),
      }).eq("id", id);
      console.error(`${tabla}: comprobante no encontrado para ${id}, se agota sin reintentar.`);
      return false;
    }
    const base64 = arrayBufferToBase64(await archivo.arrayBuffer());
    const mimeType = archivo.type || mimeTypeDesdeNombre(storagePath);
    // Presupuesto largo: acá no hay nadie mirando un spinner, así que se le
    // da a Gemini el tiempo que de verdad necesita para leer un documento
    // (ver PresupuestoTiempo en _shared/gemini-ocr.ts).
    const resultado = await leerComprobante(admin, base64, mimeType, PRESUPUESTO_SEGUNDO_PLANO);

    await admin.from(tabla).update({
      [col.estado]: "listo",
      [col.resultado]: resultado,
      [col.intentos]: intentosPrevios + 1,
      [col.ultimo]: new Date().toISOString(),
    }).eq("id", id);
    return true;
  } catch (err) {
    const intentos = intentosPrevios + 1;
    await admin.from(tabla).update({
      [col.estado]: intentos >= MAX_INTENTOS ? "agotado" : "pendiente",
      [col.intentos]: intentos,
      [col.ultimo]: new Date().toISOString(),
    }).eq("id", id);
    console.error(`${tabla}: ${id} falló (intento ${intentos}):`, err);
    return false;
  }
}

const COL_ITEMS = { estado: "ocr_reintento_estado", resultado: "ocr_reintento_resultado", intentos: "ocr_reintento_intentos", ultimo: "ocr_reintento_ultimo" };
const COL_PREVIOS = { estado: "estado", resultado: "resultado", intentos: "intentos", ultimo: "ultimo_intento" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    const auth = await autorizar(req);

    // El auto-frenado por caída generalizada es cosa del cron (que insiste
    // sobre TODOS los pendientes de TODOS los usuarios cada 5 min) -- un
    // disparo inmediato de un usuario puntual es un solo intento acotado
    // (los LOTE_* de acá abajo lo limitan igual) y conviene que se note de
    // verdad si Gemini sigue caído, no que se salte en silencio.
    if (auth.modo === "cron" && await debePausarPorCaidaGeneralizada(admin)) {
      return new Response(JSON.stringify({ ok: true, procesados: 0, exitosos: 0, nota: "Pausado: la corrida anterior falló casi entera, se espera antes de reintentar." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const inicioCorrida = Date.now();
    const quedaTiempo = () => Date.now() - inicioCorrida < TIEMPO_MAX_FUNCION_MS;
    let procesados = 0;
    let exitosos = 0;

    // ---- Cola 1: ocr_previos (comprobantes de antes de enviar la rendición) ----
    let consultaPrevios = admin
      .from("ocr_previos")
      .select("id, storage_path, intentos")
      .eq("estado", "pendiente")
      .order("ultimo_intento", { ascending: true, nullsFirst: true })
      .limit(LOTE_PREVIOS);
    if (auth.modo === "usuario") consultaPrevios = consultaPrevios.eq("usuario_id", auth.usuarioId);
    const { data: previos, error: errPrevios } = await consultaPrevios;
    if (errPrevios) throw errPrevios;
    for (const p of previos || []) {
      if (!quedaTiempo()) break;
      procesados++;
      if (await procesarPendiente(admin, "ocr_previos", p.id as string, p.storage_path as string, (p.intentos as number) || 0, COL_PREVIOS)) exitosos++;
    }

    // ---- Cola 2: rendicion_items (ítems ya guardados sin OCR exitoso) ----
    // !inner con rendiciones.estado: una rendición ya Aprobada/Rechazada no
    // necesita seguir reintentando su OCR -- nadie va a revisar la
    // sugerencia de un ítem que ya quedó resuelto.
    let consultaItems = admin
      .from("rendicion_items")
      .select("id, adjunto_url, ocr_reintento_intentos, rendiciones!inner(estado, empleado_id)")
      .eq("ocr_reintento_estado", "pendiente")
      .eq("rendiciones.estado", "Pendiente")
      .not("adjunto_url", "is", null)
      .order("ocr_reintento_ultimo", { ascending: true, nullsFirst: true })
      .limit(LOTE_ITEMS);
    if (auth.modo === "usuario") consultaItems = consultaItems.eq("rendiciones.empleado_id", auth.usuarioId);
    const { data: pendientes, error: errPend } = await consultaItems;
    if (errPend) throw errPend;
    for (const item of pendientes || []) {
      if (!quedaTiempo()) break;
      procesados++;
      if (await procesarPendiente(admin, "rendicion_items", item.id as string, item.adjunto_url as string, (item.ocr_reintento_intentos as number) || 0, COL_ITEMS)) exitosos++;
    }

    // Un solo evento por corrida (no uno por comprobante) -- corre cada 5
    // min sin que nadie lo esté mirando; un resumen agregado alcanza para
    // el registro y para el auto-frenado de arriba, y no infla
    // system_events con docenas de filas por hora.
    await logEvent(admin, "ocr_reintento_run", { metadata: { procesados, exitosos } });
    return new Response(JSON.stringify({ ok: true, procesados, exitosos }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    // Los errores de Postgrest (ej. throw errPend más arriba) son objetos
    // planos con .message, no instancias de Error -- String(objeto) da
    // "[object Object]" en vez del mensaje real, así que hay que
    // extraerlo a mano en vez de solo chequear "instanceof Error".
    const mensaje = err instanceof Error
      ? err.message
      : (typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err));
    if (!/No autorizado/i.test(mensaje)) {
      await logEvent(admin, "ocr_reintento_fail", { detalle: mensaje });
    }
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
