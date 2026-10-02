const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('PDF multipágina propone el adjunto, bloquea la ficha y analiza solo la página confirmada',async()=>{
  const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
  function nodo(tag,attrs={},text){return {tag,attrs,children:[],listeners:{},value:attrs.value||'',disabled:!!attrs.disabled,appendChild(n){this.children.push(n);return n},append(...ns){this.children.push(...ns)},insertBefore(n){this.children.push(n)},querySelector(selector){return this.children.find(n=>selector==='.'+n.attrs.class)||null},addEventListener(ev,fn){this.listeners[ev]=fn},remove(){}}}
  const parent=nodo('div'),input={id:"gasto-1-foto",files:[new File(['pdf'],'rendicion.pdf',{type:'application/pdf'})],dataset:{},isConnected:true,parentElement:parent},status=nodo('p');
  const pdf={numPages:2,destroy:async()=>{},getPage:async n=>({getTextContent:async()=>({items:[{str:n===1?'Rendición de gastos. Total informe 25000. Detalle de gastos incluidos':''}]}),cleanup(){},getViewport:()=>({width:600,height:900}),render:()=>({promise:Promise.resolve()})})};
  const lecturas=[];const ctx=vm.createContext({window:{RindeData:require("../data-access.js")},File,Blob,URL,console,nuevaGeneracionOcr:()=>{},cargarPdfJs:async()=>({getDocument:()=>({promise:Promise.resolve(pdf)})}),el:nodo,document:{createElement:()=>({getContext:()=>({}),toBlob:fn=>fn(new Blob(['pagina'],{type:'image/jpeg'}))})},DataTransfer:class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)}}}});
  vm.runInContext(app.slice(app.indexOf('function clasificarPaginaComprobante('),app.indexOf('async function leerPdfLocal(')),ctx);
  await ctx.prepararArchivoParaLectura(input,status,f=>lecturas.push(f));
  const panel=parent.children[0],select=panel.children.find(n=>n.tag==='select'),button=panel.children.find(n=>n.tag==='button');
  assert.equal(select.value,'2');assert.equal(button.disabled,false);assert.equal(lecturas.length,0);assert.equal(input.dataset.paginaPendiente,'true');
  await button.listeners.click();assert.equal(lecturas.length,1);assert.equal(lecturas[0].name,'rendicion-pagina-2.jpg');assert.equal(input.dataset.paginaPendiente,'false');
  select.value='1';await select.listeners.change();assert.equal(button.disabled,true);assert.equal(input.dataset.paginaPendiente,'true');await button.listeners.click();assert.equal(lecturas.length,1);
});
