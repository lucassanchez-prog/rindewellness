// Conserva campos y evidencias entre intentos sin ocultar lecturas contradictorias.
const CAMPOS = ["nombre_proveedor", "rut_proveedor", "tipo_documento", "nro_documento", "fecha", "monto", "descripcion", "categoria_sugerida"];
const CRITICOS = ["rut_proveedor", "nro_documento", "fecha", "monto"];
type Datos = Record<string, any>;
const legible = (v: unknown) => v !== null && v !== undefined && v !== "";
const normalizar = (campo: string, v: unknown) => campo === "rut_proveedor"
  ? String(v).replace(/[.\s-]/g, "").toUpperCase()
  : campo === "nro_documento" ? String(v).trim().replace(/^0+(?=\d)/, "") : String(v);
const contradiccion = (datos: Datos, campo: string) =>
  (campo === "monto" && datos.monto_discrepante === true)
  || (Array.isArray(datos.campos_discrepantes) && datos.campos_discrepantes.includes(campo))
  || (datos.verificacion_campos?.[campo]?.estado === "por_confirmar"
    && /discrepan|contradict|no coincide|difiere/i.test(datos.verificacion_campos?.[campo]?.motivo || ""));

export function fusionarIntentosOcr(previo: Datos, nuevo: Datos): Datos {
  // Una ficha o varios gastos no pueden heredar los importes de una lectura anterior.
  if (nuevo.requiere_separacion) {
    return {...nuevo, ...Object.fromEntries(CAMPOS.map(c => [c, null])), monto_verificado: false, monto_origen: null};
  }
  const fusion: Datos = {...previo, ...nuevo, evidencias: {...previo.evidencias}, verificacion_campos: {...previo.verificacion_campos}};
  const discrepantes: string[] = [];
  for (const campo of CAMPOS) {
    const anterior = previo[campo], siguiente = nuevo[campo];
    const difieren = CRITICOS.includes(campo) && legible(anterior) && legible(siguiente)
      && normalizar(campo, anterior) !== normalizar(campo, siguiente);
    // Un intento incompleto no levanta una contradicción anterior. Dos lecturas
    // nuevas coincidentes pueden resolverla; una sola lectura sigue pendiente.
    const confirmado = legible(siguiente) && nuevo.verificacion_campos?.[campo]?.estado === "coincidente_lecturas";
    const conflicto = contradiccion(nuevo, campo) || difieren || (contradiccion(previo, campo) && !confirmado);
    if (conflicto) {
      fusion[campo] = null;
      discrepantes.push(campo);
      fusion.verificacion_campos[campo] = {
        ...(nuevo.verificacion_campos?.[campo] || previo.verificacion_campos?.[campo] || {}),
        estado: "por_confirmar",
        motivo: difieren ? `Dos intentos discrepan: ${anterior} / ${siguiente}. Confirma este campo en el comprobante.`
          : "Lecturas contradictorias; confirma este campo en el comprobante.",
      };
    } else {
      fusion[campo] = legible(siguiente) ? siguiente : (anterior ?? null);
      const fuente = legible(siguiente) ? nuevo : previo;
      if (fuente.evidencias?.[campo]) fusion.evidencias[campo] = fuente.evidencias[campo];
      if (fuente.verificacion_campos?.[campo]) fusion.verificacion_campos[campo] = fuente.verificacion_campos[campo];
    }
  }
  const fuenteMonto = legible(nuevo.monto) ? nuevo : previo;
  for (const campo of ["monto_verificado", "monto_origen", "monto_en_palabras"]) fusion[campo] = fuenteMonto[campo] ?? (campo === "monto_verificado" ? false : null);
  fusion.campos_discrepantes = discrepantes;
  fusion.monto_discrepante = discrepantes.includes("monto");
  if (fusion.monto_discrepante) { fusion.monto_verificado = false; fusion.monto_origen = null; }
  return fusion;
}
