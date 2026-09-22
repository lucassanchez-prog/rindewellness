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
  const { data: profile, error: profileErr } = await asUser.from("profiles").select("activo").eq("id", data.user.id).maybeSingle();
  // Antes esto descartaba el error de la consulta -- si la query fallaba por
  // cualquier motivo, "profile" quedaba undefined y el chequeo de abajo
  // dejaba pasar a una cuenta desactivada sin loguear nada. Falla cerrado.
  if (profileErr) throw profileErr;
  if (profile?.activo === false) throw new Error("Tu cuenta fue desactivada.");
  return data.user;
}

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Lista ordenada de modelos a probar, en vez de un único "primario" +
// "fallback" fijos en el código -- adivinar a mano un nombre de modelo por
// blog posts/changelog público de Google ya nos falló DOS veces el mismo
// día: "gemini-2.5-flash" resultó dado de baja para esta cuenta ("no longer
// available to new users"), y "gemini-3.1-pro" directamente nunca existió
// como ID (el real es "gemini-3.1-pro-preview", que es OTRO modelo). La
// lista de acá abajo SÍ está verificada -- se confirmó contra la API real
// de Google (GET /v1beta/models con esta misma GEMINI_API_KEY, ver el
// diagnóstico que se puede activar con {listarModelos:true} en el body).
// Todos "flash" -- rápidos/baratos, apropiados para esta extracción
// estructurada -- salvo el último, "gemini-flash-latest", que es un ALIAS
// que Google mantiene apuntando al flash vigente en cada momento (nunca
// hay que actualizarlo a mano cuando Google lance un modelo nuevo), como
// último recurso antes de rendirse. Se prueban en orden y se sigue al
// próximo automáticamente cuando el anterior falla por un motivo
// relacionado al modelo (ver esErrorDeModelo más abajo). Configurable por
// si Google vuelve a cambiar la disponibilidad de alguno, para ajustar el
// orden sin esperar un redeploy del código.
const GEMINI_MODELS_ORDEN = (Deno.env.get("GEMINI_MODELS_ORDEN") || "gemini-3.6-flash,gemini-3.5-flash,gemini-3.7-flash,gemini-flash-latest")
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

    const { imageBase64, mimeType } = await req.json();

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
        let mensaje: string;
        let esErrorDeRed = false;
        try {
          // Timeout explícito por llamada -- sin esto, un fetch colgado (no
          // un error de Gemini, sino la red misma sin responder) no cuenta
          // como intento fallido y se come todo el presupuesto de tiempo sin
          // pasar nunca al siguiente modelo candidato.
          const resp = await fetch(geminiUrl(modelo), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(12_000),
          });
          const respData = await resp.json();
          if (resp.ok) return respData;
          mensaje = respData?.error?.message || "Error consultando Gemini";
        } catch (errRed) {
          // fetch()/resp.json() pueden lanzar directo (corte de conexión,
          // respuesta no-JSON como una página de error HTML del gateway
          // durante un pico de demanda, timeout del AbortSignal de arriba) --
          // antes esto se escapaba del reintento Y del paso al siguiente
          // modelo por completo, así que el caso más común de "Gemini está
          // fallando" terminaba siendo el peor manejado de todos. Se marca
          // aparte como retryable (no depende de que el texto del error
          // matchee esErrorDeModelo, que espera mensajes de Gemini, no
          // excepciones de red/timeout de fetch).
          esErrorDeRed = true;
          mensaje = errRed instanceof Error && errRed.name === "TimeoutError"
            ? "Tiempo de espera agotado consultando Gemini."
            : `Error de red consultando Gemini: ${String(errRed instanceof Error ? errRed.message : errRed)}`;
        }

        ultimoError = new Error(mensaje);
        // Se marca en el propio objeto Error (no solo en una variable local)
        // porque llamarGeminiConCandidatos también necesita saber, al
        // recibir la excepción de acá, si vale la pena pasar al siguiente
        // modelo candidato -- un error de red no trae ningún texto que
        // esErrorDeModelo pueda reconocer por sí solo.
        (ultimoError as Error & { reintentable?: boolean }).reintentable = esErrorDeRed || esErrorDeModelo(mensaje);
        const tiempoRestante = TIEMPO_MAX_TOTAL_MS - (Date.now() - inicio);
        if (!(ultimoError as Error & { reintentable?: boolean }).reintentable || intento === intentosMax || tiempoRestante <= 0) throw ultimoError;
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
          // .reintentable ya viene calculado desde llamarGemini (cubre tanto
          // errores de Gemini como de red/timeout); si no está presente
          // (excepción de otro origen), se recalcula sobre el mensaje.
          const reintentable = (ultimoError as Error & { reintentable?: boolean }).reintentable ?? esErrorDeModelo(ultimoError.message);
          if (!reintentable) throw ultimoError; // error permanente, no relacionado al modelo: no seguir probando candidatos
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

    // El prompt le pide a Gemini un número limpio (sin puntos de miles),
    // pero nada lo obliga a respetarlo -- un monto chileno como "15.000" si
    // llegara tal cual, sin este chequeo, el frontend lo interpreta como
    // Number("15.000") = 15 y autocompleta un monto mil veces más chico sin
    // ningún error visible. Se descarta (no se adivina el formato) en vez de
    // arriesgar un dato silenciosamente incorrecto.
    if (parsed.monto !== null && parsed.monto !== undefined && !Number.isFinite(Number(parsed.monto))) {
      parsed.monto = null;
    }

    // "200 OK con {} o casi vacío" es un resultado válido para Gemini pero
    // inútil para la persona, y hasta ahora no quedaba ningún rastro de que
    // había pasado -- indistinguible de "el comprobante realmente no traía
    // nada legible" versus "el modelo está degradando en silencio". Se
    // loguea (no se trata como fallo: la función igual responde 200) para
    // que quede visibilidad si empieza a pasar seguido.
    const tieneDatosUtiles = ["nombre_proveedor", "rut_proveedor", "monto", "nro_documento"].some((campo) => parsed[campo]);
    if (!tieneDatosUtiles) {
      await logEvent(admin, "ocr_vacio", { usuarioId: userId });
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
