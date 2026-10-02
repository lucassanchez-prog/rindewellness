const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const data=require('../data-access.js');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const esperar=async p=>await p;
function adjunto(nombre){return {_fotoInput:{files:[new File(['archivo'],nombre)]},monto:100,tipo_item:'SinDocumento'};}

test('subida parcial aborta todo y conserva adjuntos buenos para el reintento',async()=>{
  let falla=true;const subidos=[];const db={storage:{from:()=>({upload:async(path,file)=>{subidos.push(file.name);return {error:file.name==='b.pdf'&&falla?{message:'sin red'}:null};}})}};
  const items=[adjunto('a.pdf'),adjunto('b.pdf')],cache=new Map();
  await assert.rejects(data.prepararAdjuntos(db,items,'usuario','envio',cache,esperar),/Ítem 2.*conserva/);
  assert.equal(cache.size,1);assert.equal(items[0]._fotoInput.files[0].name,'a.pdf');
  falla=false;const listos=await data.prepararAdjuntos(db,items,'usuario','envio',cache,esperar);
  assert.deepEqual(subidos,['a.pdf','b.pdf','b.pdf']);assert.equal(listos.length,2);assert(listos.every(i=>i.adjunto_url.startsWith('usuario/envio-')));assert(!('_fotoInput' in listos[0]));
});

test('subida que no termina vence sin producir una rendición parcial',async()=>{
  const db={storage:{from:()=>({upload:()=>new Promise(()=>{})})}};
  let rpc=false;db.rpc=()=>{rpc=true;};
  const vencer=async(_p,_ms,mensaje)=>{throw Error(mensaje);};
  await assert.rejects(data.prepararAdjuntos(db,[adjunto('a.pdf')],'u','r',new Map(),vencer),/formulario se conserva/);
  assert.equal(rpc,false);
});

test('respuesta perdida permite reenviar el mismo identificador y recibir el envío anterior',async()=>{
  const ids=[];let intento=0;const db={rpc:async(name,args)=>{assert.equal(name,'crear_rendicion_completa');ids.push(args.p_cabecera.id);return ++intento===1?{error:Error('respuesta perdida')}:{data:{rendicion:{id:'r'},items:[{id:'i'}],reutilizada:true},error:null};}};
  await assert.rejects(data.guardarRendicionCompleta(db,{id:'r'},[{monto:100}]),/perdida/);
  assert.equal((await data.guardarRendicionCompleta(db,{id:'r'},[{monto:100}])).reutilizada,true);
  assert.deepEqual(ids,['r','r']);
});

test('respuesta parcial del servidor no muestra un éxito',async()=>{
  await assert.rejects(data.guardarRendicionCompleta({rpc:async()=>({data:{rendicion:{id:'r'},items:[{id:'a'}],reutilizada:false}})},{id:'r'},[{},{}]),/envío completo/);
});

test('el lector PDF deshabilita ejecución dinámica al renderizar documentos externos',()=>{
  let opciones;const tarea={promise:Promise.resolve()};const bytes=new Uint8Array([1,2]);
  assert.equal(data.abrirPdfSeguro({getDocument:x=>{opciones=x;return tarea;}},bytes),tarea);
  assert.equal(opciones.isEvalSupported,false);assert.equal(opciones.data,bytes);
});

test('un error de perfil mantiene cerrado el acceso y no intenta recrearlo',async()=>{
  let insertado=false;const nodes=new Map();const ctx=vm.createContext({console:{error(){}},currentUser:null,currentProfile:{rol:'admin'},db:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null,error:Error('red')})})}),insert:()=>{insertado=true;}})},document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,{style:{display:'block'}});return nodes.get(id);}},toast(){},show(){}});
  vm.runInContext(app.slice(app.indexOf('async function onLoggedIn('),app.indexOf('// Las cuentas permitidas')),ctx);
  await ctx.onLoggedIn({id:'u'});assert.equal(ctx.currentProfile,null);assert.equal(nodes.get('app-shell').style.display,'none');assert.equal(insertado,false);
});

test('una lectura de perfil que llega después de cerrar sesión no abre la aplicación',async()=>{
  let resolver,consultas=0;const ctx=vm.createContext({currentUser:null,currentProfile:null,db:{from:()=>{consultas++;return {select:()=>({eq:()=>({maybeSingle:()=>new Promise(r=>resolver=r)})})};}}});
  vm.runInContext(app.slice(app.indexOf('async function onLoggedIn('),app.indexOf('// Las cuentas permitidas')),ctx);
  const login=ctx.onLoggedIn({id:'u'});ctx.currentUser=null;resolver({data:{id:'u',rol:'admin'},error:null});await login;assert.equal(ctx.currentProfile,null);assert.equal(consultas,1);
});

