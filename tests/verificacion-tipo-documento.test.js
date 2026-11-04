// Un proveedor puede repetir el número de folio con otro tipo de documento
// (caso real en contabilidad: RUT 77.363.933-7 tiene "Factura Electrónica #1" y
// "Factura Exenta Electrónica #1"). Buscar solo "%#folio" mezclaba ambos.
// Además contabilidad guarda el folio como entero: el papel dice "003191702"
// y el asiento "Factura Exenta Electrónica #3191702".
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const ctx=vm.createContext({});
const inicio=app.indexOf('function patronDocumentoContable(');
vm.runInContext(app.slice(inicio,app.indexOf('async function verificarDocumentoItem(',inicio)),ctx);
const patron=(tipo,folio)=>ctx.patronDocumentoContable(tipo,folio);

test('arma el texto exacto que guarda contabilidad',()=>{
  assert.equal(patron('Factura Electrónica','37896'),'Factura Electrónica #37896');
  assert.equal(patron('Factura Exenta Electrónica','4'),'Factura Exenta Electrónica #4');
});

test('el tipo distinto produce un patrón distinto',()=>{
  assert.notEqual(patron('Factura Electrónica','1'),patron('Factura Exenta Electrónica','1'));
});

test('quita los ceros a la izquierda del folio',()=>{
  assert.equal(patron('Factura Exenta Electrónica','003191702'),'Factura Exenta Electrónica #3191702');
  assert.equal(patron('Factura Electrónica','06'),'Factura Electrónica #6');
});

test('un folio que es solo cero no queda vacío',()=>{
  assert.equal(patron('Factura Electrónica','0'),'Factura Electrónica #0');
  assert.equal(patron('Factura Electrónica','000'),'Factura Electrónica #0');
});

test('recorta espacios y tolera valores vacíos',()=>{
  assert.equal(patron('Factura Electrónica','  37896 '),'Factura Electrónica #37896');
  assert.equal(patron('Factura Electrónica',null),'Factura Electrónica #');
  assert.equal(patron('Factura Electrónica',undefined),'Factura Electrónica #');
});

test('escapa los comodines de LIKE del folio',()=>{
  assert.equal(patron('Factura Electrónica','12%3_4'),'Factura Electrónica #12\\%3\\_4');
});
