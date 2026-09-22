// Plantilla HTML compartida por las 3 Edge Functions que mandan correo
// (notificar-aprobador, notificar-estado-rendicion, recordatorios-pendientes)
// -- antes cada una tenía su propio HTML "a mano", con el riesgo real de
// que quedaran desalineadas visualmente entre sí cada vez que se
// retocaba una sola. Formato formal tipo carta corporativa (a pedido del
// usuario, con una referencia visual concreta): encabezado con logo +
// línea, título en mayúsculas, saludo formal, tabla de datos, botón
// oscuro, cierre y disclaimer.

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface FilaDato {
  label: string;
  valor: string;
  destacado?: boolean; // negrita, para el monto/folio
}

export interface EmailOpts {
  appUrl: string;
  eyebrow: string; // ej. "RENDICIÓN APROBADA"
  saludo: string; // ej. "Estimado(a) Matias Rabat,"
  cuerpo: string; // HTML ya escapado por el caller si trae datos variables
  filas?: FilaDato[];
  extraHtml?: string; // callouts opcionales (motivo de rechazo, ítems excluidos, etc.)
  botonTexto: string;
  botonUrl: string;
}

export function construirEmailHTML(opts: EmailOpts): string {
  const filasHtml = (opts.filas || [])
    .map(
      (f, i) => `
      <tr style="background:${i % 2 === 0 ? "#f7f8fa" : "#ffffff"};">
        <td style="padding:11px 16px;color:#5b6472;font-size:13px;border-bottom:1px solid #e9ecef;width:38%;">${escapeHtml(f.label)}</td>
        <td style="padding:11px 16px;color:#1a1f27;font-size:14px;${f.destacado ? "font-weight:700;" : ""}border-bottom:1px solid #e9ecef;">${f.valor}</td>
      </tr>`
    )
    .join("");

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background:#ffffff; padding:0; margin:0;">
      <div style="max-width:600px; margin:0 auto; padding:32px 36px;">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
          <tr>
            <td style="vertical-align:middle;">
              <img src="${opts.appUrl}/assets/logo-gw.png" alt="Grupo Wellness" height="30" style="height:30px;width:auto;display:block;" />
            </td>
            <td style="text-align:right;vertical-align:middle;">
              <div style="font-size:16px;font-weight:700;color:#12294d;">RindeWellness</div>
              <div style="font-size:12px;color:#8a94a3;">Sistema de rendición de gastos · Grupo Wellness</div>
            </td>
          </tr>
        </table>
        <div style="border-bottom:2px solid #12294d; margin-bottom:24px;"></div>

        <p style="margin:0 0 14px;font-size:12.5px;font-weight:700;letter-spacing:0.06em;color:#12294d;text-transform:uppercase;">${escapeHtml(opts.eyebrow)}</p>
        <p style="margin:0 0 6px;font-size:14px;color:#1a1f27;">${escapeHtml(opts.saludo)}</p>
        <p style="margin:0 0 20px;font-size:14px;color:#1a1f27;line-height:1.5;">${opts.cuerpo}</p>

        ${
          filasHtml
            ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e9ecef;border-radius:6px;overflow:hidden;margin-bottom:22px;">${filasHtml}</table>`
            : ""
        }

        ${opts.extraHtml || ""}

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:26px;">
          <tr><td style="border-radius:6px;background:#12294d;">
            <a href="${opts.botonUrl}" style="display:inline-block;padding:12px 26px;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;border-radius:6px;">${escapeHtml(opts.botonTexto)}</a>
          </td></tr>
        </table>

        <p style="margin:0 0 2px;font-size:14px;color:#1a1f27;">Atentamente,</p>
        <p style="margin:0 0 24px;font-size:14px;color:#1a1f27;">Sistema RindeWellness · Grupo Wellness</p>

        <div style="border-top:1px solid #e9ecef;padding-top:14px;">
          <p style="margin:0;font-size:11.5px;color:#9aa4ae;">Este es un mensaje automático generado por el sistema RindeWellness. Por favor no responda a este correo.</p>
        </div>
      </div>
    </div>
  `;
}
