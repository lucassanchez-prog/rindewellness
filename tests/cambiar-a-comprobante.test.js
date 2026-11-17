// Cambiar a Comprobante/Boleta un gasto ya aprobado y descargado para Kame
// (2026-11-17). Caso real: N° 87, dos tickets de Saba cargados como factura.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261117120000_cambiar_a_comprobante.sql'),'utf8');
const core=require('../pure.js');
function tramo(a,b){const i=app.indexOf(a),j=app.indexOf(b,i+a.length);assert(i>=0&&j>i,'no se encontró '+a);return app.slice(i,j);}
function ctx(){
  const c=vm.createContext({window:{RindeCore:core},campoCSV:core.campoCSV,fmtDateSlash:core.fmtDateSlash,fmtUsd:String,
    CSV_HEADER:'TipoComprobante;FolioAuto;Folio;Fecha;Comentario;Cuenta;Debe;Haber;Comentario Linea;Rut Ficha;Rzn Social Ficha;Nombre Doc;Folio Doc;Fecha Venc;Unidad Negocio;Tipo Movimiento;Numero Movimiento'});
  vm.runInContext(tramo('function csvRow(','// Arma las filas'),c);
  vm.runInContext(tramo('// Campos de la línea (Debe)','function construirFilasCSV('),c);
  return c;
}
const rend={id:'b52758da-0000',folio:87,empleado_nombre:'Andres Villablanca',rut_empleado:'12.345.678-5',created_at:'2026-11-14T15:00:00Z',tipo_rendicion:'Reembolso'};
const saba=(id,monto,nro)=>({id,estado:'Aprobado',tipo_item:'ConDocumento',tipo_documento:'Factura Electrónica',nro_documento:nro,monto,
  cuenta_contable:'2.01.07.01',categoria:'Estacionamiento',nombre_proveedor:'Saba Estacionamientos de Chile',rut_proveedor:'99.554.390-7',
  fecha_vencimiento:'2026-11-14',centro_costo:'NEO PLAZA OESTE',empresa:'Neo Gym Chile SpA'});
const items=[saba('a',9950,'108575542'),saba('b',1450,'104118259'),
  {id:'c',estado:'Aprobado',tipo_item:'SinDocumento',monto:750,cuenta_contable:'4.01.03.21',centro_costo:'NEO PLAZA OESTE'}];

test('N° 87: el ajuste sale de Proveedores con la ficha de Saba y entra a Estacionamiento, y cuadra',()=>{
  const c=ctx();
  const {fileName,content}=c.construirAjusteComprobante(rend,items,new Map([['a','4.01.03.21'],['b','4.01.03.21']]),'17/11/2026');
  assert.equal(fileName,'ajuste_rendicion_87.csv');
  const filas=content.split('\r\n').slice(1).map(l=>l.split(';'));
  assert.equal(filas.length,4,'reverso + línea nueva por cada gasto');
  const [rev,nueva]=filas;
  assert.deepEqual([rev[3],rev[5],rev[6],rev[7],rev[9],rev[11],rev[12]],['17/11/2026','2.01.07.01','0','9950','99.554.390-7','Factura Electrónica','108575542'],'sale de Proveedores con el mismo documento');
  assert.match(rev[8],/^REVERSO RENDICION N° 87 Andres Villablanca$/);
  assert.deepEqual([nueva[3],nueva[5],nueva[6],nueva[7],nueva[9],nueva[14]],['17/11/2026','4.01.03.21','9950','0','12.345.678-5','NEO PLAZA OESTE'],'entra al gasto con la ficha del empleado');
  assert.ok(filas.every(f=>f[4]==='AJUSTE RENDICION N° 87 Andres Villablanca'),'un solo comentario para el comprobante');
  const debe=filas.reduce((s,f)=>s+Number(f[6]),0),haber=filas.reduce((s,f)=>s+Number(f[7]),0);
  assert.equal(debe,11400);assert.equal(haber,11400);
});

test('solo los gastos elegidos, y nunca uno que ya es Comprobante/Boleta',()=>{
  const c=ctx();
  const {content}=c.construirAjusteComprobante(rend,items,new Map([['b','4.01.03.21']]),'17/11/2026');
  assert.equal(content.split('\r\n').length,3);
  assert.throws(()=>c.construirAjusteComprobante(rend,items,new Map([['c','4.01.03.21']]),'17/11/2026'),/Solo se ajustan/);
  assert.throws(()=>c.construirAjusteComprobante(rend,items,new Map(),'17/11/2026'),/al menos un gasto/);
});

test('el comprobante normal no cambió al extraer la línea del gasto',()=>{
  assert.match(app,/\.forEach\(\(it\) => \{\s*rows\.push\(fila\(lineaGastoKame\(rendicion, it, folioTransaccion, fecha, glosa\)\)\);/);
});

test('la base: admin, aprobada, ajena, solo ConDocumento aprobado, cuenta de gasto, con señal y registro',()=>{
  assert.match(sql,/v_motivo := public\.exigir_correccion_admin\(p_motivo\);/);
  assert.match(sql,/if r\.estado <> 'Aprobado' then/);
  assert.match(sql,/if r\.empleado_id = auth\.uid\(\) then raise exception 'No puedes corregir tu propia rendición\.'/);
  assert.match(sql,/if it\.tipo_item <> 'ConDocumento' then/);
  assert.match(sql,/v_cuenta !~ '\^4\\\.01\\\.03\\\.\[0-9\]\{2\}\$'/);
  const on=sql.indexOf("set_config('rinde.correccion_admin', '1', true)"),upd=sql.indexOf("update public.rendicion_items set tipo_item = 'SinDocumento'"),off=sql.indexOf("set_config('rinde.correccion_admin', '', true)");
  assert.ok(on>0&&on<upd&&upd<off);
  assert.match(sql,/'accion', 'cambiar_a_comprobante'/);
  assert.ok(sql.includes('revoke execute on function public.admin_cambiar_a_comprobante(uuid, jsonb, text) from public, anon;'));
  assert.match(sql,/raise exception 'proteger_aprobacion_item cambió; revisar la migración\.'/);
});

test('la app arma el ajuste ANTES de corregir y lo descarga después',()=>{
  const p=app.slice(app.indexOf('titulo: "Cambiar a Comprobante/Boleta"'),app.indexOf('titulo: "Anular aprobación"'));
  const iAjuste=p.indexOf('construirAjusteComprobante('),iRpc=p.indexOf('rpc("admin_cambiar_a_comprobante"'),iDesc=p.indexOf('descargarTextoCsv(ajuste.fileName');
  assert.ok(iAjuste>0&&iAjuste<iRpc&&iRpc<iDesc);
});
