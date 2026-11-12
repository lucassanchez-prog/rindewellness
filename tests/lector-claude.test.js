// Claude es el lector principal de comprobantes (Haiku 5.5, medido el
// 2026-11-11 con 40 fotos reales). Gemini y Groq quedan de respaldo. Estas
// pruebas fijan: que Claude va primero solo si está activado, que su lectura
// pasa por la misma validación, y que si falla (cupo, cuenta sin crédito) se
// enfría y la persona igual recibe una lectura del respaldo.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const modulo=(n)=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/'+n+'.ts')).href);

const lectura={tipo_documento:'Factura Electrónica',nro_documento:'123',rut_proveedor:'12.345.678-5',nombre_proveedor:'Ferretería Sur',fecha:'2026-11-03',monto:12495};
const json=(estado,cuerpo)=>new Response(JSON.stringify(cuerpo),{status:estado,headers:{'Content-Type':'application/json'}});
const geminiOk=()=>json(200,{candidates:[{content:{parts:[{text:JSON.stringify(lectura)}]},finishReason:'STOP'}]});
const claudeOk=(datos=lectura)=>({stop_reason:'end_turn',content:[{type:'thinking',thinking:''},{type:'text',text:'```json\n'+JSON.stringify(datos)+'\n```'}]});
const errorApi=(status,mensaje,cabeceras={})=>Object.assign(new Error(mensaje),{status,headers:new Headers(cabeceras)});

function preparar(config={}){
  const ambiente={GEMINI_API_KEY:'clave-gemini',CLAUDE_OCR_ENABLED:'true',ANTHROPIC_API_KEY:'clave-claude',...config};
  const previo={deno:globalThis.Deno,fetch:globalThis.fetch,cliente:globalThis.__clienteClaudePrueba};
  globalThis.Deno={env:{get:k=>ambiente[k]}};
  const estados=new Map(),rpcs=[],llamadas={claude:[],gemini:0};
  const admin={
    from:()=>{const api={_modelos:null,_uno:null,
      select(){return api;},in(_c,lista){api._modelos=lista;return api;},eq(_c,valor){api._uno=valor;return api;},
      maybeSingle:async()=>({data:estados.has(api._uno)?{disponible_desde:estados.get(api._uno)}:null,error:null}),
      then:(ok,ko)=>Promise.resolve({data:[...estados].filter(([m])=>!api._modelos||api._modelos.includes(m)).map(([modelo,d])=>({modelo,disponible_desde:d,intentos_ok:0,intentos_fail:0,ultimo_resultado:null,ultimo_intento:null})),error:null}).then(ok,ko)};
      return api;},
    rpc:async(nombre,args)=>{rpcs.push({nombre,...args});
      if(args.p_exito)estados.delete(args.p_modelo);else if(args.p_enfriamiento)estados.set(args.p_modelo,args.p_enfriamiento);
      return {error:null};},
  };
  const simular=({claude,gemini=geminiOk})=>{
    globalThis.__clienteClaudePrueba=(cfg,timeoutMs)=>({messages:{create:async(body)=>{llamadas.claude.push({body,cfg,timeoutMs});return claude(body);}}});
    globalThis.fetch=async(url)=>{if(String(url).includes('generativelanguage')){llamadas.gemini++;return gemini();}throw new Error('fetch inesperado: '+url);};
  };
  const restaurar=()=>{globalThis.Deno=previo.deno;globalThis.fetch=previo.fetch;globalThis.__clienteClaudePrueba=previo.cliente;};
  return {admin,estados,rpcs,llamadas,simular,restaurar};
}
const fila=(rpcs,modelo)=>rpcs.filter(r=>r.p_modelo===modelo).at(-1);
const minutos=(iso)=>(Date.parse(iso)-Date.now())/60000;

test('Claude lee primero con Haiku, la misma instrucción y la foto, y Gemini no se llama',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({claude:()=>claudeOk()});
    const r=await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(r.proveedor_lectura,'claude');
    assert.equal(r.monto,12495);assert.equal(r.nro_documento,'123');
    assert.equal(p.llamadas.gemini,0,'no gasta el respaldo');
    const {body,timeoutMs}=p.llamadas.claude[0];
    assert.equal(body.model,'claude-haiku-5-5');
    assert.deepEqual(body.output_config,{effort:'medium'});
    assert.equal(body.temperature,undefined,'sin parámetros de muestreo');
    assert.deepEqual(body.messages[0].content[0],{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'abc'}});
    assert.match(body.messages[0].content[1].text,/^Eres un asistente que extrae datos/);
    assert.ok(timeoutMs<=18000,'en vivo deja tiempo para un respaldo');
    assert.equal(fila(p.rpcs,'claude').p_exito,true);
  }finally{p.restaurar();}
});

