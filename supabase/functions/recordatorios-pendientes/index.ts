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
import { esAprobadorEfectivo } from "../_shared/auth.ts";
import { emailsDePerfiles, leerTodas } from "../_shared/data.ts";
import { construirEmailHTML } from "../_shared/email.ts";
import { clasificarFondos, type FilaFondo } from "../_shared/avisos-fondos.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "RindeWellness <onboarding@resend.dev>";
const FALLBACK_EMAIL = Deno.env.get("RESEND_FALLBACK_EMAIL");
const APP_URL = Deno.env.get("APP_URL") || "https://rindewellness.netlify.app";
const DIAS_PARA_RECORDAR = 3;
// Avisos de fondos: a la persona si un fondo lleva 7 días sin rendirse (como
// mucho uno por semana por fondo); a administradores, una vez por semana, los
// fondos listos para liquidar (gastados enteros o quietos hace 15 días).
const DIAS_FONDO_SIN_RENDIR = 7;
const DIAS_FONDO_PARA_LIQUIDAR = 15;
// Secreto compartido con pg_cron (mismo que usa ocr-reintento-pendientes).
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// La tarea diaria de pg_cron llega con el secreto compartido (devuelve null:
// no hay una persona detrás); a mano, desde el botón, con la sesión de un
// aprobador o admin.
async function requireProfile(req: Request, admin: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) return null;
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autenticado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: userRes, error: userErr } = await anon.auth.getUser(jwt);
  if (userErr || !userRes?.user) throw new Error("Sesión inválida o expirada.");
  const { data: profile, error: profileErr } = await admin.from("profiles").select("id, nombre, rol, activo, delegado_activo, delegado_hasta").eq("id", userRes.user.id).maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile) throw new Error("Perfil no encontrado.");
  if (profile.activo === false) throw new Error("Tu cuenta fue desactivada.");
  if (!esAprobadorEfectivo(profile)) throw new Error("Solo un aprobador o admin puede enviar recordatorios.");
  return profile;
}

const fmt = (n: unknown) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CL");

// Envía con Resend; en modo de pruebas reenvía al respaldo con "[Reenviado]" y
// la línea "Destinatario real:" (los usa un reenvío automático del usuario).
async function enviarCorreo(destinatarios: string[], asunto: string, html: string) {
  let resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: destinatarios, subject: asunto, html }),
  });
  let data = await resp.json();
  if (!resp.ok && FALLBACK_EMAIL && /only send testing emails/i.test(data?.message || "")) {
    const htmlConAviso = `<p style="background:#f4f7fb;color:#5b6472;padding:10px 14px;border-radius:6px;font-family:Arial,sans-serif;font-size:12px;">Destinatario real: ${escapeHtml(destinatarios.join(", "))}</p>${html}`;
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [FALLBACK_EMAIL], subject: `[Reenviado] ${asunto}`, html: htmlConAviso }),
    });
    data = await resp.json();
  }
  if (!resp.ok) throw new Error(data?.message || "Error enviando el correo con Resend");
}

const th = (t: string, derecha = false) => `<th style="padding:0 10px 8px;text-align:${derecha ? "right" : "left"};font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#9aa4ae;border-bottom:2px solid #eef1f5;">${t}</th>`;
const td = (v: string, derecha = false, fuerte = false) => `<td style="padding:10px;${derecha ? "text-align:right;white-space:nowrap;" : ""}${fuerte ? "font-weight:700;" : ""}color:#1a1f27;">${v}</td>`;

