// Edición de gastos por un administrador y registro del CSV para Kame.
// Casos reales: en la N° 57 se cambió "Factura Electrónica" a "Boleta de
// Honorario" y la cuenta siguió siendo la de Proveedores (2.01.07.01).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function tramo(a,b){const i=app.indexOf(a),j=app.indexOf(b,i+a.length);assert(i>=0&&j>i,'no se encontró '+a);return app.slice(i,j);}
const CUENTA_POR_TIPO_DOC={"Factura Electrónica":"2.01.07.01","Factura Exenta Electrónica":"2.01.07.01","Boleta de Honorario":"2.01.07.03"};
function editor(){const c=vm.createContext({CUENTA_POR_TIPO_DOC});vm.runInContext(tramo('function cuentaDocumentoEditado(','function iniciarEdicionItem('),c);return c.cuentaDocumentoEditado;}
const factura={tipo_item:'ConDocumento',tipo_documento:'Factura Electrónica',cuenta_contable:'2.01.07.01'};

test('empleado cambia factura a boleta de honorarios: la cuenta pasa a Honorarios por Pagar',()=>{
  assert.equal(editor()(factura,'Boleta de Honorario',null),'2.01.07.03');
});

test('empleado sin cambiar el tipo conserva la cuenta que puso el aprobador',()=>{
  assert.equal(editor()({...factura,cuenta_contable:'2.01.07.09'},'Factura Electrónica',null),'2.01.07.09');
  assert.equal(editor()({...factura,cuenta_contable:'2.01.07.09'},'Boleta de Honorario',null),'2.01.07.09');
});

test('una boleta que pasa a documento parte con la cuenta del tipo, no vacía',()=>{
  const boleta={tipo_item:'SinDocumento',tipo_documento:'Boleta Electrónica',cuenta_contable:'4.01.03.21'};
  assert.equal(editor()(boleta,'Factura Electrónica',null),'2.01.07.01');
  assert.equal(editor()(boleta,'Boleta de Honorario',''),'2.01.07.03');
});

test('el aprobador manda la cuenta que escribió; vacía cae a la del tipo',()=>{
  assert.equal(editor()(factura,'Boleta de Honorario','2.01.07.01'),'2.01.07.01');
  assert.equal(editor()(factura,'Boleta de Honorario',''),'2.01.07.03');
});

test('el editor valida monto mayor a cero antes de guardar',()=>{
  assert.match(tramo('tipo_item: tipoEditado,','const res = await updateChecked("rendicion_items", it.id, cambios);'),/cambios\.monto > 0/);
});

test('el CSV para Kame avisa si ya se descargó y lo registra después',async()=>{
  const llamadas=[];let confirmado=null;
  const c=vm.createContext({fmtDate:d=>String(d).slice(0,10),console,currentProfile:{nombre:'Ana'},
    db:{rpc:async(nombre,args)=>{llamadas.push([nombre,args]);return {error:null};}},
    confirm:m=>{confirmado=m;return false;}});
  vm.runInContext(tramo('function textoExportacionKame(','async function descargarCSV('),c);
  assert.equal(c.textoExportacionKame({}),'');
  assert.equal(c.textoExportacionKame({kame_exportado_en:'2026-11-09T10:00:00Z',kame_exportado_por_nombre:'Ana',kame_exportaciones:2}),'CSV para Kame descargado el 2026-11-09 por Ana (2 veces)');
  const r=[{id:'a'},{id:'b',kame_exportado_en:'2026-11-01',kame_exportaciones:1}];
  await c.registrarExportacionKame(r);
  assert.deepEqual(llamadas,[['marcar_exportado_kame',{p_rendiciones:['a','b']}]]);
  assert.equal(r[0].kame_exportaciones,1);assert.equal(r[0].kame_exportado_por_nombre,'Ana');
  assert.equal(r[1].kame_exportado_en,'2026-11-01');assert.equal(r[1].kame_exportaciones,2);
  // Si el registro falla no se rompe nada: el CSV ya se descargó.
  c.db.rpc=async()=>({error:{message:'sin red'}});const s=[{id:'x'}];await c.registrarExportacionKame(s);assert.equal(s[0].kame_exportado_en,undefined);
  // descargarCSV pregunta antes de bajar uno ya exportado y respeta el "no".
  vm.runInContext(tramo('async function descargarCSV(','// Informe PDF de una rendición'),c);
  c.conDatosActualesDeEmpleado=async()=>{throw new Error('no debía seguir');};
  await c.descargarCSV({kame_exportado_en:'2026-11-01',kame_exportaciones:1},[]);
  assert.match(confirmado,/duplica el comprobante/);
});
