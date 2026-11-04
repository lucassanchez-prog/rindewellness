// El borrador de "Nueva rendición" vive en localStorage, separado por usuario,
// para que recargar o cerrar la pestaña no pierda lo escrito. Estas pruebas
// cubren las reglas que no dependen de la pantalla: de quién es, cuánto dura,
// qué se ignora y cuándo NO se escribe.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const DIA=24*60*60*1000;

function preparar({usuario='u1',vistaActiva=true,enviando=false,campos={}}={}){
  const almacen=new Map();
  const localStorage={getItem:k=>almacen.has(k)?almacen.get(k):null,setItem:(k,v)=>almacen.set(k,String(v)),removeItem:k=>almacen.delete(k)};
  const ctx=vm.createContext({localStorage,clearTimeout:t=>clearTimeout(t),setTimeout:(f,ms)=>setTimeout(f,ms),currentUser:usuario?{id:usuario}:null,enviandoRendicion:enviando,
    document:{
      getElementById:id=>id==='view-nueva'?{classList:{contains:()=>vistaActiva}}:(id in campos?{value:campos[id]}:null),
      querySelectorAll:()=>[],
    }});
  const inicio=app.indexOf('const CLAVE_BORRADOR_RENDICION');
  vm.runInContext(app.slice(inicio,app.indexOf('function formularioTieneArchivos(',inicio)),ctx);
  return {ctx,almacen};
}
const borrador=(extra={})=>({version:1,guardado:new Date().toISOString(),items:[],comentario:'x',...extra});

test('el borrador se lee solo para su dueño',()=>{
  const {ctx,almacen}=preparar();
  almacen.set('rw-borrador-rendicion:u1',JSON.stringify(borrador()));
  assert.equal(ctx.leerBorradorRendicion().comentario,'x');
  ctx.currentUser={id:'u2'};
  assert.equal(ctx.leerBorradorRendicion(),null);
  assert.ok(almacen.has('rw-borrador-rendicion:u1'),'el borrador del otro usuario no se toca');
});

test('sin sesión no lee ni borra nada',()=>{
  const {ctx,almacen}=preparar({usuario:null});
  almacen.set('rw-borrador-rendicion:u1',JSON.stringify(borrador()));
  assert.equal(ctx.leerBorradorRendicion(),null);
  ctx.borrarBorradorRendicion();
  assert.equal(almacen.size,1);
});

test('ignora un borrador dañado, de otra versión o sin ítems',()=>{
  const {ctx,almacen}=preparar();
  for(const valor of ['{no es json',JSON.stringify(borrador({version:99})),JSON.stringify({version:1,guardado:new Date().toISOString()}),'null']){
    almacen.set('rw-borrador-rendicion:u1',valor);
    assert.equal(ctx.leerBorradorRendicion(),null,valor);
  }
});

test('descarta y borra un borrador de más de 30 días, pero conserva uno de 29',()=>{
  const {ctx,almacen}=preparar();
  almacen.set('rw-borrador-rendicion:u1',JSON.stringify(borrador({guardado:new Date(Date.now()-29*DIA).toISOString()})));
  assert.ok(ctx.leerBorradorRendicion());
  almacen.set('rw-borrador-rendicion:u1',JSON.stringify(borrador({guardado:new Date(Date.now()-31*DIA).toISOString()})));
  assert.equal(ctx.leerBorradorRendicion(),null);
  assert.equal(almacen.has('rw-borrador-rendicion:u1'),false);
});

test('borrarBorradorRendicion quita solo el del usuario actual',()=>{
  const {ctx,almacen}=preparar();
  almacen.set('rw-borrador-rendicion:u1',JSON.stringify(borrador()));
  almacen.set('rw-borrador-rendicion:u2',JSON.stringify(borrador()));
  ctx.borrarBorradorRendicion();
  assert.equal(almacen.has('rw-borrador-rendicion:u1'),false);
  assert.equal(almacen.has('rw-borrador-rendicion:u2'),true);
});

test('guardar escribe lo escrito, pero no si la pantalla no está activa ni mientras se envía',()=>{
  const activo=preparar({campos:{'nr-comentario':'Viaje'}});
  activo.ctx.guardarBorradorRendicion();
  assert.equal(JSON.parse(activo.almacen.get('rw-borrador-rendicion:u1')).comentario,'Viaje');
  for(const opciones of [{vistaActiva:false},{enviando:true}]){
    const p=preparar({campos:{'nr-comentario':'Viaje'},...opciones});
    p.ctx.guardarBorradorRendicion();
    assert.equal(p.almacen.size,0,JSON.stringify(opciones));
  }
});

test('un formulario en blanco no deja borrador y limpia el anterior',()=>{
  const {ctx,almacen}=preparar({campos:{'nr-comentario':'   '}});
  almacen.set('rw-borrador-rendicion:u1',JSON.stringify(borrador()));
  ctx.guardarBorradorRendicion();
  assert.equal(almacen.size,0);
});

test('si el almacenamiento falla, guardar no lanza error',()=>{
  const {ctx}=preparar({campos:{'nr-comentario':'Viaje'}});
  ctx.localStorage.setItem=()=>{throw new Error('QuotaExceededError');};
  assert.doesNotThrow(()=>ctx.guardarBorradorRendicion());
});
