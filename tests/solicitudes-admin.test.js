// Solicitar fondos a nombre de un empleado y devolver un fondo a pendiente
// (2026-11-14). Caso real: el fondo de Norma pedido por WhatsApp (S-20 -> S-21).
// Las funciones de base se probaron contra producción en transacciones que se
// deshacen; aquí se fija la parte de la app y las reglas de la migración.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261114120000_solicitudes_admin.sql'),'utf8');

test('las dos funciones existen, exigen administrador y no quedan abiertas a anónimos',()=>{
  for(const [f,firma] of [['admin_crear_solicitud_fondos','uuid, text, text, numeric, text, date'],['admin_devolver_solicitud_pendiente','uuid, text']]){
    assert.match(sql,new RegExp('create or replace function public\\.'+f+'\\('));
    assert.ok(sql.includes(`revoke execute on function public.${f}(${firma}) from public, anon;`),f+' revocada a anónimos');
    assert.ok(sql.includes(`grant execute on function public.${f}(${firma}) to authenticated;`));
  }
  assert.match(sql,/not public\.is_admin\(\) then\s*raise exception 'Solo un administrador puede solicitar fondos a nombre de otra persona\.'/);
  assert.match(sql,/v_motivo := public\.exigir_correccion_admin\(p_motivo\);/,'devolver exige admin activo y motivo');
});

test('crear: queda Pendiente, no para uno mismo, sin duplicados y con registro',()=>{
  const f=sql.slice(sql.indexOf('function public.admin_crear_solicitud_fondos'),sql.indexOf('function public.admin_devolver_solicitud_pendiente'));
  assert.match(f,/v_motivo, p_fecha_necesaria, 'Pendiente'\)/);
  assert.doesNotMatch(f,/'Aprobado', auth\.uid\(\)/,'no se autoaprueba');
  assert.match(f,/if p_empleado_id = auth\.uid\(\) then/);
  assert.match(f,/created_at > now\(\) - interval '24 hours'/);
  assert.match(f,/'solicitud_creada_por_admin'/);
});

test('devolver: solo aprobado ajeno, sin rendiciones ni liquidación, con la señal encendida y apagada',()=>{
  const f=sql.slice(sql.indexOf('function public.admin_devolver_solicitud_pendiente'));
  assert.match(f,/if s\.estado <> 'Aprobado' then/);
  assert.match(f,/if s\.empleado_id = auth\.uid\(\) then/);
  assert.match(f,/liquidacion_fondos_detalle where solicitud_fondo_id = s\.id/);
  assert.match(f,/rendiciones where solicitud_fondo_id = s\.id\)\s*or exists \(select 1 from public\.rendicion_fondos where solicitud_fondo_id = s\.id\)/);
  const on=f.indexOf("set_config('rinde.correccion_admin', '1', true)"),upd=f.indexOf('update public.solicitudes_fondos'),off=f.indexOf("set_config('rinde.correccion_admin', '', true)");
  assert.ok(on>0&&on<upd&&upd<off,'señal -> update -> apagar');
  assert.match(f,/'accion', 'devolver_solicitud_pendiente'/);
});

test('la protección de solicitudes solo se abre con la corrección de admin y sin tocar la liquidación',()=>{
  assert.match(sql,/if public\.correccion_admin_activa\(\) and new\.liquidacion_id is not distinct from old\.liquidacion_id then\\n    return new;/);
  assert.match(sql,/raise exception 'proteger_aprobacion_solicitud cambió; revisar la migración\.'/,'si la función cambió, la migración falla en vez de no hacer nada');
});

test('la app: formulario con modo pendiente por defecto, aviso a aprobadores y botón de devolver',()=>{
  assert.match(html,/id="btn-registrar-fondo" type="button">Fondo a nombre de un empleado</);
  assert.match(app,/el\("option", \{ value: "pendiente" \}, "Solicitud pendiente de aprobación"\),\s*el\("option", \{ value: "entregado" \}/,'pendiente es la primera opción');
  const crear=app.slice(app.indexOf('if (selModo.value === "pendiente") {'),app.indexOf('¿Registrar un fondo APROBADO'));
  const iRpc=crear.indexOf('db.rpc("admin_crear_solicitud_fondos"'),iAviso=crear.indexOf('notificarAsync("notificar-aprobador", { tipo: "solicitud", rendicion_id: creada.id }');
  assert.ok(iRpc>0&&iRpc<iAviso,'crea y después avisa a los aprobadores');
  assert.match(app,/abierto && currentProfile\?\.rol === "admin" && !esPropia && !errorConsumo && !\(rendidas \|\| \[\]\)\.length\) box\.appendChild\(panelDevolverSolicitud\(s\)\)/);
  assert.match(app,/db\.rpc\("admin_devolver_solicitud_pendiente", \{ p_solicitud: s\.id, p_motivo: motivo \}\)/);
});
