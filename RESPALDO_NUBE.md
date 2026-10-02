# Lectura de comprobantes y respaldo de nube

La lectura usa las funciones existentes de Supabase. El trabajador programado continúa con el navegador cerrado y no requiere un computador de la empresa encendido. Gemini sigue siendo el proveedor principal. Se preparó Groq como proveedor independiente de respaldo, con el mismo prompt y las mismas validaciones de RUT, fecha, monto y separación de documentos. No aprueba gastos ni modifica una corrección manual del formulario.

## Estado de activación

Groq permanece desactivado mientras no existan las cuatro variables indicadas abajo. Publicar el código no lo activa. No se ha creado una cuenta, aceptado sus términos, agregado una tarjeta ni activado facturación. Las pruebas automatizadas utilizan respuestas simuladas, sin enviar documentos a Groq. El plan real de una cuenta no puede comprobarse mediante esta configuración: `GROQ_PLAN=free` es una declaración del administrador, no un bloqueo del proveedor frente a un cambio posterior de plan.

Para activar, el titular debe crear una cuenta gratuita en https://console.groq.com/, aceptar sus términos y generar una clave de API. Debe mantenerse sin método de pago ni actualización al plan Developer. La clave se guarda directamente en **Supabase → proyecto rbmmwgndtrgdzherqxko → Edge Functions → Secrets**. Nunca en el chat, el frontend, un archivo público o Git.

| Secreto de servidor | Valor |
| --- | --- |
| `GROQ_API_KEY` | Clave privada de la cuenta gratuita |
| `GROQ_PLAN` | `free` |
| `GROQ_OCR_CONSENT` | `true`, solamente después de autorizar el envío de los comprobantes de la empresa y sus datos parciales a Groq |
| `GROQ_OCR_ENABLED` | `true`, configurar al final |

La autorización previa para enviar comprobantes a Google Gemini no se considera autorización para enviarlos a Groq. Antes de activar hay que confirmar explícitamente el nuevo destino y los datos (imágenes del comprobante, RUT, montos y campos parciales). Para desactivar, cambiar `GROQ_OCR_ENABLED` a `false`; Gemini y los reintentos existentes siguen funcionando.

## Comportamiento

- Si Gemini responde correctamente, se conserva su lectura. Si falla, y el respaldo está activado, se intenta Groq dentro del mismo presupuesto de tiempo.
- Una respuesta de cuota agotada pospone el trabajo una hora; saturación o timeout lo pospone 15 minutos. El agotamiento de ambos proveedores no obliga a mantener un computador encendido.
- Las imágenes nuevas se preparan antes de enviarlas: orientación EXIF, escala hasta 2000 píxeles, detección conservadora de bordes y corrección de perspectiva. El usuario puede girar, mejorar contraste o leer sin recortar. Se conserva la foto original como adjunto.
- Un PDF de una página se convierte a imagen para la lectura; en documentos multipágina el usuario elige la página del comprobante. La cola creada por esa lectura recibe la imagen preparada. Los PDFs antiguos que el trabajador descarga directamente del almacenamiento todavía dependen de Gemini: Groq recibe solamente JPEG, PNG o WebP. No se presenta este respaldo como cobertura total de todos los archivos históricos.
- La revisión muestra el documento junto a los campos pendientes. Las regiones señaladas son sugerencias del lector, no una prueba de exactitud. Se rechazan coordenadas inválidas y se muestra el documento completo cuando no hay ubicación precisa.
- El plan gratuito de Groq tiene límites; disponer de dos proveedores no garantiza disponibilidad continua ni lectura perfecta de documentos borrosos.

## Validación

`npm test` y `npm run lint`. Se prueban desactivación sin consentimiento/clave, formato visual, validación de RUT y monto, respuesta 429/503, ausencia de secretos en errores, perspectiva y rechazo de regiones inválidas. La revisión se comprueba en navegador con un documento ficticio. Una prueba real de Groq sigue pendiente hasta configurar cuenta y consentimiento.

`node scripts/evaluar-ocr.cjs referencias.json lecturas.json resultado.json` separa cobertura, precisión de campos completados y errores. Agrupa por tipo de comprobante y partición. Una referencia nula no se cuenta como acierto. Los ejemplos ya usados para ajustar el lector se consideran desarrollo; no son una validación independiente. Para una prueba independiente se debe reservar otro grupo de archivos, sin repartir páginas del mismo documento entre desarrollo y prueba, etiquetarlo antes de leerlo y conservar los resultados sin reajustar sobre ese grupo.

Fuentes: [Visión de Groq](https://console.groq.com/docs/vision), [facturación](https://console.groq.com/docs/billing-faqs), [límites](https://console.groq.com/docs/rate-limits), [tratamiento de datos](https://console.groq.com/docs/your-data), [secretos de Supabase](https://supabase.com/docs/guides/functions/secrets).
