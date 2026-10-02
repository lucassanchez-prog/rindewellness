(function(root){
  const etiquetas={nombre_proveedor:'Proveedor',rut_proveedor:'RUT',tipo_documento:'Documento',nro_documento:'Folio',fecha:'Fecha',monto:'Monto'};
  const estados={coincidente_lecturas:'Coincide en dos lecturas',consistente:'Consistente con el documento',por_confirmar:'Por confirmar',ilegible:'Ilegible'};
  function pendiente(revision,manual){return !manual&&!['coincidente_lecturas','consistente'].includes(revision?.estado);}
  function montar({contenedor,datos,fuente,original,campo,manual,ajustar}){
    const crear=(tag,clase,texto)=>{const n=document.createElement(tag);if(clase)n.className=clase;if(texto)n.textContent=texto;return n;};
    const panel=crear('section','ocr-verificacion revision-comprobante'),cabecera=crear('div','revision-cabecera'),titulo=crear('strong','','Revisa el comprobante y sus datos');
    const filtro=crear('button','btn btn-secondary','Ver todos los campos');filtro.type='button';let soloPendientes=true,actual=null,viendoOriginal=false,vivo=true,urlLectura=null,urlOriginal=null;
    cabecera.append(titulo,filtro);panel.append(cabecera);
    const cuerpo=crear('div','revision-cuerpo'),visor=crear('div','revision-visor'),controles=crear('div','revision-controles'),marco=crear('div','revision-imagen'),imagen=crear('img'),caja=crear('div','revision-caja'),nota=crear('p','revision-nota','Preparando vista del comprobante…');
    imagen.alt='Comprobante adjunto para comprobar los datos';marco.append(imagen,caja);caja.hidden=true;
    const origen=crear('button','btn btn-secondary','Ver original');origen.type='button';origen.hidden=!original?.type?.startsWith('image/');
    const rotar=crear('button','btn btn-secondary','Girar foto'),contraste=crear('button','btn btn-secondary','Mejorar contraste'),completo=crear('button','btn btn-secondary','Leer sin recortar');
    for(const b of [rotar,contraste,completo])b.type='button';
    controles.append(origen,rotar,contraste,completo);visor.append(controles,marco,nota);
    const fragmento=crear('div','revision-fragmento'),fragmentoTitulo=crear('strong','','Fragmento del campo seleccionado'),recorte=crear('canvas');fragmento.hidden=true;fragmento.append(fragmentoTitulo,recorte);visor.append(fragmento);
    const lista=crear('div','revision-campos');cuerpo.append(visor,lista);panel.append(cuerpo);contenedor.append(panel);
    const filas=[];
    function destacar(){
      const region=root.RindeFoto.normalizarCaja(actual?.revision?.caja);caja.hidden=viendoOriginal||!region;
      if(region&&!viendoOriginal){const [y0,x0,y1,x1]=region;Object.assign(caja.style,{top:y0/10+'%',left:x0/10+'%',height:(y1-y0)/10+'%',width:(x1-x0)/10+'%'});}
      fragmento.hidden=viendoOriginal||!region||!imagen.naturalWidth;
      if(!fragmento.hidden){const [y0,x0,y1,x1]=region,x=x0/1000*imagen.naturalWidth,y=y0/1000*imagen.naturalHeight,w=(x1-x0)/1000*imagen.naturalWidth,h=(y1-y0)/1000*imagen.naturalHeight;recorte.width=Math.max(1,Math.ceil(w));recorte.height=Math.max(1,Math.ceil(h));recorte.getContext('2d').drawImage(imagen,x,y,w,h,0,0,recorte.width,recorte.height);}
      nota.textContent=viendoOriginal?'Archivo original. Las marcas se muestran en la copia utilizada para la lectura.':region?'Zona sugerida por el lector. Contrasta el valor con el documento.':String(actual?.revision?.ubicacion||'No hay una ubicación precisa para este campo; revisa el comprobante completo.');
    }
    function refrescar(){
      for(const fila of filas){const editado=manual(fila.campo),input=campo(fila.campo);fila.elemento.hidden=soloPendientes&&!pendiente(fila.revision,editado);fila.estado.textContent=editado?'Corregido por ti':estados[fila.revision.estado]||'Por confirmar';fila.valor.textContent=input?.value||String(datos[fila.campo]??'Sin lectura');}
      let visibles=filas.filter(f=>!f.elemento.hidden);if(!visibles.length)lista.append(aviso);else aviso.remove();
      if(!actual||actual.elemento.hidden){actual=visibles[0]||null;destacar();}
      for(const fila of filas)fila.elemento.classList.toggle('seleccionado',fila===actual);
    }
    const aviso=crear('p','revision-nota','No quedan campos pendientes en esta revisión. Puedes ver todos los campos.');
    for(const [nombre,revision] of Object.entries(datos.verificacion_campos||{})){
      if(!etiquetas[nombre]||!revision||typeof revision!=='object')continue;
      const fila=crear('div','revision-campo'),boton=crear('button','revision-seleccionar'),label=crear('strong','',etiquetas[nombre]),valor=crear('span','revision-valor'),estado=crear('span','revision-estado'),evidencia=crear('p','revision-evidencia'),ir=crear('button','btn btn-secondary','Ir al campo');
      boton.type='button';ir.type='button';boton.append(label,valor,estado);evidencia.textContent=revision.texto?'Texto leído: «'+String(revision.texto).slice(0,300)+'»':String(revision.motivo||'No se obtuvo texto legible.');
      fila.append(boton,evidencia,ir);lista.append(fila);const modelo={campo:nombre,revision,elemento:fila,valor,estado};filas.push(modelo);
      boton.addEventListener('click',()=>{actual=modelo;destacar();refrescar();});ir.addEventListener('click',()=>{const input=campo(nombre);input?.scrollIntoView({block:'center',behavior:'smooth'});input?.focus();});
    }
    filtro.addEventListener('click',()=>{soloPendientes=!soloPendientes;filtro.textContent=soloPendientes?'Ver todos los campos':'Solo pendientes';refrescar();});
    origen.addEventListener('click',()=>{viendoOriginal=!viendoOriginal;imagen.src=viendoOriginal?urlOriginal:urlLectura;origen.textContent=viendoOriginal?'Ver copia de lectura':'Ver original';destacar();});
    const modificar=async opcion=>{for(const b of [rotar,contraste,completo])b.disabled=true;try{await ajustar(opcion);}finally{if(vivo)for(const b of [rotar,contraste,completo])b.disabled=false;}};
    rotar.addEventListener('click',()=>modificar('giro'));contraste.addEventListener('click',()=>modificar('contraste'));completo.addEventListener('click',()=>modificar('completo'));
    const alEditar=()=>refrescar();contenedor.addEventListener('input',alEditar);contenedor.addEventListener('change',alEditar);
    imagen.addEventListener('load',destacar);
    // Se monta antes de rellenar el formulario: esperar al próximo microtask permite mostrar el valor final.
    Promise.resolve().then(refrescar);
    Promise.resolve().then(fuente).then(file=>{if(!vivo)return;urlLectura=URL.createObjectURL(file);imagen.src=urlLectura;if(original?.type?.startsWith('image/'))urlOriginal=URL.createObjectURL(original);destacar();}).catch(()=>{if(vivo)nota.textContent='No se pudo preparar la vista. Abre el adjunto original para comprobar los datos.';});
    return {panel,limpiar(){vivo=false;contenedor.removeEventListener('input',alEditar);contenedor.removeEventListener('change',alEditar);for(const u of [urlLectura,urlOriginal])if(u)URL.revokeObjectURL(u);panel.remove();}};
  }
  const api={pendiente,montar};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RindeRevision=api;
})(typeof globalThis!=='undefined'?globalThis:this);
