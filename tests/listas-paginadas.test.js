// Las listas de rendiciones y fondos muestran 20 filas y "Mostrar 20 más": en el
// teléfono, con todas, la pantalla medía más de 22.000 px. Filtros y búsqueda
// siguen recorriendo todas las filas; solo se limita cuántas se dibujan.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');

test('muestra 20, agrega de a 20 y dice cuántas quedan',()=>{
  const codigo=app.slice(app.indexOf('const FILAS_POR_PAGINA = 20;'),app.indexOf('function renderList('));
  const el=(tag,attrs={},hijos=[])=>({tag,attrs,hijos:[].concat(hijos)});
  const ctx=vm.createContext({el});vm.runInContext(codigo,ctx);
  const filas=Array.from({length:63},(_,i)=>i),cont={dataset:{}};
  let r=ctx.limitarLista(cont,filas,()=>{});
  assert.equal(r.visibles.length,20);assert.equal(r.pie.hijos[0].hijos[0],'Mostrando 20 de 63');assert.equal(r.pie.hijos[1].hijos[0],'Mostrar 20 más');
  r.pie.hijos[1].attrs.onclick();assert.equal(cont.dataset.limite,'40');
  cont.dataset.limite='60';r=ctx.limitarLista(cont,filas,()=>{});assert.equal(r.visibles.length,60);assert.equal(r.pie.hijos[1].hijos[0],'Mostrar 3 más');
  cont.dataset.limite='80';r=ctx.limitarLista(cont,filas,()=>{});assert.equal(r.visibles.length,63);assert.equal(r.pie,null,'con todas visibles no hay botón');
  assert.equal(ctx.limitarLista({dataset:{}},filas.slice(0,5),()=>{}).pie,null);
});

test('las dos listas lo usan y un filtro nuevo vuelve a la primera página',()=>{
  assert.match(app,/function renderList\([^)]*\) \{[\s\S]{0,300}limitarLista\(container, todas/);
  assert.match(app,/function renderListSolicitudes\([^)]*\) \{[\s\S]{0,300}limitarLista\(container, todas/);
  assert.match(app,/if \(lista && lista\.dataset\.filtros !== claveFiltros\) \{ lista\.dataset\.filtros = claveFiltros; delete lista\.dataset\.limite; \}/);
});
