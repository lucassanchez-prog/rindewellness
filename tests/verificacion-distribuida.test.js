const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const core=require('../pure.js');
const app=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const base={tipo_documento:'Factura Electrónica',rut_proveedor:'96.792.430-K',nro_documento:'149876710',estado:'Pendiente',monto:14495};
const original={id:2095277,rut:'76.717.692-9',empresa:'NEO SPA',ficha:base.rut_proveedor,documento:'Factura Electrónica #149876710',cuenta_cod:'2.01.07.01',cuenta_nom:'Proveedores Nacionales',comprobante:'858',debe:0,haber:28990};
function preparar(filas=[original],opciones={}){
  const writes=[],filters=[];
  const items=[{...base,id:'florida',centro_costo:'NEO LA FLORIDA'},{...base,id:'inde',centro_costo:'NEO INDEPENDENCIA'}];
  const consulta={select(){return this;},eq(k,v){filters.push([k,v]);return this;},ilike(k,v){filters.push([k,v]);return this;},async limit(){
    const data=filas.filter(row=>filters.every(([k,v])=>v.startsWith('%')?String(row[k]).endsWith(v.slice(1)):row[k]===v));
    return {data,error:null,count:opciones.incompleto?501:data.length};
  }};
  const ctx=vm.createContext({window:{RindeCore:core},fmtCLP:core.fmtCLP,nombreCuenta:()=>original.cuenta_nom,dbContabilidad:{from:()=>{filters.length=0;return consulta;}},updateChecked:async(table,id,values)=>{
    writes.push({table,id,values});return opciones.falloGuardado?{ok:false,mensaje:'No se guardó'}:{ok:true,data:[values]};
  }});
  for(const [inicio,fin] of [['const RUT_POR_EMPRESA =','// Centros de Costo'],['const CUENTA_POR_TIPO_DOC =','const CUENTA_CONTRAPARTIDA'],['const MOVIMIENTOS_COLS =','// Busca el nombre'],['function compararMontoContable(','function recalcTotal()']]){
    vm.runInContext(app.slice(app.indexOf(inicio),app.indexOf(fin,app.indexOf(inicio))),ctx);
  }
  return {ctx,items,writes,filters,box:{}};
}
test('verifica factura dividida por RUT empresa aunque el nombre contable sea diferente',async()=>{
  const p=preparar();await p.ctx.verificarDocumentoItem(p.items[0],p.box,'Neo Gym Chile SpA',p.items);
  assert.equal(p.writes.length,1);const v=p.writes[0].values.verificacion_contable;
  assert.equal(v.estado,'coincide');assert.equal(v.monto_rendido,14495);assert.equal(v.monto_documento_rendido,28990);assert.equal(v.monto_contable,28990);
  assert.equal(v.miembros.length,2);assert.deepEqual(p.items.map(i=>i.monto),[14495,14495]);
  assert.match(p.box.textContent,/Suma de 2 gastos coincide/);assert.match(p.box.textContent,/Este gasto/);
  assert.match(p.ctx.detalleMontoVerificado(v),/Total documento revisado: \$28.990 en 2 gastos/);
});
test('no verifica otra empresa ni otro proveedor con el mismo folio',async()=>{
  const p=preparar([{...original,rut:'76.717.691-0'},{...original,ficha:'76.134.941-4'}]);
  await p.ctx.verificarDocumentoItem(p.items[0],p.box,'Neo Gym Chile SpA',p.items);
  assert.equal(p.writes[0].values.verificacion_contable.estado,'empresa_distinta');assert.match(p.box.textContent,/No se confirmó el monto/);
  assert.equal(p.writes[0].values.existe_en_contabilidad,false);assert.equal(p.writes[0].values.verificacion_contable.monto_contable,null);
});
test('factura ausente se informa sin inventar un monto confirmado',async()=>{
  const p=preparar([]);await p.ctx.verificarDocumentoItem(p.items[0],p.box,'Neo Gym Chile SpA',p.items);
  assert.equal(p.writes[0].values.verificacion_contable.estado,'no_encontrado');assert.match(p.box.textContent,/no aparece registrada/);
});
test('no busca sin identificación de empresa ni guarda resultados incompletos',async()=>{
  for(const opcion of [{empresa:''},{empresa:'Neo Gym Chile SpA',incompleto:true}]){
    const p=preparar([original],opcion);await p.ctx.verificarDocumentoItem(p.items[0],p.box,opcion.empresa,p.items);
    assert.equal(p.writes.length,0);assert.match(p.box.className,/err/);
  }
});
test('informa diferencia cuando el reparto no suma la factura',async()=>{
  const p=preparar();p.items[1].monto=10000;await p.ctx.verificarDocumentoItem(p.items[0],p.box,'Neo Gym Chile SpA',p.items);
  assert.equal(p.writes[0].values.verificacion_contable.estado,'diferente');assert.equal(p.writes[0].values.verificacion_contable.diferencia,-4495);
});
test('elige la cuenta de proveedores y no la primera línea del asiento',async()=>{
  const p=preparar([{...original,id:2,cuenta_cod:'4.01.03.12',cuenta_nom:'Implementos',debe:28990,haber:0},original]);
  await p.ctx.verificarDocumentoItem(p.items[1],p.box,'Neo Gym Chile SpA',p.items);
  assert.equal(p.writes[0].values.cuenta_contable,'2.01.07.01');assert.equal(p.writes[0].values.verificacion_contable.nombre_cuenta,'Proveedores Nacionales');
});
test('no muestra verificación exitosa si falla el guardado',async()=>{
  const p=preparar([original],{falloGuardado:true});await p.ctx.verificarDocumentoItem(p.items[0],p.box,'Neo Gym Chile SpA',p.items);
  assert.equal(p.box.textContent,'No se guardó');assert.match(p.box.className,/err/);
});
