const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const core=require('../pure.js');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
function tramo(inicio,fin){const a=app.indexOf(inicio),b=app.indexOf(fin,a+inicio.length);assert(a>=0&&b>a,'tramo de fuente encontrado');return app.slice(a,b);}

test('duplicados: normaliza RUT, tilde y folio, respeta proveedor y tipo',()=>{
  const factura={rut_proveedor:'76.717.691-0',tipo_documento:'Factura Electrónica',nro_documento:'00123'};
  assert.deepEqual(core.documentosDuplicados([factura,{...factura,rut_proveedor:'767176910',tipo_documento:'Factura Electronica',nro_documento:'123'},{...factura,tipo_documento:'Boleta de Honorario'},{...factura,rut_proveedor:'775749113'}]),[[0,1]]);
  assert.deepEqual(core.documentosDuplicados([{...factura,nro_documento:''},{...factura,nro_documento:''}]),[]);
});
test('alerta identifica tarjetas repetidas y desaparece al corregir',()=>{
  const avisos=new Map(),campos=new Map();
  const cards=[{id:'item-1',querySelector:()=>({classList:{contains:()=>true}})},{id:'item-2',querySelector:()=>({classList:{contains:()=>false}})}];
  for(const card of cards){const suf=card.id==='item-1'?'':'2';avisos.set(card.id+'-dup-local',{textContent:'',className:''});campos.set(card.id+'-rut'+suf,{value:'76.717.691-0'});campos.set(card.id+'-tipodoc'+suf,{value:'Factura Electrónica'});campos.set(card.id+'-folio'+suf,{value:'123'});}
  const ctx=vm.createContext({documentosDuplicados:core.documentosDuplicados,document:{querySelectorAll:()=>cards,getElementById:id=>avisos.get(id)||campos.get(id)}});
  vm.runInContext(tramo('function documentoDeTarjeta(', 'async function chequearDuplicadoHistorico('),ctx);
  vm.runInContext('actualizarAlertasDuplicados()',ctx);
  assert.match(avisos.get('item-1-dup-local').textContent,/1, 2/);
  assert.match(avisos.get('item-2-dup-local').className,/show err/);
  campos.get('item-2-folio2').value='124';vm.runInContext('actualizarAlertasDuplicados()',ctx);
  assert.equal(avisos.get('item-1-dup-local').textContent,'');assert.equal(avisos.get('item-2-dup-local').className,'ocr-status');
});
test('CSV conserva separadores, comillas y saltos de línea',()=>{
  assert.equal(core.campoCSV('Proveedor;Sucursal'),'"Proveedor;Sucursal"');
  assert.equal(core.campoCSV('A "B"\nC'),'"A ""B""\nC"');
  assert.equal(core.campoCSV(null),'');assert.equal(core.campoCSV(100),'100');
});
test('CSV excluye rechazados y mantiene Debe y Haber',()=>{
  const ctx=vm.createContext({campoCSV:core.campoCSV,fmtDateSlash:()=> '30/09/2026',CUENTA_CONTRAPARTIDA:{Reembolso:{cuenta:'2.01.07.29'}}});
  vm.runInContext(tramo('function csvRow(', 'async function calcularSplitFondo('),ctx);
  ctx.r={id:'rendicion',folio:1,tipo_rendicion:'Reembolso',monto_total:100,empleado_nombre:'Ana',created_at:'2026-09-30'};
  ctx.items=[{estado:'Aprobado',tipo_item:'SinDocumento',cuenta_contable:'4.01',monto:100},{estado:'Rechazado',tipo_item:'SinDocumento',cuenta_contable:'4.01',monto:50}];
  const rows=vm.runInContext('construirFilasCSV(r,items)',ctx);assert.equal(rows.length,2);
  assert.equal(rows.reduce((n,row)=>n+Number(row.split(';')[6]),0),100);
  assert.equal(rows.reduce((n,row)=>n+Number(row.split(';')[7]),0),100);
});
test('23 casos del lector integrados a la suite',()=>{
  const ctx=vm.createContext({console,validarRut:core.validarRut,RUT_POR_EMPRESA:{}});
  vm.runInContext(tramo('const MESES_ES =','const CAMPOS_OCR_CON ='),ctx);
  vm.runInContext(tramo('const CABECERA_DETALLE','async function buscarDatosPreviosPorRut'),ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'pruebas_lector.js'),'utf8'),ctx);
  const resultado=vm.runInContext('correrPruebasLector()',ctx);assert.equal(resultado.total,23);assert.equal(resultado.fallos.length,0);
});
test('cuenta desactivada no se considera aprobador',()=>assert.equal(core.esAprobadorEfectivo({rol:'admin',activo:false}),false));
test('logEvent detecta error devuelto y separa solicitudes de rendiciones',async()=>{
  const {logEvent}=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/logging.ts')));
  let fila,errores=0;const original=console.error;console.error=()=>errores++;
  try{await logEvent({from:()=>({insert:async datos=>{fila=datos;return {error:{message:'FK'}};}})},'correo',{solicitudId:'solicitud'});}finally{console.error=original;}
  assert.equal(fila.rendicion_id,null);assert.equal(fila.solicitud_id,'solicitud');assert.equal(errores,1);
});
test('paginación completa con páginas más pequeñas que lo solicitado',async()=>{
  const {leerTodas}=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/data.ts')));
  const datos=Array.from({length:251},(_,i)=>({id:i}));
  const filas=await leerTodas(()=>({range:async inicio=>({data:datos.slice(inicio,inicio+17),count:datos.length,error:null})}));
  assert.equal(filas.length,251);assert.equal(filas[250].id,250);
  await assert.rejects(()=>leerTodas(()=>({range:async()=>({data:[],count:2,error:null})})),/incompleta/);
});
test('emails por ID y bloqueo de rutas ajenas o relativas',async()=>{
  const {emailsDePerfiles,rutaPropia}=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/data.ts')));
  const emails=await emailsDePerfiles({auth:{admin:{getUserById:async id=>({data:{user:{email:id+'@test.invalid'}},error:null})}}},[{id:'usuario-en-pagina-2'}]);
  assert.equal(emails.get('usuario-en-pagina-2'),'usuario-en-pagina-2@test.invalid');
  assert.equal(rutaPropia('a/factura.pdf','a'),true);assert.equal(rutaPropia('b/factura.pdf','a'),false);assert.equal(rutaPropia('a/../b/factura.pdf','a'),false);
});

