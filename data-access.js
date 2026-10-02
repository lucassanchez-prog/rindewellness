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


// Un fallo de subida corta el envío completo. Las subidas que sí finalizaron
// se reutilizan al reintentar el mismo borrador, sin reemplazar archivos.
async function prepararAdjuntos(db, items, usuarioId, envioId, cache, esperar) {
  const preparados=[];
  for (const [idx,item] of items.entries()) {
    const {_fotoInput,...datos}=item;
    const file=_fotoInput?.files?.[0];
    if(!file) throw new Error(`Falta el comprobante del Ítem ${idx+1}.`);
    let path=cache.get(file);
    if(!path) {
      const nombre=file.name.replace(/[^a-zA-Z0-9.\-_]/g,"_");
      path=`${usuarioId}/${envioId}-${idx}-${crypto.randomUUID()}-${nombre}`;
      const subida=db.storage.from("comprobantes").upload(path,file);
      const {error}=await esperar(subida,45000,`Se agotó el tiempo subiendo el comprobante del Ítem ${idx+1}. Tu formulario se conserva.`);
      if(error) throw new Error(`No se pudo subir el comprobante del Ítem ${idx+1}. Tu formulario se conserva. ${error.message||"Reintenta."}`);
      cache.set(file,path);
    }
    preparados.push({...datos,adjunto_url:path});
  }
  return preparados;
}

async function guardarRendicionCompleta(db,cabecera,items) {
  const {data,error}=await db.rpc("crear_rendicion_completa",{p_cabecera:cabecera,p_items:items});
  if(error) throw error;
  if(!data?.rendicion || data.rendicion.id!==cabecera.id || !Array.isArray(data.items) || !data.items.length
    || (!data.reutilizada && data.items.length!==items.length))
    throw new Error("No se pudo confirmar el envío completo. Reintenta desde este formulario; se usará el mismo identificador.");
  return data;
}

function abrirPdfSeguro(pdfjs,datos) {
  // Mitigación oficial de GHSA-wgrm-67xf-hhpq para documentos externos.
  return pdfjs.getDocument({data:datos,isEvalSupported:false});
}

const api={consultarTodas,distribuirFondosCsv,prepararAdjuntos,guardarRendicionCompleta,abrirPdfSeguro};
if(typeof module!=="undefined" && module.exports)module.exports=api;else root.RindeData=api;
})(typeof window!=="undefined"?window:globalThis);
