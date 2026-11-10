// Los gastos de una rendición se muestran en el orden en que se cargaron. La
// posición sale de la ruta del comprobante ("usuario/<envío>-<posición>-..."):
// sin esto, editar un gasto lo hacía saltar al primer lugar.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ordenarItemsRendicion}=require('../pure.js');

const USUARIO='0b2f8a10-1111-4222-8333-444455556666',ENVIO='9c20f804-2631-41c8-bb2e-40dbb176a26c';
const ruta=(pos,nombre='boleta.pdf')=>`${USUARIO}/${ENVIO}-${pos}-${'7e1d3c2b-aaaa-4bbb-8ccc-ddddeeeeffff'}-${nombre}`;

test('un gasto editado vuelve a su lugar aunque el servidor lo devuelva primero',()=>{
  const items=[{id:'c',adjunto_url:ruta(2)},{id:'a',adjunto_url:ruta(0)},{id:'b',adjunto_url:ruta(1)}];
  assert.deepEqual(ordenarItemsRendicion(items).map(i=>i.id),['a','b','c']);
});

test('ordena por número y no por texto (el 10 va después del 2)',()=>{
  const items=[{id:'x',adjunto_url:ruta(10)},{id:'y',adjunto_url:ruta(2)},{id:'z',adjunto_url:ruta(1)}];
  assert.deepEqual(ordenarItemsRendicion(items).map(i=>i.id),['z','y','x']);
});

test('dos gastos que comparten comprobante (ítem dividido) quedan juntos y en orden estable',()=>{
  const items=[{id:'b2',adjunto_url:ruta(1)},{id:'c',adjunto_url:ruta(2)},{id:'a',adjunto_url:ruta(0)},{id:'b1',adjunto_url:ruta(1)}];
  assert.deepEqual(ordenarItemsRendicion(items).map(i=>i.id),['a','b1','b2','c']);
});

test('sin posición en la ruta van al final, en orden estable, sin romper el resto',()=>{
  const items=[{id:'s2',adjunto_url:'otra/ruta.pdf'},{id:'b',adjunto_url:ruta(1)},{id:'s1',adjunto_url:null},{id:'a',adjunto_url:ruta(0)}];
  assert.deepEqual(ordenarItemsRendicion(items).map(i=>i.id),['a','b','s1','s2']);
});

test('el nombre del archivo puede traer guiones o números sin confundir la posición',()=>{
  const items=[{id:'b',adjunto_url:ruta(1,'factura-0-123.pdf')},{id:'a',adjunto_url:ruta(0,'2-copia.jpg')}];
  assert.deepEqual(ordenarItemsRendicion(items).map(i=>i.id),['a','b']);
});

test('ordena en el lugar y devuelve el mismo arreglo',()=>{
  const items=[{id:'b',adjunto_url:ruta(1)},{id:'a',adjunto_url:ruta(0)}];
  assert.equal(ordenarItemsRendicion(items),items);
  assert.equal(items[0].id,'a');
});

// Rendición N° 69 (unión de las N° 69 a 74, 10-11-2026): todas las rutas dicen
// posición 0 y el orden quedaba al azar. La columna "orden" manda.
test('la columna orden manda sobre la ruta, y sin ella se usa la ruta',()=>{
  const otro=(pos)=>`${USUARIO}/1bf2c597-65d3-4a6a-b788-aaad3fa9e455-${pos}-7e1d3c2b-aaaa-4bbb-8ccc-ddddeeeeffff-x.pdf`;
  const items=[{id:'1f6c',orden:3,adjunto_url:otro(0)},{id:'45ec',orden:4,adjunto_url:otro(0)},{id:'5fc6',orden:0,adjunto_url:ruta(0)},{id:'9b21',orden:1,adjunto_url:otro(0)}];
  assert.deepEqual(ordenarItemsRendicion(items).map(i=>i.id),['5fc6','9b21','1f6c','45ec']);
  assert.deepEqual(ordenarItemsRendicion([{id:'b',orden:null,adjunto_url:ruta(1)},{id:'a',adjunto_url:ruta(0)}]).map(i=>i.id),['a','b']);
});

test('el folio de un documento tributario es solo números',()=>{
  const {folioDocumentoValido}=require('../pure.js');
  for(const ok of ['62052','0000011526379',' 1732 ','','9999999999',null]) assert.equal(folioDocumentoValido(ok),true,String(ok));
  for(const mal of ['ERO01010005103622222','0','12345678901','F-123','12 34']) assert.equal(folioDocumentoValido(mal),false,mal);
  const fs=require('node:fs'),path=require('node:path');
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261110150000_orden_items_y_folio_documento.sql'),'utf8');
  assert.match(sql,/!~ '\^0\*\[1-9\]\[0-9\]\{0,9\}\$'/,'la base aplica la misma regla');
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  assert.equal((app.match(/folioDocumentoValido\(/g)||[]).length,2,'se valida al enviar y al editar');
});
