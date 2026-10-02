const {test}=require('node:test'),assert=require('node:assert/strict');const {evaluar}=require('../scripts/evaluar-ocr.cjs');
test('evaluación no inventa una precisión sin referencias y detecta errores de escala en montos',()=>{
 assert.throws(()=>evaluar([{id:'a',referencia:null}],[]),/referencias humanas/);
 const r=evaluar([{id:'a',referencia:{rut_proveedor:'76.717.691-0',nro_documento:'00123',monto:200000}}],[{id:'a',datos:{rut_proveedor:'767176910',nro_documento:'123',monto:200}}]);
 assert.equal(r.porCampo.rut_proveedor.exactitud,1);assert.equal(r.porCampo.nro_documento.exactitud,1);assert.equal(r.porCampo.monto.exactitud,0);assert.equal(r.documentos_con_campos_evaluados_correctos,0);
});
test('una cobertura parcial no se presenta como precisión baja o validación independiente',()=>{
 const r=evaluar([{id:'a',referencia:{monto:100}},{id:'b',referencia:{monto:200}},{id:'c',referencia:{monto:null}}],[{id:'a',datos:{monto:100}}]);
 assert.equal(r.porCampo.monto.cobertura,.5);assert.equal(r.porCampo.monto.precision_completados,1);assert.equal(r.porCampo.monto.exactitud,.5);assert.equal(r.porCampo.monto.sin_valor_referencia,1);assert.equal(r.por_particion.desarrollo.documentos_etiquetados,3);
});
