// Multifondo: una rendición se rinde contra varios fondos. Todos menos el
// último llevan un tope y el último recibe el resto. Debe calcular igual que la
// vista rendiciones_por_fondo (ver 20261105120000_rendicion_multifondo.sql).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {repartirEntreFondos,validarFondosRendicion}=require('../pure.js');

const partes=(total,fondos)=>repartirEntreFondos(total,fondos).map(f=>f.parte);

test('caso real: factura de $148.550 entre S-16 (tope $131.840) y S-17 (resto)',()=>{
  assert.deepEqual(partes(148550,[{id:'s16',monto:131840},{id:'s17',monto:null}]),[131840,16710]);
});

test('un solo fondo recibe todo el total',()=>{
  assert.deepEqual(partes(18160,[{id:'s16',monto:null}]),[18160]);
});

test('si el total baja (gasto rechazado), se llenan en orden y el último queda en cero',()=>{
  assert.deepEqual(partes(100000,[{id:'a',monto:131840},{id:'b',monto:null}]),[100000,0]);
  assert.deepEqual(partes(50000,[{id:'a',monto:30000},{id:'b',monto:30000},{id:'c',monto:null}]),[30000,20000,0]);
});

test('si el total sube, el excedente va al último fondo',()=>{
  assert.deepEqual(partes(200000,[{id:'a',monto:50000},{id:'b',monto:null}]),[50000,150000]);
});

test('la suma de las partes siempre es el total',()=>{
  for(const total of [0,1,999,50000,131840,148550,1e6]){
    const suma=partes(total,[{id:'a',monto:40000},{id:'b',monto:60000},{id:'c',monto:null}]).reduce((s,x)=>s+x,0);
    assert.equal(suma,total);
  }
});

test('valida igual que la base',()=>{
  const ok=[{id:'a',monto:131840},{id:'b',monto:null}];
  assert.equal(validarFondosRendicion(ok,148550),null);
  assert.equal(validarFondosRendicion([{id:'a',monto:null}],148550),null);
  assert.match(validarFondosRendicion([{id:'',monto:null}],1000),/Selecciona el fondo/);
  assert.match(validarFondosRendicion([{id:'a',monto:500},{id:'',monto:null}],1000),/Falta elegir/);
  assert.match(validarFondosRendicion([{id:'a',monto:500},{id:'a',monto:null}],1000),/dos veces/);
  assert.match(validarFondosRendicion([{id:'a',monto:0},{id:'b',monto:null}],1000),/cuánto se rinde/);
  assert.match(validarFondosRendicion([{id:'a',monto:148550},{id:'b',monto:null}],148550),/no le queda nada/);
  assert.match(validarFondosRendicion([],1000),/entre 1 y 10/);
});

test('con rendicion_fondos hay dos caminos rendiciones→solicitudes_fondos: todo embed debe nombrar la FK',()=>{
  // Sin la FK, PostgREST responde PGRST201 ("more than one relationship was found")
  // y el Excel general dejó de generarse.
  const fs=require('node:fs'),path=require('node:path');
  for(const archivo of ['app.js','data-access.js','reportes-exportacion.js','portal-ui.js']){
    const src=fs.readFileSync(path.join(__dirname,'..',archivo),'utf8');
    assert.doesNotMatch(src,/solicitudes_fondos\(/,archivo+' embebe solicitudes_fondos sin indicar la FK');
  }
});
