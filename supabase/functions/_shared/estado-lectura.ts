// Estado de completitud separado de la existencia de una respuesta del modelo.
export function revisarCompletitud(resultado: Record<string, unknown>, conocidos: Record<string, unknown> = {}): Record<string, unknown> {
  if (resultado.requiere_separacion) return {...resultado,revision_estado:"requiere_separacion",campos_pendientes:[]};
  const valores={...conocidos,...Object.fromEntries(Object.entries(resultado).filter(([,v]) => v !== null && v !== undefined && v !== ""))};
  const campos=["nombre_proveedor","fecha","monto"];
  if (/factura|honorario/i.test(String(valores.tipo_documento || "")) || conocidos.tipo_item === "ConDocumento") campos.push("rut_proveedor","tipo_documento","nro_documento");
  const pendientes=campos.filter(c => c === "monto" ? !(Number(valores[c])>0) || !!resultado.monto_discrepante : !String(valores[c] ?? "").trim());
  const revisiones=resultado.verificacion_campos as Record<string, {estado?:string;motivo?:string}> | undefined;
  for(const c of campos) if (revisiones?.[c]?.estado === "por_confirmar" && /discrepan|contradict|no coincide/i.test(revisiones[c]?.motivo || "") && !pendientes.includes(c)) pendientes.push(c);
  return {...resultado,revision_estado:pendientes.length ? "parcial" : "completo",campos_pendientes:pendientes};
}

export function estadoTrasIntento(resultado: Record<string, unknown>, intentos: number, maximo: number): string {
  if(resultado.revision_estado === "completo" || resultado.requiere_separacion) return "listo";
  return intentos >= maximo ? "agotado" : "pendiente";
}
