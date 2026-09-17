// Edge Function: notificar-aprobador
// Cuando se envía una rendición nueva, le manda un correo a cada
// aprobador/admin avisando que hay algo pendiente de revisar. También la
// reutiliza la app para avisar de una SOLICITUD DE FONDOS nueva (payload
// con tipo: "solicitud") -- mismo destinatario, mismo mecanismo, solo
// cambia el texto del asunto y del cuerpo.
//
// Exige una sesión válida: la anon key es pública (vive en config.js,
// cualquiera que visite el sitio puede verla), así que sin este chequeo
// cualquiera podía invocar la función sin estar logueado. Además el
// folio/monto/empleado/comentario del correo SIEMPRE se relee de la base
// de datos a partir de rendicion_id -- nunca se confía en lo que venga en
// el body, para que no se puedan mandar avisos con datos inventados.
//
// Secrets necesarios (Supabase Dashboard > Edge Functions > Manage secrets):
//   RESEND_API_KEY       -> tu API key de resend.com (gratis)
//   RESEND_FROM_EMAIL    -> opcional. Si no lo pones, usa el remitente de
//                           pruebas de Resend (onboarding@resend.dev), que
//                           funciona sin verificar un dominio propio.
//   RESEND_FALLBACK_EMAIL -> opcional pero recomendado mientras no haya un
//                           dominio verificado en Resend. Mientras el
//                           remitente sea el de pruebas (onboarding@resend.dev),
//                           Resend SOLO deja mandar correos a la cuenta dueña
//                           de la API key -- a cualquier otro destinatario le
//                           falla en silencio. Si se define este secret, el
//                           correo se reenvía ahí (avisando quién era el
//                           destinatario real) en vez de perderse. Se deja de
//                           necesitar el día que se verifique un dominio propio.
//
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los inyecta
// Supabase automático en toda Edge Function -- no hay que configurarlos a
// mano. Se necesita el service role acá (no el anon) porque hay que leer
// los emails reales desde auth.users, cosa que la app normal no puede hacer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "RindeWellness <onboarding@resend.dev>";
const FALLBACK_EMAIL = Deno.env.get("RESEND_FALLBACK_EMAIL");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Los campos que se interpolan en el HTML del correo los escribe gente de
// la empresa a través de la app -- nunca hay que confiar en que no traigan
// "<" o ">" que rompan el HTML o inserten un link falso dentro de un correo
// con marca "RindeWellness".
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Verifica el JWT de quien llama (no la anon key) y devuelve su perfil.
async function requireProfile(req: Request, admin: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autenticado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: userRes, error: userErr } = await anon.auth.getUser(jwt);
  if (userErr || !userRes?.user) throw new Error("Sesión inválida o expirada.");
  const { data: profile } = await admin.from("profiles").select("id, nombre, rol").eq("id", userRes.user.id).maybeSingle();
  if (!profile) throw new Error("Perfil no encontrado.");
  return profile;
}

