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
import { logEvent, contarEventosRecientes } from "../_shared/logging.ts";
import { esAprobadorEfectivo } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Ninguno de los dos correos (este y notificar-estado-rendicion) tenía un
// link real -- solo texto plano "Ingresa a RindeWellness". La app ya lee el
// hash de la URL al cargar y también después de loguearse (ver
// estadoDesdeHash/onLoggedIn en app.js), así que un link directo al detalle
// funciona incluso para alguien que todavía no inició sesión.
const APP_URL = Deno.env.get("APP_URL") || "https://rindewellness.netlify.app";
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
  const { data: profile, error: profileErr } = await admin.from("profiles").select("id, nombre, rol, activo, delegado_activo, delegado_hasta").eq("id", userRes.user.id).maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile) throw new Error("Perfil no encontrado.");
  // Las policies de la base ya bloquean a alguien desactivado a nivel de
  // fila, pero esta función corre con el service role (que se salta RLS) --
  // sin este chequeo explícito, una cuenta desactivada con una sesión
  // todavía viva podía seguir disparando estos correos igual.
  if (profile.activo === false) throw new Error("Tu cuenta fue desactivada.");
  return profile;
}

// Manda el correo con Resend; si el remitente de pruebas rechaza el envío
// por no ir dirigido al dueño de la cuenta ("testing emails"), y hay un
// RESEND_FALLBACK_EMAIL configurado, reintenta mandándolo ahí para que el
// aviso no se pierda -- avisando en el propio correo quién era el
// destinatario real.
// Reintenta una vez con una breve espera ante un fallo de RED (fetch que
// tira excepción, ej. timeout/DNS) o un 5xx de Resend -- antes un solo
// hiccup transitorio perdía el correo para siempre, en silencio (el caller
// solo hace .then/.catch con console.error, no reintenta nada).
async function fetchConReintento(url: string, init: RequestInit): Promise<Response> {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok || resp.status < 500 || intento === 2) return resp;
    } catch (err) {
      if (intento === 2) throw err;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  // Inalcanzable (el for siempre retorna o lanza en el segundo intento),
  // pero TypeScript exige un retorno en todos los caminos.
  return fetch(url, init);
}

