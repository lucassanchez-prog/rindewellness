// Acceso a datos y exportación completa: módulo sin DOM.
(function(root){
async function consultarTodas(crearConsulta) {
  const filas = [], ids = new Set();
  let esperado = null;
  for (let inicio = 0; ; ) {
    const {data,error,count} = await crearConsulta().range(inicio,inicio+499);
    if (error) throw error;
    if (!Array.isArray(data) || !Number.isInteger(count)) throw new Error("No se pudo comprobar que la consulta esté completa.");
    if (esperado !== null && esperado !== count) throw new Error("Los datos cambiaron durante la lectura. Intenta nuevamente.");
    esperado = count;
    for (const fila of data) {
      if (fila.id != null && ids.has(fila.id)) throw new Error("La consulta contiene páginas repetidas. Intenta nuevamente.");
      if (fila.id != null) ids.add(fila.id);
      filas.push(fila);
    }
    inicio += data.length;
    if (inicio === esperado) return filas;
    if (!data.length || inicio > esperado) throw new Error("La consulta está incompleta. Intenta nuevamente.");
  }
}


async function distribuirFondosCsv(db, rendicionesFondo) {
  const seleccion=(rendicionesFondo||[]).filter(r => r.solicitud_fondo_id);
  const resultado=new Map();
  for(let inicio=0;inicio<seleccion.length;inicio+=500) {
    const lote=seleccion.slice(inicio,inicio+500);
    const {data,error}=await db.rpc("distribuir_fondos_csv",{p_rendiciones:lote.map(r => r.id)});
    if(error) throw error;
    if(!Array.isArray(data)) throw new Error("No se pudo comprobar la distribución del fondo.");
    for(const fila of data) {
      const original=lote.find(r => r.id===fila.id);
      if(!original || resultado.has(fila.id) || !Number.isFinite(Number(fila.dentroDelFondo)) || !Number.isFinite(Number(fila.excedente)) || Number(fila.dentroDelFondo)<0 || Number(fila.excedente)<0 || Math.abs(Number(fila.dentroDelFondo)+Number(fila.excedente)-Number(original.monto_total))>0.001) throw new Error("La distribución del fondo no coincide con el monto exportado. Actualiza la rendición.");
      resultado.set(fila.id,fila);
    }
    if(lote.some(r => !resultado.has(r.id))) throw new Error("Falta comprobar la distribución de una rendición. No se generó el CSV.");
  }
  return resultado;
}


const api={consultarTodas,distribuirFondosCsv};
if(typeof module!=="undefined" && module.exports)module.exports=api;else root.RindeData=api;
})(typeof window!=="undefined"?window:globalThis);
