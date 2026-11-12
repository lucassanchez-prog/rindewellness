// Correcciones de administrador (cambiar empresa o dueño, unir, anular una
// aprobación), aviso de notas de crédito y aviso de Claude sin crédito.
// Las funciones de base se probaron contra producción dentro de transacciones
// que se deshacen (12 verificaciones, 3 vueltas); aquí se fija la parte de la app.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const core=require('../pure.js');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261112120000_correcciones_admin.sql'),'utf8');

test('el reverso invierte Debe y Haber, fecha hoy y conserva documento y ficha',()=>{
  const fila=['TRASPASO','S',1,'09/11/2026','RENDICION N° 68 Norma','2.01.07.01',148550,0,'RENDICION N° 68 Norma','76.103.802-8','BUALE GROUP LTDA.','Factura Electrónica','62052','29/10/2026','','',''];
  const r=core.invertirFilaKame(fila,'12/11/2026');
  assert.deepEqual([r[3],r[6],r[7]],['12/11/2026',0,148550]);
  assert.equal(r[4],'REVERSO RENDICION N° 68 Norma');assert.equal(r[8],'REVERSO RENDICION N° 68 Norma');
  assert.deepEqual(r.slice(9,14),fila.slice(9,14),'mismo proveedor, documento y folio: Kame cancela ese documento');
  assert.equal(fila[6],148550,'no modifica la línea original');
  assert.throws(()=>core.invertirFilaKame(fila,'2026-11-12'),/Fecha/);
});

test('detecta la nota de crédito que anuló la factura de la N° 68, y no otras',()=>{
  const movimientos=[
    {fecha:'2026-10-29',documento:null,concepto:'Nota de Crédito Electrónica #59532, ficha 76.103.802-8 BUALE GROUP LTDA',debe:'148560.0',haber:'0.0',comprobante:'4257'},
    {fecha:'2026-10-29',documento:'Factura Electrónica #62052',concepto:'Factura Electrónica #62052, ficha 76103802-8 BUALE GROUP LTDA',debe:'0.0',haber:'148550.0',comprobante:'4265'},
    {fecha:'2026-10-30',documento:'Nota de Crédito Electrónica #59533',concepto:'x',debe:'20000',haber:'0',comprobante:'4300'},
    {fecha:'2026-03-01',documento:'Nota de Crédito Electrónica #50000',concepto:'x',debe:'148550',haber:'0',comprobante:'100'},
  ];
  const r=core.notasCreditoCercanas(movimientos,{monto:148550,fecha:'2026-10-29'});
  assert.deepEqual(r.map(n=>[n.folio,n.monto]),[['59532',148560]],'monto casi igual y cerca en fecha; descarta una NC chica y una de hace meses');
  assert.deepEqual(core.notasCreditoCercanas(movimientos.slice(1),{monto:148550,fecha:'2026-10-29'}),[]);
  assert.deepEqual(core.notasCreditoCercanas([{...movimientos[0],concepto:'Nota de Credito #1'}],{monto:148550}),[{folio:'1',monto:148560,fecha:'2026-10-29',comprobante:'4257'}],'sin fecha de factura no filtra por fecha; acepta "Credito" sin tilde');
});