async function enviarConFallback(to: string[], subject: string, html: string) {
  const enviar = (destinatarios: string[], asuntoFinal: string, htmlFinal: string) =>
    fetchConReintento("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: destinatarios, subject: asuntoFinal, html: htmlFinal }),
    });

  let resp = await enviar(to, subject, html);
  let data = await resp.json();
  if (!resp.ok && FALLBACK_EMAIL && /only send testing emails/i.test(data?.message || "")) {
    // Mismo tag <p> que antes -- un Google Apps Script del usuario reenvía
    // estos correos parseando "Destinatario real:" del cuerpo en texto
    // plano, así que lo más seguro es tocar solo colores/texto, no la
    // estructura HTML. Antes era fondo amarillo con ícono de alerta, que se
    // veía como un aviso de spam/phishing; ahora es neutro.
    const htmlConAviso = `
      <p style="background:#f4f7fb;color:#5b6472;padding:10px 14px;border-radius:6px;font-family:Arial,sans-serif;font-size:12px;">
        Destinatario real: ${escapeHtml(to.join(", "))}
      </p>
      ${html}
    `;
    // OJO: "[Reenviado]" tal cual, con corchetes -- hay un Google Apps
    // Script del lado del usuario que reenvía estos correos automáticamente
    // buscando exactamente `subject:"[Reenviado]" from:onboarding@resend.dev`
    // + la línea "Destinatario real:" en el cuerpo. Cambiar este prefijo
    // (o esa frase) rompe ese reenvío automático sin que la app se entere.
    resp = await enviar([FALLBACK_EMAIL], `[Reenviado] ${subject}`, htmlConAviso);
    data = await resp.json();
  }
  return { resp, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let callerId: string | null = null;
  let rendicionId: string | null = null;
  try {
    if (!RESEND_API_KEY) throw new Error("Falta configurar el secret RESEND_API_KEY en el proyecto.");

    const caller = await requireProfile(req, admin);
    callerId = caller.id;

    const { tipo, rendicion_id } = await req.json();
    if (!rendicion_id) throw new Error("Falta rendicion_id.");
    rendicionId = rendicion_id;
    const esSolicitud = tipo === "solicitud";

    // Límite de frecuencia: como cualquier sesión válida puede disparar
    // esta función (no solo aprobador/admin -- un empleado la llama al
    // enviar su propia rendición), sin esto alguien podía scriptear el
    // envío repetido y spamear a todo el equipo de aprobadores.
    const recientesPorFila = await contarEventosRecientes(admin, "notificar_aprobador_ok", { rendicionId: rendicion_id }, 2);
    if (recientesPorFila >= 1) {
      throw new Error("Ya se avisó a los aprobadores sobre esto hace un momento.");
    }
    const recientesPorUsuario = await contarEventosRecientes(admin, "notificar_aprobador_ok", { usuarioId: callerId }, 60);
    if (recientesPorUsuario >= 30) {
      throw new Error("Demasiados avisos enviados en la última hora. Espera un poco.");
    }

    const tabla = esSolicitud ? "solicitudes_fondos" : "rendiciones";
    const { data: row, error: errRow } = await admin.from(tabla).select("*").eq("id", rendicion_id).maybeSingle();
    if (errRow || !row) throw new Error("No se encontró la rendición/solicitud.");
    if (row.empleado_id !== caller.id && !esAprobadorEfectivo(caller)) {
      throw new Error("No autorizado para notificar sobre esta rendición/solicitud.");
    }

    const folio = row.folio;
    const empleado_nombre = row.empleado_nombre;
    const empresa = row.empresa;
    const monto_total = esSolicitud ? row.monto_solicitado : row.monto_total;
    const comentario = esSolicitud ? row.motivo : row.comentario;

    // Además de aprobador/admin "de planta", cuentan las personas con una
    // delegación temporal activa y vigente (ver delegado_activo/
    // delegado_hasta en migracion_mejoras_v2.sql) -- típicamente alguien
    // cubriendo a un aprobador de vacaciones. Se filtra la vigencia acá
    // (no en el SELECT) porque Supabase-js no arma bien un OR con fecha
    // nula-o-futura en una sola llamada simple.
    const { data: perfilesTodos, error: errPerfiles } = await admin
      .from("profiles")
      .select("id, nombre, rol, delegado_activo, delegado_hasta")
      .or("rol.in.(aprobador,admin),delegado_activo.eq.true");
    if (errPerfiles) throw errPerfiles;
    const ahora = Date.now();
    const aprobadores = (perfilesTodos || []).filter((p) =>
      ["aprobador", "admin"].includes(p.rol) ||
      (p.delegado_activo && (!p.delegado_hasta || new Date(p.delegado_hasta).getTime() > ahora))
    );
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
    const linkDetalle = `${APP_URL}/#${esSolicitud ? "detalle-solicitud" : "detalle"}/${rendicion_id}`;
    const hoyFmt = new Date().toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" });
    const filaDato = (label: string, valor: string) => `
      <tr>
        <td style="padding:9px 0;color:#9aa4ae;font-size:12px;text-transform:uppercase;letter-spacing:0.03em;width:44%;">${label}</td>
        <td style="padding:9px 0;color:#1a1f27;font-size:14px;font-weight:600;">${valor}</td>
      </tr>`;
    const html = `
      <div style="font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background:#eef1f5; padding:32px 16px;">
        <div style="max-width:560px; margin:0 auto;">
          <div style="text-align:center;margin-bottom:16px;">
            <img src="${APP_URL}/assets/logo-gw.png" alt="Grupo Wellness" height="28" style="height:28px;width:auto;" />
          </div>

          <div style="background:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e2e8f0; box-shadow:0 1px 2px rgba(28,39,51,0.06);">
            <div style="background:linear-gradient(135deg,#046bd2,#0456a8); padding:26px 28px;">
              <p style="margin:0; color:#ffffff; font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; opacity:0.8;">RindeWellness</p>
              <h1 style="margin:6px 0 0; color:#ffffff; font-size:20px;">${esSolicitud ? "Nueva solicitud de fondos" : "Nueva rendición"} para aprobar</h1>
              <p style="margin:4px 0 0; color:#ffffff; font-size:12.5px; opacity:0.85;">${hoyFmt}</p>
            </div>

            <div style="padding:26px 28px;">
              <table style="border-collapse:collapse; width:100%; margin-bottom:24px;">
                ${filaDato("Folio", escapeHtml(folioFmt))}
                ${filaDato("Empleado", escapeHtml(empleado_nombre))}
                ${filaDato("Empresa", escapeHtml(empresa || "-"))}
                ${filaDato(esSolicitud ? "Monto solicitado" : "Monto total", montoFmt)}
                ${comentario ? filaDato(esSolicitud ? "Motivo" : "Comentario", escapeHtml(comentario)) : ""}
              </table>

              <div style="text-align:center;">
                <a href="${linkDetalle}" style="display:inline-block; padding:13px 32px; background:#046bd2; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; border-radius:8px;">Revisar y aprobar</a>
              </div>
            </div>

            <div style="background:#f4f7fb; padding:14px 28px; border-top:1px solid #e2e8f0;">
              <p style="margin:0; color:#9aa4ae; font-size:11px;">RindeWellness · Grupo Wellness</p>
            </div>
          </div>
        </div>
      </div>
    `;

    const { resp, data } = await enviarConFallback(destinatarios, asunto, html);
    if (!resp.ok) throw new Error(data?.message || "Error enviando el correo con Resend");

    await logEvent(admin, "notificar_aprobador_ok", { usuarioId: callerId, rendicionId });
    return new Response(JSON.stringify({ ok: true, enviados: destinatarios.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    if (!/No autenticado|Sesión inválida|desactivada|Ya se avisó|Demasiados avisos/i.test(mensaje)) {
      await logEvent(admin, "notificar_aprobador_fail", { usuarioId: callerId, rendicionId, detalle: mensaje });
    }
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
