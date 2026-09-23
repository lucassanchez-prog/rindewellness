// Edge Function: ocr-drive
// Puente entre la app y el OCR de Google Drive, que vive en un Apps Script
// de la cuenta del usuario (ver apps_script_ocr_drive.gs en la raíz).
//
// POR QUÉ EXISTE ESTA FUNCIÓN Y NO SE LLAMA AL SCRIPT DESDE EL NAVEGADOR
// El Apps Script se publica accesible para "cualquier usuario" (es la única
// forma de que responda a llamadas externas), así que lo único que evita que
// un tercero gaste la cuota de Drive de la cuenta es el secreto compartido.
// Si el navegador lo llamara directo, tanto la URL como el secreto quedarían
// escritos en app.js, que es público: el secreto no protegería nada. Acá
// viven como secrets del proyecto y nadie que mire el sitio los ve.
//
// POR QUÉ DRIVE Y NO GEMINI
// Gemini lee fotos mucho mejor, pero su capa gratuita son ~20 solicitudes
// por modelo al día. El OCR de Drive es gratis con la cuenta de Google que
// ya se tiene. Es OCR y no un modelo de lenguaje: devuelve texto mejor
// leído, pero quién es el total lo sigue decidiendo parsearTextoFactura en
// el navegador.
//
// Deploy: supabase functions deploy ocr-drive
// Secrets: supabase secrets set DRIVE_OCR_URL=<url del Apps Script, /exec>
//          supabase secrets set DRIVE_OCR_SECRET=<el mismo secreto del script>

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent, contarEventosRecientes } from "../_shared/logging.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DRIVE_OCR_URL = Deno.env.get("DRIVE_OCR_URL");
const DRIVE_OCR_SECRET = Deno.env.get("DRIVE_OCR_SECRET");

// El OCR de Drive tarda: sube el archivo, lo convierte a documento y lo
// borra. Medido en decenas de segundos para una foto de celular. Este
// presupuesto tiene que ser MENOR que el de la llamada del navegador, para
// que el mensaje de error que llegue sea el nuestro y no un corte opaco.
const TIMEOUT_MS = 45_000;

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autenticado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anon.auth.getUser(jwt);
  if (error || !data?.user) throw new Error("Sesión inválida o expirada.");
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: profile, error: profileErr } = await asUser.from("profiles").select("activo").eq("id", data.user.id).maybeSingle();
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
  try {
    const user = await requireUser(req);
    userId = user.id;

    if (!DRIVE_OCR_URL || !DRIVE_OCR_SECRET) {
      throw new Error("El OCR de Drive no está configurado (faltan DRIVE_OCR_URL o DRIVE_OCR_SECRET).");
    }

    // Mismo tope por hora que ocr-recibo. Acá no se gasta cuota de Gemini,
    // pero sí la de conversiones de Drive de la cuenta, que también tiene
    // límite diario y se comparte con todo lo demás que haga esa cuenta.
    const recientes = await contarEventosRecientes(admin, "ocr_drive", { usuarioId: userId }, 60);
    if (recientes >= 40) {
      throw new Error("Demasiadas lecturas en la última hora. Espera unos minutos e inténtalo de nuevo.");
    }
    await logEvent(admin, "ocr_drive", { usuarioId: userId });

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error("Falta la imagen (imageBase64).");
    if (imageBase64.length > 16_000_000) throw new Error("El comprobante es muy pesado (máx. ~12MB).");

    const resp = await fetch(DRIVE_OCR_URL, {
      method: "POST",
      // text/plain a propósito: Apps Script devuelve un redirect a
      // googleusercontent.com y el fetch lo sigue, pero con content-type
      // application/json la petición se complica sin ganar nada. El script
      // parsea el cuerpo como JSON igual.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secreto: DRIVE_OCR_SECRET, imagenBase64: imageBase64, mimeType }),
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const crudo = await resp.text();
    let datos: { texto?: string; error?: string };
    try {
      datos = JSON.parse(crudo);
    } catch {
      // Apps Script devuelve HTML cuando algo falla antes de llegar al
      // código (permisos, implementación vieja, URL equivocada). Sin este
      // caso el error que veía la persona era un "Unexpected token <" que
      // no dice nada sobre la causa real.
      throw new Error("El Apps Script no respondió JSON. Revisa que la implementación esté publicada como aplicación web y que la URL termine en /exec.");
    }
    if (datos.error) throw new Error(`OCR de Drive: ${datos.error}`);
    if (!datos.texto || !datos.texto.trim()) {
      await logEvent(admin, "ocr_drive_vacio", { usuarioId: userId });
      return new Response(JSON.stringify({ texto: "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ texto: datos.texto }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    const esperable = /No autenticado|Sesión inválida|desactivada|Demasiadas lecturas/i.test(mensaje);
    if (!esperable) await logEvent(admin, "ocr_drive_fail", { usuarioId: userId, detalle: mensaje });
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
