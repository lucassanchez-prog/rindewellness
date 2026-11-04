// Los dos proveedores gratuitos de IA (Gemini y el respaldo Groq) se agotan. Estas
// pruebas fijan lo que el servidor debe hacer cuando eso pasa: no insistirle a
// quien ya dijo que no tiene cupo, fallar rápido con un mensaje claro, y que el
// agente en segundo plano se pause solo mientras no quede ninguno.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const modulo=(n,sufijo='')=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/'+n+'.ts')).href+sufijo);

const respuesta=(estado,cuerpo,cabeceras={})=>new Response(JSON.stringify(cuerpo),{status:estado,headers:{'Content-Type':'application/json',...cabeceras}});
const lectura={tipo_documento:'Factura Electrónica',nro_documento:'123',rut_proveedor:'12.345.678-5',nombre_proveedor:'Ferretería Sur',fecha:'2026-11-03',monto:12495};
const geminiOk=()=>respuesta(200,{candidates:[{content:{parts:[{text:JSON.stringify(lectura)}]},finishReason:'STOP'}]});
const geminiCuota=()=>respuesta(429,{error:{code:429,message:'You exceeded your current quota, please check your plan and billing details.',status:'RESOURCE_EXHAUSTED'}});
const groqOk=()=>respuesta(200,{choices:[{message:{content:JSON.stringify(lectura)}}]});
const groqLimite=(retryAfter)=>new Response('{}',{status:429,headers:retryAfter?{'retry-after':retryAfter}:{}});

function preparar(config={}){
  const ambiente={GEMINI_API_KEY:'clave-gemini',GROQ_API_KEY:'clave-groq',GROQ_PLAN:'free',GROQ_OCR_ENABLED:'true',GROQ_OCR_CONSENT:'true',...config};
  const previoDeno=globalThis.Deno,previoFetch=globalThis.fetch;
  globalThis.Deno={env:{get:k=>ambiente[k]}};
  const estados=new Map(),rpcs=[],llamadas={gemini:[],groq:0};
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
  const simular=({gemini=geminiCuota,groq=groqLimite})=>{
    globalThis.fetch=async(url)=>{
      const u=String(url);
      if(u.includes('generativelanguage')){llamadas.gemini.push(u);return gemini(u);}
      if(u.includes('api.groq.com')){llamadas.groq++;return groq();}
      throw new Error('fetch inesperado: '+u);
    };
  };
  const restaurar=()=>{globalThis.Deno=previoDeno;globalThis.fetch=previoFetch;};
  return {admin,estados,rpcs,llamadas,simular,restaurar};
}
const enSegundos=(iso)=>(Date.parse(iso)-Date.now())/1000;
const fila=(rpcs,modelo)=>rpcs.filter(r=>r.p_modelo===modelo).at(-1);

test('Groq sin cupo queda en enfriamiento con su retry-after, y la siguiente lectura ni lo llama',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({groq:()=>groqLimite('120')});
    await assert.rejects(leerComprobante(p.admin,'abc','image/jpeg'),/límite gratuito/);
    const registro=fila(p.rpcs,'groq');
    assert.equal(registro.p_exito,false);
    assert.ok(enSegundos(registro.p_enfriamiento)>100&&enSegundos(registro.p_enfriamiento)<130,'enfría lo que pidió Groq (120 s)');
    assert.equal(p.llamadas.groq,1);

    const antes=p.llamadas.groq;
    const error=await leerComprobante(p.admin,'abc','image/jpeg').catch(e=>e);
    assert.match(error.message,/límite gratuito/);
    assert.match(error.message,/a mano/);
    assert.equal(p.llamadas.groq,antes,'no vuelve a llamar a Groq mientras está en enfriamiento');
    assert.ok(error.retryAfterMs>=30000&&error.retryAfterMs<=120000,'dice cuánto falta para reintentar');
  }finally{p.restaurar();}
});

test('sin retry-after, Groq se enfría 5 minutos',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({groq:()=>groqLimite()});
    await assert.rejects(leerComprobante(p.admin,'abc','image/jpeg'),/límite gratuito/);
    const minutos=enSegundos(fila(p.rpcs,'groq').p_enfriamiento)/60;
    assert.ok(minutos>4&&minutos<6,'esperado ~5 min, fue '+minutos);
  }finally{p.restaurar();}
});

test('un éxito de Groq se registra, limpia su enfriamiento vencido y devuelve la lectura',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.estados.set('groq',new Date(Date.now()-1000).toISOString());
    p.simular({groq:groqOk});
    const r=await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(r.proveedor_lectura,'groq');
    assert.equal(r.monto,12495);
    assert.equal(fila(p.rpcs,'groq').p_exito,true);
    assert.equal(p.estados.has('groq'),false);
  }finally{p.restaurar();}
});

test('un error de Groq que no es de límite no lo deja en enfriamiento',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({groq:()=>new Response('{}',{status:500})});
    await assert.rejects(leerComprobante(p.admin,'abc','image/jpeg'),/no está disponible/);
    assert.equal(fila(p.rpcs,'groq').p_enfriamiento,null);
  }finally{p.restaurar();}
});

test('Groq no se usa con un PDF, y no se toca su enfriamiento',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    p.simular({});
    await assert.rejects(leerComprobante(p.admin,'abc','application/pdf'));
    assert.equal(p.llamadas.groq,0);
    assert.equal(fila(p.rpcs,'groq'),undefined);
  }finally{p.restaurar();}
});

