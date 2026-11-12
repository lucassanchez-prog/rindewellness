// Recorrido guiado: los pasos dependen del rol y cada uno apunta a algo que
// existe en la app (Inicio y el menú, que están en computador y en teléfono).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pasosRecorrido}=require('../recorrido.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const portal=fs.readFileSync(path.join(__dirname,'../portal-ui.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');

test('cada rol ve sus pasos, y el administrador además reportes, usuarios y correcciones',()=>{
  const t=(o)=>pasosRecorrido(o).map(p=>p.titulo);
  assert.equal(t({rol:'empleado'}).length,9);
  assert.ok(!t({rol:'empleado'}).includes('Lo que te toca revisar'));
  assert.ok(t({rol:'empleado',aprobador:true}).includes('Lo que te toca revisar'),'un aprobador (o delegado) ve lo que debe revisar');
  const admin=t({rol:'admin'});
  for(const x of ['Reportes','Usuarios y salud del sistema','Correcciones','Lo que te toca revisar'])assert.ok(admin.includes(x),x);
  assert.equal(t({rol:'admin',nombre:'Lucas Sanchez'})[0],'Hola, Lucas 👋');
  assert.equal(admin.at(-1),'Listo');
});

test('los elementos que ilumina existen en la app',()=>{
  for(const p of pasosRecorrido({rol:'admin',aprobador:true}).filter(p=>p.selector)){
    const ruta=/data-route="(\w+)"/.exec(p.selector)?.[1],portalRoute=/data-portal-route="([\w-]+)"/.exec(p.selector)?.[1];
    if(ruta)assert.ok(portal.includes("['"+ruta+"','"),'menú: '+ruta);
    else if(portalRoute)assert.match(html,new RegExp('data-portal-route="'+portalRoute+'"'),'inicio: '+portalRoute);
    else if(p.selector==='#btn-recorrido')assert.match(fs.readFileSync(path.join(__dirname,'../recorrido.js'),'utf8'),/id: "btn-recorrido"/);
    else assert.match(html+portal,/portal-home-content|portal-metrics/,p.selector);
  }
});

test('la app lo carga y lo ofrece al pintar Inicio, sin romper si falla',()=>{
  assert.match(html,/<script src="recorrido\.js\?v=\d+"><\/script>/);
  assert.match(app,/try \{ window\.RindeRecorrido\?\.preparar\(\{ usuarioId: usuario\.id/);
  assert.match(fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'),/"\/recorrido\.js\?v=\d+"/,'disponible sin conexión');
});

test('solo la primera vez: queda en el perfil y vale en cualquier dispositivo',()=>{
  const rec=fs.readFileSync(path.join(__dirname,'../recorrido.js'),'utf8');
  assert.match(rec,/!datos\.yaVisto && !ofrecido\.has\(datos\.usuarioId\)/,'si ya lo vio, no aparece solo');
  assert.match(rec,/contexto\?\.alTerminar\?\.\(\)/,'terminarlo o saltarlo lo marca como visto');
  assert.match(app,/yaVisto: !!perfil\?\.recorrido_visto_en/);
  assert.match(app,/if \(perfil\.recorrido_visto_en\) return;[\s\S]{0,120}db\.rpc\("marcar_recorrido_visto"\)/,'se guarda una sola vez');
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261112130000_recorrido_visto.sql'),'utf8');
  assert.match(sql,/set recorrido_visto_en = coalesce\(recorrido_visto_en, now\(\)\)\s*where id = auth\.uid\(\)/,'solo el propio perfil y se conserva la primera fecha');
  assert.match(sql,/revoke execute on function public\.marcar_recorrido_visto\(\) from public, anon;/);
});
