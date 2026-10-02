(function(root){
  const estados = ['Aprobado','Rechazado','Pendiente'];
  function resumen(items){
    const r={rendido:0,aprobado:0,rechazado:0,pendiente:0,total:items.length};
    for(const it of items){const monto=Number(it.monto||0);if(!Number.isFinite(monto)||monto<0)throw Error('Hay un gasto con monto inválido. Corrígelo antes de exportar.');r.rendido+=monto;r[it.estado==='Aprobado'?'aprobado':it.estado==='Rechazado'?'rechazado':'pendiente']+=monto;}
    return r;
  }
  function fecha(valor){
    if(!valor)return null;
    let dia;
    if(/^\d{4}-\d{2}-\d{2}$/.test(valor))dia=valor;
    else {const d=new Date(valor);if(!Number.isFinite(d.getTime()))return null;const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const v=Object.fromEntries(p.map(x=>[x.type,x.value]));dia=v.year+'-'+v.month+'-'+v.day;}
    const d=new Date(dia+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===dia?d:null;
  }
  function preparar(rendiciones,items,solicitudes,nombreCuenta=()=> ''){
    const rendPorId=new Map(rendiciones.map(r=>[r.id,r])),solPorId=new Map(solicitudes.map(s=>[s.id,s]));
    const itemsPorId=new Map(rendiciones.map(r=>[r.id,[]]));
    for(const it of items){if(!itemsPorId.has(it.rendicion_id))throw Error('El detalle y las rendiciones no coinciden. Vuelve a exportar.');itemsPorId.get(it.rendicion_id).push(it);}
    const sumas=new Map(rendiciones.map(r=>[r.id,resumen(itemsPorId.get(r.id))]));
    const fondoFolio=r=>{const folio=solPorId.get(r.solicitud_fondo_id)?.folio??r.solicitudes_fondos?.folio;return r.solicitud_fondo_id?(folio!=null?'S-'+folio:'Referencia no disponible'):'';};
    const resumenFilas=rendiciones.map(r=>{const s=sumas.get(r.id);return {'Folio':r.folio??'','Fecha':fecha(r.fecha_rendicion||r.created_at),'Fecha de envío':fecha(r.created_at),'Empleado':r.empleado_nombre||'','RUT Empleado':r.rut_empleado||'','Empresa':r.empresa||'','Tipo':r.tipo_rendicion==='FondoPorRendir'?'Fondo por rendir':'Reembolso','Fondo Asociado':fondoFolio(r),'Comentario':r.comentario||'','Gastos':s.total,'Monto rendido':s.rendido,'Monto aprobado':s.aprobado,'Monto rechazado':s.rechazado,'Monto pendiente':s.pendiente,'Estado':r.estado||'Pendiente','Aprobador':r.aprobador_nombre||'','Fecha Aprobación':fecha(r.fecha_aprobacion),'Motivo Rechazo':r.motivo_rechazo||''};});
    const detalle=items.map(it=>{const r=rendPorId.get(it.rendicion_id);return {'Folio Rendición':r.folio??'','Empleado':r.empleado_nombre||'','RUT Empleado':r.rut_empleado||'','Empresa':it.empresa||r.empresa||'','Fondo Asociado':fondoFolio(r),'Centro de Costo':it.centro_costo||'','Tipo Ítem':it.tipo_item==='ConDocumento'?'Documento electrónico':'Comprobante / boleta','Proveedor':it.nombre_proveedor||'','RUT Proveedor':it.rut_proveedor||'','Tipo Documento':it.tipo_documento||'','N° Documento':it.nro_documento==null?'':String(it.nro_documento),'Fecha Vencimiento':fecha(it.fecha_vencimiento),'Categoría':it.categoria||'','Cuenta Contable':it.cuenta_contable||'','Nombre Cuenta':nombreCuenta(it.cuenta_contable)||'','Monto':Number(it.monto||0),'Estado':it.estado||'Pendiente','Motivo Rechazo':it.motivo_rechazo||'','Descripción':it.descripcion||'','Comprobante Adjunto':it.adjunto_url?'Sí':'No'};});
    const fondos=solicitudes.map(s=>{const vinculadas=rendiciones.filter(r=>r.solicitud_fondo_id===s.id&&(r.estado==='Pendiente'||r.estado==='Aprobado'));let aprobado=0,pendiente=0;for(const r of vinculadas){const t=sumas.get(r.id);aprobado+=t.aprobado;pendiente+=t.pendiente;}const monto=Number(s.monto_solicitado||0),consumido=aprobado+pendiente;return {'Folio':s.folio!=null?'S-'+s.folio:'','Fecha':fecha(s.created_at),'Empleado':s.empleado_nombre||'','RUT Empleado':s.rut_empleado||'','Empresa':s.empresa||'','Centro de Costo':s.centro_costo||'','Motivo':s.motivo||'','Monto Solicitado':monto,'Monto Aprobado':aprobado,'Monto Pendiente':pendiente,'Monto Consumido':consumido,'Saldo Disponible':s.estado==='Aprobado'?Math.max(0,monto-consumido):null,'Exceso Sobre Fondo':s.estado==='Aprobado'?Math.max(0,consumido-monto):null,'Estado':s.estado||'Pendiente','Fecha Necesaria':fecha(s.fecha_necesaria),'Aprobador':s.aprobador_nombre||'','Fecha Aprobación':fecha(s.fecha_aprobacion),'Motivo Rechazo':s.motivo_rechazo||''};});
    const totales=resumen(items);
    return {resumen:resumenFilas,detalle,fondos,totales};
  }
  function crearLibro(ExcelJS,datos,corte=new Date()){
    const wb=new ExcelJS.Workbook();wb.creator='RindeWellness';wb.created=corte;wb.modified=corte;wb.calcProperties.fullCalcOnLoad=true;
    function hoja(nombre,filas,cabeceras,nota){
      const ws=wb.addWorksheet(nombre,{views:[{state:'frozen',ySplit:5}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:5'}});
      const keys=filas.length?Object.keys(filas[0]):cabeceras;
      ws.columns=keys.map(k=>({key:k,width:/Comentario|Descripción|Motivo|Proveedor|Nombre Cuenta/.test(k)?38:/Empleado|Empresa|Cuenta/.test(k)?27:/Monto|Saldo|Exceso|Fecha/.test(k)?20:18}));
      ws.mergeCells(1,1,1,keys.length);ws.getCell(1,1).value='RindeWellness · '+nombre;ws.getCell(1,1).font={name:'Calibri',size:18,bold:true,color:{argb:'FF167F76'}};ws.getRow(1).height=30;
      ws.mergeCells(2,1,2,keys.length);ws.getCell(2,1).value='Corte: '+new Intl.DateTimeFormat('es-CL',{timeZone:'America/Santiago',dateStyle:'medium',timeStyle:'short'}).format(corte)+' · Montos en CLP';
      ws.mergeCells(3,1,3,keys.length);ws.getCell(3,1).value=nota;ws.getCell(3,1).alignment={wrapText:true,vertical:'middle'};ws.getRow(3).height=32;
      const head=ws.getRow(5);head.values=keys;head.height=32;
      head.eachCell(c=>{c.font={name:'Calibri',bold:true,color:{argb:'FFFFFFFF'},size:11};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF167F76'}};c.alignment={wrapText:true,vertical:'middle'};});
      for(const fila of filas){const row=ws.addRow(keys.map(k=>fila[k]===''?null:fila[k]??null));const lineas=Math.max(...keys.map((k,i)=>String(fila[k]??'').split('\n').reduce((s,t)=>s+Math.max(1,Math.ceil(t.length/(ws.getColumn(i+1).width-2))),0)));row.height=Math.min(409,Math.max(30,lineas*15+8));row.eachCell((c,col)=>{const key=keys[col-1];c.font={name:'Calibri',size:11,color:{argb:'FF213642'}};c.alignment={wrapText:true,vertical:'middle'};if(row.number%2===0)c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F6F6'}};if(c.value instanceof Date)c.numFmt='dd-mm-yyyy';if(typeof c.value==='number')c.numFmt=/Monto|Saldo|Exceso/.test(key)?'"$"#,##0':'#,##0';if(key==='Estado'&&estados.includes(c.value))c.font={...c.font,bold:true,color:{argb:c.value==='Aprobado'?'FF167F76':c.value==='Rechazado'?'FFC35D4A':'FFA57929'}};});}
      ws.autoFilter={from:{row:5,column:1},to:{row:Math.max(5,ws.rowCount),column:keys.length}};
      if(!filas.length){ws.mergeCells(6,1,6,keys.length);ws.getCell(6,1).value='Sin registros para exportar.';}
      ws.headerFooter.oddFooter='RindeWellness · CLP &R Página &P de &N';
      return ws;
    }
    const resumenWs=hoja('Resumen',datos.resumen,['Folio','Empleado','Monto rendido','Monto aprobado','Monto rechazado','Monto pendiente','Estado'],'Rendido = aprobado + rechazado + pendiente. Los rechazados quedan visibles y no forman parte del monto aprobado.');
    if(datos.resumen.length){const keys=Object.keys(datos.resumen[0]),total=resumenWs.addRow(keys.map(k=>k==='Empleado'?'TOTAL':null));total.font={bold:true,color:{argb:'FF213642'}};total.height=28;for(const key of ['Monto rendido','Monto aprobado','Monto rechazado','Monto pendiente']){const col=keys.indexOf(key)+1;const letra=resumenWs.getColumn(col).letter;const n=datos.totales[{'Monto rendido':'rendido','Monto aprobado':'aprobado','Monto rechazado':'rechazado','Monto pendiente':'pendiente'}[key]];total.getCell(col).value={formula:'SUM('+letra+'6:'+letra+(total.number-1)+')',result:n};total.getCell(col).numFmt='"$"#,##0';}}
    hoja('Detalle',datos.detalle,['Folio Rendición','Empleado','Monto','Estado','Nombre Cuenta'],'Un registro por gasto. Los folios y RUT se conservan como texto. Los adjuntos originales se incorporan al informe PDF de cada rendición.');
    hoja('Solicitudes Fondos',datos.fondos,['Folio','Empleado','Monto Solicitado','Monto Consumido','Saldo Disponible','Estado'],'Consumido = gastos aprobados + pendientes de rendiciones vigentes. Excluye rechazados. El exceso se muestra por separado del saldo disponible.');
    return wb;
  }
  const api={preparar,crearLibro,fecha};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RindeReportes=api;
})(typeof globalThis!=='undefined'?globalThis:this);

