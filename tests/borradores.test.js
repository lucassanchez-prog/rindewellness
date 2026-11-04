// Módulo de borradores: lo que se empieza y no se envía se guarda por usuario y
// caduca una semana después de la última edición.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {VIGENCIA_MS,crearAlmacen,describir}=require('../borradores.js');

const DIA=24*60*60*1000;
function preparar(inicio=Date.UTC(2026,10,4,12,0,0)){
  const memoria=new Map();
  const storage={getItem:k=>memoria.has(k)?memoria.get(k):null,setItem:(k,v)=>memoria.set(k,String(v)),removeItem:k=>memoria.delete(k)};
  const reloj={ahora:inicio};
  const almacen=crearAlmacen({storage,ahora:()=>reloj.ahora});
  return {memoria,storage,reloj,almacen};
}
const datos=(extra={})=>({fecha:'2026-11-04',tipo:'Reembolso',fondo:'',empresa:'Dmoov Corp SpA',cc:'Casa Matriz',comentario:'Viaje',items:[],...extra});

test('la vigencia es de una semana exacta',()=>{
  assert.equal(VIGENCIA_MS,7*DIA);
});

test('guarda, recupera y lista de más reciente a más antiguo',()=>{
  const p=preparar();
  p.almacen.guardar('u1','a',datos({comentario:'primero'}));
  p.reloj.ahora+=60e3;
  p.almacen.guardar('u1','b',datos({comentario:'segundo'}));
  assert.equal(p.almacen.obtener('u1','a').datos.comentario,'primero');
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['b','a']);
  assert.equal(p.almacen.contar('u1'),2);
  assert.equal(p.almacen.obtener('u1','no-existe'),null);
});

test('un borrador caduca justo después de una semana, y se borra del almacenamiento',()=>{
  const p=preparar();
  p.almacen.guardar('u1','a',datos());
  p.reloj.ahora+=7*DIA;
  assert.equal(p.almacen.contar('u1'),1,'a los 7 días exactos todavía vale');
  p.reloj.ahora+=1;
  assert.equal(p.almacen.contar('u1'),0,'un milisegundo después ya caducó');
  assert.equal(p.memoria.size,0,'no queda basura guardada');
});

test('cada edición renueva la semana',()=>{
  const p=preparar();
  p.almacen.guardar('u1','a',datos());
  p.reloj.ahora+=6*DIA;
  const editado=p.almacen.guardar('u1','a',datos({comentario:'cambió'}));
  assert.equal(editado.creado,p.almacen.obtener('u1','a').creado,'conserva la fecha de creación');
  p.reloj.ahora+=6*DIA;
  assert.equal(p.almacen.obtener('u1','a').datos.comentario,'cambió','12 días después sigue vigente porque se editó al sexto');
  p.reloj.ahora+=2*DIA;
  assert.equal(p.almacen.obtener('u1','a'),null);
});

test('solo caduca el que pasó la semana, no los demás',()=>{
  const p=preparar();
  p.almacen.guardar('u1','viejo',datos());
  p.reloj.ahora+=5*DIA;
  p.almacen.guardar('u1','nuevo',datos());
  p.reloj.ahora+=3*DIA;
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['nuevo']);
});

test('cada usuario ve solo sus borradores',()=>{
  const p=preparar();
  p.almacen.guardar('u1','a',datos());
  p.almacen.guardar('u2','b',datos());
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['a']);
  assert.equal(p.almacen.obtener('u1','b'),null);
  p.almacen.eliminar('u1','b');
  assert.equal(p.almacen.contar('u2'),1,'eliminar no toca los de otro usuario');
  assert.deepEqual(p.almacen.listar(null),[]);
  assert.equal(p.almacen.guardar(null,'a',datos()),null);
});

test('eliminar quita solo ese borrador',()=>{
  const p=preparar();
  p.almacen.guardar('u1','a',datos());p.almacen.guardar('u1','b',datos());
  p.almacen.eliminar('u1','a');
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['b']);
  p.almacen.eliminar('u1','b');
  assert.equal(p.memoria.size,0);
});

