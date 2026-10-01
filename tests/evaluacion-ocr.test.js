const {test}=require('node:test'),assert=require('node:assert/strict');const {evaluar}=require('../scripts/evaluar-ocr.cjs');
test('evaluación no inventa una precisión sin referencias y detecta errores de escala en montos',()=>{
 assert.throws(()=>evaluar([{id:'a',referencia:null}],[]),/referencias humanas/);
 const r=evaluar([{id:'a',referencia:{rut_proveedor:'76.717.691-0',nro_documento:'00123',monto:200000}}],[{id:'a',datos:{rut_proveedor:'767176910',nro_documento:'123',monto:200}}]);
 assert.equal(r.porCampo.rut_proveedor.exactitud,1);assert.equal(r.porCampo.nro_documento.exactitud,1);assert.equal(r.porCampo.monto.exactitud,0);assert.equal(r.documentos_con_campos_evaluados_correctos,0);
});
