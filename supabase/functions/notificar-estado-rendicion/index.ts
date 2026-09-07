// Edge Function: notificar-estado-rendicion
// Cuando un aprobador aprueba o rechaza una rendición, le manda un correo
// al EMPLEADO que la envió (no a los aprobadores) avisando el resultado,
// y si fue rechazada, el motivo. También la reutiliza la app para avisar
// el resultado de una SOLICITUD DE FONDOS (payload con tipo: "solicitud")
// -- mismo mecanismo, solo cambia el texto del asunto y del cuerpo.
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
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automático
// en toda Edge Function -- no hay que configurarlos a mano. Se necesita el
// service role acá (no el anon) porque hay que leer el email real del
// empleado desde auth.users, cosa que la app normal no puede hacer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "RindeWellness <onboarding@resend.dev>";
const FALLBACK_EMAIL = Deno.env.get("RESEND_FALLBACK_EMAIL");

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
        Destinatario real: ${to.join(", ")}
      </p>
      ${html}
    `;
    resp = await enviar([FALLBACK_EMAIL], `[Reenviado] ${subject}`, htmlConAviso);
    data = await resp.json();
  }
  return { resp, data };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!RESEND_API_KEY) throw new Error("Falta configurar el secret RESEND_API_KEY en el proyecto.");

    const { tipo, folio, empleado_id, empleado_nombre, empresa, monto_total, estado, motivo_rechazo, aprobador_nombre } = await req.json();
    if (!empleado_id) throw new Error("Falta empleado_id.");
    const esSolicitud = tipo === "solicitud";

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: userData, error: errUser } = await admin.auth.admin.getUserById(empleado_id);
    if (errUser) throw errUser;
    const destinatario = userData?.user?.email;
    if (!destinatario) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, nota: "No se encontró el email del empleado." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aprobado = estado === "Aprobado";
    const montoFmt = "$" + Math.round(Number(monto_total) || 0).toLocaleString("es-CL");
    const folioFmt = esSolicitud ? `S-${folio}` : `N° ${folio}`;
    const sustantivo = esSolicitud ? "solicitud de fondos" : "rendición";
    const asunto = `Tu ${sustantivo} ${folioFmt} fue ${aprobado ? "aprobada" : "rechazada"}`;
    const colorEstado = aprobado ? "#1a7a4c" : "#b3261e";
    const html = `
      <div style="font-family: Arial, sans-serif; color: #1a1f27;">
        <h2 style="margin-bottom: 4px;">Tu ${sustantivo} fue <span style="color:${colorEstado}">${aprobado ? "aprobada" : "rechazada"}</span></h2>
        <p style="color: #5b6472; margin-top: 0;">RindeWellness · Grupo Wellness</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Folio</td><td><strong>${folioFmt}</strong></td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Empleado</td><td>${empleado_nombre || "-"}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">Empresa</td><td>${empresa || "-"}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">${esSolicitud ? "Monto solicitado" : "Monto total"}</td><td><strong>${montoFmt}</strong></td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #5b6472;">${aprobado ? "Aprobado" : "Rechazado"} por</td><td>${aprobador_nombre || "-"}</td></tr>
          ${!aprobado ? `<tr><td style="padding: 4px 12px 4px 0; color: #5b6472; vertical-align:top;">Motivo</td><td>${motivo_rechazo || "No se indicó un motivo."}</td></tr>` : ""}
        </table>
        ${aprobado && esSolicitud ? `<p style="color:#5b6472;">La entrega del fondo corresponde a que la gestione Finanzas, fuera de la app.</p>` : ""}
        <p>Ingresa a RindeWellness para ver el detalle.</p>
      </div>
    `;

    const { resp, data } = await enviarConFallback([destinatario], asunto, html);
    if (!resp.ok) throw new Error(data?.message || "Error enviando el correo con Resend");

    return new Response(JSON.stringify({ ok: true, enviados: 1 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
