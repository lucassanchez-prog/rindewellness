const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const source=app.slice(app.indexOf('async function restaurarSesionInicial()'),app.indexOf('window.addEventListener("DOMContentLoaded"'));
function contexto(getSession,recovery=false){
  const llamadas=[];
  const ctx=vm.createContext({db:{auth:{getSession}},document:{getElementById:()=>({classList:{contains:()=>recovery}})},show:id=>llamadas.push(id),onLoggedIn:async user=>llamadas.push(user.id)});
  vm.runInContext(source,ctx);return {ctx,llamadas};
}
test('recarga con sesión espera la respuesta sin mostrar login y restaura al usuario',async()=>{
  let resolver;const {ctx,llamadas}=contexto(()=>new Promise(resolve=>{resolver=resolve;}));
  const pending=ctx.restaurarSesionInicial();assert.deepEqual(llamadas,[]);
  resolver({data:{session:{user:{id:'persona'}}},error:null});await pending;assert.deepEqual(llamadas,['persona']);
});
test('sin sesión confirmada se presenta el login',async()=>{
  const {ctx,llamadas}=contexto(async()=>({data:{session:null},error:null}));await ctx.restaurarSesionInicial();assert.deepEqual(llamadas,['view-login']);
});
test('fallo de conexión no se interpreta como ausencia de sesión',async()=>{
  const {ctx,llamadas}=contexto(async()=>({data:null,error:new Error('Sin conexión')}));await assert.rejects(ctx.restaurarSesionInicial(),/Sin conexión/);assert.deepEqual(llamadas,[]);
});
test('recuperación de contraseña conserva su pantalla en la restauración inicial',async()=>{
  const {ctx,llamadas}=contexto(async()=>({data:{session:{user:{id:'persona'}}},error:null}),true);await ctx.restaurarSesionInicial();assert.deepEqual(llamadas,[]);
});
