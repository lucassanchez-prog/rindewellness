// Lector principal de comprobantes: Claude (Anthropic). Gemini y Groq quedan
// de respaldo en leerComprobante (gemini-ocr.ts).
//
// Por qué Claude Haiku: se midió con 40 fotos reales del archivo de
// Rindegastos (scripts/medir-lectura-claude.py, 2026-11-11) y acertó igual o
// mejor que Opus, a ~US$0,0013 por foto. Opus llegó a tomar el bruto de una
// boleta de honorarios y el precio de una cotización de Uber. El modelo se
// cambia con el secret CLAUDE_OCR_MODEL, sin tocar código.
//
// Devuelve la respuesta con la misma forma que Gemini ({candidates:[...]}),
// así pasa por la misma validación (interpretarRespuestaOcr): monto contra el
// total en letras, categoría del catálogo, RUT/folio/fecha con evidencia.
//
// El SDK se carga recién al llamar (import dinámico): los módulos de _shared
// se prueban en Node, que no resuelve "npm:", y así un comprobante leído por
// Gemini o Groq no depende de él.

export const PROVEEDOR_CLAUDE = "claude";
export const MODELO_CLAUDE_POR_DEFECTO = "claude-haiku-5-5";
// Esfuerzo medido: "medium" (el valor por defecto de Haiku 5.5, explícito).
const ESFUERZO = "medium";
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// Límites del API: 5 MB por imagen y 32 MB por solicitud (en base64 ~ x1,37).
const MAX_BASE64_IMAGEN = Math.floor(5 * 1024 * 1024 * 4 / 3);
const MAX_BASE64_PDF = 30 * 1024 * 1024;

export type ConfigClaude = Record<string, string | undefined>;
export const configClaude = (): ConfigClaude =>
  Object.fromEntries(["CLAUDE_OCR_ENABLED", "CLAUDE_OCR_MODEL", "ANTHROPIC_API_KEY"].map((k) => [k, Deno.env.get(k)]));

export function claudeHabilitado(config: ConfigClaude): boolean {
  return config.CLAUDE_OCR_ENABLED === "true" && !!config.ANTHROPIC_API_KEY;
}

export function claudeAdmite(mimeType: string, imageBase64: string): boolean {
  if (mimeType === "application/pdf") return imageBase64.length <= MAX_BASE64_PDF;
  return TIPOS_IMAGEN.includes(mimeType) && imageBase64.length <= MAX_BASE64_IMAGEN;
}

// Solo para pruebas: globalThis.__clienteClaudePrueba reemplaza el cliente del
// SDK por uno simulado (en producción nunca está definido).
type ClienteClaude = { messages: { create: (body: Record<string, unknown>) => Promise<any> } };

async function crearCliente(config: ConfigClaude, timeoutMs: number): Promise<ClienteClaude> {
  const fabricaPrueba = (globalThis as { __clienteClaudePrueba?: (c: ConfigClaude, t: number) => ClienteClaude }).__clienteClaudePrueba;
  if (fabricaPrueba) return fabricaPrueba(config, timeoutMs);
  const { default: Anthropic } = await import("npm:@anthropic-ai/sdk@1.3.0");
  // Sin reintentos del SDK: si Claude falla, la cadena pasa a Gemini y Groq
  // dentro del mismo presupuesto de tiempo, en vez de esperar acá.
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: timeoutMs, maxRetries: 0 }) as unknown as ClienteClaude;
}

export interface ErrorClaude extends Error { retryAfterMs?: number; cuenta?: boolean }

function cabecera(headers: unknown, nombre: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(nombre);
  const v = (headers as Record<string, unknown>)[nombre];
  return typeof v === "string" ? v : null;
}

// Traduce un error del SDK a un mensaje para la persona y, si corresponde, a
// cuánto enfriar a Claude antes de volver a llamarlo.
export function errorDeClaude(e: unknown): ErrorClaude {
  const status = Number((e as { status?: number })?.status);
  const texto = e instanceof Error ? e.message : String(e);
  let error: ErrorClaude;
  if (status === 429 || status === 529) {
    error = new Error("Claude está saturado o alcanzó su límite por ahora.");
    const segundos = Number(cabecera((e as { headers?: unknown })?.headers, "retry-after"));
    error.retryAfterMs = Number.isFinite(segundos) && segundos > 0 ? Math.min(3_600_000, Math.max(30_000, segundos * 1000)) : 5 * 60_000;
  } else if (status === 401 || status === 403 || (status === 400 && /credit balance|billing/i.test(texto))) {
    // Llave inválida o cuenta sin crédito: no se arregla reintentando cada
    // lectura. Se enfría una hora y Gemini/Groq siguen leyendo mientras tanto.
    error = new Error("La cuenta de Claude no está disponible (llave o crédito). Se usa el lector de respaldo.");
    error.cuenta = true;
    error.retryAfterMs = 60 * 60_000;
  } else if (status >= 500) {
    error = new Error("Claude no está disponible en este momento.");
  } else if (/timed? ?out|timeout|aborted/i.test(texto)) {
    error = new Error("Tiempo de espera agotado leyendo con Claude.");
  } else {
    error = new Error("Claude rechazó la solicitud" + (status ? " (HTTP " + status + ")" : "") + ": " + texto.slice(0, 200));
  }
  return error;
}

export async function consultarClaude(
  imageBase64: string, mimeType: string, prompt: string, config: ConfigClaude, timeoutMs: number,
): Promise<{ candidates: { content: { parts: { text: string }[] } }[] }> {
  if (!claudeHabilitado(config)) throw new Error("La lectura con Claude no está activada.");
  if (!claudeAdmite(mimeType, imageBase64)) throw new Error("Claude no admite este archivo (tipo o tamaño).");
  const archivo = mimeType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } };
  const cliente = await crearCliente(config, Math.max(1000, timeoutMs));
  let respuesta: any;
  try {
    respuesta = await cliente.messages.create({
      model: config.CLAUDE_OCR_MODEL || MODELO_CLAUDE_POR_DEFECTO,
      max_tokens: 8000,
      output_config: { effort: ESFUERZO },
      messages: [{ role: "user", content: [archivo, { type: "text", text: prompt }] }],
    });
  } catch (e) {
    throw errorDeClaude(e);
  }
  if (respuesta?.stop_reason === "refusal") throw new Error("Claude no quiso leer este comprobante.");
  if (respuesta?.stop_reason === "max_tokens") throw new Error("El comprobante es muy complejo para procesarlo completo (max_tokens).");
  const texto = (respuesta?.content || []).filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
  if (!texto.trim()) throw new Error("Claude no devolvió una lectura utilizable.");
  // El prompt pide SOLO JSON; si viniera con texto alrededor, se toma el objeto.
  const a = texto.indexOf("{"), b = texto.lastIndexOf("}");
  return { candidates: [{ content: { parts: [{ text: a >= 0 && b > a ? texto.slice(a, b + 1) : texto }] } }] };
}
