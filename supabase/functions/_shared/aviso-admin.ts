// Aviso por correo a los administradores cuando un servicio del que depende
// la app deja de estar disponible por un problema de cuenta (hoy: Claude sin
// crédito o con la llave rechazada). Quien lo llama ya limita la frecuencia:
// Claude solo se vuelve a probar cuando termina su pausa de una hora, así que
// llega a lo más un correo por hora mientras dure el problema.
//
// Igual que notificar-estado-rendicion: si Resend está en modo de pruebas y
// rechaza el destinatario, se reenvía a RESEND_FALLBACK_EMAIL con
// "[Reenviado]" y la línea "Destinatario real:" (los usa un reenvío automático
// del lado del usuario; no cambiar ese formato). Nunca lanza errores.

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { construirEmailHTML } from "./email.ts";

type AdminClient = ReturnType<typeof createClient>;

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export async function avisarAdministradores(
  admin: AdminClient | null, asunto: string, titulo: string, parrafos: string[], solicitar: typeof fetch = fetch,
): Promise<{ enviados: number; error?: string }> {
  try {
    const clave = Deno.env.get("RESEND_API_KEY");
    if (!admin || !clave) return { enviados: 0, error: "Sin cliente o sin RESEND_API_KEY" };
    const desde = Deno.env.get("RESEND_FROM_EMAIL") || "RindeWellness <onboarding@resend.dev>";
    const respaldo = Deno.env.get("RESEND_FALLBACK_EMAIL");
    const { data: perfiles, error } = await admin.from("profiles").select("id").eq("rol", "admin").eq("activo", true);
    if (error) throw error;
    const correos: string[] = [];
    for (const p of perfiles || []) {
      const { data } = await admin.auth.admin.getUserById(p.id as string);
      if (data?.user?.email) correos.push(data.user.email);
    }
    const destinatarios = correos.length ? correos : respaldo ? [respaldo] : [];
    if (!destinatarios.length) return { enviados: 0, error: "No hay administradores con correo" };
    const appUrl = Deno.env.get("APP_URL") || "https://rindewellness.netlify.app";
    const html = construirEmailHTML({
      appUrl, eyebrow: titulo.toUpperCase(), saludo: "Hola,",
      cuerpo: parrafos.map((p) => `<p style="margin:0 0 12px;">${escapar(p)}</p>`).join(""),
      botonTexto: "Abrir RindeWellness", botonUrl: appUrl,
    });
    const enviar = (to: string[], subject: string, cuerpo: string) => solicitar("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: desde, to, subject, html: cuerpo }),
    });
    let enviadosA = destinatarios;
    let resp = await enviar(destinatarios, asunto, html);
    let data = await resp.json().catch(() => ({}));
    if (!resp.ok && respaldo && /only send testing emails/i.test(data?.message || "")) {
      const conAviso = `<p style="background:#f4f7fb;color:#5b6472;padding:10px 14px;border-radius:6px;font-family:Arial,sans-serif;font-size:12px;">Destinatario real: ${escapar(destinatarios.join(", "))}</p>${html}`;
      enviadosA = [respaldo];
      resp = await enviar(enviadosA, `[Reenviado] ${asunto}`, conAviso);
      data = await resp.json().catch(() => ({}));
    }
    if (!resp.ok) return { enviados: 0, error: String(data?.message || "HTTP " + resp.status) };
    return { enviados: enviadosA.length };
  } catch (e) {
    console.error("No se pudo avisar a los administradores:", e);
    return { enviados: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
