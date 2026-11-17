// Google Apps Script (cuenta de Gmail que recibe los correos de respaldo de Resend).
// Mientras Resend está en modo de pruebas, la app manda cada aviso a esta casilla
// con "[Reenviado]" en el asunto y una línea "Destinatario real: ..." en el cuerpo.
// Este script lo envía a esas personas como un correo normal de RindeWellness:
// nombre de remitente "RindeWellness", asunto original, sin la línea de reenvío
// y sin el encabezado "---------- Forwarded message ----------".
// Se ejecuta con un activador por tiempo (cada 1 o 5 minutos).
//
// Ojo: la dirección sigue siendo la de esta cuenta de Gmail; solo cambia el nombre
// que se ve. Para que salga desde una dirección propia de RindeWellness hay que
// verificar el dominio en Resend (y entonces este script ya no hace falta).
//
// Se recuerda cada MENSAJE enviado (no el hilo): Gmail agrupa en un mismo hilo
// los avisos con el mismo asunto (p. ej. el resumen semanal), y marcar el hilo
// hacía que los avisos siguientes de ese hilo nunca se enviaran.

function reenviarNotificacionesRindeWellness() {
  const ETIQUETA = "RindeWellness/Reenviado";
  const NOMBRE = "RindeWellness";
  const props = PropertiesService.getScriptProperties();
  const enviados = JSON.parse(props.getProperty("enviados") || "[]");
  const yaEnviado = new Set(enviados);
  let label = GmailApp.getUserLabelByName(ETIQUETA);
  if (!label) label = GmailApp.createLabel(ETIQUETA);

  const hilos = GmailApp.search('subject:"[Reenviado]" from:onboarding@resend.dev newer_than:7d');

  hilos.forEach((hilo) => {
    hilo.getMessages().forEach((msg) => {
      const id = msg.getId();
      if (yaEnviado.has(id)) return;
      // Correos anteriores a este script: ya los reenviaba la versión antigua.
      if (hilo.getLabels().some((l) => l.getName() === ETIQUETA) && msg.getDate() < INICIO) { yaEnviado.add(id); enviados.push(id); return; }

      const match = /Destinatario real:\s*([^\n\r]+)/i.exec(msg.getPlainBody());
      if (!match) return; // no es un correo de reenvío de RindeWellness
      const emails = match[1].match(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
      if (!emails || !emails.length) return;

      const asunto = msg.getSubject().replace(/^\s*\[Reenviado\]\s*/i, "");
      // Quita el párrafo "Destinatario real: ..." que agrega la app (es el primer <p>).
      const html = msg.getBody().replace(/<p[^>]*>\s*Destinatario real:[\s\S]*?<\/p>/i, "");
      const texto = msg.getPlainBody().replace(/^\s*Destinatario real:[^\n\r]*[\r\n]*/i, "");

      try {
        GmailApp.sendEmail(emails.join(","), asunto, texto, { htmlBody: html, name: NOMBRE });
        Logger.log("Enviado a: " + emails.join(", ") + " · " + asunto);
        yaEnviado.add(id); enviados.push(id);
        hilo.addLabel(label);
      } catch (err) {
        Logger.log("Error enviando (se reintenta en la próxima pasada): " + err);
      }
    });
  });

  // Solo hace falta recordar lo de la última semana (la búsqueda mira 7 días).
  props.setProperty("enviados", JSON.stringify(enviados.slice(-500)));
}

// Fecha en que se instaló esta versión: lo anterior ya lo reenvió la versión antigua.
const INICIO = new Date("2026-11-17T00:00:00-03:00");
