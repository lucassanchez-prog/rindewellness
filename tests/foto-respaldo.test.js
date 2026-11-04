const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const foto=require('../foto-comprobante.js'),{pendiente}=require('../revision-comprobante.js');
const modulo=nombre=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/'+nombre+'.ts')));
test('rectificación conserva píxeles de las cuatro esquinas y rechaza regiones inválidas',()=>{
 const data=new Uint8ClampedArray(4*4*4);for(let y=0;y<4;y++)for(let x=0;x<4;x++){const i=(y*4+x)*4;data[i]=x*60;data[i+1]=y*60;data[i+3]=255;}
 const r=foto.rectificar({width:4,height:4,data},[[0,0],[.75,0],[.75,.75],[0,.75]]);
 assert.equal(r.width,3);assert.equal(r.height,3);assert.equal(r.data[0],0);assert.equal(r.data[8],180);assert.equal(r.data[(8*4)+1],180);
 assert.equal(foto.homografia([[0,0],[0,0],[0,0],[0,0]]),null);
 for(const caja of [[0,0,1001,50],[1,2,0,5],[1,5,8,2],['1',2,5,8],null])assert.equal(foto.normalizarCaja(caja),null);
 assert.deepEqual(foto.normalizarCaja([200,300,600,800]),[200,300,600,800]);
});
test('detecta papel separado del fondo y conserva páginas blancas o fotos sin bordes claros',()=>{
 const imagen=(papel)=>{const data=new Uint8ClampedArray(100*100*4);for(let y=0;y<100;y++)for(let x=0;x<100;x++){const v=papel(x,y);data.set([v,v,v,255],(y*100+x)*4);}return {width:100,height:100,data};};
 const q=foto.detectarPapel(imagen((x,y)=>x>=15&&x<=85&&y>=10&&y<=90?245:30));assert(q);assert(Math.abs(q[0][0]-.15)<.01);assert(Math.abs(q[2][1]-.9)<.01);
 assert.equal(foto.detectarPapel(imagen(()=>255)),null);assert.equal(foto.detectarPapel(imagen((x,y)=>x>3&&y>3?255:30)),null);
});
test('campos corregidos manualmente salen de pendientes sin validar ciegamente la confianza de IA',()=>{
 assert.equal(pendiente({estado:'por_confirmar'},false),true);assert.equal(pendiente({estado:'ilegible'},true),false);assert.equal(pendiente({estado:'consistente'},false),false);assert.equal(pendiente({estado:'inventado'},false),true);
});
test('respaldo requiere clave, plan gratuito, activación y consentimiento; no transmite cuando falta uno',async()=>{
 const {habilitado,consultarGroq}=await modulo('respaldo-nube');const config={GROQ_API_KEY:'clave-prueba',GROQ_PLAN:'free',GROQ_OCR_ENABLED:'true',GROQ_OCR_CONSENT:'true'};
 assert(habilitado(config));for(const k of Object.keys(config)){const incompleto={...config};delete incompleto[k];assert(!habilitado(incompleto));await assert.rejects(consultarGroq('abc','image/png','prompt',incompleto,1000,()=>{throw Error('No debe enviar datos');}),/no está activado/);}
 assert(!habilitado({...config,GROQ_PLAN:'paid'}));
 await assert.rejects(consultarGroq('abc','application/pdf','p',config,1000,()=>{throw Error('No debe enviar PDF');}),/requiere una imagen/);
});
test('Groq devuelve el mismo formato verificable y su error no revela respuesta ni clave',async()=>{
 const {consultarGroq}=await modulo('respaldo-nube'),{demoraTransitoriaOcr}=await modulo('reintentos-ocr');const config={GROQ_API_KEY:'clave-prueba',GROQ_PLAN:'free',GROQ_OCR_ENABLED:'true',GROQ_OCR_CONSENT:'true'};let peticion;
 const r=await consultarGroq('YWJj','image/jpeg','solo datos',config,1000,async(url,opciones)=>{peticion={url,...opciones};return new Response(JSON.stringify({choices:[{message:{content:'{"monto":12300}'}}]}));});
 assert.equal(JSON.parse(r.candidates[0].content.parts[0].text).monto,12300);assert.equal(peticion.url,'https://api.groq.com/openai/v1/chat/completions');assert.equal(JSON.parse(peticion.body).messages[0].content[1].image_url.url,'data:image/jpeg;base64,YWJj');assert(JSON.parse(peticion.body).max_completion_tokens<=2048);
 for(const [status,demora] of [[429,3600000],[503,900000],[401,null]]){let error;try{await consultarGroq('abc','image/png','p',config,1000,async()=>new Response('clave-prueba secreto',{status}));}catch(e){error=e;}assert(error);assert(!error.message.includes('clave-prueba'));assert.equal(demoraTransitoriaOcr(error),demora);}
});
test('Groq respeta la espera temporal indicada por el proveedor sin revelar su respuesta',async()=>{
 const {consultarGroq}=await modulo('respaldo-nube'),{demoraTransitoriaOcr}=await modulo('reintentos-ocr');
 const config={GROQ_API_KEY:'clave-prueba',GROQ_PLAN:'free',GROQ_OCR_ENABLED:'true',GROQ_OCR_CONSENT:'true'};
 for(const [valor,esperado] of [['60',60000],['0',30000],['999999',86400000],['secreto-invalido',3600000]]){
  let error;try{await consultarGroq('abc','image/png','p',config,1000,async()=>new Response('datos privados',{status:429,headers:{'retry-after':valor}}));}catch(e){error=e;}
  assert(error);assert.equal(demoraTransitoriaOcr(error),esperado);assert(!error.message.includes('datos privados'));assert(!error.message.includes('secreto-invalido'));
 }
});
test('evidencia rechaza coordenadas fuera de la página y un RUT inválido',async()=>{
 const {verificarCampos}=await modulo('verificacion-ocr');const datos={rut_proveedor:'12.345.678-0',monto:500,evidencias:{rut_proveedor:{caja:[0,0,1001,50]},monto:{texto:'$500',caja:[500,20,600,500]}}};const r=verificarCampos(datos);assert.equal(datos.rut_proveedor,null);assert.equal(r.rut_proveedor.caja,null);assert.deepEqual(r.monto.caja,[500,20,600,500]);assert.equal(r.monto.estado,'por_confirmar');
});
test('el lector compartido recurre a Groq y aplica las mismas validaciones; desactivado no envía datos',async()=>{
 const previoDeno=globalThis.Deno,previoFetch=globalThis.fetch;const config={GROQ_API_KEY:'clave-prueba',GROQ_PLAN:'free',GROQ_OCR_ENABLED:'true',GROQ_OCR_CONSENT:'true'};let llamadas=0;
 globalThis.Deno={env:{get:k=>config[k]}};
 try{const {leerComprobante}=await modulo('gemini-ocr');globalThis.fetch=async(url)=>{llamadas++;assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({tipo_documento:'Factura Electrónica',nro_documento:'123',rut_proveedor:'12.345.678-0',monto:100000,monto_en_palabras:'doscientos mil'})}}]}));};
 const r=await leerComprobante(null,'abc','image/jpeg');assert.equal(r.proveedor_lectura,'groq');assert.equal(r.rut_proveedor,null);assert.equal(r.monto,null);assert.equal(r.monto_discrepante,true);assert.equal(llamadas,1);
 config.GROQ_OCR_ENABLED='false';await assert.rejects(leerComprobante(null,'abc','image/jpeg'),/GEMINI_API_KEY/);assert.equal(llamadas,1);
 }finally{globalThis.Deno=previoDeno;globalThis.fetch=previoFetch;}
});