test('un modelo de Gemini que no existe se salta y queda horas en enfriamiento; el obsoleto ya no se prueba',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    const noExiste=(u)=>u.includes('gemini-3.8-flash:')
      ?respuesta(404,{error:{code:404,message:'models/gemini-3.8-flash is not found for API version v1beta, or is not supported for generateContent.',status:'NOT_FOUND'}})
      :geminiOk();
    p.simular({gemini:noExiste});
    const r=await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(r.proveedor_lectura,'gemini');
    assert.ok(p.llamadas.gemini[0].includes('gemini-3.8-flash:'),'empieza por el flash vigente');
    assert.ok(p.llamadas.gemini[1].includes('gemini-3.5-flash-lite:'),'sigue con el lite de alto volumen');
    assert.equal(p.llamadas.gemini.some(u=>u.includes('gemini-3.6-flash')),false,'el obsoleto no está en la lista');
    const horas=enSegundos(fila(p.rpcs,'gemini-3.8-flash').p_enfriamiento)/3600;
    assert.ok(horas>5&&horas<7,'enfriado ~6 horas, fue '+horas);
  }finally{p.restaurar();}
});

const MODELOS=['gemini-3.8-flash','gemini-3.5-flash-lite','gemini-3.5-flash','gemini-flash-latest','gemini-3.7-flash','gemini-3.6-flash'];

test('si los modelos nuevos no responden, la lista llega hasta los antiguos, que quedan de último recurso',async()=>{
  const p=preparar();
  try{
    const {leerComprobante}=await modulo('gemini-ocr');
    const soloElUltimo=(u)=>u.includes('gemini-3.6-flash:')?geminiOk():respuesta(404,{error:{code:404,message:'models/x is not found for API version v1beta, or is not supported for generateContent.',status:'NOT_FOUND'}});
    p.simular({gemini:soloElUltimo});
    const r=await leerComprobante(p.admin,'abc','image/jpeg');
    assert.equal(r.proveedor_lectura,'gemini');
    assert.deepEqual(p.llamadas.gemini.map(u=>/models\/([^:]+):/.exec(u)[1]),MODELOS);
    assert.equal(p.llamadas.groq,0,'Groq no hizo falta');
    // y a la lectura siguiente los inexistentes ya no se vuelven a llamar
    p.llamadas.gemini.length=0;
    await leerComprobante(p.admin,'abc','image/jpeg');
    assert.deepEqual(p.llamadas.gemini.map(u=>/models\/([^:]+):/.exec(u)[1]),['gemini-3.6-flash']);
  }finally{p.restaurar();}
});

test('proveedoresDisponibles: hay cupo, sin estadísticas, o solo Gemini enfriado',async()=>{
  const p=preparar();
  try{
    const {proveedoresDisponibles}=await modulo('gemini-ocr');
    assert.deepEqual(await proveedoresDisponibles(p.admin),{disponible:true,hasta:null});
    const futuro=new Date(Date.now()+3600e3).toISOString();
    for(const m of MODELOS)p.estados.set(m,futuro);
    assert.equal((await proveedoresDisponibles(p.admin)).disponible,true,'Groq sigue libre');
    assert.deepEqual(await proveedoresDisponibles(null),{disponible:true,hasta:null});
  }finally{p.restaurar();}
});

test('proveedoresDisponibles: con todos en enfriamiento informa cuándo vuelve el primero',async()=>{
  const p=preparar();
  try{
    const {proveedoresDisponibles}=await modulo('gemini-ocr');
    const horas=h=>new Date(Date.now()+h*3600e3).toISOString();
    MODELOS.forEach((m,i)=>p.estados.set(m,horas(2+i)));
    p.estados.set('groq',horas(1));
    const r=await proveedoresDisponibles(p.admin);
    assert.equal(r.disponible,false);
    assert.ok(Math.abs(enSegundos(r.hasta)-3600)<5,'vuelve en 1 hora (Groq)');
    p.estados.set('groq',horas(-1));
    assert.equal((await proveedoresDisponibles(p.admin)).disponible,true,'Groq ya se liberó');
  }finally{p.restaurar();}
});

test('proveedoresDisponibles: sin Groq habilitado cuenta solo Gemini, y ante un error de consulta no frena',async()=>{
  const p=preparar({GROQ_OCR_ENABLED:'false'});
  try{
    const {proveedoresDisponibles}=await modulo('gemini-ocr');
    const futuro=new Date(Date.now()+3600e3).toISOString();
    for(const m of MODELOS)p.estados.set(m,futuro);
    assert.equal((await proveedoresDisponibles(p.admin)).disponible,false);
    const roto={from:()=>({select:()=>({in:async()=>({data:null,error:{message:'sin conexión'}})})})};
    assert.deepEqual(await proveedoresDisponibles(roto),{disponible:true,hasta:null});
  }finally{p.restaurar();}
});

test('proveedoresDisponibles: sin ningún proveedor configurado no frena, para que se vea el error real',async()=>{
  const p=preparar({GEMINI_API_KEY:undefined,GROQ_OCR_ENABLED:'false'});
  try{
    const {proveedoresDisponibles}=await modulo('gemini-ocr','?sin-clave');
    assert.deepEqual(await proveedoresDisponibles(p.admin),{disponible:true,hasta:null});
  }finally{p.restaurar();}
});
