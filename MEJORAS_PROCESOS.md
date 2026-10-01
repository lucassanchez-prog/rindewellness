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

Este respaldo corre mientras el navegador está abierto. El trabajador de Supabase sigue usando Gemini: no se ha configurado un segundo modelo de lenguaje ni facturación. Tesseract requiere descargar su motor e idioma la primera vez y no comprende documentos como un modelo visual.

## Exportables

El Excel contiene resumen conciliado por estados, detalle con cuenta y nombre, motivos de rechazo, referencia de fondo y presencia de adjuntos, y solicitudes con consumo/saldo/exceso. Conserva fechas y montos como valores tipados, folios como texto, filtros y encabezados inmovilizados. ExcelJS está fijado a 4.4.0 y se carga desde un recurso local al exportar.

El PDF conserva el diseño aprobado, incorpora el índice de adjuntos, todas las páginas de los PDF e imágenes originales y evita repetir un archivo compartido entre ítems. Advierte por gastos sin adjunto y archivos no disponibles. El CSV contable rechaza diferencias entre gastos aprobados y contrapartida; el reporte general pagina todos los registros y escapa comas, comillas y saltos de línea.

Validación ampliada: 56 pruebas automatizadas y ESLint. PDF generado con el código real de la aplicación y fotografías históricas, renderizado para comprobar su presencia. Excel generado, reabierto y sus hojas inspeccionadas; no se modificaron gastos reales durante estas pruebas.