test('agente valida RUT, fechas imposibles y conflicto de montos sin inventar certeza',async()=>{
  const {verificarCampos,rutValido,fechaValida}=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/verificacion-ocr.ts')));
  assert.equal(rutValido('76.717.691-0'),true);assert.equal(rutValido('76.717.691-1'),false);
  assert.equal(fechaValida('2024-02-29'),true);assert.equal(fechaValida('2026-02-29'),false);
  const datos={rut_proveedor:'76.717.691-1',fecha:'2026-02-30',monto:null,monto_discrepante:true,evidencias:{monto:{texto:'TOTAL $100',ubicacion:'Pie'}}};
  const revision=verificarCampos(datos);
  assert.equal(datos.rut_proveedor,null);assert.equal(datos.fecha,null);
  assert.equal(revision.monto.estado,'por_confirmar');assert.equal(revision.monto.texto,'TOTAL $100');
  assert.equal(verificarCampos({monto:100,monto_verificado:true}).monto.estado,'consistente');
  assert.equal(verificarCampos({rut_proveedor:'76.717.691-0'}).rut_proveedor.estado,'por_confirmar');
});
test('resultado tardío conserva el campo editado y completa los demás',()=>{
  const ctx=vm.createContext({document:{}});
  vm.runInContext(tramo('const camposEditadosOcr =','function mostrarVerificacionOcr('),ctx);
  const resultado=vm.runInContext('camposEditadosOcr.add("item-1-monto"); protegerEdicionOcr("item-1", {monto:100,nro_documento:"123"})',ctx);
  assert.equal(resultado.monto,undefined);assert.equal(resultado.nro_documento,'123');
});

test('agente interpreta varias partes, descarta monto contradictorio y cruza segunda lectura',async()=>{
  const previoDeno=globalThis.Deno,previoFetch=globalThis.fetch;
  globalThis.Deno={env:{get:clave=>clave==='GEMINI_API_KEY'?'clave-de-prueba-sin-red':clave==='GEMINI_MODELS_ORDEN'?'modelo-prueba':undefined}};
  try {
    const agente=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/gemini-ocr.ts')));
    const respuesta=datos=>({candidates:[{content:{parts:[{thought:true,text:'no incluir'},{text:JSON.stringify(datos).slice(0,8)},{text:JSON.stringify(datos).slice(8)}]}}]});
    const conflicto=agente.interpretarRespuestaOcr(respuesta({monto:100000,monto_en_palabras:'doscientos mil',rut_proveedor:'76.717.691-0'}));
    assert.equal(conflicto.monto,null);assert.equal(conflicto.monto_discrepante,true);assert.equal(conflicto.verificacion_campos.monto.estado,'por_confirmar');
    let llamadas=0;globalThis.fetch=async()=>({ok:true,json:async()=>respuesta({rut_proveedor:'76.717.691-0',fecha:'2026-09-30',nro_documento:++llamadas===1?'123':'124',monto:100})});
    const resultado=await agente.leerComprobante(null,'aW1hZ2Vu','image/jpeg',agente.PRESUPUESTO_SEGUNDO_PLANO);
    assert.equal(llamadas,2);assert.equal(resultado.nro_documento,null);assert.match(resultado.verificacion_campos.nro_documento.motivo,/123 \/ 124/);
    assert.equal(resultado.verificacion_campos.monto.estado,'coincidente_lecturas');
  } finally {globalThis.Deno=previoDeno;globalThis.fetch=previoFetch;}
});
test('fallos de proveedor se posponen; documento ilegible sí consume intento',async()=>{
  const {demoraTransitoriaOcr}=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/reintentos-ocr.ts')));
  assert.equal(demoraTransitoriaOcr(new Error('quota exceeded')),3600000);
  assert.equal(demoraTransitoriaOcr(new Error('high demand')),900000);
  assert.equal(demoraTransitoriaOcr(new Error('No se obtuvo ningún campo legible')),null);
});

test('resumen visual conserva el monto rendido y distingue las decisiones',()=>{
  // Referencia visual enviada por el usuario: la suma presentada se conserva.
  const ejemplo=core.resumenRendicion([...Array.from({length:14},()=>({monto:30000,estado:'Aprobado'})),{monto:67060,estado:'Aprobado'},{monto:20000,estado:'Rechazado'}]);
  assert.equal(ejemplo.rendido,507060);assert.equal(ejemplo.aprobado,487060);assert.equal(ejemplo.rechazado,20000);assert.equal(ejemplo.aprobados,15);assert.equal(ejemplo.total,16);
});
