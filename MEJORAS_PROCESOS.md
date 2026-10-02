# Procesos verificables — octubre de 2026

## Comprobantes

La lectura distingue resultados completos, parciales, contradictorios y documentos que requieren separar gastos. Los conflictos de monto, RUT, folio, fecha y tipo se muestran y requieren confirmación manual. Los reintentos del mismo archivo conservan las ediciones del usuario.

Las lecturas parciales se encolan también antes de enviar una rendición. El agente conserva los campos legibles, consulta los pendientes y respeta el máximo de dos intentos y las pausas por cuota o saturación. Sus resultados se guardan como sugerencias; no aprueba gastos ni modifica los montos guardados.

La comprobación local de fotos advierte sobre baja resolución y poco contraste. Es una heurística: no garantiza legibilidad ni detecta todos los casos de desenfoque o recorte.

## Fondos y contabilidad

`distribuir_fondos_csv` calcula fondo y exceso con una única lectura del historial, con permisos del usuario y orden estable. La interfaz impide exportar si falta una distribución comprobada o si su suma no corresponde al monto que se exportará.

La verificación contable guarda monto, cuenta con nombre, referencia y fecha. Al editar datos relevantes, el servidor invalida la comprobación. Para documentos repartidos entre ítems, se compara la suma de las partes no rechazadas y se comprueba que la distribución siga vigente al mostrar la verificación.

## Validación

- `npm ci --ignore-scripts`
- `npm run lint`
- `npm test`

El flujo de GitHub ejecuta estas comprobaciones en cada push y pull request. `data-access.js` contiene la paginación y la distribución, sin depender del DOM. `_shared/estado-lectura.ts` contiene las decisiones de completitud y reintento.

## Evaluar la IA con referencias

`node scripts/evaluar-ocr.cjs referencias.json lecturas.json resultado.json`

Los archivos son arreglos por `id`. Cada referencia debe contener un objeto `referencia` con los campos comprobados por una persona; cada lectura contiene `datos`. El evaluador normaliza formato de RUT, folio y texto, pero exige igualdad numérica del monto. No calcula precisión sin referencias y no llama a servicios externos.

Los ejemplos privados y sus resultados deben permanecer fuera del repositorio. La cobertura de campos de un lector no equivale a exactitud de IA: solo se puede medir esta última contra referencias verificadas.

## Respaldo independiente sin API de pago

Cuando Gemini falla, el navegador puede usar Tesseract para fotos y PDF escaneados de una página. El motor se reutiliza, serializa las lecturas, vence las operaciones bloqueadas y se reinicia para el siguiente comprobante. Una lectura débil permite una segunda segmentación y ampliar imágenes pequeñas; no se elige el mayor número del documento como total de una foto.

El bot aplica el mismo circuito de proveedores, discrepancias, campos editados y alertas de duplicados. Cada campo recuperado queda marcado para comparar con el original. Montos contradictorios quedan vacíos. Emisión tiene prioridad sobre vencimiento cuando está rotulada. Un PDF multipágina requiere seleccionar/separar el comprobante antes de leerlo.

Tesseract corre mientras el navegador está abierto y requiere descargar su motor e idioma la primera vez. El trabajador de Supabase dispone también de Groq visual como respaldo independiente de Gemini, activado con consentimiento de la empresa y limitado al plan gratuito. Ambos proveedores pasan por las mismas comprobaciones de campos y evidencia; se respetan las esperas por cuota. No se ha activado facturación. Tesseract reconoce texto y no comprende documentos como un modelo visual.

## Exportables

El Excel contiene resumen conciliado por estados, detalle con cuenta y nombre, motivos de rechazo, referencia de fondo y presencia de adjuntos, y solicitudes con consumo/saldo/exceso. Conserva fechas y montos como valores tipados, folios como texto, filtros y encabezados inmovilizados. ExcelJS está fijado a 4.4.0 y se carga desde un recurso local al exportar.

El PDF conserva el diseño aprobado, incorpora el índice de adjuntos, todas las páginas de los PDF e imágenes originales y evita repetir un archivo compartido entre ítems. Advierte por gastos sin adjunto y archivos no disponibles. El CSV contable rechaza diferencias entre gastos aprobados y contrapartida; el reporte general pagina todos los registros y escapa comas, comillas y saltos de línea. Los textos del CSV general se neutralizan para evitar que Excel los interprete como fórmulas.

Validación ampliada: pruebas automatizadas y ESLint en cada cambio. PDF generado con el código real de la aplicación y fotografías históricas, renderizado para comprobar su presencia. Excel generado, reabierto y sus hojas inspeccionadas; no se modificaron gastos reales durante estas pruebas.

## Envío completo y seguridad — auditoría del 2 de octubre

`crear_rendicion_completa` guarda la cabecera y todos los gastos en una transacción con permisos del usuario. Un archivo que no se sube cancela el envío y conserva el formulario. Los archivos subidos correctamente se reutilizan al reintentar. Cada borrador conserva su UUID para reconocer un envío ya recibido aunque se haya perdido la respuesta; los reintentos no vuelven a notificar al aprobador.

La identidad proviene del perfil del servidor y los totales de los gastos guardados. El RPC no permite enviar aprobaciones ni acreditar verificación con una bandera del navegador. La fecha seleccionada se guarda en `fecha_rendicion`; los registros anteriores conservan su fecha de creación. Los exportables distinguen fecha de rendición y fecha de envío. Los indicadores y filtros históricos siguen midiendo la fecha de envío.

Usuarios desactivados y cuentas sin perfil no acceden a datos financieros ni generan nuevos enlaces de comprobantes. Los aprobadores delegados vigentes pueden abrir los adjuntos que revisan. Las políticas evalúan identidad y rol una vez por consulta, y los eventos operativos solo se registran desde el servidor. Los enlaces firmados emitidos antes de desactivar una cuenta mantienen su validez hasta expirar.

El lector de PDF desactiva la evaluación dinámica siguiendo la mitigación oficial de Mozilla para GHSA-wgrm-67xf-hhpq. Se retiró la biblioteca XLSX antigua que ya no se utilizaba y se fijó el cliente Supabase a 2.117.2. El cambio de categoría o clasificación de una boleta conserva RUT, tipo, folio y fecha del comprobante.

`supabase/tests/envio-permisos.sql` comprueba guardado atómico, reintentos, identidad, totales y acceso con el rol real `authenticated`. Debe ejecutarse en una transacción con ROLLBACK; solo crea datos sintéticos y no llama a servicios externos. Como cualquier prueba de INSERT con secuencias PostgreSQL, puede dejar huecos en folios aunque se reviertan las filas.

