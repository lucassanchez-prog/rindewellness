// Edge Function: ocr-recibo
// Recibe la foto de un comprobante (factura/boleta) en base64, se la manda a
// Google Gemini y devuelve los datos extraídos como JSON. La API key de
// Gemini vive SOLO acá (variable de entorno del proyecto), nunca en el
// frontend.
//
// Deploy: supabase functions deploy ocr-recibo
// Secret:  supabase secrets set GEMINI_API_KEY=tu-api-key

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PROMPT = `Eres un asistente que extrae datos de comprobantes de compra chilenos
(facturas electrónicas, boletas electrónicas o boletas de honorarios).
Analiza la imagen adjunta y devuelve SOLO un JSON válido, sin texto adicional
ni explicaciones, con exactamente esta forma:
{
  "nombre_proveedor": "razón social o nombre del proveedor" o null,
  "rut_proveedor": "12.345.678-9" o null,
  "tipo_documento": "Factura Electrónica" | "Factura Exenta Electrónica" | "Boleta de Honorario" | "Boleta Electrónica" | null,
  "nro_documento": "string" o null,
  "fecha": "YYYY-MM-DD" o null,
  "monto": number o null,
  "descripcion": "breve descripción del gasto, ej: Almuerzo equipo ventas" o null
}
Si no puedes leer un dato con certeza, usa null en ese campo. No inventes datos.
El monto debe ser el total final del documento, sin puntos ni signos, solo el número.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
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
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
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

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(text);

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
