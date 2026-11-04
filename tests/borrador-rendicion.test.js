// Autoguardado de "Nueva rendición" sobre el módulo de borradores: cada
// rendición en curso tiene su propio borrador (con id en la URL), se guarda solo
// si se escribió algo y caduca a la semana. Estas pruebas cubren las reglas que
// no dependen de la pantalla: cuándo se guarda, cuándo NO, y qué pasa si falla.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const modulo=require('../borradores.js');

const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const DIA=24*60*60*1000;

function preparar({usuario='u1',vistaActiva=true,enviando=false,campos={},hash='#nueva'}={}){
  const memoria=new Map(),insignias=[],reemplazos=[];
  const localStorage={getItem:k=>memoria.has(k)?memoria.get(k):null,setItem:(k,v)=>memoria.set(k,String(v)),removeItem:k=>memoria.delete(k)};
  const reloj={ahora:Date.UTC(2026,10,4,12,0,0)};
  // El módulo usa el reloj que le pasemos: así se prueba la caducidad sin esperar una semana.
  const conReloj={...modulo,crearAlmacen:(opciones)=>modulo.crearAlmacen({...opciones,ahora:()=>reloj.ahora})};
  const ctx=vm.createContext({
    clearTimeout:t=>clearTimeout(t),setTimeout:(f,ms)=>setTimeout(f,ms),
    currentUser:usuario?{id:usuario}:null,enviandoRendicion:enviando,
    location:{hash},history:{state:{portalDepth:2},replaceState:(estado,_t,url)=>{reemplazos.push({estado,url});ctx.location.hash=url;}},
    window:{RindeBorradores:conReloj,localStorage,RindeUI:{setBadge:(ruta,n)=>insignias.push([ruta,n])}},
    document:{
      getElementById:id=>id==='view-nueva'?{classList:{contains:()=>vistaActiva}}:(id in campos?{value:campos[id]}:null),
      querySelectorAll:()=>[],
    },
  });
  const inicio=app.indexOf('let restaurandoBorrador = false;');
  // "borradorActualId" es un let de app.js: se fija con una función definida junto al código bajo prueba.
  vm.runInContext(app.slice(inicio,app.indexOf('function formularioTieneArchivos(',inicio))+'\nfunction __poner(valor){borradorActualId=valor;}',ctx);
  const poner=(id)=>ctx.__poner(id);
  const almacen=conReloj.crearAlmacen({storage:localStorage});
  return {ctx,memoria,insignias,reemplazos,reloj,poner,almacen};
}

test('escribir algo crea el borrador, pone su id en la URL y actualiza el contador del menú',()=>{
  const p=preparar({campos:{'nr-comentario':'Viaje','nr-empresa':'Dmoov SpA'}});
  p.poner('b1');
  p.ctx.guardarBorradorRendicion();
  const e=p.almacen.obtener('u1','b1');
  assert.equal(e.datos.comentario,'Viaje');assert.equal(e.datos.empresa,'Dmoov SpA');
  assert.equal(p.reemplazos.at(-1).url,'#nueva/b1');
  assert.deepEqual(p.insignias.at(-1),['borradores',1]);
});

test('guardar sin cambios (abrir el borrador, un foco) no renueva su semana; una edición sí',()=>{
  const p=preparar({campos:{'nr-comentario':'Viaje'}});
  p.poner('b1');p.ctx.guardarBorradorRendicion();
  const primera=p.almacen.obtener('u1','b1').actualizado;
  p.reloj.ahora+=3*DIA;
  p.ctx.guardarBorradorRendicion();
  assert.equal(p.almacen.obtener('u1','b1').actualizado,primera,'sin cambios: misma fecha de edición');
  p.ctx.document.getElementById=id=>id==='view-nueva'?{classList:{contains:()=>true}}:(id==='nr-comentario'?{value:'Viaje a terreno'}:null);
  p.ctx.guardarBorradorRendicion();
  assert.notEqual(p.almacen.obtener('u1','b1').actualizado,primera,'con un cambio: se renueva');
  p.reloj.ahora+=6*DIA;
  assert.ok(p.almacen.obtener('u1','b1'),'6 días después de la edición sigue vigente');
});

test('la URL no se reescribe si ya apunta a ese borrador',()=>{
  const p=preparar({campos:{'nr-comentario':'Viaje'},hash:'#nueva/b1'});
  p.poner('b1');
  p.ctx.guardarBorradorRendicion();
  assert.equal(p.reemplazos.length,0);
});

