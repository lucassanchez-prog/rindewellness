// ============================================================
// Excel general de rendiciones (botón "Exportar a Excel").
// preparar() filtra y calcula todo (es puro y se prueba en Node); crearLibro()
// solo le da forma con ExcelJS. Hojas:
//   Resumen · Rendiciones · Gastos · Por centro de costo · Por cuenta contable
//   · Fondos · Cuadratura
// El período filtra por la fecha de la rendición (o la de envío si falta). Los
// fondos muestran su saldo AL DÍA DE HOY, no del período: el saldo de un fondo
// depende de todo lo rendido contra él. Con multifondo, cada fondo cuenta solo
// la parte que le toca (vista rendiciones_por_fondo).
// ============================================================
(function(root){
  const ESTADOS=['Aprobado','Rechazado','Pendiente'];
  const CLP='"$"#,##0', FECHA='dd-mm-yyyy', ENTERO='#,##0', PCT='0%';
  const VERDE='FF167F76', ROJO='FFC35D4A', AMBAR='FFA57929', TINTA='FF213642', TENUE='FF6B7A85', FONDO_SUAVE='FFF1F6F6';

  // Fecha de calendario en Chile, como Date a medianoche UTC (Excel no tiene zona horaria).
  function fecha(valor){
    if(!valor)return null;
    let dia;
    if(/^\d{4}-\d{2}-\d{2}$/.test(valor))dia=valor;
    else {const d=new Date(valor);if(!Number.isFinite(d.getTime()))return null;const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const v=Object.fromEntries(p.map(x=>[x.type,x.value]));dia=v.year+'-'+v.month+'-'+v.day;}
    const d=new Date(dia+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===dia?d:null;
  }
  const dia=v=>{const d=fecha(v);return d?d.toISOString().slice(0,10):'';};
  const ddmmaaaa=t=>t?t.split('-').reverse().join('-'):'';
  const MESES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const nombreMes=m=>{const [a,n]=m.split('-');return MESES[Number(n)-1]+' '+a;};

  function resumen(items){
    const r={rendido:0,aprobado:0,rechazado:0,pendiente:0,total:items.length};
    for(const it of items){const monto=Number(it.monto||0);if(!Number.isFinite(monto)||monto<0)throw Error('Hay un gasto con monto inválido. Corrígelo antes de exportar.');r.rendido+=monto;r[it.estado==='Aprobado'?'aprobado':it.estado==='Rechazado'?'rechazado':'pendiente']+=monto;}
    return r;
  }

  function filtrar(rendiciones,filtro={}){
    return rendiciones.filter(r=>{
      const d=dia(r.fecha_rendicion||r.created_at);
      if(filtro.desde&&(!d||d<filtro.desde))return false;
      if(filtro.hasta&&(!d||d>filtro.hasta))return false;
      if(filtro.empresa&&r.empresa!==filtro.empresa)return false;
      if(filtro.estado&&(r.estado||'Pendiente')!==filtro.estado)return false;
      return true;
    });
  }

  function textoFiltro(f={}){
    const periodo=f.desde||f.hasta?(f.desde&&f.hasta?'del '+ddmmaaaa(f.desde)+' al '+ddmmaaaa(f.hasta):f.desde?'desde el '+ddmmaaaa(f.desde):'hasta el '+ddmmaaaa(f.hasta)):'todo el historial';
    const estado=f.estado?{Aprobado:'solo aprobadas',Rechazado:'solo rechazadas',Pendiente:'solo pendientes'}[f.estado]||f.estado:'todos los estados';
    return 'Período: '+periodo+' · '+(f.empresa||'Todas las empresas')+' · '+estado;
  }

  // Agrupa filas por clave y suma campos; devuelve las filas ordenadas.
  function agrupar(filas,clave,campos,orden){
    const m=new Map();
    for(const f of filas){const k=clave(f);if(!m.has(k))m.set(k,{clave:k,n:0,rendiciones:new Set(),...Object.fromEntries(campos.map(c=>[c,0]))});const g=m.get(k);g.n++;if(f._rendicion)g.rendiciones.add(f._rendicion);for(const c of campos)g[c]+=Number(f[c]||0);}
    return [...m.values()].sort(orden||((a,b)=>b.aprobado-a.aprobado||String(a.clave).localeCompare(String(b.clave))));
  }

  function preparar(rendicionesTodas,items,solicitudes,opciones={}){
    // Compatibilidad: antes el cuarto argumento era la función nombreCuenta.
    if(typeof opciones==='function')opciones={nombreCuenta:opciones};
    const {nombreCuenta=()=>'',filtro={},porFondo=[]}=opciones;
    const rendiciones=filtrar(rendicionesTodas,filtro).sort((a,b)=>Number(a.folio||0)-Number(b.folio||0));
    const todas=new Set(rendicionesTodas.map(r=>r.id)),incluidas=new Map(rendiciones.map(r=>[r.id,[]]));
    for(const it of items){if(!todas.has(it.rendicion_id))throw Error('El detalle y las rendiciones no coinciden. Vuelve a exportar.');if(incluidas.has(it.rendicion_id))incluidas.get(it.rendicion_id).push(it);}
    const solPorId=new Map(solicitudes.map(s=>[s.id,s]));
    const partesPorRendicion=new Map();
    for(const p of porFondo){if(!partesPorRendicion.has(p.id))partesPorRendicion.set(p.id,[]);partesPorRendicion.get(p.id).push(p);}
    const folioFondo=id=>{const f=solPorId.get(id)?.folio;return f!=null?'S-'+f:'S-?';};
    const fondosDe=r=>{
      if(r.tipo_rendicion!=='FondoPorRendir'||!r.solicitud_fondo_id)return '';
      const partes=(partesPorRendicion.get(r.id)||[]).slice().sort((a,b)=>Number(a.orden||0)-Number(b.orden||0));
      if(partes.length>1)return partes.map(p=>folioFondo(p.solicitud_fondo_id)).join(' + ');
      const folio=solPorId.get(r.solicitud_fondo_id)?.folio??r.solicitudes_fondos?.folio;
      return folio!=null?'S-'+folio:'Referencia no disponible';
    };
    const sumas=new Map(rendiciones.map(r=>[r.id,resumen(incluidas.get(r.id))]));

    const filasRendiciones=rendiciones.map(r=>{
      const s=sumas.get(r.id),aprobada=r.estado==='Aprobado';
      const dias=r.fecha_aprobacion&&r.created_at?Math.max(0,Math.round((new Date(r.fecha_aprobacion)-new Date(r.created_at))/86400000)):null;
      return {'Folio':r.folio??null,'Fecha':fecha(r.fecha_rendicion||r.created_at),'Empleado':r.empleado_nombre||'','RUT empleado':r.rut_empleado||'','Empresa':r.empresa||'',
        'Tipo':r.tipo_rendicion==='FondoPorRendir'?'Fondo por rendir':'Reembolso','Fondo':fondosDe(r),'Comentario':r.comentario||'','Gastos':s.total,
        'Rendido':s.rendido,'Aprobado':s.aprobado,'Rechazado':s.rechazado,'Pendiente':s.pendiente,'Estado':r.estado||'Pendiente','Aprobador':r.aprobador_nombre||'',
        'Fecha aprobación':fecha(r.fecha_aprobacion),'Días en aprobar':dias,'CSV Kame':aprobada?(r.kame_exportado_en?'Descargado':'Falta'):'',
        'Fecha CSV Kame':fecha(r.kame_exportado_en),'Motivo rechazo':r.motivo_rechazo||''};
    });

    const gastos=[];
    for(const r of rendiciones){
      for(const it of incluidas.get(r.id)){
        const d=dia(r.fecha_rendicion||r.created_at),esDoc=it.tipo_item==='ConDocumento';
        gastos.push({_rendicion:r.id,_mes:d.slice(0,7),'Folio':r.folio??null,'Fecha':fecha(r.fecha_rendicion||r.created_at),'Empleado':r.empleado_nombre||'','Empresa':r.empresa||it.empresa||'',_empresaItem:it.empresa||'',
          'Centro de costo':it.centro_costo||'Sin centro de costo','Tipo':esDoc?'Documento electrónico':'Comprobante / boleta','Proveedor':it.nombre_proveedor||'','RUT proveedor':it.rut_proveedor||'',
          'Tipo documento':it.tipo_documento||'','N° documento':it.nro_documento==null?'':String(it.nro_documento),'Fecha documento':fecha(it.fecha_vencimiento),'Categoría':it.categoria||'Sin categoría',
          'Cuenta':it.cuenta_contable||'','Nombre cuenta':nombreCuenta(it.cuenta_contable)||'','Monto':Number(it.monto||0),'Estado':it.estado||'Pendiente',
          'En contabilidad':esDoc?(it.existe_en_contabilidad===true?'Sí':it.existe_en_contabilidad===false?'No encontrado':'Sin verificar'):'No aplica',
          'Comprobante':it.adjunto_url?'Sí':'No','Motivo rechazo':it.motivo_rechazo||'','Descripción':it.descripcion||'',
          rendido:Number(it.monto||0),aprobado:it.estado==='Aprobado'?Number(it.monto||0):0,rechazado:it.estado==='Rechazado'?Number(it.monto||0):0,pendiente:(it.estado||'Pendiente')==='Pendiente'?Number(it.monto||0):0});
      }
    }
    const totales={...resumen(gastos.map(g=>({monto:g.Monto,estado:g.Estado}))),rendiciones:rendiciones.length,
      conComprobante:gastos.filter(g=>g.Comprobante==='Sí').length};
    const diasAprob=filasRendiciones.map(f=>f['Días en aprobar']).filter(v=>v!=null);
    totales.diasPromedio=diasAprob.length?diasAprob.reduce((s,v)=>s+v,0)/diasAprob.length:null;
    totales.pendientesRendiciones=rendiciones.filter(r=>(r.estado||'Pendiente')==='Pendiente').length;
    totales.faltaKame=filasRendiciones.filter(f=>f['CSV Kame']==='Falta').length;

    const campos=['rendido','aprobado','rechazado','pendiente'];
    const porEmpresa=agrupar(gastos,g=>g.Empresa||'Sin empresa',campos);
    const porMes=agrupar(gastos,g=>g._mes||'sin fecha',campos,(a,b)=>String(a.clave).localeCompare(String(b.clave)));
    const porCategoria=agrupar(gastos,g=>g['Categoría'],campos);
    const porEmpleado=agrupar(gastos,g=>g.Empleado||'Sin nombre',campos);
    const porCentro=agrupar(gastos,g=>g.Empresa+'\u0000'+g['Centro de costo'],campos,(a,b)=>String(a.clave).localeCompare(String(b.clave))).map(g=>{const [empresa,centro]=g.clave.split('\u0000');return {...g,empresa,centro};});
    const porCuenta=agrupar(gastos,g=>g.Cuenta||'Sin cuenta',campos).map(g=>({...g,nombre:g.clave==='Sin cuenta'?'':nombreCuenta(g.clave)||''}));

    // Fondos: saldo al día de hoy con la parte que le toca a cada fondo.
    const fondos=solicitudes.filter(s=>!filtro.empresa||s.empresa===filtro.empresa).sort((a,b)=>Number(a.folio||0)-Number(b.folio||0)).map(s=>{
      const partes=porFondo.filter(p=>p.solicitud_fondo_id===s.id&&(p.estado==='Pendiente'||p.estado==='Aprobado'));
      const consumido=partes.reduce((n,p)=>n+Number(p.monto_total||0),0),aprobado=partes.reduce((n,p)=>n+Number(p.monto_aprobado||0),0);
      const monto=Number(s.monto_solicitado||0),vigente=s.estado==='Aprobado';
      return {'Folio':s.folio!=null?'S-'+s.folio:'','Fecha':fecha(s.created_at),'Empleado':s.empleado_nombre||'','Empresa':s.empresa||'','Centro de costo':s.centro_costo||'',
        'Motivo':s.motivo||'','Otorgado':monto,'Aprobado':aprobado,'En revisión':Math.max(0,consumido-aprobado),'Consumido':consumido,
        'Saldo':vigente?Math.max(0,monto-consumido):null,'Exceso':vigente?Math.max(0,consumido-monto):null,'Estado':s.estado||'Pendiente',
        'Rendiciones':[...new Set(partes.map(p=>p.folio))].sort((a,b)=>a-b).map(f=>'N° '+f).join(', ')};
    });

    // Cuadratura: controles que el archivo se hace a sí mismo.
    const cuadratura=[];
    const control=(nombre,detalle,estado)=>cuadratura.push({'Control':nombre,'Resultado':detalle,'Estado':estado});
    const conRendido=rendiciones.filter(r=>r.monto_rendido!=null);
    const difRendido=conRendido.filter(r=>Math.abs(Number(r.monto_rendido)-sumas.get(r.id).rendido)>0.5);
    control('Rendido de cada rendición = suma de sus gastos',difRendido.length?difRendido.length+' no cuadran: N° '+difRendido.map(r=>r.folio).join(', '):conRendido.length+' rendiciones cuadran',difRendido.length?'Revisar':'OK');
    const aprobadas=rendiciones.filter(r=>r.estado==='Aprobado');
    const difAprob=aprobadas.filter(r=>Math.abs(Number(r.monto_total||0)-sumas.get(r.id).aprobado)>0.5);
    control('Total aprobado = gastos aprobados',difAprob.length?difAprob.length+' no cuadran: N° '+difAprob.map(r=>r.folio).join(', '):aprobadas.length+' rendiciones aprobadas cuadran',difAprob.length?'Revisar':'OK');
    const cerradasConPend=rendiciones.filter(r=>r.estado&&r.estado!=='Pendiente'&&sumas.get(r.id).pendiente>0);
    control('Rendiciones cerradas sin gastos pendientes',cerradasConPend.length?'N° '+cerradasConPend.map(r=>r.folio).join(', '):'Ninguna con gastos pendientes',cerradasConPend.length?'Revisar':'OK');
    const sinCuenta=gastos.filter(g=>g.Estado==='Aprobado'&&!g.Cuenta);
    control('Gastos aprobados con cuenta contable',sinCuenta.length?sinCuenta.length+' sin cuenta (N° '+[...new Set(sinCuenta.map(g=>g.Folio))].join(', ')+')':'Todos tienen cuenta',sinCuenta.length?'Revisar':'OK');
    const sinAdjunto=gastos.filter(g=>g.Comprobante!=='Sí');
    control('Gastos con comprobante adjunto',sinAdjunto.length?sinAdjunto.length+' sin comprobante':'Todos tienen comprobante',sinAdjunto.length?'Revisar':'OK');
    const multi=rendiciones.filter(r=>(partesPorRendicion.get(r.id)||[]).length>1);
    const difMulti=multi.filter(r=>Math.abs((partesPorRendicion.get(r.id)||[]).reduce((n,p)=>n+Number(p.monto_total||0),0)-Number(r.monto_total||0))>0.5);
    control('Rendiciones con varios fondos: las partes suman el total',multi.length?(difMulti.length?'No cuadran: N° '+difMulti.map(r=>r.folio).join(', '):multi.length+' cuadran'):'No hay rendiciones con varios fondos en el período',difMulti.length?'Revisar':'OK');
    control('Rendiciones aprobadas con CSV para Kame descargado',totales.faltaKame?totales.faltaKame+' de '+aprobadas.length+' sin descargar':'Todas descargadas',totales.faltaKame?'Pendiente':'OK');
    const docs=gastos.filter(g=>g.Tipo==='Documento electrónico'&&g.Estado==='Aprobado');
    const docsVerif=docs.filter(g=>g['En contabilidad']==='Sí').length;
    control('Documentos aprobados verificados en contabilidad',docs.length?docsVerif+' de '+docs.length+' verificados':'Sin documentos aprobados','Informativo');
    // La empresa que vale es la de la rendición (la usan el CSV de Kame y la app);
    // si se cambió después de enviarla, sus gastos pueden haber quedado con la anterior.
    const otraEmpresa=gastos.filter(g=>g._empresaItem&&g._empresaItem!==g.Empresa);
    control('Gastos con la misma empresa que su rendición',otraEmpresa.length?otraEmpresa.length+' con otra empresa guardada (N° '+[...new Set(otraEmpresa.map(g=>g.Folio))].join(', ')+'); el informe usa la de la rendición':'Todos coinciden',otraEmpresa.length?'Revisar':'OK');
    const suma=totales.aprobado+totales.rechazado+totales.pendiente;
    control('Rendido = aprobado + rechazado + pendiente',Math.abs(suma-totales.rendido)<0.5?'Cuadra':'Diferencia de '+(totales.rendido-suma),Math.abs(suma-totales.rendido)<0.5?'OK':'Revisar');

    const limpiar=g=>{const {_rendicion,_mes,_empresaItem,rendido,aprobado,rechazado,pendiente,...resto}=g;return resto;};
    return {filtroTexto:textoFiltro(filtro),rendiciones:filasRendiciones,gastos:gastos.map(limpiar),fondos,totales,
      porEmpresa,porMes:porMes.map(g=>({...g,nombre:g.clave==='sin fecha'?'Sin fecha':nombreMes(g.clave)})),porCategoria,porEmpleado,porCentro,porCuenta,cuadratura,
      // Nombres anteriores, por si algo externo los usa.
      get resumen(){return this.rendiciones;},get detalle(){return this.gastos;}};
  }

  // ------------------------------------------------------------
  // Libro
  // ------------------------------------------------------------
  const fuente=(extra={})=>({name:'Calibri',size:11,color:{argb:TINTA},...extra});
  const relleno=argb=>({type:'pattern',pattern:'solid',fgColor:{argb}});

  function crearLibro(ExcelJS,datos,corte=new Date()){
    const wb=new ExcelJS.Workbook();wb.creator='RindeWellness';wb.created=corte;wb.modified=corte;wb.calcProperties.fullCalcOnLoad=true;
    const textoCorte='Generado el '+new Intl.DateTimeFormat('es-CL',{timeZone:'America/Santiago',dateStyle:'long',timeStyle:'short'}).format(corte)+' · Montos en pesos (CLP)';
    let nTabla=0;

    function hoja(nombre,anchos){
      const ws=wb.addWorksheet(nombre,{views:[{showGridLines:false}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0},
        headerFooter:{oddFooter:'&LRindeWellness · '+nombre+'&RPágina &P de &N'}});
      ws.columns=anchos.map(w=>({width:w}));
      return ws;
    }
    function encabezado(ws,titulo,columnas){
      ws.mergeCells(1,1,1,columnas);ws.mergeCells(2,1,2,columnas);
      Object.assign(ws.getCell(1,1),{value:titulo,font:fuente({size:20,bold:true,color:{argb:VERDE}})});ws.getRow(1).height=34;
      Object.assign(ws.getCell(2,1),{value:datos.filtroTexto+'   ·   '+textoCorte,font:fuente({size:10,color:{argb:TENUE}})});ws.getRow(2).height=18;
    }
    function subtitulo(ws,fila,texto,columnas){
      ws.mergeCells(fila,1,fila,columnas);const c=ws.getCell(fila,1);c.value=texto;c.font=fuente({size:13,bold:true,color:{argb:VERDE}});
      c.border={bottom:{style:'medium',color:{argb:VERDE}}};ws.getRow(fila).height=24;
    }
    // Tabla de Excel con estilo, filtros, fila de totales y formatos por columna.
    function tabla(ws,fila,columnas,filas,{totales=true,barras=null,col=1}={}){
      if(!filas.length){ws.getCell(fila,col).value='Sin datos en el período elegido.';ws.getCell(fila,col).font=fuente({italic:true,color:{argb:TENUE}});return fila+1;}
      const conTotal=totales&&columnas.some(c=>c.total);
      ws.addTable({name:'T'+(++nTabla)+'_'+ws.name.replace(/[^A-Za-z0-9]/g,'').slice(0,20),ref:ws.getCell(fila,col).address,headerRow:true,totalsRow:conTotal,
        style:{theme:'TableStyleMedium2',showRowStripes:true},
        columns:columnas.map((c,i)=>({name:c.nombre,filterButton:true,totalsRowFunction:conTotal?(c.total||'none'):undefined,totalsRowLabel:conTotal&&i===0?'Total':undefined})),
        rows:filas.map(f=>columnas.map(c=>{const v=f[c.clave??c.nombre];return v===''||v===undefined?null:v;}))});
      const ultima=fila+filas.length+(conTotal?1:0);
      ws.getRow(fila).height=30;
      columnas.forEach((c,i)=>{
        const n=col+i,formato={clp:CLP,fecha:FECHA,entero:ENTERO,pct:PCT}[c.tipo];
        for(let r=fila;r<=ultima;r++){const celda=ws.getCell(r,n);celda.alignment={vertical:'middle',wrapText:r===fila||c.tipo==='texto_largo',horizontal:['clp','entero','pct'].includes(c.tipo)?'right':'left'};if(formato&&r>fila)celda.numFmt=formato;}
        if(c.nombre==='Estado')for(let r=fila+1;r<=fila+filas.length;r++){const celda=ws.getCell(r,n),col2={Aprobado:VERDE,OK:VERDE,Rechazado:ROJO,Revisar:ROJO,Pendiente:AMBAR}[celda.value];if(col2)celda.font=fuente({bold:true,color:{argb:col2}});}
      });
      if(conTotal)ws.getRow(ultima).font=fuente({bold:true});
      if(barras){const i=columnas.findIndex(c=>c.nombre===barras);if(i>=0&&filas.length>1){const letra=ws.getColumn(col+i).letter;
        ws.addConditionalFormatting({ref:letra+(fila+1)+':'+letra+(fila+filas.length),rules:[{type:'dataBar',priority:1,cfvo:[{type:'num',value:0},{type:'max'}],color:{argb:'FF7CC4BB'},gradient:false}]});}}
      return ultima+1;
    }

    // ---------- Resumen ----------
    const t=datos.totales;
    const res=hoja('Resumen',[28,17,17,17,17,17]);
    encabezado(res,'Informe de rendiciones',6);
    const tarjeta=(fila,col,etiqueta,valor,formato,color=TINTA,nota='')=>{
      res.mergeCells(fila,col,fila,col+1);res.mergeCells(fila+1,col,fila+1,col+1);res.mergeCells(fila+2,col,fila+2,col+1);
      const a=res.getCell(fila,col),b=res.getCell(fila+1,col),c=res.getCell(fila+2,col);
      a.value=etiqueta;a.font=fuente({size:10,bold:true,color:{argb:TENUE}});b.value=valor;b.numFmt=formato;b.font=fuente({size:20,bold:true,color:{argb:color}});c.value=nota;c.font=fuente({size:9,color:{argb:TENUE}});
      for(let r=fila;r<=fila+2;r++)for(let k=col;k<=col+1;k++){const celda=res.getCell(r,k);celda.fill=relleno(FONDO_SUAVE);celda.alignment={vertical:'middle',horizontal:'left',indent:1};}
    };
    res.getRow(4).height=18;res.getRow(5).height=32;res.getRow(6).height=16;res.getRow(8).height=18;res.getRow(9).height=32;res.getRow(10).height=16;
    tarjeta(4,1,'MONTO RENDIDO',t.rendido,CLP,TINTA,t.rendiciones+' rendiciones · '+t.total+' gastos');
    tarjeta(4,3,'APROBADO',t.aprobado,CLP,VERDE,t.rendido?Math.round(100*t.aprobado/t.rendido)+'% de lo rendido':'');
    tarjeta(4,5,'PENDIENTE DE REVISIÓN',t.pendiente,CLP,AMBAR,t.pendientesRendiciones+' rendiciones pendientes');
    tarjeta(8,1,'RECHAZADO',t.rechazado,CLP,ROJO,'No se paga ni consume fondos');
    tarjeta(8,3,'GASTOS CON COMPROBANTE',t.total?t.conComprobante/t.total:0,PCT,TINTA,t.conComprobante+' de '+t.total);
    tarjeta(8,5,'DÍAS PROMEDIO EN APROBAR',t.diasPromedio==null?null:Math.round(t.diasPromedio*10)/10,'0.0',TINTA,t.faltaKame?t.faltaKame+' aprobadas sin CSV para Kame':'CSV para Kame al día');
    let f=12;
    subtitulo(res,f,'Por empresa',6);f+=1;
    f=tabla(res,f,[{nombre:'Empresa'},{nombre:'Rendiciones',clave:'nRend',tipo:'entero',total:'sum'},{nombre:'Rendido',clave:'rendido',tipo:'clp',total:'sum'},{nombre:'Aprobado',clave:'aprobado',tipo:'clp',total:'sum'},{nombre:'Rechazado',clave:'rechazado',tipo:'clp',total:'sum'},{nombre:'Pendiente',clave:'pendiente',tipo:'clp',total:'sum'}],
      datos.porEmpresa.map(g=>({Empresa:g.clave,nRend:g.rendiciones.size,...g})),{barras:'Aprobado'})+1;
    subtitulo(res,f,'Por mes',6);f+=1;
    f=tabla(res,f,[{nombre:'Mes',clave:'nombre'},{nombre:'Rendiciones',clave:'nRend',tipo:'entero',total:'sum'},{nombre:'Rendido',clave:'rendido',tipo:'clp',total:'sum'},{nombre:'Aprobado',clave:'aprobado',tipo:'clp',total:'sum'},{nombre:'Rechazado',clave:'rechazado',tipo:'clp',total:'sum'},{nombre:'Pendiente',clave:'pendiente',tipo:'clp',total:'sum'}],
      datos.porMes.map(g=>({nRend:g.rendiciones.size,...g})),{barras:'Aprobado'})+1;
    subtitulo(res,f,'Categorías con más gasto aprobado (10 primeras)',6);f+=1;
    f=tabla(res,f,[{nombre:'Categoría',clave:'clave'},{nombre:'Gastos',clave:'n',tipo:'entero'},{nombre:'Aprobado',clave:'aprobado',tipo:'clp'},{nombre:'% del aprobado',clave:'pct',tipo:'pct'}],
      datos.porCategoria.slice(0,10).map(g=>({...g,pct:t.aprobado?g.aprobado/t.aprobado:0})),{totales:false,barras:'Aprobado'})+1;
    subtitulo(res,f,'Empleados con más gasto rendido (10 primeros)',6);f+=1;
    tabla(res,f,[{nombre:'Empleado',clave:'clave'},{nombre:'Rendiciones',clave:'nRend',tipo:'entero'},{nombre:'Rendido',clave:'rendido',tipo:'clp'},{nombre:'Aprobado',clave:'aprobado',tipo:'clp'},{nombre:'Rechazado',clave:'rechazado',tipo:'clp'}],
      datos.porEmpleado.slice().sort((a,b)=>b.rendido-a.rendido).slice(0,10).map(g=>({...g,nRend:g.rendiciones.size})),{totales:false,barras:'Rendido'});

    // ---------- Rendiciones ----------
    const colsRend=[{nombre:'Folio',tipo:'entero',ancho:9},{nombre:'Fecha',tipo:'fecha',ancho:12},{nombre:'Empleado',ancho:26},{nombre:'RUT empleado',ancho:14},{nombre:'Empresa',ancho:24},{nombre:'Tipo',ancho:16},{nombre:'Fondo',ancho:13},
      {nombre:'Comentario',tipo:'texto_largo',ancho:34},{nombre:'Gastos',tipo:'entero',ancho:9,total:'sum'},{nombre:'Rendido',tipo:'clp',ancho:14,total:'sum'},{nombre:'Aprobado',tipo:'clp',ancho:14,total:'sum'},{nombre:'Rechazado',tipo:'clp',ancho:14,total:'sum'},
      {nombre:'Pendiente',tipo:'clp',ancho:14,total:'sum'},{nombre:'Estado',ancho:12},{nombre:'Aprobador',ancho:22},{nombre:'Fecha aprobación',tipo:'fecha',ancho:13},{nombre:'Días en aprobar',tipo:'entero',ancho:10},
      {nombre:'CSV Kame',ancho:12},{nombre:'Fecha CSV Kame',tipo:'fecha',ancho:13},{nombre:'Motivo rechazo',tipo:'texto_largo',ancho:34}];
    const wsR=hoja('Rendiciones',colsRend.map(c=>c.ancho));encabezado(wsR,'Rendiciones',colsRend.length);
    tabla(wsR,4,colsRend,datos.rendiciones);wsR.views=[{state:'frozen',ySplit:4,xSplit:1,showGridLines:false}];

    // ---------- Gastos ----------
    const colsG=[{nombre:'Folio',tipo:'entero',ancho:9},{nombre:'Fecha',tipo:'fecha',ancho:12},{nombre:'Empleado',ancho:24},{nombre:'Empresa',ancho:22},{nombre:'Centro de costo',ancho:22},{nombre:'Tipo',ancho:20},
      {nombre:'Proveedor',ancho:28},{nombre:'RUT proveedor',ancho:14},{nombre:'Tipo documento',ancho:20},{nombre:'N° documento',ancho:13},{nombre:'Fecha documento',tipo:'fecha',ancho:13},{nombre:'Categoría',ancho:24},
      {nombre:'Cuenta',ancho:12},{nombre:'Nombre cuenta',ancho:30},{nombre:'Monto',tipo:'clp',ancho:14,total:'sum'},{nombre:'Estado',ancho:12},{nombre:'En contabilidad',ancho:15},{nombre:'Comprobante',ancho:12},
      {nombre:'Motivo rechazo',tipo:'texto_largo',ancho:30},{nombre:'Descripción',tipo:'texto_largo',ancho:40}];
    const wsG=hoja('Gastos',colsG.map(c=>c.ancho));encabezado(wsG,'Gastos (un registro por gasto)',colsG.length);
    tabla(wsG,4,colsG,datos.gastos);wsG.views=[{state:'frozen',ySplit:4,xSplit:1,showGridLines:false}];

    // ---------- Por centro de costo ----------
    const wsC=hoja('Por centro de costo',[26,28,12,16,16,16,16]);encabezado(wsC,'Gasto por centro de costo',7);
    tabla(wsC,4,[{nombre:'Empresa',clave:'empresa'},{nombre:'Centro de costo',clave:'centro'},{nombre:'Gastos',clave:'n',tipo:'entero',total:'sum'},{nombre:'Rendido',clave:'rendido',tipo:'clp',total:'sum'},{nombre:'Aprobado',clave:'aprobado',tipo:'clp',total:'sum'},{nombre:'Rechazado',clave:'rechazado',tipo:'clp',total:'sum'},{nombre:'Pendiente',clave:'pendiente',tipo:'clp',total:'sum'}],
      datos.porCentro,{barras:'Aprobado'});

    // ---------- Por cuenta contable ----------
    const wsK=hoja('Por cuenta contable',[14,36,12,16,16,16]);encabezado(wsK,'Gasto por cuenta contable',6);
    tabla(wsK,4,[{nombre:'Cuenta',clave:'clave'},{nombre:'Nombre',clave:'nombre'},{nombre:'Gastos',clave:'n',tipo:'entero',total:'sum'},{nombre:'Rendido',clave:'rendido',tipo:'clp',total:'sum'},{nombre:'Aprobado',clave:'aprobado',tipo:'clp',total:'sum'},{nombre:'Pendiente',clave:'pendiente',tipo:'clp',total:'sum'}],
      datos.porCuenta,{barras:'Aprobado'});

    // ---------- Fondos ----------
    const colsF=[{nombre:'Folio',ancho:9},{nombre:'Fecha',tipo:'fecha',ancho:12},{nombre:'Empleado',ancho:24},{nombre:'Empresa',ancho:22},{nombre:'Centro de costo',ancho:20},{nombre:'Motivo',tipo:'texto_largo',ancho:32},
      {nombre:'Otorgado',tipo:'clp',ancho:14,total:'sum'},{nombre:'Aprobado',tipo:'clp',ancho:14,total:'sum'},{nombre:'En revisión',tipo:'clp',ancho:14,total:'sum'},{nombre:'Consumido',tipo:'clp',ancho:14,total:'sum'},
      {nombre:'Saldo',tipo:'clp',ancho:14,total:'sum'},{nombre:'Exceso',tipo:'clp',ancho:14,total:'sum'},{nombre:'Estado',ancho:12},{nombre:'Rendiciones',tipo:'texto_largo',ancho:26}];
    const wsF=hoja('Fondos',colsF.map(c=>c.ancho));encabezado(wsF,'Fondos por rendir · saldo al día de hoy',colsF.length);
    wsF.mergeCells(3,1,3,colsF.length);wsF.getCell(3,1).value='El saldo no depende del período: cuenta todo lo rendido contra cada fondo. Con varios fondos en una rendición, cada uno cuenta solo su parte. Excluye rechazados.';
    wsF.getCell(3,1).font=fuente({size:10,italic:true,color:{argb:TENUE}});
    tabla(wsF,5,colsF,datos.fondos);wsF.views=[{state:'frozen',ySplit:5,showGridLines:false}];

    // ---------- Cuadratura ----------
    const wsQ=hoja('Cuadratura',[52,60,14]);encabezado(wsQ,'Cuadratura y controles',3);
    tabla(wsQ,4,[{nombre:'Control'},{nombre:'Resultado',tipo:'texto_largo'},{nombre:'Estado'}],datos.cuadratura,{totales:false});

    return wb;
  }

  const api={preparar,crearLibro,fecha,filtrar,textoFiltro};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RindeReportes=api;
})(typeof globalThis!=='undefined'?globalThis:this);
