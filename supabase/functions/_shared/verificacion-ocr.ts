// Las comprobaciones locales son independientes de la confianza declarada por el modelo.
export const CAMPOS_DOCUMENTO = ["nombre_proveedor", "rut_proveedor", "tipo_documento", "nro_documento", "fecha", "monto"] as const;
export function rutValido(valor: unknown): boolean {
  if (typeof valor !== "string") return false;
  const rut = valor.replace(/[.\s-]/g, "").toUpperCase();
  if (!/^\d{7,8}[\dK]$/.test(rut)) return false;
  let suma = 0, factor = 2;
  for (const n of rut.slice(0, -1).split("").reverse()) { suma += Number(n) * factor; factor = factor === 7 ? 2 : factor + 1; }
  const resto = 11 - suma % 11;
  return rut.at(-1) === (resto === 11 ? "0" : resto === 10 ? "K" : String(resto));
}
export function fechaValida(valor: unknown): boolean {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const fecha = new Date(valor + "T00:00:00Z");
  return Number.isFinite(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor;
}
export function verificarCampos(datos: Record<string, any>): Record<string, any> {
  const evidencias = datos.evidencias && typeof datos.evidencias === "object" ? datos.evidencias : {};
  const resultado: Record<string, any> = {};
  for (const campo of CAMPOS_DOCUMENTO) {
    const fuente = evidencias[campo];
    const texto = typeof fuente?.texto === "string" ? fuente.texto.trim().slice(0, 300) : "";
    const ubicacion = typeof fuente?.ubicacion === "string" ? fuente.ubicacion.trim().slice(0, 120) : "";
    let motivo = "Lectura de IA; pendiente de confirmación visual.";
    let estado = datos[campo] == null || datos[campo] === "" ? "ilegible" : "por_confirmar";
    if (campo === "rut_proveedor" && datos[campo]) {
      if (!rutValido(datos[campo])) { motivo = "El RUT no supera la validación de dígito verificador."; datos[campo] = null; estado = "por_confirmar"; }
      else motivo = "Dígito verificador válido; confirmar que corresponde al emisor.";
    }
    if (campo === "fecha" && datos[campo] && !fechaValida(datos[campo])) {
      motivo = "La fecha no existe o su formato es ambiguo."; datos[campo] = null; estado = "por_confirmar";
    }
    if (campo === "monto") {
      if (datos.monto_discrepante) { motivo = "El total en cifras y en palabras difiere. Confirmar el importe en el documento."; estado = "por_confirmar"; }
      else if (datos.monto_verificado && datos.monto) { motivo = "El total en cifras coincide con el total transcrito en palabras."; estado = "consistente"; }
    }
    if (estado === "ilegible") motivo = "No se obtuvo una lectura utilizable.";
    const candidato=fuente?.caja;
    const caja=Array.isArray(candidato)&&candidato.length===4&&candidato.every((n:any)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000)&&candidato[2]>candidato[0]&&candidato[3]>candidato[1]?candidato:null;
    resultado[campo] = { estado, texto, ubicacion, motivo, caja };
  }
  return resultado;
}