function contextoEnvio(fallar){
  const elementos=new Map(),mensajes=[],rpc=[],notificaciones=[];
  function campo(id,value=''){const n={value,files:[],disabled:false,innerHTML:'',textContent:''};elementos.set(id,n);return n;}
  for(const [id,val] of Object.entries({'nr-fecha':'2026-09-24','nr-tipo':'Reembolso','nr-comentario':'Prueba','nr-empresa':'Prueba','nr-cc':'Casa Matriz'}))campo(id,val);
  campo('btn-guardar-rendicion');
  const cards=['a','b'].map(id=>({id,querySelector:()=>({classList:{contains:()=>false}})}));
  for(const {id} of cards){for(const suf of ['rut2','tipodoc2','folio2','fecha2','cuenta','categoria','desc2','cc','nombreprov2'])campo(`${id}-${suf}`);campo(`${id}-monto2`,'100');campo(`${id}-foto2`).files=[new File(['foto'],`${id}.pdf`)];}
  const db={storage:{from:()=>({upload:async(_path,file)=>({error:fallar&&file.name==='b.pdf'?{message:'sin red'}:null})})},rpc:async(name,args)=>{rpc.push(name);return {data:{rendicion:{id:args.p_cabecera.id},items:args.p_items,reutilizada:false},error:null};}};
  const ctx=vm.createContext({crypto,currentUser:{id:'u'},envioRendicionId:'envio-estable',enviandoRendicion:false,adjuntosBorrador:new Map(),db,
    document:{querySelector:()=>null,querySelectorAll:()=>cards,getElementById:id=>elementos.get(id)},ocrBloqueado:new Set(),ocrOrigen:new Map(),
    conflictosSinConfirmar:()=>[],parseMoneyValue:Number,validarRut:()=>true,estadoReintentoOcr:()=>null,montoSigueVerificado:()=>false,documentosDuplicados:()=>[],
    window:{RindeCore:{claveDocumento:()=>null},RindeData:data},conTimeout:esperar,toast:m=>mensajes.push(m),mensajeErrorAmigable:e=>e.message,
    notificarAsync:name=>notificaciones.push(name),replaceView(){},loadDashboard(){}});
  vm.runInContext(app.slice(app.indexOf('async function submitRendicion()'),app.indexOf('// Solicitudes de fondos por rendir')),ctx);
  return {ctx,elementos,mensajes,rpc,notificaciones};
}

test('el flujo real conserva el formulario y no notifica ni guarda si falla el segundo archivo',async()=>{
  const t=contextoEnvio(true);await t.ctx.submitRendicion();
  assert.equal(t.rpc.length,0);assert.equal(t.notificaciones.length,0);assert.equal(t.ctx.envioRendicionId,'envio-estable');
  assert.equal(t.elementos.get('a-monto2').value,'100');assert.equal(t.elementos.get('btn-guardar-rendicion').disabled,false);assert.equal(t.ctx.enviandoRendicion,false);assert.match(t.mensajes[0],/Ítem 2.*conserva/);
});

test('el flujo real guarda todos los gastos una vez y bloquea doble clic concurrente',async()=>{
  const t=contextoEnvio(false);await Promise.all([t.ctx.submitRendicion(),t.ctx.submitRendicion()]);
  assert.deepEqual(t.rpc,['crear_rendicion_completa']);assert.deepEqual(t.notificaciones,['notificar-aprobador']);assert.match(t.mensajes[0],/completa/);assert.equal(t.ctx.adjuntosBorrador.size,0);
});

test('un error al consultar cuentas permitidas no las convierte en acceso sin restricción',async()=>{
  const ctx=vm.createContext({currentUser:{id:'u'},currentProfile:{},cuentasPermitidas:null,db:{from:()=>({select:()=>({eq:async()=>({data:null,error:Error('red')})})})}});
  vm.runInContext(app.slice(app.indexOf('async function cargarCuentasPermitidas()'),app.indexOf('// Dashboard')),ctx);
  await assert.rejects(ctx.cargarCuentasPermitidas(),/red/);assert.equal(ctx.cuentasPermitidas.size,0);
});

test('un resultado tardío de cuentas no reemplaza los permisos de otra sesión',async()=>{
  let resolver;const ctx=vm.createContext({currentUser:{id:'u'},currentProfile:{},cuentasPermitidas:null,db:{from:()=>({select:()=>({eq:()=>new Promise(r=>resolver=r)})})}});
  vm.runInContext(app.slice(app.indexOf('async function cargarCuentasPermitidas()'),app.indexOf('// Dashboard')),ctx);
  const carga=ctx.cargarCuentasPermitidas();ctx.currentUser={id:'otro'};ctx.cuentasPermitidas=new Set(['nueva']);resolver({data:[{cuenta_cod:'antigua'}],error:null});await carga;assert.deepEqual([...ctx.cuentasPermitidas],['nueva']);
});