// Manda el correo con Resend; si el remitente de pruebas rechaza el envío
// por no ir dirigido al dueño de la cuenta ("testing emails"), y hay un
// RESEND_FALLBACK_EMAIL configurado, reintenta mandándolo ahí para que el
// aviso no se pierda -- avisando en el propio correo quién era el
// destinatario real.
async function enviarConFallback(to: string[], subject: string, html: string) {
  const enviar = (destinatarios: string[], asuntoFinal: string, htmlFinal: string) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: destinatarios, subject: asuntoFinal, html: htmlFinal }),
    });

  let resp = await enviar(to, subject, html);
  let data = await resp.json();
  if (!resp.ok && FALLBACK_EMAIL && /only send testing emails/i.test(data?.message || "")) {
    const htmlConAviso = `
      <p style="background:#fff3cd;color:#7a5c00;padding:10px 14px;border-radius:6px;font-family:Arial,sans-serif;">
        ⚠ Reenviado a esta casilla porque Resend todavía no tiene un dominio verificado.
        Destinatario real: ${escapeHtml(to.join(", "))}
      </p>
      ${html}
    `;
    resp = await enviar([FALLBACK_EMAIL], `[Reenviado] ${subject}`, htmlConAviso);
    data = await resp.json();
  }
  return { resp, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!RESEND_API_KEY) throw new Error("Falta configurar el secret RESEND_API_KEY en el proyecto.");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const caller = await requireProfile(req, admin);

    const { tipo, rendicion_id } = await req.json();
    if (!rendicion_id) throw new Error("Falta rendicion_id.");
    const esSolicitud = tipo === "solicitud";

    const tabla = esSolicitud ? "solicitudes_fondos" : "rendiciones";
    const { data: row, error: errRow } = await admin.from(tabla).select("*").eq("id", rendicion_id).maybeSingle();
    if (errRow || !row) throw new Error("No se encontró la rendición/solicitud.");
    if (row.empleado_id !== caller.id && !["admin", "aprobador"].includes(caller.rol)) {
      throw new Error("No autorizado para notificar sobre esta rendición/solicitud.");
    }

    const folio = row.folio;
    const empleado_nombre = row.empleado_nombre;
    const empresa = row.empresa;
    const monto_total = esSolicitud ? row.monto_solicitado : row.monto_total;
    const comentario = esSolicitud ? row.motivo : row.comentario;

    const { data: aprobadores, error: errPerfiles } = await admin
      .from("profiles")
      .select("id, nombre, rol")
      .in("rol", ["aprobador", "admin"]);
    if (errPerfiles) throw errPerfiles;
    if (!aprobadores || !aprobadores.length) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, nota: "No hay aprobadores/admin registrados." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: usersData, error: errUsers } = await admin.auth.admin.listUsers();
    if (errUsers) throw errUsers;
    const emailPorId = new Map(usersData.users.map((u) => [u.id, u.email]));
    const destinatarios = aprobadores.map((p) => emailPorId.get(p.id)).filter(Boolean) as string[];

    if (!destinatarios.length) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, nota: "No se encontraron emails de aprobadores." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const montoFmt = "$" + Math.round(Number(monto_total) || 0).toLocaleString("es-CL");
    const folioFmt = esSolicitud ? `S-${folio}` : `N° ${folio}`;
    const asunto = esSolicitud
      ? `Nueva solicitud de fondos pendiente · ${folioFmt} · ${empleado_nombre}`
      : `Nueva rendición pendiente · ${folioFmt} · ${empleado_nombre}`;
    const html = `
      <div style="font-family: Arial, sans-serif; color: #1a1f27;">
        <h2 style="margin-bottom: 4px;">${esSolicitud ? "Nueva solicitud de fondos para aprobar" : "Nueva rendición para aprobar"}</h2>
        <p style="color: #5b6472; margin-top: 0;">RindeWellness · Grupo Wellness</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Folio</td><td><strong>${escapeHtml(folioFmt)}</strong></td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Empleado</td><td>${escapeHtml(empleado_nombre)}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Empresa</td><td>${escapeHtml(empresa || "-")}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">${esSolicitud ? "Monto solicitado" : "Monto total"}</td><td><strong>${montoFmt}</strong></td></tr>
          ${comentario ? `<tr><td style="padding: 4px 12px 4px 0; color: #5b6472; vertical-align:top;">${esSolicitud ? "Motivo" : "Comentario"}</td><td>${escapeHtml(comentario)}</td></tr>` : ""}
        </table>
        <p>Ingresa a RindeWellness para revisarla y aprobarla o rechazarla.</p>
      </div>
    `;

    const { resp, data } = await enviarConFallback(destinatarios, asunto, html);
    if (!resp.ok) throw new Error(data?.message || "Error enviando el correo con Resend");

    return new Response(JSON.stringify({ ok: true, enviados: destinatarios.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
