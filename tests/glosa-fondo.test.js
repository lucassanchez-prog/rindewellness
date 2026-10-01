const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
test('comentarios contables identifican el fondo en cada línea y conservan Debe/Haber',()=>{
  const ctx=vm.createContext({fmtDateSlash:()=> '01/10/2026',campoCSV:v=>String(v??''),CUENTA_CONTRAPARTIDA:{FondoPorRendir:{cuenta:'1.1'},Reembolso:{cuenta:'2.1'}}});
  vm.runInContext(app.slice(app.indexOf('function csvRow('),app.indexOf('async function calcularSplitFondo(')),ctx);
  const r={id:'prueba',folio:18,empleado_nombre:'Persona de prueba',created_at:'2026-10-01',tipo_rendicion:'FondoPorRendir',solicitud_fondo_id:'fondo',monto_total:100};
  const items=[{estado:'Aprobado',tipo_item:'SinDocumento',monto:100,cuenta_contable:'4.01'},{estado:'Rechazado',monto:50}];
  const rows=ctx.construirFilasCSV(r,items,1,{dentroDelFondo:80,excedente:20,fondoFolio:2});
  assert.equal(rows.length,3);for(const row of rows){assert.match(row.split(';')[4],/FONDO S-2/);assert.match(row.split(';')[8],/FONDO S-2/);}
  assert.equal(rows.reduce((n,r)=>n+Number(r.split(';')[6]),0),100);assert.equal(rows.reduce((n,r)=>n+Number(r.split(';')[7]),0),100);
  const reembolso=ctx.construirFilasCSV({...r,tipo_rendicion:'Reembolso',solicitud_fondo_id:null},items);assert.doesNotMatch(reembolso[0],/FONDO S-/);
});
