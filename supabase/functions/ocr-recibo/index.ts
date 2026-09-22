// Edge Function: ocr-recibo
// Recibe la foto de un comprobante (factura/boleta) en base64, se la manda a
// Google Gemini y devuelve los datos extraídos como JSON. La API key de
// Gemini vive SOLO acá (variable de entorno del proyecto), nunca en el
// frontend. La lógica de "qué modelo de Gemini usar y cómo reintentar" vive
// en _shared/gemini-ocr.ts (la comparte con ocr-reintento-pendientes, que
// reintenta en segundo plano los comprobantes que fallaron acá).
//
// Exige una sesión válida: sin este chequeo, cualquiera con la anon key
// pública (visible en config.js) podía llamar a esta función sin estar
// logueado y consumir la cuota/el costo de Gemini del proyecto.
//
// Deploy: supabase functions deploy ocr-recibo
// Secret:  supabase secrets set GEMINI_API_KEY=tu-api-key

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent, contarEventosRecientes } from "../_shared/logging.ts";
import { leerComprobante, tieneDatosUtiles } from "../_shared/gemini-ocr.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autenticado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anon.auth.getUser(jwt);
  if (error || !data?.user) throw new Error("Sesión inválida o expirada.");
  // Cliente autenticado como la propia persona (no service role, no hace
  // falta acá): RLS ya la deja leer su propio perfil. Sin este chequeo, una
  // cuenta desactivada con una sesión todavía viva podía seguir consumiendo
  // la cuota paga de Gemini.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: profile, error: profileErr } = await asUser.from("profiles").select("activo").eq("id", data.user.id).maybeSingle();
  // Antes esto descartaba el error de la consulta -- si la query fallaba por
  // cualquier motivo, "profile" quedaba undefined y el chequeo de abajo
  // dejaba pasar a una cuenta desactivada sin loguear nada. Falla cerrado.
  if (profileErr) throw profileErr;
  if (profile?.activo === false) throw new Error("Tu cuenta fue desactivada.");
  return data.user;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let userId: string | null = null;
  // Declarados afuera del try porque el catch los necesita para encolar el
  // comprobante en ocr_previos si la lectura en vivo falla -- ver más abajo.
  let imageBase64: string | undefined;
  let mimeType: string | undefined;
  try {
    const user = await requireUser(req);
    userId = user.id;

    ({ imageBase64, mimeType } = await req.json());

    // Límite de frecuencia liviano: sin esto, cualquier cuenta activa podía
    // llamar esta función en loop sin ningún tope, consumiendo la cuota
    // paga de Gemini sin control. Un intento fallido (ej. Gemini caído)
    // cuenta igual que uno exitoso contra este tope -- es decir, durante una
    // caída real de Gemini, cada reintento de la persona le come cupo por
    // algo que no es su culpa. 60/hora (subido de 40) deja margen real para
    // reintentar unas cuantas veces durante un incidente sin llegar a
    // trabarse, sin dejar de ser un tope muy por encima de lo que alguien
    // carga a mano en una rendición real.
    const llamadasRecientes = await contarEventosRecientes(admin, "ocr_call", { usuarioId: userId }, 60);
    if (llamadasRecientes >= 60) {
      throw new Error("Demasiadas lecturas de comprobantes en la última hora. Espera unos minutos e inténtalo de nuevo.");
    }
    await logEvent(admin, "ocr_call", { usuarioId: userId });

    if (!imageBase64) throw new Error("Falta la imagen (imageBase64).");
    // ~15MB de archivo original equivalen a ~20M caracteres en base64
    // (overhead ~33%). Sin este tope, un PDF/foto gigante se manda entero a
    // Gemini y puede colgar la función o fallar con un error de red opaco
    // en vez de un mensaje claro.
    if (imageBase64.length > 20_000_000) {
      throw new Error("El comprobante es muy pesado (máx. ~15MB). Comprime la imagen o el PDF e inténtalo de nuevo.");
    }

    const resultado = await leerComprobante(admin, imageBase64, mimeType);

    // No es un fallo (la función igual responde 200), pero si Gemini no
    // sacó ningún dato útil del comprobante, se loguea para tener
    // visibilidad -- indistinguible si no, de "el comprobante realmente no
    // traía nada legible" versus "el modelo está degradando en silencio".
    if (!tieneDatosUtiles(resultado)) {
      await logEvent(admin, "ocr_vacio", { usuarioId: userId });
    }

    return new Response(JSON.stringify(resultado), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    const esRechazoEsperable = /No autenticado|Sesión inválida|desactivada|Demasiadas lecturas/i.test(mensaje);
    // No registramos los rechazos esperables (sesión inválida, límite de
    // frecuencia) como "fallo" -- son parte del funcionamiento normal, no
    // algo que un admin necesite revisar en el registro de eventos.
    if (!esRechazoEsperable) {
      await logEvent(admin, "ocr_fail", { usuarioId: userId, detalle: mensaje });
    }

    // El agente en segundo plano "toma el rol" apenas falla la lectura en
    // vivo, no recién cuando se envía la rendición (ver
    // migracion_ocr_previo.sql) -- se sube el comprobante a Storage y se
    // encola en ocr_previos ACÁ MISMO, antes de responderle al frontend, así
    // ocr-reintento-pendientes ya tiene algo real que reintentar desde el
    // primer fallo. Best-effort: si esto falla (ej. Storage caído también),
    // no debe tapar el mensaje de error original de Gemini con uno de
    // Storage -- se loguea aparte y se responde igual sin previaId.
    let previaId: string | null = null;
    if (!esRechazoEsperable && userId && imageBase64) {
      try {
        const bytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
        const path = `${userId}/previo-${crypto.randomUUID()}`;
        const { error: errUpload } = await admin.storage.from("comprobantes").upload(path, bytes, {
          contentType: mimeType || "application/octet-stream",
        });
        if (errUpload) throw errUpload;
        const { data: previa, error: errInsert } = await admin.from("ocr_previos").insert({
          usuario_id: userId,
          storage_path: path,
        }).select("id").single();
        if (errInsert) throw errInsert;
        previaId = previa.id as string;
      } catch (errEncolar) {
        console.error("No se pudo encolar el comprobante en ocr_previos:", errEncolar);
      }
    }

    return new Response(JSON.stringify({ error: mensaje, previaId }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
