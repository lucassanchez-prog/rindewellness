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
