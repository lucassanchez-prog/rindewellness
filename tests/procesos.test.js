const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function tramo(a,b){const i=app.indexOf(a),j=app.indexOf(b,i+a.length);assert(i>=0&&j>i);return app.slice(i,j);}
function ctx(extra={}){return vm.createContext({console,Map,Set,...extra});}
test('paginación mantiene todas las filas aunque la API entregue páginas pequeñas',async()=>{
 const c={consultarTodas:require('../data-access.js').consultarTodas};
 const filas=Array.from({length:7},(_,id)=>({id}));
 assert.equal((await c.consultarTodas(()=>({range:async i=>({data:filas.slice(i,i+2),count:7,error:null})}))).length,7);
 await assert.rejects(c.consultarTodas(()=>({range:async()=>({data:null,count:null,error:Error('red')})})),/red/);
 await assert.rejects(c.consultarTodas(()=>({range:async()=>({data:[],count:7,error:null})})),/incompleta/);
 let n=0;await assert.rejects(c.consultarTodas(()=>({range:async()=>({data:[{id:n++}],count:n===1?2:3,error:null})})),/cambiaron/);
});
test('conflicto de monto viaja al aplicador y el servidor no queda oculto por el lector local',()=>{
 const c=ctx({montoValidoCLP:Number,fmtCLP:String});vm.runInContext(tramo('function fusionarLecturas(','// La ÚNICA llamada'),c);
 for(const ia of [{monto:20000},{monto:null,monto_discrepante:true}]){
  const r=c.fusionarLecturas({monto:10000},ia,{});assert.equal(r.datos.monto,null);assert.equal(r.aporteIA.monto_discrepante,true);assert.equal(r.aporteIA.monto,null);
 }
});
test('historial fallido cancela la distribución del fondo; historial completo separa exceso',async()=>{
 const api=require('../data-access.js');const c={};c.calcularSplitFondo=r=>api.distribuirFondosCsv(c.db,r);
 c.db={rpc:async()=>({data:null,error:Error('historial fallido')})};
 await assert.rejects(c.calcularSplitFondo([{id:'r2',solicitud_fondo_id:'f',monto_total:50}]),/historial fallido/);
 c.db.rpc=async()=>({data:[{id:'r2',dentroDelFondo:20,excedente:30,fondoFolio:2}],error:null});
 const r=(await c.calcularSplitFondo([{id:'r2',solicitud_fondo_id:'f',monto_total:50}])).get('r2');assert.equal(r.dentroDelFondo,20);assert.equal(r.excedente,30);
 await assert.rejects(c.calcularSplitFondo([{id:'r2',solicitud_fondo_id:'f',monto_total:55}]),/no coincide/);
});
test('CSV no permite omitir la distribución comprobada del fondo',()=>{
 const c=ctx({campoCSV:String,fmtDateSlash:String});vm.runInContext(tramo('function csvRow(','async function calcularSplitFondo('),c);
 assert.throws(()=>c.construirFilasCSV({id:'r',tipo_rendicion:'FondoPorRendir',solicitud_fondo_id:'f',created_at:'2026-10-01'},[]),/distribución/);
});
test('abrir fondo aprobado presenta consumo y saldo sin ReferenceError',async()=>{
 const box={innerHTML:'',appendChild(node){this.nodes.push(node);},nodes:[]};
 const fondo={id:'f',folio:2,estado:'Aprobado',empleado_id:'u',monto_solicitado:100};
 const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:fondo,error:null})};
 const nodo=(tag,attrs,children)=>({tag,attrs,children,nodes:[],appendChild(n){this.nodes.push(n);},setAttribute(){}});
 const c=ctx({window:{RindeUI:{metric:(label,value,help)=>nodo("div",{},[label,value,help])}},db:{from:()=>q},document:{getElementById:()=>box},currentProfile:{},currentUser:{id:'u'},esAprobadorEfectivo:()=>false,fmtCLP:String,fmtDate:String,el:nodo,filaClickable:(_,c)=>nodo('tr',{},c),consultarTodas:async()=>[{id:'r',folio:1,estado:'Pendiente',monto_total:80,monto_aprobado:0}],pushView(){},replaceView(){},show(){},pushState(){},history:{pushState(){}},toast(){},renderRoute(){}});
 vm.runInContext(tramo('function resumirConsumoFondo(','async function cargarConsumoFondos('),c);
 vm.runInContext(tramo('async function openDetalleSolicitud(','async function '),c);
 await c.openDetalleSolicitud('f',false);const texto=JSON.stringify(box.nodes);assert.match(texto,/Consumo aprobado/);assert.match(texto,/En revisión/);assert.match(texto,/80/);assert.match(texto,/20/);
});
test('una respuesta del agente que requiere separación conserva el error',async()=>{
 const estado={textContent:'',className:''};let sondeo;
 const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{estado:'listo',resultado:{requiere_separacion:true}},error:null})};
 const c=ctx({db:{from:()=>q},notificarAsync(){},esGeneracionVigenteOcr:()=>true,document:{body:{contains:()=>true}},setTimeout:fn=>{sondeo=fn;}});
 vm.runInContext(tramo('function dispararAgenteYEsperar(','// Al adjuntar un comprobante NUEVO'),c);
 c.dispararAgenteYEsperar('i','p',1,async()=>({estado:'requiere_separacion',mensaje:'Separa los gastos.'}),estado);await sondeo();assert.equal(estado.textContent,'Separa los gastos.');assert.match(estado.className,/err/);
});
test('lectura parcial se reintenta aunque una llamada previa haya obtenido datos',()=>{
 const c=ctx({ocrExitoso:new Map([['i',true]]),ocrBloqueado:new Set()});vm.runInContext(tramo('function estadoReintentoOcr(','// De dónde salieron'),c);
 assert.equal(c.estadoReintentoOcr('i',['Proveedor',null]),'pendiente');assert.equal(c.estadoReintentoOcr('i',['Proveedor',100]),null);c.ocrBloqueado.add('i');assert.equal(c.estadoReintentoOcr('i',[null]),null);
});
test('completitud distingue voucher, factura parcial y documento con varios gastos',async()=>{
 const {pathToFileURL}=require('node:url');const {revisarCompletitud,estadoTrasIntento}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/estado-lectura.ts')));
 const voucher=revisarCompletitud({nombre_proveedor:'Comercio',fecha:'2026-10-01',monto:100,tipo_documento:'Voucher'});
 assert.equal(voucher.revision_estado,'completo');
 const factura=revisarCompletitud({...voucher,tipo_documento:'Factura Electrónica'});assert.equal(factura.revision_estado,'parcial');assert(factura.campos_pendientes.includes('nro_documento'));
 assert.equal(estadoTrasIntento(factura,1,2),'pendiente');assert.equal(estadoTrasIntento(factura,2,2),'agotado');
 assert.equal(revisarCompletitud({requiere_separacion:true}).revision_estado,'requiere_separacion');
 assert.equal(revisarCompletitud({...voucher,monto:null,monto_discrepante:true},{monto:100}).revision_estado,'parcial');
});
test('una imagen pequeña o sin contraste advierte antes de la lectura',()=>{
 const c=ctx();vm.runInContext(tramo('function evaluarCalidadFoto(','async function mostrarCalidadFoto('),c);
 assert.equal(c.evaluarCalidadFoto(300,500,30).length,1);assert.equal(c.evaluarCalidadFoto(1800,2400,5).length,1);assert.equal(c.evaluarCalidadFoto(1800,2400,30).length,0);
});
test('verificación suma la distribución del mismo documento y excluye rechazados',()=>{
 const {grupoDocumentoContable}=require('../pure.js');
 const base={rut_proveedor:'76.717.691-0',tipo_documento:'Factura Electrónica',nro_documento:'00123',estado:'Pendiente'};
 const items=[{...base,id:'a',monto:80},{...base,id:'b',nro_documento:'123',monto:20},{...base,id:'c',monto:50,estado:'Rechazado'},{...base,id:'d',nro_documento:'124',monto:500}];
 const g=grupoDocumentoContable(items[0],items);assert.equal(g.monto,100);assert.equal(g.miembros.length,2);
 const firma=JSON.stringify(g.miembros);items[1].monto=30;assert.notEqual(JSON.stringify(grupoDocumentoContable(items[0],items).miembros),firma);
});
test('aplicar un monto discrepante limpia el autocompletado pero conserva una corrección manual',async()=>{
 const campos=new Map();const doc={getElementById:id=>{if(!campos.has(id))campos.set(id,{value:'dato'});return campos.get(id);}};
 const c=ctx({document:doc,camposEditadosOcr:new Set(),ocrExitoso:new Map(),ocrBloqueado:new Set(),ocrConflictos:new Map(),esGeneracionVigenteOcr:()=>true,recalcTotal(){},chequearDuplicadoHistorico(){},montoValidoCLP:Number,formatearRut:String});
 vm.runInContext(tramo('const SUFIJOS_OCR =','function mostrarVerificacionOcr('),c);c.mostrarVerificacionOcr=()=>{};
 vm.runInContext(tramo('function aplicarConflictosOcr(','function estadoReintentoOcr('),c);
 vm.runInContext(tramo('async function aplicarResultadoOcrCon(','// Dispara el agente de reintento'),c);
 doc.getElementById('i-monto').value='10.000';const conflicto=await c.aplicarResultadoOcrCon('i',{monto:null,monto_discrepante:true},1);assert.equal(doc.getElementById('i-monto').value,'');assert.equal(conflicto.estado,'conflicto');
 doc.getElementById('i-monto').value='20.000';c.camposEditadosOcr.add('i-monto');await c.aplicarResultadoOcrCon('i',{monto:null,monto_discrepante:true},1);assert.equal(doc.getElementById('i-monto').value,'20.000');
});
test('folios y fechas contradictorios no se conservan por preferencia del lector local',()=>{
 const c=ctx({montoValidoCLP:Number,fmtCLP:String});vm.runInContext(tramo('function fusionarLecturas(','// La ÚNICA llamada'),c);
 const r=c.fusionarLecturas({nro_documento:'123',fecha:'2026-09-30'},{nro_documento:'124',fecha:'2026-10-01'},{});
 assert.equal(r.datos.nro_documento,null);assert.equal(r.aporteIA.fecha,null);assert(r.aporteIA.campos_discrepantes.includes('nro_documento'));
 const normalizado=c.fusionarLecturas({nro_documento:'00123'},{nro_documento:'123'},{});assert.equal(normalizado.datos.nro_documento,'00123');
});

