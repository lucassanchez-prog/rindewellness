// "Salud del sistema" muestra cuántas lecturas con IA hizo cada proveedor,
// sumando las de en vivo (ocr_resultado.metadata.proveedor) y las del bot de
// reintentos (ocr_reintento_run.metadata.proveedores). Sin este dato no había
// forma de saber cuánto aportaba Groq frente a Gemini.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const ctx=vm.createContext({});
const inicio=app.indexOf('function contarLecturasPorProveedor(');
vm.runInContext(app.slice(inicio,app.indexOf('// Registra un fondo por rendir',inicio)),ctx);
const contar=(vivo,bot)=>ctx.contarLecturasPorProveedor(vivo,bot);

test('suma las lecturas en vivo por proveedor e ignora las sin dato',()=>{
  const r=contar([{metadata:{proveedor:'gemini'}},{metadata:{proveedor:'gemini'}},{metadata:{proveedor:'groq'}},{metadata:{proveedor:null}},{metadata:null}],[]);
  assert.equal(r.total.gemini,2);assert.equal(r.total.groq,1);
  assert.equal(Object.keys(r.total).length,2);assert.equal(r.delBot,0);
});

test('suma las corridas del bot y cuenta cuántas leyó él',()=>{
  const r=contar([{metadata:{proveedor:'gemini'}}],[{metadata:{proveedores:{gemini:3,groq:1}}},{metadata:{proveedores:{}}},{metadata:null},{metadata:{procesados:2}}]);
  assert.equal(r.total.gemini,4);assert.equal(r.total.groq,1);assert.equal(r.delBot,4);
});

test('cantidades inválidas o en cero no cuentan',()=>{
  const r=contar([],[{metadata:{proveedores:{gemini:0,groq:'x',desconocido:2}}}]);
  assert.equal(Object.keys(r.total).join(),'desconocido');assert.equal(r.total.desconocido,2);assert.equal(r.delBot,2);
});

test('sin eventos no inventa datos',()=>{
  for(const [vivo,bot] of [[[],[]],[null,undefined]]){
    const r=contar(vivo,bot);assert.equal(Object.keys(r.total).length,0);assert.equal(r.delBot,0);
  }
});
