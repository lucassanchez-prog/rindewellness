// Lógica compartida para leer un comprobante con Gemini: arma el prompt,
// prueba una cadena de modelos candidatos con reintentos, y valida/limpia
// el JSON de vuelta. La usan tanto ocr-recibo (llamada en vivo cuando
// alguien adjunta un comprobante) como ocr-reintento-pendientes (reintento
// en segundo plano, vía pg_cron, para los que fallaron la primera vez) --
// separado a un módulo propio para no tener esta lógica duplicada en dos
// archivos: ya costó dos incidentes el mismo día corregir un nombre de
// modelo mal puesto, y tenerlo repetido en dos lados solo hubiera
// significado corregirlo dos veces.
//
// "Aprende" cuál modelo probar primero: cada intento (éxito o fallo) queda
// registrado en public.gemini_modelo_stats (ver migracion_ocr_reintento.sql),
// y el orden de GEMINI_MODELS_ORDEN se reordena en cada llamada según qué
// modelo viene respondiendo mejor últimamente -- si Google satura
// "gemini-3.6-flash" por un rato y "gemini-3.7-flash" viene respondiendo
// bien, las próximas llamadas empiezan directo por el que funciona, sin
// esperar a que alguien note el patrón y reordene la lista a mano.

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AdminClient = ReturnType<typeof createClient>;

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// Lista BASE de modelos a probar -- el orden real de cada llamada sale de
// ordenarModelosPorRendimiento() más abajo, esto es solo el conjunto y el
// orden de partida (para modelos sin estadística todavía, o si la consulta
// a gemini_modelo_stats falla). Adivinar a mano un nombre de modelo por
// blog posts/changelog público de Google ya falló DOS veces el mismo día:
// "gemini-2.5-flash" resultó dado de baja para esta cuenta ("no longer
// available to new users"), y "gemini-3.1-pro" directamente nunca existió
// como ID (el real es "gemini-3.1-pro-preview", que es OTRO modelo). Esta
// lista SÍ está verificada -- se confirmó contra la API real de Google
// (GET /v1beta/models con esta misma GEMINI_API_KEY). Todos "flash" --
// rápidos/baratos, apropiados para esta extracción estructurada -- salvo el
// último, "gemini-flash-latest", que es un ALIAS que Google mantiene
// apuntando al flash vigente en cada momento (nunca hay que actualizarlo a
// mano cuando Google lance un modelo nuevo), como último recurso antes de
// rendirse. Configurable por si Google vuelve a cambiar la disponibilidad
// de alguno, para ajustar el conjunto sin esperar un redeploy del código.
const GEMINI_MODELOS_BASE = (Deno.env.get("GEMINI_MODELS_ORDEN") || "gemini-3.6-flash,gemini-3.5-flash,gemini-3.7-flash,gemini-flash-latest")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const geminiUrl = (modelo: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;

// Ventana de "reciente" para pesar la estadística -- un modelo que estuvo
// mal hace 3 días no debería seguir castigado hoy. Se usa solo para el
// desempate por antigüedad (ver ordenarModelosPorRendimiento); los
// contadores acumulados igual se resetean solos cada tanto porque
// gemini_modelo_stats guarda "última hora" de éxito/fallo, no un log
// infinito.
const VENTANA_RECIENTE_MS = 3 * 60 * 60 * 1000; // 3 horas

// Registra el resultado de UN intento contra UN modelo -- no bloquea el
// flujo principal si falla (una tabla de estadística que no se pudo
// actualizar no debería tumbar una lectura de comprobante que sí funcionó).
// La cuota del nivel gratuito es POR MODELO (ej. "limit: 20, model:
// gemini-3.6-flash"). Cuando un modelo la agota, seguir llamándolo es 100%
// desperdicio: responde el mismo error sin hacer nada. Esto detecta ese
// caso para poder ponerlo en enfriamiento.
const esErrorDeCuota = (mensaje: string) =>
  /quota|rate.?limit|exceeded your current quota/i.test(mensaje);

// Cuánto esperar antes de volver a probar un modelo que agotó cuota. Google
// manda un "Please retry in 20.4s" cuando es el límite por minuto; si no
// viene ese dato, se asume que es el límite DIARIO y se espera bastante más
// (no tiene sentido reintentar cada 5 minutos contra un tope diario).
const ENFRIAMIENTO_POR_DEFECTO_MS = 60 * 60 * 1000; // 1 hora

function calcularEnfriamiento(mensaje: string): number {
  const sugerido = /retry in ([\d.]+)s/i.exec(mensaje);
  if (sugerido) return Math.max(Number(sugerido[1]) * 1000 + 2000, 30_000);
  return ENFRIAMIENTO_POR_DEFECTO_MS;
}

async function registrarIntentoModelo(admin: AdminClient | null, modelo: string, exito: boolean, mensajeError?: string) {
  if (!admin) return;
  try {
    const ahora = new Date();
    const { data: fila } = await admin.from("gemini_modelo_stats").select("intentos_ok, intentos_fail").eq("modelo", modelo).maybeSingle();
    // Si el fallo fue por cuota, se anota hasta cuándo no vale la pena
    // volver a llamarlo -- ver ordenarModelosPorRendimiento, que directamente
    // lo saca de la lista hasta esa hora. Un éxito limpia el enfriamiento.
    const enfriamiento = !exito && mensajeError && esErrorDeCuota(mensajeError)
      ? new Date(ahora.getTime() + calcularEnfriamiento(mensajeError)).toISOString()
      : null;
    await admin.from("gemini_modelo_stats").upsert({
      modelo,
      intentos_ok: (fila?.intentos_ok || 0) + (exito ? 1 : 0),
      intentos_fail: (fila?.intentos_fail || 0) + (exito ? 0 : 1),
      ultimo_resultado: exito ? "ok" : "fail",
      ultimo_intento: ahora.toISOString(),
      // El mensaje crudo POR MODELO. Sin esto solo quedaba en console.error
      // de la Edge Function (que no se puede consultar desde acá), y hubo
      // que deducir qué estaba fallando mirando los tiempos entre intentos
      // -- costó horas de diagnóstico a ciegas.
      ultimo_error: exito ? null : (mensajeError || null),
      disponible_desde: enfriamiento,
    });
  } catch (err) {
    console.error(`No se pudo registrar estadística de Gemini para ${modelo}:`, err);
  }
}

// Reordena GEMINI_MODELOS_BASE según qué modelo viene funcionando mejor
// últimamente. Heurística simple a propósito (no hace falta más que esto
// para el objetivo real, que es "dejar de insistirle primero al que
// acaba de fallar"):
//   1. Si el último resultado fue "ok" Y fue reciente (< VENTANA_RECIENTE_MS),
//      ese modelo sube al frente -- lo más probable es que un modelo que
//      acaba de responder bien siga respondiendo bien los próximos minutos.
//   2. Entre el resto, gana la mejor tasa de éxito acumulada
//      (intentos_ok / total) -- desempata por orden original si no hay
//      estadística (modelo nuevo, o la consulta falló).
// No es aprendizaje automático de verdad, es una cola que se reordena sola
// con datos reales en vez de quedar fija para siempre en el código.
async function ordenarModelosPorRendimiento(admin: AdminClient | null): Promise<string[]> {
  if (!admin) return GEMINI_MODELOS_BASE;
  try {
    const { data: stats, error } = await admin
      .from("gemini_modelo_stats")
      .select("modelo, intentos_ok, intentos_fail, ultimo_resultado, ultimo_intento, disponible_desde")
      .in("modelo", GEMINI_MODELOS_BASE);
    if (error || !stats?.length) return GEMINI_MODELOS_BASE;

    const porModelo = new Map(stats.map((s) => [s.modelo as string, s]));
    const ahora = Date.now();

    // Lo más importante para no desperdiciar cuota: sacar de la lista los
    // modelos que ya dijeron "quota exceeded" y todavía están en
    // enfriamiento. Llamarlos de nuevo antes de tiempo no falla "gratis":
    // consume una solicitud del cupo para recibir exactamente el mismo
    // error. Si TODOS están enfriándose, se devuelve lista vacía y
    // leerComprobante corta al instante sin tocar Gemini ni una vez.
    const disponibles = GEMINI_MODELOS_BASE.filter((m) => {
      const hasta = porModelo.get(m)?.disponible_desde as string | null | undefined;
      return !hasta || new Date(hasta).getTime() <= ahora;
    });

    return disponibles.sort((a, b) => {
      const sa = porModelo.get(a);
      const sb = porModelo.get(b);
      const puntaje = (s: typeof sa) => {
        if (!s) return 0; // sin estadística: neutral, ni favorecido ni castigado
        const total = (s.intentos_ok || 0) + (s.intentos_fail || 0);
        const tasa = total > 0 ? (s.intentos_ok || 0) / total : 0;
        const reciente = s.ultimo_intento && (ahora - new Date(s.ultimo_intento as string).getTime()) < VENTANA_RECIENTE_MS;
        const bonusReciente = reciente && s.ultimo_resultado === "ok" ? 1 : 0;
        return tasa + bonusReciente;
      };
      // Orden descendente de puntaje; empate real (ambos 0) mantiene el
      // orden original de GEMINI_MODELOS_BASE (Array.sort es estable).
      return puntaje(sb) - puntaje(sa);
    });
  } catch (err) {
    console.error("No se pudo leer gemini_modelo_stats, se usa el orden base:", err);
    return GEMINI_MODELOS_BASE;
  }
}

// Mismo listado de categorías de gasto directo que CATEGORIAS_GASTO en
// app.js (sin la opción "Otro", que es solo para elegir cuenta a mano) --
// se le pasa a Gemini para que elija la más parecida, en vez de inventar
// una categoría que no existe en la app.
export const CATEGORIAS = [
  "Gerenciamiento", "Arriendo Instalaciones", "Arriendo Instalaciones Variables", "Gastos Comunes",
  "Telefonía e Internet", "Electricidad", "Gas", "Agua", "Servicios Informaticos", "Servicio de Seguridad",
  "Implementos Gimnasio", "Servicios en Streaming", "Gasto Fee de Ventas y Marketing", "Patentes Comerciales",
  "Fletes", "Combustibles", "Arriendo de Vehiculos", "Estacionamiento", "Seguros", "Materiales",
  "Materiales de Aseo y Oficina", "Gastos Cafeteria", "Servicios Computacionales", "Donaciones",
  "Gastos de Administración", "Mantenciones Generales", "Mantenciones Extraordinarias", "Gastos de Representacion",
  "Prevencion de Riesgos", "Publicidad y Marketing", "Publicidad After Dmoov", "Publicidad en RRSS",
  "Licencias SCD", "Fitmewise", "Informatica y Licencias", "Gastos RFA", "Asesoria Legal", "Asesoria Tributaria",
  "Otras Asesorias", "Beneficios del Personal", "Traslados del Personal", "Viaticos del Personal",
  "Capacitaciones al Personal", "Honorarios Profesionales", "Honorarios Sin Retención",
];

const PROMPT = `Eres un asistente que extrae datos de comprobantes de compra chilenos
(facturas electrónicas, boletas electrónicas o boletas de honorarios).
Analiza la imagen adjunta y devuelve SOLO un JSON válido, sin texto adicional
ni explicaciones, con exactamente esta forma:
{
  "nombre_proveedor": "razón social o nombre del proveedor/local" o null,
  "rut_proveedor": "12.345.678-9" o null,
  "tipo_documento": "Factura Electrónica" | "Factura Exenta Electrónica" | "Boleta de Honorario" | "Boleta Electrónica" | null,
  "nro_documento": "string" o null,
  "fecha": "YYYY-MM-DD" o null,
  "monto": number o null,
  "descripcion": "breve descripción del gasto, ej: Almuerzo equipo ventas" o null,
  "categoria_sugerida": una de estas opciones EXACTAS: ${CATEGORIAS.map((c) => `"${c}"`).join(", ")} -- la que mejor calce con el gasto, o null si ninguna calza bien
}
Si no puedes leer un dato con certeza, usa null en ese campo. No inventes datos.
El monto debe ser el total final del documento, sin puntos ni signos, solo el número.
Para "categoria_sugerida", usa el texto EXACTO de una de las opciones de la lista (respetando tildes y mayúsculas), nunca inventes una categoría nueva.`;

// Gemini a veces devuelve "high demand" de forma transitoria (picos de uso),
// la capa gratuita tiene un límite de solicitudes POR MINUTO ("quota
// exceeded") que se libera solo unos segundos después, y a veces un modelo
// completo deja de estar disponible para esta cuenta (dado de baja,
// restringido, etc.) -- los tres casos se resuelven pasando al siguiente
// modelo candidato, no son errores permanentes de la llamada en sí. OJO: el
// mensaje real de Google para "modelo dado de baja" es "no longer available
// to new users", que NO contiene la palabra "unavailable" -- por eso va
// listado aparte acá; nos pasó exactamente este caso con gemini-2.5-flash.
// Un error genuinamente permanente (API key inválida, contenido bloqueado
// por seguridad, request malformado) NO matchea ninguno de estos patrones,
// así que corta altiro en vez de gastar tiempo probando cada candidato de
// la lista para nada.
const esErrorDeModelo = (mensaje: string) =>
  /high demand|unavailable|overloaded|quota|rate.?limit|no longer available|not found|is not supported|deprecated/i.test(mensaje);

// Presupuestos de tiempo. OJO, esto ya nos mordió fuerte: el primer valor
// que se puso acá fue 12s por llamada / 22s en total, elegido "a ojo" sin
// medir nunca cuánto tarda de verdad una lectura exitosa -- y resultó ser
// MÁS CORTO que lo que tarda Gemini en leer un documento. El resultado fue
// que 9 de cada 10 fallos de la tarde eran nuestro propio timeout cortando
// llamadas que iban en camino, no un problema de Google: con 4 modelos
// candidatos y 22s totales, ninguno llegaba a tener una oportunidad real.
//
// Por eso ahora son configurables por caller, con valores muy distintos:
//   - En vivo (ocr-recibo): hay una persona mirando el spinner, así que la
//     prioridad es NO hacerla esperar de más. Vale más darle a UN modelo
//     una oportunidad de verdad que repartir migajas entre cuatro. Tiene
//     que caber bajo el timeout del frontend (35s, ver conTimeout en
//     llamarOcrRecibo, app.js).
//   - En segundo plano (ocr-reintento-pendientes): no hay nadie esperando.
//     Puede darse el lujo de esperar lo que Gemini necesite.
export interface PresupuestoTiempo {
  porLlamadaMs: number;
  totalMs: number;
}
export const PRESUPUESTO_EN_VIVO: PresupuestoTiempo = { porLlamadaMs: 28_000, totalMs: 30_000 };
export const PRESUPUESTO_SEGUNDO_PLANO: PresupuestoTiempo = { porLlamadaMs: 45_000, totalMs: 100_000 };

async function llamarGemini(admin: AdminClient | null, modelo: string, intentosMax: number, inicio: number, body: unknown, presupuesto: PresupuestoTiempo) {
  let ultimoError: Error = new Error("Error consultando Gemini");
  for (let intento = 1; intento <= intentosMax; intento++) {
    let mensaje: string;
    let esErrorDeRed = false;
    try {
      // Timeout explícito por llamada -- sin esto, un fetch colgado (no un
      // error de Gemini, sino la red misma sin responder) no cuenta como
      // intento fallido y se come todo el presupuesto de tiempo sin pasar
      // nunca al siguiente modelo candidato. Ver PresupuestoTiempo sobre
      // por qué este número NO puede ser corto "por las dudas".
      const resp = await fetch(geminiUrl(modelo), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(presupuesto.porLlamadaMs),
      });
      const respData = await resp.json();
      if (resp.ok) {
        await registrarIntentoModelo(admin, modelo, true);
        return respData;
      }
      mensaje = respData?.error?.message || "Error consultando Gemini";
    } catch (errRed) {
      // fetch()/resp.json() pueden lanzar directo (corte de conexión,
      // respuesta no-JSON como una página de error HTML del gateway
      // durante un pico de demanda, timeout del AbortSignal de arriba) --
      // se marca aparte como retryable (no depende de que el texto del
      // error matchee esErrorDeModelo, que espera mensajes de Gemini, no
      // excepciones de red/timeout de fetch).
      esErrorDeRed = true;
      mensaje = errRed instanceof Error && errRed.name === "TimeoutError"
        ? "Tiempo de espera agotado consultando Gemini."
        : `Error de red consultando Gemini: ${String(errRed instanceof Error ? errRed.message : errRed)}`;
    }

    await registrarIntentoModelo(admin, modelo, false, mensaje);
    ultimoError = new Error(mensaje);
    (ultimoError as Error & { reintentable?: boolean }).reintentable = esErrorDeRed || esErrorDeModelo(mensaje);
    const tiempoRestante = presupuesto.totalMs - (Date.now() - inicio);
    if (!(ultimoError as Error & { reintentable?: boolean }).reintentable || intento === intentosMax || tiempoRestante <= 0) throw ultimoError;
    const retrySugerido = /retry in ([\d.]+)s/i.exec(mensaje);
    const esperaSugerida = retrySugerido ? Math.min(Number(retrySugerido[1]) * 1000 + 1000, 3000) : 1200 * intento;
    await new Promise((r) => setTimeout(r, Math.min(esperaSugerida, tiempoRestante)));
  }
  throw ultimoError;
}

