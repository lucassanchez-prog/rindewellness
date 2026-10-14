// Una factura ya rendida tiene DOS asientos en la cuenta del proveedor: el
// que la registra (haber) y el que la cancela cuando se contabiliza la
// rendición o el pago (debe). Agrupar por comprobante y exigir uno solo
// devolvía "ambiguo" justo en las facturas que completaron el proceso --
// caso real: la #80559421, comprobante 859 con la factura y el 866 con
// "RENDICION N° 23" cancelándola.
//
// El monto del documento es lo que se le ABONÓ al proveedor; lo que se le
// cargó después no cambia cuánto valía la factura. La ambigüedad sigue
// detectándose donde sí importa: dos comprobantes distintos abonando el
// mismo documento es una doble contabilización.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const ctx=vm.createContext({});
for(const [inicio,fin] of [['const CUENTA_POR_TIPO_DOC =','const CUENTA_CONTRAPARTIDA'],['function compararMontoContable(','function detalleMontoVerificado(']]){
  vm.runInContext(app.slice(app.indexOf(inicio),app.indexOf(fin,app.indexOf(inicio))),ctx);
}

const linea=(comprobante,debe,haber,cuenta_cod='2.01.07.01')=>({comprobante,cuenta_cod,debe,haber});
const comparar=(filas,monto=13980)=>ctx.compararMontoContable({tipo_documento:'Factura Electrónica',monto},filas);

test('la factura sola se confirma',()=>{
  const r=comparar([linea('859',0,13980)]);
  assert.equal(r.estado,'coincide');
  assert.equal(r.contable,13980);
});

test('una factura ya rendida se confirma aunque el asiento de la rendición la cancele',()=>{
  const r=comparar([linea('859',0,13980),linea('866',13980,0)]);
  assert.equal(r.estado,'coincide');
  assert.equal(r.contable,13980);
});

test('una factura pagada y rendida también se confirma',()=>{
  const r=comparar([linea('859',0,13980),linea('866',13980,0),linea('900',13980,0)]);
  assert.equal(r.estado,'coincide');
});

test('dos comprobantes abonando el mismo documento siguen siendo ambiguos',()=>{
  const r=comparar([linea('859',0,13980),linea('870',0,13980)]);
  assert.equal(r.estado,'ambiguo');
  assert.equal(r.cantidad,2);
});

test('un cargo sin abono no permite afirmar ningún monto',()=>{
  assert.equal(comparar([linea('866',13980,0)]).estado,'sin_monto');
});

test('una nota de crédito dentro del mismo comprobante neta el monto',()=>{
  const r=comparar([linea('859',0,13980),linea('859',3000,0)],10980);
  assert.equal(r.estado,'coincide');
  assert.equal(r.contable,10980);
});

test('un monto distinto se reporta como diferente, no como coincidencia',()=>{
  const r=comparar([linea('859',0,9999)]);
  assert.equal(r.estado,'diferente');
  assert.equal(r.contable,9999);
  assert.equal(r.diferencia,13980-9999);
});

test('los asientos de otras cuentas no definen el monto del proveedor',()=>{
  assert.equal(comparar([linea('859',13980,0,'4.01.03.01')]).estado,'sin_monto');
});