// Avisos de fondos (ver _shared/avisos-fondos.ts). Con simular, solo informa
// qué mandaría: no envía correos ni marca nada.
async function avisarFondos(admin: ReturnType<typeof createClient>, destinatariosAdmin: () => Promise<string[]>, simular: boolean) {
  const { data: filas, error } = await admin.rpc("estado_fondos_abiertos");
  if (error) throw error;
  const { porRendir, porLiquidar } = clasificarFondos((filas || []) as FilaFondo[], { diasRendir: DIAS_FONDO_SIN_RENDIR, diasLiquidar: DIAS_FONDO_PARA_LIQUIDAR });
  const haceUnaSemana = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const empleados: unknown[] = [];
  let liquidar: unknown = null;

  // 1. A cada persona: sus fondos quietos que no se le avisaron esta semana.
  for (const g of porRendir) {
    const fondos = g.fondos.filter((f) => !f.ultimo_aviso_empleado || new Date(f.ultimo_aviso_empleado).getTime() < haceUnaSemana);
    if (!fondos.length) continue;
    const { data: u } = await admin.auth.admin.getUserById(g.empleado_id);
    const correo = u?.user?.email;
    const total = fondos.reduce((s, f) => s + (Number(f.sin_rendir) || 0), 0);
    empleados.push({ persona: g.empleado_nombre, tiene_correo: !!correo, fondos: fondos.map((f) => "S-" + f.folio), sin_rendir: total });
    if (simular || !correo) continue;
    const filasHtml = fondos.map((f) => `<tr style="border-bottom:1px solid #eef1f5;">${td("S-" + escapeHtml(f.folio), false, true)}${td(escapeHtml(f.motivo || f.empresa))}${td(fmt(f.otorgado), true)}${td(fmt(f.sin_rendir), true, true)}${td(f.dias_sin_movimiento + " días", true)}</tr>`).join("");
    const html = construirEmailHTML({
      appUrl: APP_URL, eyebrow: "FONDOS POR RENDIR", saludo: `Hola ${escapeHtml(String(g.empleado_nombre).split(" ")[0])},`,
      cuerpo: `Tienes <strong>${fmt(total)}</strong> sin rendir en ${fondos.length === 1 ? "un fondo" : fondos.length + " fondos"} que llevan más de ${DIAS_FONDO_SIN_RENDIR} días sin movimiento. Rinde los gastos que hiciste con ese dinero o, si sobró, coordina su devolución con Finanzas.`,
      extraHtml: `<table style="border-collapse:collapse;width:100%;margin-bottom:18px;"><thead><tr>${th("Fondo")}${th("Motivo")}${th("Entregado", true)}${th("Sin rendir", true)}${th("Quieto", true)}</tr></thead><tbody>${filasHtml}</tbody></table>`,
      botonTexto: "Rendir mis gastos", botonUrl: `${APP_URL}/#nueva`,
    });
    await enviarCorreo([correo], `Tienes ${fmt(total)} sin rendir en tus fondos`, html);
    const { error: errMarca } = await admin.rpc("marcar_aviso_fondos", { p_ids: fondos.map((f) => f.id) });
    if (errMarca) throw errMarca;
  }

  // 2. A administradores, una vez por semana: fondos listos para liquidar.
  if (porLiquidar.length) {
    const { data: previo } = await admin.from("system_events").select("created_at").eq("tipo", "aviso_fondos_liquidar_ok")
      .gte("created_at", new Date(Date.now() - 6.5 * 24 * 60 * 60 * 1000).toISOString()).limit(1);
    const yaAvisado = !!previo?.length;
    liquidar = { grupos: porLiquidar.map((g) => ({ persona: g.empleado_nombre, empresa: g.empresa, fondos: g.fondos.map((f) => "S-" + f.folio), neto: g.neto })), ya_avisado_esta_semana: yaAvisado };
    if (!simular && !yaAvisado) {
      const destinatarios = await destinatariosAdmin();
      if (destinatarios.length) {
        const resultado = (n: number) => n > 0 ? "Devuelve " + fmt(n) : n < 0 ? "Se le paga " + fmt(-n) : "Compensado";
        const filasHtml = porLiquidar.map((g) => `<tr style="border-bottom:1px solid #eef1f5;">${td(escapeHtml(g.empleado_nombre), false, true)}${td(escapeHtml(g.empresa))}${td(g.fondos.map((f) => "S-" + f.folio).join(", "))}${td(resultado(g.neto), true, true)}${td(g.dias + " días", true)}</tr>`).join("");
        const html = construirEmailHTML({
          appUrl: APP_URL, eyebrow: "FONDOS PARA LIQUIDAR", saludo: "Estimado(a),",
          cuerpo: `Hay ${porLiquidar.length === 1 ? "una persona" : porLiquidar.length + " personas"} con fondos listos para liquidar: sin rendiciones en revisión, y ya gastados o sin movimiento hace más de ${DIAS_FONDO_PARA_LIQUIDAR} días. Se liquidan desde el detalle de cualquiera de sus fondos.`,
          extraHtml: `<table style="border-collapse:collapse;width:100%;margin-bottom:18px;"><thead><tr>${th("Persona")}${th("Empresa")}${th("Fondos")}${th("Resultado", true)}${th("Abierto", true)}</tr></thead><tbody>${filasHtml}</tbody></table>`,
          botonTexto: "Ver fondos", botonUrl: `${APP_URL}/#fondos`,
        });
        await enviarCorreo(destinatarios, `${porLiquidar.length} persona(s) con fondos para liquidar`, html);
        await logEvent(admin, "aviso_fondos_liquidar_ok", { metadata: { grupos: porLiquidar.length } });
      }
    }
  }
  return { empleados, liquidar };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let callerId: string | null = null;
  try {
    if (!RESEND_API_KEY) throw new Error("Falta configurar el secret RESEND_API_KEY en el proyecto.");
    const caller = await requireProfile(req, admin);
    callerId = caller?.id ?? null;
    const cuerpo = await req.json().catch(() => ({}));
    const simular = cuerpo?.simular === true;

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

    // Destinatarios aprobadores/admin: se buscan una sola vez y solo si hacen falta.
    let cacheDestinatarios: string[] | null = null;
    const destinatariosAprobadores = async () => {
      if (cacheDestinatarios) return cacheDestinatarios;
      const perfiles = await leerTodas(() => admin.from("profiles")
        .select("id, nombre, rol, activo, delegado_activo, delegado_hasta", { count: "exact" })
        .eq("activo", true).or("rol.in.(aprobador,admin),delegado_activo.eq.true").order("id"));
      const ahora = Date.now();
      const elegidos = (perfiles || []).filter((p) => ["aprobador", "admin"].includes(p.rol) || (p.delegado_activo && (!p.delegado_hasta || new Date(p.delegado_hasta).getTime() > ahora)));
      const emails = await emailsDePerfiles(admin, elegidos);
      cacheDestinatarios = [...new Set(elegidos.map((p) => emails.get(p.id)).filter((e): e is string => !!e))];
      return cacheDestinatarios;
    };

    // Los avisos de fondos corren aunque no haya rendiciones pendientes, y su
    // falla no impide el resumen de pendientes (queda en Salud del sistema).
    let fondos: unknown = null;
    try { fondos = await avisarFondos(admin, destinatariosAprobadores, simular); }
    catch (e) { const m = e instanceof Error ? e.message : String(e); fondos = { error: m }; await logEvent(admin, "aviso_fondos_fail", { usuarioId: callerId, detalle: m }); }

    if (totalPendientes === 0 || simular) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, simulado: simular, total_pendientes: totalPendientes, fondos, nota: simular ? "Simulación: no se envió nada." : "No hay nada pendiente hace más de " + DIAS_PARA_RECORDAR + " días sin recordatorio reciente." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const perfilesTodos = await leerTodas(() => admin.from("profiles")
      .select("id, nombre, rol, activo, delegado_activo, delegado_hasta", { count: "exact" })
      .eq("activo", true).or("rol.in.(aprobador,admin),delegado_activo.eq.true").order("id"));
    const ahoraMs = Date.now();
    const destinatariosPerfiles = (perfilesTodos || []).filter((p) =>
      ["aprobador", "admin"].includes(p.rol) ||
      (p.delegado_activo && (!p.delegado_hasta || new Date(p.delegado_hasta).getTime() > ahoraMs))
    );
    const emailPorId = await emailsDePerfiles(admin, destinatariosPerfiles);
    const destinatarios = [...new Set(destinatariosPerfiles.map((p) => emailPorId.get(p.id)).filter((e): e is string => !!e))];

    if (!destinatarios.length) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, nota: "No se encontraron emails de aprobadores." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Días de antigüedad (no solo la fecha) -- da una idea de urgencia de
    // un vistazo, sin tener que restar fechas a mano. Se muestra como
    // pastilla de color (ámbar desde el mínimo, rojo desde los 10 días)
    // para que la fila más urgente salte a la vista sin leer el número.
    const diasDesde = (fechaIso: string) => Math.floor((Date.now() - new Date(fechaIso).getTime()) / (24 * 60 * 60 * 1000));
    const pillAntiguedad = (dias: number) => {
      const urgente = dias >= 10;
      const bg = urgente ? "#fbeaea" : "#fbf1e2";
      const color = urgente ? "#b3261e" : "#8a6d00";
      return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${bg};color:${color};font-size:12px;font-weight:600;white-space:nowrap;">${dias} día${dias === 1 ? "" : "s"}</span>`;
    };

    const filaRendicion = (r: any) => `
      <tr style="border-bottom:1px solid #eef1f5;">
        <td style="padding:12px;color:#1a1f27;font-weight:600;">N° ${escapeHtml(r.folio)}</td>
        <td style="padding:12px;color:#1a1f27;">${escapeHtml(r.empleado_nombre)}</td>
        <td style="padding:12px;">${pillAntiguedad(diasDesde(r.created_at))}</td>
        <td style="padding:12px;text-align:right;font-weight:700;color:#1a1f27;white-space:nowrap;">$${Math.round(Number(r.monto_total) || 0).toLocaleString("es-CL")}</td>
        <td style="padding:12px;text-align:right;"><a href="${APP_URL}/#detalle/${r.id}" style="color:#046bd2;text-decoration:none;font-weight:700;font-size:13px;">Revisar →</a></td>
      </tr>`;
    const filaSolicitud = (s: any) => `
      <tr style="border-bottom:1px solid #eef1f5;">
        <td style="padding:12px;color:#1a1f27;font-weight:600;">S-${escapeHtml(s.folio)}</td>
        <td style="padding:12px;color:#1a1f27;">${escapeHtml(s.empleado_nombre)}</td>
        <td style="padding:12px;">${pillAntiguedad(diasDesde(s.created_at))}</td>
        <td style="padding:12px;text-align:right;font-weight:700;color:#1a1f27;white-space:nowrap;">$${Math.round(Number(s.monto_solicitado) || 0).toLocaleString("es-CL")}</td>
        <td style="padding:12px;text-align:right;"><a href="${APP_URL}/#detalle-solicitud/${s.id}" style="color:#046bd2;text-decoration:none;font-weight:700;font-size:13px;">Revisar →</a></td>
      </tr>`;

    const cabeceraTabla = (col1: string) => `
      <thead>
        <tr>
          <th style="padding:0 12px 8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#9aa4ae;border-bottom:2px solid #eef1f5;">${col1}</th>
          <th style="padding:0 12px 8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#9aa4ae;border-bottom:2px solid #eef1f5;">Empleado</th>
          <th style="padding:0 12px 8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#9aa4ae;border-bottom:2px solid #eef1f5;">Antigüedad</th>
          <th style="padding:0 12px 8px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#9aa4ae;border-bottom:2px solid #eef1f5;">Monto</th>
          <th style="border-bottom:2px solid #eef1f5;"></th>
        </tr>
      </thead>`;

    const montoTotalPendiente =
      (rendiciones || []).reduce((s, r) => s + (Number(r.monto_total) || 0), 0) +
      (solicitudes || []).reduce((s, r) => s + (Number(r.monto_solicitado) || 0), 0);
    const montoTotalFmt = "$" + Math.round(montoTotalPendiente).toLocaleString("es-CL");

    const tablasHtml = `
      ${rendiciones && rendiciones.length ? `
        <p style="font-weight:700; font-size:13px; color:#1a1f27; margin:0 0 6px;">Rendiciones (${rendiciones.length})</p>
        <table style="border-collapse:collapse; width:100%; margin-bottom:22px;">
          ${cabeceraTabla("Folio")}
          <tbody>${rendiciones.map(filaRendicion).join("")}</tbody>
        </table>
      ` : ""}

      ${solicitudes && solicitudes.length ? `
        <p style="font-weight:700; font-size:13px; color:#1a1f27; margin:0 0 6px;">Solicitudes de fondos (${solicitudes.length})</p>
        <table style="border-collapse:collapse; width:100%; margin-bottom:22px;">
          ${cabeceraTabla("Folio")}
          <tbody>${solicitudes.map(filaSolicitud).join("")}</tbody>
        </table>
      ` : ""}
    `;

    const html = construirEmailHTML({
      appUrl: APP_URL,
      eyebrow: "RESUMEN DE PENDIENTES",
      saludo: "Estimado(a),",
      cuerpo: `Hay <strong>${totalPendientes}</strong> pendiente(s) hace más de ${DIAS_PARA_RECORDAR} días, por un total de <strong>${montoTotalFmt}</strong>.`,
      extraHtml: tablasHtml,
      botonTexto: "Ir a Aprobaciones pendientes",
      botonUrl: `${APP_URL}/#dashboard`,
    });

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
    return new Response(JSON.stringify({ ok: true, enviados: destinatarios.length, total_pendientes: totalPendientes, fondos }), {
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