async function llamarGeminiConCandidatos(admin: AdminClient | null, body: unknown, presupuesto: PresupuestoTiempo) {
  const inicio = Date.now();
  const modelosOrdenados = await ordenarModelosPorRendimiento(admin);
  if (!modelosOrdenados.length) {
    // Cero llamadas a Gemini: todos los modelos agotaron su cuota y siguen
    // en enfriamiento. Antes esto igual gastaba una solicitud por modelo
    // para recibir cuatro veces el mismo "quota exceeded".
    const err = new Error("La cuota diaria gratuita de la IA está agotada por ahora. Se reintenta solo más tarde, sin que tengas que hacer nada.");
    (err as Error & { reintentable?: boolean }).reintentable = true;
    throw err;
  }
  let ultimoError: Error = new Error("No hay modelos de Gemini configurados (GEMINI_MODELS_ORDEN).");
  for (let i = 0; i < modelosOrdenados.length; i++) {
    // Solo se empieza con otro candidato si queda tiempo para darle una
    // oportunidad REAL (no arrancar una llamada que vamos a cortar a los 2
    // segundos -- ese fue justamente el error del presupuesto anterior).
    const tiempoRestante = presupuesto.totalMs - (Date.now() - inicio);
    if (tiempoRestante < Math.min(presupuesto.porLlamadaMs, 10_000)) break;
    try {
      // Un solo intento por modelo: con el presupuesto de tiempo realista de
      // ahora, reintentarle dos veces al mismo modelo saturado cuesta más de
      // lo que rinde -- es mejor gastar ese tiempo en el siguiente candidato.
      return await llamarGemini(admin, modelosOrdenados[i], 1, inicio, body, presupuesto);
    } catch (err) {
      ultimoError = err instanceof Error ? err : new Error(String(err));
      const reintentable = (ultimoError as Error & { reintentable?: boolean }).reintentable ?? esErrorDeModelo(ultimoError.message);
      if (!reintentable) throw ultimoError;
    }
  }
  throw ultimoError;
}