test('cada rendición en curso tiene su propio borrador',()=>{
  const p=preparar({campos:{'nr-comentario':'Primera'}});
  p.poner('a');p.ctx.guardarBorradorRendicion();
  p.ctx.document.getElementById=id=>id==='view-nueva'?{classList:{contains:()=>true}}:(id==='nr-comentario'?{value:'Segunda'}:null);
  p.poner('b');p.ctx.guardarBorradorRendicion();
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.datos.comentario).sort(),['Primera','Segunda']);
  assert.deepEqual(p.insignias.at(-1),['borradores',2]);
});

test('un formulario en blanco no deja borrador y limpia el suyo (no los demás)',()=>{
  const p=preparar({campos:{'nr-comentario':'   '}});
  p.almacen.guardar('u1','a',{comentario:'se queda',items:[]});
  p.almacen.guardar('u1','b',{comentario:'antes tenía texto',items:[]});
  p.poner('b');p.ctx.guardarBorradorRendicion();
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['a']);
});

test('no guarda si la pantalla no está activa, mientras se envía, sin sesión o sin borrador actual',()=>{
  for(const opciones of [{vistaActiva:false},{enviando:true},{usuario:null}]){
    const p=preparar({campos:{'nr-comentario':'Viaje'},...opciones});
    p.poner('b1');p.ctx.guardarBorradorRendicion();
    assert.equal(p.memoria.size,0,JSON.stringify(opciones));
  }
  const p=preparar({campos:{'nr-comentario':'Viaje'}});
  p.poner(null);p.ctx.guardarBorradorRendicion();
  assert.equal(p.memoria.size,0);
});

test('leerBorradorRendicion devuelve el borrador, y null si es de otro usuario, no existe o caducó',()=>{
  const p=preparar({campos:{'nr-comentario':'Viaje'}});
  p.poner('b1');p.ctx.guardarBorradorRendicion();
  assert.equal(p.ctx.leerBorradorRendicion('b1').datos.comentario,'Viaje');
  assert.equal(p.ctx.leerBorradorRendicion('otro'),null);
  assert.equal(p.ctx.leerBorradorRendicion(null),null);
  p.ctx.currentUser={id:'u2'};
  assert.equal(p.ctx.leerBorradorRendicion('b1'),null,'otro usuario no lo ve');
  p.ctx.currentUser={id:'u1'};
  p.reloj.ahora+=7*DIA+1;
  assert.equal(p.ctx.leerBorradorRendicion('b1'),null,'pasada la semana ya no existe');
});

test('borrarBorradorRendicion elimina solo el borrador actual y baja el contador',()=>{
  const p=preparar({campos:{'nr-comentario':'Viaje'}});
  p.almacen.guardar('u1','otro',{comentario:'queda',items:[]});
  p.poner('b1');p.ctx.guardarBorradorRendicion();
  p.ctx.borrarBorradorRendicion();
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['otro']);
  assert.deepEqual(p.insignias.at(-1),['borradores',1]);
});

test('tras enviar (borrar) el formulario, que sigue lleno, no vuelve a crear el borrador al salir de la pantalla',()=>{
  const p=preparar({campos:{'nr-comentario':'Rendición enviada'}});
  p.poner('b1');p.ctx.guardarBorradorRendicion();
  assert.equal(p.almacen.contar('u1'),1);
  p.ctx.borrarBorradorRendicion();
  p.ctx.guardarBorradorRendicion(); // lo que dispara show() al pasar al panel
  assert.equal(p.almacen.contar('u1'),0,'sigue sin borrador');
  assert.equal(p.memoria.size,0);
});

test('si el almacenamiento falla, guardar y borrar no lanzan error',()=>{
  const p=preparar({campos:{'nr-comentario':'Viaje'}});
  p.ctx.window.localStorage.setItem=()=>{throw new Error('QuotaExceededError');};
  p.poner('b1');
  assert.doesNotThrow(()=>p.ctx.guardarBorradorRendicion());
  p.ctx.window.localStorage.getItem=()=>{throw new Error('SecurityError');};
  assert.doesNotThrow(()=>p.ctx.borrarBorradorRendicion());
  assert.equal(p.ctx.leerBorradorRendicion('b1'),null);
});
