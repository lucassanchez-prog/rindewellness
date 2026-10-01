const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {crearLector}=require('../lector-local.js'),core=require('../pure.js');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function tramo(a,b){return app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)+a.length));}
test('el bot reutiliza el motor y serializa comprobantes simultáneos',async()=>{
 let creados=0,activos=0,maximo=0,cerrados=0;const modos=[];
 const lector=crearLector(()=>({createWorker:async()=>{creados++;return {setParameters:async p=>modos.push(p.tessedit_pageseg_mode),recognize:async imagen=>{activos++;maximo=Math.max(maximo,activos);await new Promise(r=>setTimeout(r,5));activos--;return {data:{text:imagen}};},terminate:async()=>cerrados++};}}));
 try{const r=await Promise.all([lector.leer('uno'),lector.leer('dos',11)]);assert.equal(r[1].data.text,'dos');assert.equal(creados,1);assert.equal(maximo,1);assert.deepEqual(modos,['3','11']);}finally{await lector.cerrar();}assert.equal(cerrados,1);
});
test('un motor bloqueado vence y la siguiente lectura puede recuperarse',async()=>{
 let creados=0;const lector=crearLector(()=>({createWorker:async()=>{const intento=++creados;return {setParameters:async()=>{},recognize:()=>intento===1?new Promise(()=>{}):Promise.resolve({data:{text:'recuperado'}}),terminate:async()=>{}};}}),{timeoutMs:15});
 try{await assert.rejects(lector.leer('a'),/agotó/);assert.equal((await lector.leer('b')).data.text,'recuperado');assert.equal(creados,2);}finally{await lector.cerrar();}
});
test('la revisión local conserva alertas y no transforma discrepancias en montos seguros',()=>{
 const c=vm.createContext({montoValidoCLP:core.montoValidoCLP || Number,fmtCLP:String});vm.runInContext(tramo('function fusionarLecturas(','// La ÚNICA llamada'),c);
 const r=c.fusionarLecturas({monto:1000,monto_verificado:false,confianza_baja:['monto'],verificacion_campos:{monto:{estado:'por_confirmar'}}},null,{});
 assert.equal(r.datos.monto_verificado,false);assert.equal(r.datos.confianza_baja[0],'monto');assert.equal(r.datos.verificacion_campos.monto.estado,'por_confirmar');
 assert.equal(c.fusionarLecturas({monto_discrepante:true},{monto:1000},{}).datos.monto,null);
});
test('el lector distingue la fecha de emisión de un vencimiento anterior',()=>{
 const c=vm.createContext({validarRut:core.validarRut,RUT_POR_EMPRESA:{}});vm.runInContext(tramo('const MESES_ES =','const CAMPOS_OCR_CON ='),c);vm.runInContext(tramo('const CABECERA_DETALLE','async function buscarDatosPreviosPorRut'),c);
 assert.equal(c.parsearTextoFactura('Vencimiento 14/05/2025. Fecha emisión: 14 de Mayo del 2026. Factura Electrónica N° 1618190').fecha,'2026-05-14');
});
test('el respaldo escanea un PDF de una página y evita mezclar documentos multipágina',async()=>{
 let destruido=0,escaneado=0,paginas=1;const pdf={get numPages(){return paginas;},getPage:async()=>({getViewport:()=>({width:500,height:700}),render:()=>({promise:Promise.resolve()})}),destroy:async()=>destruido++};
 const c=vm.createContext({console,File,Blob,LADO_MAXIMO_OCR:2000,cargarPdfJs:async()=>({getDocument:()=>({promise:Promise.resolve(pdf)})}),leerFotoLocal:async file=>{assert.equal(file.type,'image/png');escaneado++;return {monto:100};},document:{createElement:()=>({getContext:()=>({}),toBlob:fn=>fn(new Blob(['foto'],{type:'image/png'}))})}});
 vm.runInContext(tramo('async function leerEscaneadoLocal(','async function aplicarRespaldoFoto('),c);const file=new File(['pdf'],'gasto.pdf',{type:'application/pdf'});
 assert.equal((await c.leerEscaneadoLocal(file)).monto,100);paginas=2;assert.equal(await c.leerEscaneadoLocal(file),null);assert.equal(escaneado,1);assert.equal(destruido,2);
});