test('la lectura de Claude pasa por la misma validación: total en letras que no calza deja el monto vacío',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({claude:()=>claudeOk({...lectura,monto:100000,monto_en_palabras:'doscientos mil',categoria_sugerida:'Inventada'})});
    const r=await leerComprobante(p.admin,'abc','image/png');
    assert.equal(r.proveedor_lectura,'claude');
    assert.equal(r.monto,null);assert.equal(r.monto_discrepante,true);
    assert.equal(r.categoria_sugerida,null,'una categoría fuera del catálogo se descarta');
  }finally{p.restaurar();}
});

test('Claude saturado: lee Gemini, Claude se enfría lo que pidió y la siguiente lectura ni lo llama',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({claude:()=>{throw errorApi(429,'rate limited',{'retry-after':'120'});}});
    const r=await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(r.proveedor_lectura,'gemini');
    const reg=fila(p.rpcs,'claude');
    assert.equal(reg.p_exito,false);
    assert.ok(minutos(reg.p_enfriamiento)>1.8&&minutos(reg.p_enfriamiento)<2.2,'enfría 120 s');
    await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(p.llamadas.claude.length,1,'no vuelve a llamar a Claude en enfriamiento');
    assert.equal(p.llamadas.gemini,2);
  }finally{p.restaurar();}
});

test('cuenta de Claude sin crédito: se enfría una hora y la persona igual recibe la lectura de Gemini',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({claude:()=>{throw errorApi(400,'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');}});
    const r=await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(r.proveedor_lectura,'gemini');
    const m=minutos(fila(p.rpcs,'claude').p_enfriamiento);
    assert.ok(m>55&&m<65,'esperado ~60 min, fue '+m);
  }finally{p.restaurar();}
});

test('sin activar, o sin llave, Claude no se llama; un PDF va como documento',async()=>{
  for(const config of [{CLAUDE_OCR_ENABLED:'false'},{ANTHROPIC_API_KEY:''}]){
    const p=preparar(config);
    try{
      const {leerComprobante}=await modulo('gemini-ocr');
      p.simular({claude:()=>claudeOk()});
      const r=await leerComprobante(p.admin,'abc','image/jpeg');
      assert.equal(r.proveedor_lectura,'gemini');assert.equal(p.llamadas.claude.length,0);
    }finally{p.restaurar();}
  }
  const p=preparar({CLAUDE_OCR_MODEL:'claude-sonnet-5-5'});
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({claude:()=>claudeOk()});
    await leerComprobante(p.admin,'JVBERi0','application/pdf');
    const {body}=p.llamadas.claude[0];
    assert.equal(body.model,'claude-sonnet-5-5','el modelo se cambia con CLAUDE_OCR_MODEL');
    assert.deepEqual(body.messages[0].content[0],{type:'document',source:{type:'base64',media_type:'application/pdf',data:'JVBERi0'}});
  }finally{p.restaurar();}
});

test('el agente en segundo plano sigue mientras Claude o Gemini tengan cupo, y se pausa si ninguno',async()=>{
  const p=preparar({GEMINI_MODELS_ORDEN:'gemini-x'});
  try{
    const {proveedoresDisponibles}=await modulo('gemini-ocr');
    const futuro=new Date(Date.now()+600000).toISOString();
    p.estados.set('claude',futuro);
    assert.equal((await proveedoresDisponibles(p.admin)).disponible,true,'Gemini sigue disponible');
    for(const m of ['gemini-3.8-flash','gemini-3.5-flash-lite','gemini-3.5-flash','gemini-flash-latest','gemini-3.7-flash','gemini-3.6-flash','gemini-x'])p.estados.set(m,futuro);
    assert.equal((await proveedoresDisponibles(p.admin)).disponible,false);
  }finally{p.restaurar();}
});
