const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module'),{pathToFileURL}=require('node:url');
const fuente=fs.readFileSync(path.join(__dirname,'../supabase/functions/ocr-reintento-pendientes/index.ts'),'utf8');
test('el agente conserva la lectura parcial y reintenta solo los huecos con presupuesto acotado',async()=>{
 const {revisarCompletitud,estadoTrasIntento}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/estado-lectura.ts')));
 const estados=[],enfoques=[];let llamada=0,actual={tipo_item:'SinDocumento',monto:12000,fecha_vencimiento:null};
 const admin={storage:{from:()=>({download:async()=>({data:new Blob(['foto'],{type:'image/jpeg'}),error:null})})},from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:actual,error:null}),update:c=>{estados.push(c);actual={...actual,...c};return q;},then:resolve=>resolve({data:[{id:'i'}],error:null})};return q;}};
 const c=vm.createContext({console:{error(){}},Blob,Date,Object,Error,MAX_INTENTOS:2,revisarCompletitud,estadoTrasIntento,PRESUPUESTO_SEGUNDO_PLANO:{},rutaPropia:()=>true,arrayBufferToBase64:()=> 'Zm90bw==',mimeTypeDesdeNombre:()=> 'image/jpeg',tieneDatosUtiles:()=>true,demoraTransitoriaOcr:()=>null,leerComprobante:async(a,b,m,p,e)=>{enfoques.push(e);return ++llamada===1?{tipo_documento:'Voucher',nombre_proveedor:'Comercio'}:{fecha:'2026-10-01'};}});
 const a=fuente.indexOf('const CAMPOS_OCR ='),b=fuente.indexOf('const COL_ITEMS',a);vm.runInContext(stripTypeScriptTypes(fuente.slice(a,b)),c);
 const col={estado:'ocr_reintento_estado',resultado:'ocr_reintento_resultado',intentos:'ocr_reintento_intentos',ultimo:'ocr_reintento_ultimo'};
 await c.procesarPendiente(admin,'rendicion_items','i','u/foto',0,col,null,'u','reserva');
 assert.equal(estados[0].ocr_reintento_estado,'pendiente');assert.equal(estados[0].ocr_reintento_resultado.revision_estado,'parcial');assert.equal(estados[0].ocr_reintento_intentos,1);assert(Date.parse(estados[0].ocr_lease_hasta)>Date.now());
 await c.procesarPendiente(admin,'rendicion_items','i','u/foto',1,col,null,'u','reserva');
 assert.equal(estados[1].ocr_reintento_estado,'listo');assert.equal(estados[1].ocr_reintento_resultado.nombre_proveedor,'Comercio');assert.equal(estados[1].ocr_reintento_resultado.fecha,'2026-10-01');assert(!enfoques[1].camposFaltantes.includes('nombre_proveedor'));
});