test('la app arma el reverso ANTES de anular, y avisa al empleado después',()=>{
  const anular=app.slice(app.indexOf('titulo: "Anular aprobación"'),app.indexOf('if (!botones.children.length) return null;'));
  const iReverso=anular.indexOf('prepararReversoKame(r, items)'),iRpc=anular.indexOf('rpc("admin_anular_aprobacion"'),iDescarga=anular.indexOf('descargarTextoCsv('),iAviso=anular.indexOf('notificarAsync("notificar-estado-rendicion"');
  assert.ok(iReverso>0&&iReverso<iRpc&&iRpc<iDescarga&&iDescarga<iAviso,'reverso -> anular -> descargar -> avisar');
  assert.match(app,/if \(currentProfile\?\.rol === "admin"\) \{\s*try \{ const panel = await panelCorreccionesAdmin\(r, items\)/,'el panel es solo para administradores');
  for(const f of ['admin_cambiar_empresa_rendicion','admin_cambiar_empleado_rendicion','admin_unir_rendiciones','admin_anular_aprobacion']){
    assert.match(app,new RegExp('rpc\\("'+f+'"'),'la app usa '+f);
    assert.match(sql,new RegExp('create or replace function public\\.'+f+'\\('),'la base define '+f);
    assert.match(sql,new RegExp('revoke execute on function public\\.'+f+'\\([^)]*\\) from public, anon;'),f+' no queda abierta a anónimos');
  }
  assert.match(app,/construirFilasCSV\(rend, items, 1, split, \{ reverso: \{ fecha:/);
});

test('la base exige administrador y motivo, y solo abre las protecciones con la señal de corrección',()=>{
  assert.match(sql,/raise exception 'Solo un administrador activo puede hacer correcciones\.'/);
  assert.match(sql,/raise exception 'Explica el motivo de la corrección/);
  assert.match(sql,/coalesce\(current_setting\('rinde\.correccion_admin', true\), ''\) = '1'\s*and auth\.uid\(\) is not null and public\.is_activo\(\) and public\.is_admin\(\)/);
  assert.equal((sql.match(/set_config\('rinde\.correccion_admin', '1', true\)/g)||[]).length,3,'la señal se enciende solo en traspasar, unir y anular');
  assert.equal((sql.match(/set_config\('rinde\.correccion_admin', '', true\)/g)||[]).length,3,'y se apaga en las tres');
  assert.match(sql,/El fondo S-% ya está liquidado\. Anula primero la liquidación del fondo\./);
  assert.match(sql,/asociada a un fondo de %; el fondo no se puede cambiar de empresa desde aquí/,'cambiar la empresa no rompe un fondo ni borra su reparto');
});

test('aprobar avisa si un gasto tiene una nota de crédito, y enviar avisa si ya hay otra pendiente contra el fondo',()=>{
  const fin=app.slice(app.indexOf('async function finalizarAprobacionRendicion('),app.indexOf('db.rpc("finalizar_rendicion"'));
  assert.match(fin,/verificacion_contable\?\.notas_credito\?\.length/);
  assert.match(app,/notas_credito:notasCredito/,'la verificación guarda las NC encontradas');
  const envio=app.slice(app.indexOf('async function submitRendicion('),app.indexOf('const usuarioEnvio = currentUser.id;'));
  assert.match(envio,/\.eq\("estado", "Pendiente"\)\.eq\("solicitud_fondo_id", solicitudFondoId\)/);
  assert.match(envio,/if \(envioRendicionId\) q = q\.neq\("id", envioRendicionId\)/,'un reintento del mismo envío no se avisa a sí mismo');
});

test('aviso a administradores: a sus correos, con reenvío en modo de pruebas, y sin clave no envía',async()=>{
  const previo={deno:globalThis.Deno};
  const ambiente={RESEND_API_KEY:'re_x',RESEND_FALLBACK_EMAIL:'respaldo@ejemplo.cl'};
  globalThis.Deno={env:{get:k=>ambiente[k]}};
  try{
    const {avisarAdministradores}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/aviso-admin.ts')).href);
    const admin={from:()=>({select(){return this;},eq(){return this;},then:(ok)=>ok({data:[{id:'a1'},{id:'a2'}],error:null})}),
      auth:{admin:{getUserById:async(id)=>({data:{user:{email:id+'@ejemplo.cl'}}})}}};
    const envios=[];
    const ok=await avisarAdministradores(admin,'Asunto','Título',['uno'],async(url,init)=>{envios.push(JSON.parse(init.body));return new Response('{"id":"1"}',{status:200});});
    assert.equal(ok.enviados,2);assert.deepEqual(envios[0].to,['a1@ejemplo.cl','a2@ejemplo.cl']);assert.match(envios[0].html,/uno/);
    envios.length=0;
    const r2=await avisarAdministradores(admin,'Asunto','Título',['dos'],async(url,init)=>{envios.push(JSON.parse(init.body));
      return envios.length===1?new Response('{"message":"You can only send testing emails to your own email address"}',{status:403}):new Response('{"id":"2"}',{status:200});});
    assert.equal(r2.enviados,1);assert.deepEqual(envios[1].to,['respaldo@ejemplo.cl']);assert.match(envios[1].subject,/^\[Reenviado\] /);assert.match(envios[1].html,/Destinatario real: a1@ejemplo\.cl, a2@ejemplo\.cl/);
    delete ambiente.RESEND_API_KEY;
    const r3=await avisarAdministradores(admin,'A','T',['x'],async()=>{throw new Error('no debía enviar');});
    assert.equal(r3.enviados,0);
  }finally{globalThis.Deno=previo.deno;}
});
