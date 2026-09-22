// Edge Function: recordatorios-pendientes
// Manda UN correo-resumen a todos los aprobadores/admin/delegados con la
// lista de rendiciones y solicitudes de fondos que llevan Pendientes más
// de 3 días -- antes nada avisaba de un cuello de botella salvo que
// alguien entrara a mirar el dashboard (que desde esta misma revisión ya
// muestra el stat "Pendientes hace +7 días", pero solo si entras a mirarlo).
//
// Se dispara A MANO desde el botón "Enviar recordatorios ahora" en el
// panel de Usuarios (solo admin/aprobador, ver app.js). No se dejó
// programada con pg_cron en la migración porque una tarea programada mal
// configurada (permisos, secret, huso horario) falla en silencio sin
// forma de comprobarlo desde acá -- si más adelante se quiere automatizar,
// alcanza con programar una llamada HTTP diaria a esta misma función
// (Supabase Dashboard > Database > Cron Jobs, o cualquier scheduler
// externo) con el header Authorization de un aprobador/admin.
//
// No reenvía el mismo aviso todos los días para la misma fila: cada
// rendición/solicitud incluida actualiza su columna "ultimo_recordatorio",
// y no se vuelve a incluir hasta que pasen otros 3 días.
//
// Secrets: los mismos que notificar-aprobador (RESEND_API_KEY, etc.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent } from "../_shared/logging.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "RindeWellness <onboarding@resend.dev>";
const FALLBACK_EMAIL = Deno.env.get("RESEND_FALLBACK_EMAIL");
const APP_URL = Deno.env.get("APP_URL") || "https://rindewellness.netlify.app";
const DIAS_PARA_RECORDAR = 3;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function requireProfile(req: Request, admin: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autenticado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: userRes, error: userErr } = await anon.auth.getUser(jwt);
  if (userErr || !userRes?.user) throw new Error("Sesión inválida o expirada.");
  const { data: profile, error: profileErr } = await admin.from("profiles").select("id, nombre, rol, activo").eq("id", userRes.user.id).maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile) throw new Error("Perfil no encontrado.");
  if (profile.activo === false) throw new Error("Tu cuenta fue desactivada.");
  if (!["admin", "aprobador"].includes(profile.rol)) throw new Error("Solo un aprobador o admin puede enviar recordatorios.");
  return profile;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let callerId: string | null = null;
  try {
    if (!RESEND_API_KEY) throw new Error("Falta configurar el secret RESEND_API_KEY en el proyecto.");
    const caller = await requireProfile(req, admin);
    callerId = caller.id;

    // Misma ventana de N días gobierna dos cosas distintas (hace cuánto se
    // creó, hace cuánto se recordó por última vez) -- un solo valor alcanza.
    const limite = new Date(Date.now() - DIAS_PARA_RECORDAR * 24 * 60 * 60 * 1000).toISOString();

    const { data: rendiciones, error: errRendiciones } = await admin
      .from("rendiciones")
      .select("id, folio, empleado_nombre, monto_total, created_at, ultimo_recordatorio")
      .eq("estado", "Pendiente")
      .lt("created_at", limite)
      .or(`ultimo_recordatorio.is.null,ultimo_recordatorio.lt.${limite}`);
    if (errRendiciones) throw errRendiciones;

    const { data: solicitudes, error: errSolicitudes } = await admin
      .from("solicitudes_fondos")
      .select("id, folio, empleado_nombre, monto_solicitado, created_at, ultimo_recordatorio")
      .eq("estado", "Pendiente")
      .lt("created_at", limite)
      .or(`ultimo_recordatorio.is.null,ultimo_recordatorio.lt.${limite}`);
    if (errSolicitudes) throw errSolicitudes;

    const totalPendientes = (rendiciones?.length || 0) + (solicitudes?.length || 0);
    if (totalPendientes === 0) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, nota: "No hay nada pendiente hace más de " + DIAS_PARA_RECORDAR + " días sin recordatorio reciente." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: perfilesTodos, error: errPerfilesTodos } = await admin
      .from("profiles")
      .select("id, rol, delegado_activo, delegado_hasta")
      .or("rol.in.(aprobador,admin),delegado_activo.eq.true");
    if (errPerfilesTodos) throw errPerfilesTodos;
    const ahoraMs = Date.now();
    const destinatariosPerfiles = (perfilesTodos || []).filter((p) =>
      ["aprobador", "admin"].includes(p.rol) ||
      (p.delegado_activo && (!p.delegado_hasta || new Date(p.delegado_hasta).getTime() > ahoraMs))
    );
    const { data: usersData, error: errUsersData } = await admin.auth.admin.listUsers();
    if (errUsersData) throw errUsersData;
    const emailPorId = new Map((usersData?.users || []).map((u) => [u.id, u.email]));
    const destinatarios = [...new Set(destinatariosPerfiles.map((p) => emailPorId.get(p.id)).filter((e): e is string => !!e))];

    if (!destinatarios.length) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, nota: "No se encontraron emails de aprobadores." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const filaRendicion = (r: any) => `
      <tr>
        <td style="padding:4px 10px 4px 0;">N° ${escapeHtml(r.folio)}</td>
        <td style="padding:4px 10px;">${escapeHtml(r.empleado_nombre)}</td>
        <td style="padding:4px 10px;">$${Math.round(Number(r.monto_total) || 0).toLocaleString("es-CL")}</td>
        <td style="padding:4px 0;"><a href="${APP_URL}/#detalle/${r.id}">Ver</a></td>
      </tr>`;
    const filaSolicitud = (s: any) => `
      <tr>
        <td style="padding:4px 10px 4px 0;">S-${escapeHtml(s.folio)}</td>
        <td style="padding:4px 10px;">${escapeHtml(s.empleado_nombre)}</td>
        <td style="padding:4px 10px;">$${Math.round(Number(s.monto_solicitado) || 0).toLocaleString("es-CL")}</td>
        <td style="padding:4px 0;"><a href="${APP_URL}/#detalle-solicitud/${s.id}">Ver</a></td>
      </tr>`;

    const html = `
      <div style="font-family: Arial, sans-serif; color: #1a1f27;">
        <h2 style="margin-bottom: 4px;">Pendientes hace más de ${DIAS_PARA_RECORDAR} días</h2>
        <p style="color: #5b6472; margin-top: 0;">RindeWellness · Grupo Wellness</p>
        ${rendiciones && rendiciones.length ? `
          <p style="font-weight:600;margin-bottom:4px;">Rendiciones (${rendiciones.length})</p>
          <table style="border-collapse: collapse; margin-bottom:16px;">${rendiciones.map(filaRendicion).join("")}</table>
        ` : ""}
        ${solicitudes && solicitudes.length ? `
          <p style="font-weight:600;margin-bottom:4px;">Solicitudes de fondos (${solicitudes.length})</p>
          <table style="border-collapse: collapse;">${solicitudes.map(filaSolicitud).join("")}</table>
        ` : ""}
      </div>
    `;

    let resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: destinatarios, subject: `${totalPendientes} pendiente(s) hace más de ${DIAS_PARA_RECORDAR} días`, html }),
    });
    let data = await resp.json();
    if (!resp.ok && FALLBACK_EMAIL && /only send testing emails/i.test(data?.message || "")) {
      const htmlConAviso = `<p style="background:#f4f7fb;color:#5b6472;padding:10px 14px;border-radius:6px;font-family:Arial,sans-serif;font-size:12px;">Destinatario real: ${escapeHtml(destinatarios.join(", "))}</p>${html}`;
      resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_EMAIL, to: [FALLBACK_EMAIL], subject: `[Reenviado] ${totalPendientes} pendiente(s) hace más de ${DIAS_PARA_RECORDAR} días`, html: htmlConAviso }),
      });
      data = await resp.json();
    }
    if (!resp.ok) throw new Error(data?.message || "Error enviando el correo con Resend");

    const ahoraIso = new Date().toISOString();
    if (rendiciones && rendiciones.length) {
      await admin.from("rendiciones").update({ ultimo_recordatorio: ahoraIso }).in("id", rendiciones.map((r) => r.id));
    }
    if (solicitudes && solicitudes.length) {
      await admin.from("solicitudes_fondos").update({ ultimo_recordatorio: ahoraIso }).in("id", solicitudes.map((s) => s.id));
    }

    await logEvent(admin, "recordatorios_ok", { usuarioId: callerId, metadata: { total: totalPendientes } });
    return new Response(JSON.stringify({ ok: true, enviados: destinatarios.length, total_pendientes: totalPendientes }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    await logEvent(admin, "recordatorios_fail", { usuarioId: callerId, detalle: mensaje });
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
