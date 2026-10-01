(function(root){
  function crearLector(obtenerTesseract,{timeoutMs=90000,inactivoMs=300000}={}){
    let motor=null,cola=Promise.resolve(),pendientes=0,inactivo=null;
    async function limitar(promesa){let timer;try{return await Promise.race([promesa,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('El escáner local agotó su tiempo. Puedes reintentar sin volver a cargar el archivo.')),timeoutMs);})]);}finally{clearTimeout(timer);}}
    async function cerrar(){clearTimeout(inactivo);const anterior=motor;motor=null;if(anterior)try{const worker=await anterior;await worker.terminate();}catch{/* La siguiente lectura crea un motor nuevo. */}}
    async function ejecutar(imagen,modo){
      clearTimeout(inactivo);
      try{
        if(!motor)motor=Promise.resolve().then(obtenerTesseract).then(t=>t.createWorker('spa',1,{errorHandler:()=>{}}));
        const worker=await limitar(motor);
        await limitar(worker.setParameters({tessedit_pageseg_mode:String(modo),preserve_interword_spaces:'1'}));
        return await limitar(worker.recognize(imagen));
      }catch(e){const anterior=motor;motor=null;if(anterior)anterior.then(w=>w.terminate()).catch(()=>{});throw e;}
    }
    function leer(imagen,modo=3){
      pendientes++;
      const tarea=cola.then(()=>ejecutar(imagen,modo));cola=tarea.catch(()=>{});
      return tarea.finally(()=>{pendientes--;if(!pendientes)inactivo=setTimeout(()=>{cerrar();},inactivoMs);});
    }
    return {leer,cerrar};
  }
  const api={crearLector};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RindeOcrLocal=api;
})(typeof globalThis!=='undefined'?globalThis:this);
