export function demoraTransitoriaOcr(error: unknown): number | null {
  const mensaje = error instanceof Error ? error.message : String(error);
  if (/quota|cuota|límite gratuito|rate.?limit|resource.exhausted/i.test(mensaje)) {
    const demora = (error as {retryAfterMs?:unknown})?.retryAfterMs;
    if(typeof demora==='number' && Number.isFinite(demora) && demora>=30000 && demora<=86400000)return demora;
    return 60 * 60 * 1000;
  }
  if (/high demand|overloaded|unavailable|no está disponible|tiempo de espera|timeout|error de red/i.test(mensaje)) return 15 * 60 * 1000;
  return null;
}
