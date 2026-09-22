// Edge Function: ocr-recibo
// Recibe la foto de un comprobante (factura/boleta) en base64, se la manda a
// Google Gemini y devuelve los datos extraídos como JSON. La API key de
// Gemini vive SOLO acá (variable de entorno del proyecto), nunca en el
// frontend.
//
// Exige una sesión válida: sin este chequeo, cualquiera con la anon key
// pública (visible en config.js) podía llamar a esta función sin estar
// logueado y consumir la cuota/el costo de Gemini del proyecto.
//
// Deploy: supabase functions deploy ocr-recibo
// Secret:  supabase secrets set GEMINI_API_KEY=tu-api-key

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent, contarEventosRecientes } from "../_shared/logging.ts";

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
  const { data: profile } = await asUser.from("profiles").select("activo").eq("id", data.user.id).maybeSingle();
  if (profile?.activo === false) throw new Error("Tu cuenta fue desactivada.");
  return data.user;
}

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Lista ordenada de modelos a probar, en vez de un único "primario" +
// "fallback" fijos en el código -- ya nos pasó dos veces seguidas el mismo
// día: primero gemini-3.6-flash (recién lanzado) estuvo saturado por Google
// durante más de 30 minutos seguidos (503 "high demand" sostenido, no un
// error puntual), y el respaldo que elegimos a mano para ese caso
// (gemini-2.5-flash) resultó estar dado de baja para cuentas nuevas ("no
// longer available to new users"). Adivinar a mano cuál modelo está vivo hoy
// no escala; se prueban varios candidatos en orden y se sigue al próximo
// automáticamente cuando el anterior falla por un motivo relacionado al
// modelo (ver esErrorDeModelo más abajo). Todos de la familia 3.x (Google
// está retirando el acceso pre-3.x para API keys nuevas) y de nivel "flash"
// -- rápidos/baratos, apropiados para esta extracción estructurada -- salvo
// el último (gemini-3.1-pro), que es más lento/caro pero es el último
// recurso antes de rendirse y su capacidad en Google suele ser independiente
// de la de los modelos "flash". Configurable por si Google vuelve a cambiar
// la disponibilidad de alguno, para ajustar el orden sin esperar un
// redeploy del código.
const GEMINI_MODELS_ORDEN = (Deno.env.get("GEMINI_MODELS_ORDEN") || "gemini-3.6-flash,gemini-3.5-flash,gemini-3.7-flash,gemini-3.1-pro")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const geminiUrl = (modelo: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mismo listado de categorías de gasto directo que CATEGORIAS_GASTO en
// app.js (sin la opción "Otro", que es solo para elegir cuenta a mano) --
// se le pasa a Gemini para que elija la más parecida, en vez de inventar
// una categoría que no existe en la app.
const CATEGORIAS = [
  "Gerenciamiento", "Arriendo Instalaciones", "Arriendo Instalaciones Variables", "Gastos Comunes",
  "Telefonía e Internet", "Electricidad", "Gas", "Agua", "Servicios Informaticos", "Servicio de Seguridad",
  "Implementos Gimnasio", "Servicios en Streaming", "Gasto Fee de Ventas y Marketing", "Patentes Comerciales",
  "Fletes", "Combustibles", "Arriendo de Vehiculos", "Estacionamiento", "Seguros", "Materiales",
  "Materiales de Aseo y Oficina", "Gastos Cafeteria", "Servicios Computacionales", "Donaciones",
  "Gastos de Administración", "Mantenciones Generales", "Mantenciones Extraordinarias", "Gastos de Representacion",
  "Prevencion de Riesgos", "Publicidad y Marketing", "Publicidad After Dmoov", "Publicidad en RRSS",
  "Licencias SCD", "Fitmewise", "Informatica y Licencias", "Gastos RFA", "Asesoria Legal", "Asesoria Tributaria",
  "Otras Asesorias", "Beneficios del Personal", "Traslados del Personal", "Viaticos del Personal",
  "Capacitaciones al Personal", "Honorarios Profesionales", "Honorarios Sin Retención",
];

const PROMPT = `Eres un asistente que extrae datos de comprobantes de compra chilenos
(facturas electrónicas, boletas electrónicas o boletas de honorarios).
Analiza la imagen adjunta y devuelve SOLO un JSON válido, sin texto adicional
ni explicaciones, con exactamente esta forma:
{
  "nombre_proveedor": "razón social o nombre del proveedor/local" o null,
  "rut_proveedor": "12.345.678-9" o null,
  "tipo_documento": "Factura Electrónica" | "Factura Exenta Electrónica" | "Boleta de Honorario" | "Boleta Electrónica" | null,
  "nro_documento": "string" o null,
  "fecha": "YYYY-MM-DD" o null,
  "monto": number o null,
  "descripcion": "breve descripción del gasto, ej: Almuerzo equipo ventas" o null,
  "categoria_sugerida": una de estas opciones EXACTAS: ${CATEGORIAS.map((c) => `"${c}"`).join(", ")} -- la que mejor calce con el gasto, o null si ninguna calza bien
}
Si no puedes leer un dato con certeza, usa null en ese campo. No inventes datos.
El monto debe ser el total final del documento, sin puntos ni signos, solo el número.
Para "categoria_sugerida", usa el texto EXACTO de una de las opciones de la lista (respetando tildes y mayúsculas), nunca inventes una categoría nueva.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let userId: string | null = null;
  try {
    const user = await requireUser(req);
    userId = user.id;
    if (!GEMINI_API_KEY) throw new Error("Falta configurar el secret GEMINI_API_KEY en el proyecto.");

    // Límite de frecuencia liviano: sin esto, cualquier cuenta activa podía
    // llamar esta función en loop sin ningún tope, consumiendo la cuota
    // paga de Gemini sin control. 40 comprobantes por hora es bastante más
    // de lo que alguien carga a mano en una rendición real.
    const llamadasRecientes = await contarEventosRecientes(admin, "ocr_call", { usuarioId: userId }, 60);
    if (llamadasRecientes >= 40) {
      throw new Error("Demasiadas lecturas de comprobantes en la última hora. Espera unos minutos e inténtalo de nuevo.");
    }
    await logEvent(admin, "ocr_call", { usuarioId: userId });

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error("Falta la imagen (imageBase64).");
    // ~15MB de archivo original equivalen a ~20M caracteres en base64
    // (overhead ~33%). Sin este tope, un PDF/foto gigante se manda entero a
    // Gemini y puede colgar la función o fallar con un error de red opaco
    // en vez de un mensaje claro.
    if (imageBase64.length > 20_000_000) {
      throw new Error("El comprobante es muy pesado (máx. ~15MB). Comprime la imagen o el PDF e inténtalo de nuevo.");
    }

    const body = {
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      // maxOutputTokens explícito: sin esto, un PDF (que consume bastantes
      // más tokens de "visión de documento" que una foto comprimida, sobre
      // todo si tiene varias páginas) puede agotar el límite por defecto del
      // modelo ANTES de terminar de escribir el JSON de salida. Cuando eso
      // pasa, Gemini responde 200 OK con finishReason "MAX_TOKENS" y texto
      // vacío -- no es un error, así que antes cursaba directo al mensaje
      // genérico de "no se pudo leer" sin ninguna pista real de la causa.
      generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 },
    };

    // Gemini a veces devuelve "high demand" de forma transitoria (picos de
    // uso), la capa gratuita tiene un límite de solicitudes POR MINUTO
    // ("quota exceeded") que se libera solo unos segundos después, y a veces
    // un modelo completo deja de estar disponible para esta cuenta (dado de
    // baja, restringido, etc.) -- los tres casos se resuelven pasando al
    // siguiente modelo candidato, no son errores permanentes de la llamada
    // en sí. OJO: el mensaje real de Google para "modelo dado de baja" es
    // "no longer available to new users", que NO contiene la palabra
    // "unavailable" -- por eso va listado aparte acá; nos pasó exactamente
    // este caso con gemini-2.5-flash. Un error genuinamente permanente (API
    // key inválida, contenido bloqueado por seguridad, request malformado)
    // NO matchea ninguno de estos patrones, así que corta altiro en vez de
    // gastar tiempo probando cada candidato de la lista para nada.
    const esErrorDeModelo = (mensaje: string) =>
      /high demand|unavailable|overloaded|quota|rate.?limit|no longer available|not found|is not supported|deprecated/i.test(mensaje);

    // Tope de tiempo total (sumando todos los modelos candidatos y sus
    // reintentos) para no superar el timeout que tiene el frontend para esta
    // llamada completa (ver conTimeout en llamarOcrRecibo, app.js) -- sin
    // este tope, con varios candidatos y backoff entre reintentos, la
    // función podía seguir probando modelos mucho después de que el usuario
    // ya hubiera visto el timeout y perdido la espera.
    const TIEMPO_MAX_TOTAL_MS = 22_000;

    async function llamarGemini(modelo: string, intentosMax: number, inicio: number) {
      let ultimoError: Error = new Error("Error consultando Gemini");
      for (let intento = 1; intento <= intentosMax; intento++) {
        const resp = await fetch(geminiUrl(modelo), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const respData = await resp.json();
        if (resp.ok) return respData;

        const mensaje = respData?.error?.message || "Error consultando Gemini";
        ultimoError = new Error(mensaje);
        const tiempoRestante = TIEMPO_MAX_TOTAL_MS - (Date.now() - inicio);
        if (!esErrorDeModelo(mensaje) || intento === intentosMax || tiempoRestante <= 0) throw ultimoError;
        // El error de cuota trae su propio "retry in Ns"; si no lo trae, usamos
        // el backoff normal. Nunca esperamos más que el presupuesto de tiempo
        // que queda, para dejarle margen a los próximos candidatos.
        const retrySugerido = /retry in ([\d.]+)s/i.exec(mensaje);
        const esperaSugerida = retrySugerido ? Math.min(Number(retrySugerido[1]) * 1000 + 1000, 3000) : 1200 * intento;
        await new Promise((r) => setTimeout(r, Math.min(esperaSugerida, tiempoRestante)));
      }
      throw ultimoError;
    }

    // Se prueba cada modelo de GEMINI_MODELS_ORDEN en orden hasta que uno
    // responda. Al primer candidato se le dan 2 intentos (por si fue un
    // tropiezo puntual, no necesariamente el modelo entero caído); a los
    // siguientes 1 solo, para no gastar el presupuesto de tiempo
    // reintentando dos veces un modelo cuando todavía quedan otros
    // candidatos por probar.
    async function llamarGeminiConCandidatos() {
      const inicio = Date.now();
      let ultimoError: Error = new Error("No hay modelos de Gemini configurados (GEMINI_MODELS_ORDEN).");
      for (let i = 0; i < GEMINI_MODELS_ORDEN.length; i++) {
        if (Date.now() - inicio >= TIEMPO_MAX_TOTAL_MS) break; // sin margen de tiempo para probar otro modelo más
        try {
          return await llamarGemini(GEMINI_MODELS_ORDEN[i], i === 0 ? 2 : 1, inicio);
        } catch (err) {
          ultimoError = err instanceof Error ? err : new Error(String(err));
          if (!esErrorDeModelo(ultimoError.message)) throw ultimoError; // error permanente, no relacionado al modelo: no seguir probando candidatos
        }
      }
      throw ultimoError;
    }

    const data = await llamarGeminiConCandidatos();

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      // Gemini puede responder 200 OK sin "candidates", o con texto vacío,
      // por más de un motivo -- antes esto se devolvía como "{}" silencioso
      // y el formulario quedaba vacío sin ninguna pista de por qué. Un PDF
      // (sobre todo escaneado o de varias páginas) consume bastantes más
      // tokens de "visión de documento" que una foto comprimida, así que es
      // más probable que llegue a MAX_TOKENS antes de terminar el JSON --
      // eso también cuenta como "sin resultado", no es un error de la API.
      const finishReason = data?.candidates?.[0]?.finishReason;
      const motivo = data?.promptFeedback?.blockReason
        || (finishReason === "MAX_TOKENS" ? "El comprobante es muy complejo para procesarlo completo (MAX_TOKENS)." : null)
        || (finishReason ? `Gemini no devolvió resultado (finishReason: ${finishReason}).` : null)
        || "Gemini no devolvió resultado para este comprobante.";
      throw new Error(motivo);
    }
    const parsed = JSON.parse(text);

    // El prompt le pide a Gemini un valor EXACTO de CATEGORIAS, pero un LLM
    // puede no respetarlo -- si no calza con el catálogo cerrado que usa la
    // app, se descarta en vez de guardar una categoría inexistente.
    if (parsed.categoria_sugerida && !CATEGORIAS.includes(parsed.categoria_sugerida)) {
      parsed.categoria_sugerida = null;
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    // No registramos los rechazos esperables (sesión inválida, límite de
    // frecuencia) como "fallo" -- son parte del funcionamiento normal, no
    // algo que un admin necesite revisar en el registro de eventos.
    if (!/No autenticado|Sesión inválida|desactivada|Demasiadas lecturas/i.test(mensaje)) {
      await logEvent(admin, "ocr_fail", { usuarioId: userId, detalle: mensaje });
    }
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
