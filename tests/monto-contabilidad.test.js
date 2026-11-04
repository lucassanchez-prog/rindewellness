const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('verificación de monto distingue coincidencias, diferencias y registros ambiguos sin sumar doble partida',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8'),ctx=vm.createContext({CUENTA_POR_TIPO_DOC:{'Factura Electrónica':'2.01.07.01'}});
 vm.runInContext(app.slice(app.indexOf('function compararMontoContable('),app.indexOf('async function verificarDocumentoItem(')),ctx);
 const item={tipo_documento:'Factura Electrónica',monto:40000};
 const filas=[{id:1,cuenta_cod:'2.01.07.01',comprobante:'A',debe:0,haber:40000},{id:2,cuenta_cod:'4.01',comprobante:'A',debe:40000,haber:0}];
 assert.equal(ctx.compararMontoContable(item,filas).estado,'coincide');
 assert.equal(ctx.compararMontoContable({...item,monto:45000},filas).diferencia,5000);
 assert.equal(ctx.compararMontoContable(item,[...filas,{...filas[0],comprobante:'B'}]).estado,'ambiguo');
 assert.equal(ctx.compararMontoContable(item,[{...filas[0],haber:null}]).estado,'sin_monto');
 assert.equal(ctx.compararMontoContable(item,[filas[1]]).estado,'sin_monto');
});
