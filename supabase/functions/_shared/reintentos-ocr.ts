export function demoraTransitoriaOcr(error: unknown): number | null {
  const mensaje = error instanceof Error ? error.message : String(error);
  if (/quota|cuota|rate.?limit|resource.exhausted/i.test(mensaje)) return 60 * 60 * 1000;
  if (/high demand|overloaded|unavailable|no está disponible|tiempo de espera|timeout|error de red/i.test(mensaje)) return 15 * 60 * 1000;
  return null;
}
