// Evita mezclar gastos independientes o usar una ficha como comprobante original.
export function revisarEstructuraDocumento(datos: Record<string, any>): void {
  const estructura = datos.analisis_documento;
  if (!estructura || typeof estructura !== "object" || Array.isArray(estructura)) return;
  const tipos = ["factura", "boleta", "voucher", "transferencia", "deposito", "recibo", "ficha_rendicion", "mixto", "otro"];
  const tipo = tipos.includes(estructura.tipo) ? estructura.tipo : "otro";
  const cantidad = Number.isInteger(estructura.gastos_independientes) && estructura.gastos_independientes >= 0 ? Math.min(estructura.gastos_independientes,100) : null;
  datos.analisis_documento = {tipo,gastos_independientes:cantidad,pago_adjunto:estructura.pago_adjunto === true,
    legibilidad:["buena","parcial","baja"].includes(estructura.legibilidad) ? estructura.legibilidad : "parcial"};
  if (tipo === "ficha_rendicion" || (cantidad !== null && cantidad > 1)) {
    datos.requiere_separacion = true;
    datos.aviso_documento = tipo === "ficha_rendicion"
      ? "La página es una ficha de rendición. Selecciona el comprobante original para leer este gasto."
      : "Se detectaron varios gastos independientes. Adjunta o selecciona un comprobante por gasto para no mezclar datos.";
    for (const campo of ["nombre_proveedor","rut_proveedor","tipo_documento","nro_documento","fecha","monto","monto_en_palabras","descripcion","categoria_sugerida"]) datos[campo]=null;
    datos.monto_verificado=false;datos.monto_origen=null;
  }
}
