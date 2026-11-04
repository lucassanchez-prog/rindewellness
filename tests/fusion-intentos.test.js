const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const modulo=n=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/'+n+'.ts')));

test('un intento parcial conserva los campos legibles y sus evidencias originales',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura');
 const previo={nombre_proveedor:'Comercio',fecha:'2026-09-25',monto:40000,monto_verificado:true,monto_origen:'palabras+digitos',monto_en_palabras:'cuarenta mil',evidencias:{monto:{texto:'TOTAL $40.000',caja:[1,2,3,4]}},verificacion_campos:{monto:{estado:'consistente'}}};
 const original=JSON.stringify(previo);
 const r=fusionarIntentosOcr(previo,{nombre_proveedor:null,fecha:null,monto:null,monto_verificado:false,monto_origen:null,monto_en_palabras:null,nro_documento:'108144',evidencias:{monto:{texto:''}},verificacion_campos:{monto:{estado:'ilegible'}}});
 assert.equal(r.nombre_proveedor,'Comercio');assert.equal(r.fecha,'2026-09-25');assert.equal(r.monto,40000);assert.equal(r.nro_documento,'108144');
 assert.equal(r.monto_verificado,true);assert.equal(r.monto_en_palabras,'cuarenta mil');assert.deepEqual(r.evidencias.monto,previo.evidencias.monto);assert.equal(r.verificacion_campos.monto.estado,'consistente');assert.equal(JSON.stringify(previo),original);
});

test('dos intentos contradictorios dejan vacío el campo y pendiente la revisión',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura'),{revisarCompletitud}=await modulo('estado-lectura');
 for(const [campo,a,b] of [['monto',40000,4000],['fecha','2026-09-25','2024-09-25'],['nro_documento','108144','108145'],['rut_proveedor','77.598.398-1','76.029.743-7']]){
  const base={tipo_documento:'Factura Electrónica',nombre_proveedor:'Comercio',monto:40000,fecha:'2026-09-25',rut_proveedor:'77.598.398-1',nro_documento:'108144'};
  const r=fusionarIntentosOcr({...base,[campo]:a},{[campo]:b});assert.equal(r[campo],null);assert(r.campos_discrepantes.includes(campo));
  const revision=revisarCompletitud(r,{...base,[campo]:a});assert.equal(revision.revision_estado,'parcial');assert(revision.campos_pendientes.includes(campo));
  if(campo==='monto'){assert.equal(r.monto_verificado,false);assert.equal(r.monto_discrepante,true);}
 }
});

test('formatos equivalentes de RUT y folio no se consideran contradicciones',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura');
 const r=fusionarIntentosOcr({rut_proveedor:'77.598.398-1',nro_documento:'00108144'},{rut_proveedor:'77598398-1',nro_documento:'108144'});
 assert.deepEqual(r.campos_discrepantes,[]);assert.equal(r.nro_documento,'108144');
});

test('un folio contradictorio de voucher requiere revisión aunque el folio sea opcional',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura'),{revisarCompletitud}=await modulo('estado-lectura');
 const r=fusionarIntentosOcr({tipo_documento:'Voucher',nombre_proveedor:'Comercio',monto:100,fecha:'2026-10-01',nro_documento:'123'},{nro_documento:'124'});
 const revision=revisarCompletitud(r);assert.equal(revision.revision_estado,'parcial');assert(revision.campos_pendientes.includes('nro_documento'));
});

test('una discrepancia sobrevive a un intento vacío o una única nueva lectura',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura');
 const previo={monto:null,monto_discrepante:true,fecha:null,campos_discrepantes:['fecha'],verificacion_campos:{fecha:{estado:'por_confirmar',motivo:'Dos lecturas discrepan'}}};
 for(const nuevo of [{monto:null,monto_discrepante:false},{monto:40000,fecha:'2026-09-25'}]){
  const r=fusionarIntentosOcr(previo,nuevo);assert.equal(r.monto,null);assert.equal(r.fecha,null);assert.equal(r.monto_discrepante,true);assert(r.campos_discrepantes.includes('fecha'));
 }
 const confirmado=fusionarIntentosOcr(previo,{monto:40000,fecha:'2026-09-25',verificacion_campos:{monto:{estado:'coincidente_lecturas'},fecha:{estado:'coincidente_lecturas'}}});
 assert.equal(confirmado.monto,40000);assert.equal(confirmado.fecha,'2026-09-25');assert.deepEqual(confirmado.campos_discrepantes,[]);
});

test('reemplazar un monto también reemplaza su evidencia y comprobación',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura');
 const r=fusionarIntentosOcr({monto:null,monto_verificado:true,monto_en_palabras:'dato antiguo'},{monto:40000,monto_verificado:false,monto_origen:'ia',monto_en_palabras:null,evidencias:{monto:{texto:'40000'}}});
 assert.equal(r.monto_verificado,false);assert.equal(r.monto_en_palabras,null);assert.equal(r.evidencias.monto.texto,'40000');
});

test('un documento que requiere separación no hereda campos del intento previo',async()=>{
 const {fusionarIntentosOcr}=await modulo('fusion-lectura');
 const r=fusionarIntentosOcr({monto:40000,nro_documento:'108144',nombre_proveedor:'Comercio'},{requiere_separacion:true,aviso_documento:'Separa los gastos.'});
 assert.equal(r.monto,null);assert.equal(r.nro_documento,null);assert.equal(r.nombre_proveedor,null);assert.equal(r.requiere_separacion,true);
});

test('recuperar solo la fecha cuenta como lectura útil, un JSON vacío no',async()=>{
 const anterior=globalThis.Deno;globalThis.Deno={env:{get:()=>undefined}};
 try{const {interpretarRespuestaOcr,tieneDatosUtiles}=await modulo('gemini-ocr');
  const respuesta=obj=>interpretarRespuestaOcr({candidates:[{content:{parts:[{text:JSON.stringify(obj)}]}}]});
  assert.equal(tieneDatosUtiles(respuesta({fecha:'2026-09-25'})),true);assert.equal(tieneDatosUtiles(respuesta({})),false);
 }finally{globalThis.Deno=anterior;}
});
