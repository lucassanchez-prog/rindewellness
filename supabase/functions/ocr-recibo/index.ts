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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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

  try {
    await requireUser(req);
    if (!GEMINI_API_KEY) throw new Error("Falta configurar el secret GEMINI_API_KEY en el proyecto.");

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error("Falta la imagen (imageBase64).");

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

    // Gemini a veces devuelve "high demand" de forma transitoria (picos de uso),
    // y la capa gratuita tiene un límite de solicitudes POR MINUTO ("quota
    // exceeded") que se libera solo unos segundos después -- ambos casos se
    // solucionan reintentando con espera, no son errores permanentes.
    const INTENTOS = 3;
    let data;
    for (let intento = 1; intento <= INTENTOS; intento++) {
      const resp = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await resp.json();
      if (resp.ok) break;

      const mensaje = data?.error?.message || "Error consultando Gemini";
      const esTransitorio = /high demand|unavailable|overloaded|quota|rate.?limit/i.test(mensaje);
      if (!esTransitorio || intento === INTENTOS) throw new Error(mensaje);
      // El error de cuota trae su propio "retry in Ns"; si no lo trae, usamos
      // el backoff normal. Esperamos un poco más que lo pedido por margen.
      const retrySugerido = /retry in ([\d.]+)s/i.exec(mensaje);
      const espera = retrySugerido ? Number(retrySugerido[1]) * 1000 + 1000 : 1500 * intento;
      await new Promise((r) => setTimeout(r, espera));
    }

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
    return new Response(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
