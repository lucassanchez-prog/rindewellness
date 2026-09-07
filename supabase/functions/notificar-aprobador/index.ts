// Edge Function: notificar-aprobador
// Cuando se envía una rendición nueva, le manda un correo a cada
// aprobador/admin avisando que hay algo pendiente de revisar. También la
// reutiliza la app para avisar de una SOLICITUD DE FONDOS nueva (payload
// con tipo: "solicitud") -- mismo destinatario, mismo mecanismo, solo
// cambia el texto del asunto y del cuerpo.
//
// Secrets necesarios (Supabase Dashboard > Edge Functions > Manage secrets):
//   RESEND_API_KEY     -> tu API key de resend.com (gratis)
//   RESEND_FROM_EMAIL  -> opcional. Si no lo pones, usa el remitente de
//                         pruebas de Resend (onboarding@resend.dev), que
//                         funciona sin verificar un dominio propio.
//
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automático
// en toda Edge Function -- no hay que configurarlos a mano. Se necesita el
// service role acá (no el anon) porque hay que leer los emails reales desde
// auth.users, cosa que la app normal no puede hacer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "RindeWellness <onboarding@resend.dev>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!RESEND_API_KEY) throw new Error("Falta configurar el secret RESEND_API_KEY en el proyecto.");

    const { tipo, folio, empleado_nombre, empresa, monto_total, comentario, rendicion_id } = await req.json();
    const esSolicitud = tipo === "solicitud";

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Folio</td><td><strong>${folioFmt}</strong></td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Empleado</td><td>${empleado_nombre}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Empresa</td><td>${empresa || "-"}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">${esSolicitud ? "Monto solicitado" : "Monto total"}</td><td><strong>${montoFmt}</strong></td></tr>
          ${comentario ? `<tr><td style="padding: 4px 12px 4px 0; color: #5b6472; vertical-align:top;">${esSolicitud ? "Motivo" : "Comentario"}</td><td>${comentario}</td></tr>` : ""}
        </table>
        <p>Ingresa a RindeWellness para revisarla y aprobarla o rechazarla.</p>
      </div>
    `;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: destinatarios,
        subject: asunto,
        html,
      }),
    });
    const data = await resp.json();
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