test('ignora lo dañado, de otra versión o sin ítems',()=>{
  const p=preparar();
  for(const valor of ['{no es json','null',JSON.stringify({version:1,entradas:[]}),JSON.stringify({version:2,entradas:'x'})]){
    p.memoria.set('rw-borradores:u1',valor);
    assert.deepEqual(p.almacen.listar('u1'),[],valor);
  }
  const ok={id:'ok',creado:new Date(p.reloj.ahora).toISOString(),actualizado:new Date(p.reloj.ahora).toISOString(),datos:datos()};
  p.memoria.set('rw-borradores:u1',JSON.stringify({version:2,entradas:[ok,{id:'sin-datos'},{id:'',actualizado:ok.actualizado,datos:datos()},{id:'fecha-mala',actualizado:'nunca',datos:datos()},{id:'sin-items',actualizado:ok.actualizado,datos:{}}]}));
  assert.deepEqual(p.almacen.listar('u1').map(e=>e.id),['ok']);
});

test('convierte el borrador único de la versión anterior y borra la clave vieja',()=>{
  const p=preparar();
  const guardado=new Date(p.reloj.ahora-DIA).toISOString();
  p.memoria.set('rw-borrador-rendicion:u1',JSON.stringify({version:1,guardado,fecha:'2026-11-03',tipo:'Reembolso',empresa:'Dmoov SpA',cc:'Casa Matriz',comentario:'antiguo',items:[]}));
  const lista=p.almacen.listar('u1');
  assert.equal(lista.length,1);
  assert.equal(lista[0].datos.comentario,'antiguo');
  assert.equal(lista[0].actualizado,guardado);
  assert.equal(p.memoria.has('rw-borrador-rendicion:u1'),false);
  assert.equal(p.almacen.contar('u1'),1,'no se duplica en la siguiente lectura');
});

test('el borrador de la versión anterior también caduca a la semana',()=>{
  const p=preparar();
  p.memoria.set('rw-borrador-rendicion:u1',JSON.stringify({version:1,guardado:new Date(p.reloj.ahora-8*DIA).toISOString(),comentario:'viejo',items:[]}));
  assert.equal(p.almacen.contar('u1'),0);
  assert.equal(p.memoria.size,0);
});

test('si el almacenamiento falla no lanza error',()=>{
  const p=preparar();
  p.storage.setItem=()=>{throw new Error('QuotaExceededError');};
  assert.equal(p.almacen.guardar('u1','a',datos()),null);
  p.storage.getItem=()=>{throw new Error('SecurityError');};
  assert.deepEqual(p.almacen.listar('u1'),[]);
  assert.doesNotThrow(()=>p.almacen.eliminar('u1','a'));
});

test('describir: título, total, cantidad de gastos y días que quedan',()=>{
  const p=preparar();
  const e=p.almacen.guardar('u1','a',datos({comentario:'  Viaje a terreno ',items:[
    {tipo:'ConDocumento',campos:{monto:'9.000',nombreprov:'Marisol'}},
    {tipo:'SinDocumento',campos:{monto2:'25.000',nombreprov2:'Ferretería'}},
    {tipo:'SinDocumento',campos:{monto:'999.999',monto2:''}},
  ]}));
  p.reloj.ahora+=2*DIA+3600e3;
  const d=describir(e,p.reloj.ahora);
  assert.equal(d.titulo,'Viaje a terreno');
  assert.equal(d.gastos,3);
  assert.equal(d.total,34000,'cada ítem suma el monto de SU pestaña, no el del otro');
  assert.equal(d.diasRestantes,5);
  assert.equal(d.porVencer,false);
  assert.equal(d.empresa,'Dmoov Corp SpA');
});

test('describir: sin comentario usa el proveedor, y sin nada "sin título"; avisa si vence pronto',()=>{
  const p=preparar();
  const a=p.almacen.guardar('u1','a',datos({comentario:'',items:[{tipo:'ConDocumento',campos:{nombreprov:'  '}},{tipo:'ConDocumento',campos:{nombreprov:'Proveedor Sur'}}]}));
  assert.equal(describir(a,p.reloj.ahora).titulo,'Proveedor Sur');
  const b=p.almacen.guardar('u1','b',datos({comentario:'',items:[]}));
  assert.equal(describir(b,p.reloj.ahora).titulo,'Rendición sin título');
  p.reloj.ahora+=5*DIA+3600e3;
  const d=describir(a,p.reloj.ahora);
  assert.equal(d.diasRestantes,2);
  assert.equal(d.porVencer,true);
  p.reloj.ahora+=2*DIA;
  assert.equal(describir(a,p.reloj.ahora).diasRestantes,0,'vencido: 0 días, nunca negativo');
});