export interface ResultadoOcr {
  nombre_proveedor: string | null;
  rut_proveedor: string | null;
  tipo_documento: string | null;
  nro_documento: string | null;
  fecha: string | null;
  monto: number | null;
  descripcion: string | null;
  categoria_sugerida: string | null;
}

// Punto de entrada único: imagen/PDF en base64 adentro, JSON ya validado
// afuera (o una excepción con un mensaje explicable). Ni ocr-recibo ni
// ocr-reintento-pendientes necesitan saber nada de la cadena de modelos,
// el prompt, ni el formato exacto de la respuesta de Gemini. "admin" es
// opcional: sin él, simplemente no hay estadística ni reordenamiento (cae
// al orden base) -- así este módulo también se puede usar/testear sin una
// conexión real a la base si algún día hiciera falta.
export async function leerComprobante(
  admin: AdminClient | null,
  imageBase64: string,
  mimeType: string,
  presupuesto: PresupuestoTiempo = PRESUPUESTO_EN_VIVO,
): Promise<ResultadoOcr> {
  if (!GEMINI_API_KEY) throw new Error("Falta configurar el secret GEMINI_API_KEY en el proyecto.");

  const body = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
        ],
      },
    ],
    // maxOutputTokens explícito: sin esto, un PDF (que consume bastantes
    // más tokens de "visión de documento" que una foto comprimida, sobre
    // todo si tiene varias páginas) puede agotar el límite por defecto del
    // modelo ANTES de terminar de escribir el JSON de salida. Cuando eso
    // pasa, Gemini responde 200 OK con finishReason "MAX_TOKENS" y texto
    // vacío -- no es un error, así que antes cursaba directo al mensaje
    // genérico de "no se pudo leer" sin ninguna pista real de la causa.
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 },
  };

  const data = await llamarGeminiConCandidatos(admin, body, presupuesto);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    const motivo = data?.promptFeedback?.blockReason
      || (finishReason === "MAX_TOKENS" ? "El comprobante es muy complejo para procesarlo completo (MAX_TOKENS)." : null)
      || (finishReason ? `Gemini no devolvió resultado (finishReason: ${finishReason}).` : null)
      || "Gemini no devolvió resultado para este comprobante.";
    throw new Error(motivo);
  }
  const parsed = JSON.parse(text);

  // El prompt le pide a Gemini un valor EXACTO de CATEGORIAS, pero un LLM
  // puede no respetarlo -- si no calza con el catálogo cerrado que usa la
  // app, se descarta en vez de guardar una categoría inexistente.
  if (parsed.categoria_sugerida && !CATEGORIAS.includes(parsed.categoria_sugerida)) {
    parsed.categoria_sugerida = null;
  }

  // El prompt le pide a Gemini un número limpio (sin puntos de miles), pero
  // nada lo obliga a respetarlo -- un monto chileno como "15.000" leído tal
  // cual, sin este chequeo, se interpreta como Number("15.000") = 15 y
  // autocompleta un monto mil veces más chico sin ningún error visible. Se
  // descarta (no se adivina el formato) en vez de arriesgar un dato
  // silenciosamente incorrecto.
  if (parsed.monto !== null && parsed.monto !== undefined && !Number.isFinite(Number(parsed.monto))) {
    parsed.monto = null;
  }

  return parsed as ResultadoOcr;
}

// "200 OK con {} o casi vacío" es un resultado válido para Gemini pero
// inútil para la persona -- ni ocr-recibo ni ocr-reintento-pendientes
// deberían tratarlo como éxito silencioso.
export function tieneDatosUtiles(resultado: ResultadoOcr): boolean {
  return ["nombre_proveedor", "rut_proveedor", "monto", "nro_documento"].some((campo) => (resultado as Record<string, unknown>)[campo]);
}
