/**
 * OCR de comprobantes con Google Drive, para RindeWellness.
 * ============================================================
 *
 * QUÉ HACE
 * Recibe la foto de un comprobante, la hace pasar por el OCR de Google Drive
 * (el mismo que usa Google Docs al convertir una imagen) y devuelve el texto.
 * El archivo temporal se borra siempre, incluso si algo falla.
 *
 * POR QUÉ EXISTE
 * Leer fotos con el OCR del navegador (Tesseract) se midió contra 188
 * comprobantes reales y falla donde más caro sale: confunde un dígito y un
 * total de $10.130 se lee $310.130. Gemini lee esas mismas fotos bien, pero
 * su capa gratuita son ~20 solicitudes por modelo AL DÍA y se agota. El OCR
 * de Drive es gratis con la cuenta de Google que ya tienes y lee bastante
 * mejor que Tesseract.
 *
 * OJO: esto es OCR, no un modelo de lenguaje. Devuelve TEXTO, mejor leído,
 * pero no entiende el documento: cuál de los números es el total lo sigue
 * decidiendo parsearTextoFactura en app.js, con las mismas reglas de
 * siempre. Mejora la materia prima, no el razonamiento.
 *
 * ------------------------------------------------------------
 * CÓMO INSTALARLO (una sola vez)
 *
 * 1. Entra a https://script.google.com y crea un proyecto nuevo.
 *    Ponle un nombre reconocible, ej. "OCR Comprobantes RindeWellness".
 *
 * 2. Borra el contenido de Código.gs y pega este archivo completo.
 *
 * 3. Activa el servicio de Drive:
 *    Panel izquierdo > "Servicios" > el botón "+" > elige "Drive API".
 *    IMPORTANTE: en "Versión" elige **v2**, no v3. Este script usa
 *    Drive.Files.insert con la opción ocr, que es de la v2; con la v3 el
 *    nombre del método cambia y va a fallar.
 *    Deja el identificador en "Drive" y dale "Agregar".
 *
 * 4. Genera un secreto largo y pégalo abajo en SECRETO. Sirve cualquier
 *    cadena aleatoria larga (un generador de contraseñas está bien).
 *    Guárdalo, lo vas a necesitar en el paso 6.
 *
 * 5. Publica: botón "Implementar" > "Nueva implementación" >
 *    tipo "Aplicación web", con:
 *       - "Ejecutar como": Yo (tu cuenta)
 *       - "Quién tiene acceso": Cualquier usuario
 *    Dale "Implementar" y acepta los permisos que pida (va a pedir acceso a
 *    tu Drive: es para crear y borrar el archivo temporal del OCR).
 *    Copia la URL que te queda; termina en /exec.
 *
 *    Sobre "Cualquier usuario": la URL queda accesible para quien la tenga,
 *    por eso existe el SECRETO. Además la URL no va a estar en la página
 *    web: la guarda la Edge Function de Supabase, que es la única que llama
 *    aquí. Nadie que mire el código del sitio la ve.
 *
 * 6. Pásale a Claude la URL y el secreto, o configúralos tú:
 *       supabase secrets set DRIVE_OCR_URL=<la-url-que-termina-en-exec>
 *       supabase secrets set DRIVE_OCR_SECRET=<el-secreto-del-paso-4>
 *
 * 7. Despliega la función que lo usa:
 *       supabase functions deploy ocr-drive
 *
 * ------------------------------------------------------------
 * CÓMO PROBAR QUE QUEDÓ BIEN
 * En el editor de Apps Script, elige la función "probar" en el desplegable
 * de arriba y dale "Ejecutar". Debería registrar un texto leído de una
 * imagen generada al vuelo. Si falla ahí, falla por permisos o por la
 * versión del servicio de Drive, no por la integración.
 */

// Reemplaza esto por tu propio secreto largo antes de publicar.
const SECRETO = "CAMBIA-ESTO-POR-UN-SECRETO-LARGO";

// Tope de tamaño. Una foto de celular comprimida ronda 1-2 MB; algo mucho
// más grande es un error de quien llama, y conviene cortarlo acá antes de
// gastar el tiempo de conversión.
const MAX_BYTES = 12 * 1024 * 1024;

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return responder({ error: "Sin cuerpo en la solicitud." });

    const cuerpo = JSON.parse(e.postData.contents);
    // Comparación simple: esto no protege secretos de alto valor, solo evita
    // que un tercero que dé con la URL gaste la cuota de Drive de la cuenta.
    if (!SECRETO || SECRETO === "CAMBIA-ESTO-POR-UN-SECRETO-LARGO") {
      return responder({ error: "El script no tiene SECRETO configurado." });
    }
    if (cuerpo.secreto !== SECRETO) return responder({ error: "No autorizado." });
    if (!cuerpo.imagenBase64) return responder({ error: "Falta imagenBase64." });

    const bytes = Utilities.base64Decode(cuerpo.imagenBase64);
    if (bytes.length > MAX_BYTES) return responder({ error: "El comprobante es muy pesado." });

    const blob = Utilities.newBlob(bytes, cuerpo.mimeType || "image/jpeg", "comprobante");
    return responder({ texto: textoPorOcr(blob) });
  } catch (err) {
    // El mensaje se devuelve tal cual a propósito: del otro lado se registra
    // para poder diagnosticar sin tener que entrar acá a mirar los logs.
    return responder({ error: String((err && err.message) || err) });
  }
}

/**
 * Convierte el blob a documento de Google (que es lo que dispara el OCR),
 * lee el texto y borra el temporal.
 */
function textoPorOcr(blob) {
  // OJO con estos parámetros, es el punto donde esto falla si se toca:
  //   - El "resource" NO lleva mimeType de documento de Google. Pedirle a
  //     Drive que cree directamente un Doc Y ADEMÁS que aplique OCR falla con
  //     "OCR is not supported for files of type application/vnd.google-apps.document":
  //     el OCR se aplica sobre el archivo ORIGINAL (la imagen o el PDF), no
  //     sobre el destino.
  //   - La conversión se pide aparte, con convert:true. Sin eso el archivo se
  //     sube tal cual y no hay documento del que leer texto.
  const archivo = Drive.Files.insert(
    { title: "ocr-temporal-" + Date.now() },
    blob,
    { convert: true, ocr: true, ocrLanguage: "es" }
  );
  try {
    return DocumentApp.openById(archivo.id).getBody().getText();
  } finally {
    // En finally: si la lectura falla, igual no queremos dejar archivos
    // sueltos acumulándose en el Drive de la cuenta.
    try { Drive.Files.remove(archivo.id); } catch (errBorrado) { console.error("No se pudo borrar el temporal:", errBorrado); }
  }
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Prueba manual desde el editor: genera una imagen con texto conocido, la
 * pasa por el OCR y registra lo que salió. Sirve para separar "el script
 * está mal configurado" de "la integración está mal conectada".
 */
function probar() {
  // Un PNG mínimo no sirve para probar OCR, así que se usa un PDF de texto
  // generado al vuelo: Drive lo convierte igual y devuelve su contenido.
  const html = "<h1>BOLETA ELECTRONICA N 4471</h1><p>TOTAL $ 8.990</p><p>SON: OCHO MIL NOVECIENTOS NOVENTA</p>";
  const pdf = Utilities.newBlob(html, "text/html", "prueba.html").getAs("application/pdf");
  const texto = textoPorOcr(pdf);
  console.log("Texto leído:\n" + texto);
  if (texto.indexOf("4471") === -1) console.warn("No se encontró el folio esperado: revisa la versión del servicio de Drive (debe ser v2).");
  return texto;
}