test('navegar por fondos conserva su destino al volver y no reinicia la vista actual',()=>{
 let rendered;const location={hash:'#inicio'},history={state:null,pushState(state,unused,hash){this.state=state;location.hash=hash;}};
 const c=ctx({location,history,renderRoute:state=>{rendered=state;},window:{scrollTo(){}}});
 vm.runInContext(tramo('function navegarPortal(','function configurarSeccionDashboard('),c);
 c.navegarPortal('fondos');assert.equal(rendered.viewId,'view-dashboard');assert.equal(rendered.params.section,'fondos');assert.equal(history.state.portalDepth,1);
 const previous=rendered;c.navegarPortal('fondos');assert.equal(rendered,previous);assert.equal(history.state.portalDepth,1);
 c.navegarPortal('nueva');assert.equal(history.state.viewId,'view-nueva');assert.equal(history.state.portalDepth,2);
});

test('el selector de fondo reserva pendientes y no convierte un fallo de saldo en cero',async()=>{
 const select={disabled:false,children:[],replaceChildren(...children){this.children=children;}};
 let failure=false,call=0;
 const c=ctx({currentUser:{id:'u'},document:{getElementById:id=>id==='nr-fondo'?select:{value:'Empresa'}},window:{RindeUI:{updateFormSummary(){}}},el:(tag,attrs,text)=>({tag,attrs,text}),fmtCLP:String,consultarTodas:async()=>{call++;if(call===1)return [{id:'f',folio:2,monto_solicitado:350000}];if(failure)throw Error('fallo');return [{solicitud_fondo_id:'f',estado:'Pendiente',monto_total:105131,monto_aprobado:40131},{solicitud_fondo_id:'f',estado:'Rechazado',monto_total:20000}];},console:{error(){}}});
 vm.runInContext(tramo('function resumirConsumoFondo(','async function cargarConsumoFondos('),c);
 vm.runInContext(tramo('let cargaSolicitudesDisponibles =','// El Centro de Costo'),c);
 await c.cargarSolicitudesDisponibles();assert.match(select.children[0].text,/Disponible 244869/);assert.match(select.children[0].text,/En revisión 65000/);
 failure=true;call=0;await c.cargarSolicitudesDisponibles();assert.equal(select.children[0].attrs.value,'');assert.match(select.children[0].text,/No se pudo comprobar/);assert.equal(select.disabled,false);
});
