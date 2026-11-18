// Dividir una rendición entre dos empresas (2026-11-18). Caso real: N° 99,
// notaría por finiquitos de Dmoov SpA y Dmoov Corp SpA, 50% y 50%.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261118120000_dividir_rendicion.sql'),'utf8');

test('la base exige admin, pendiente, ajena, sin Kame, reembolso, gastos pendientes, sin facturas y en pesos',()=>{
  assert.match(sql,/v_motivo := public\.exigir_correccion_admin\(p_motivo\);/);
  for(const m of ["Solo se divide una rendición pendiente","No puedes dividir tu propia rendición","ya se descargó para Kame; no se divide",
    "Solo se dividen reembolsos","Hay gastos ya revisados","está emitida a una sola empresa; no se divide","Hay gastos en dólares",
    "El porcentaje de la nueva rendición debe estar entre 1 y 99","demasiado chico para dividirlo"])
    assert.ok(sql.includes(m),'falta la regla: '+m);
  assert.ok(sql.includes('revoke execute on function public.admin_dividir_rendicion(uuid, text, text, text, text, numeric, text) from public, anon;'));
});

test('cada gasto se reparte sin perder un peso y la nueva queda pendiente con el mismo comprobante',()=>{
  assert.match(sql,/v_parte := round\(it\.monto \* p_porcentaje_nueva \/ 100\);/);
  assert.match(sql,/update public\.rendicion_items set monto = it\.monto - v_parte, empresa = v_ea, centro_costo = v_ca where id = it\.id;/);
  assert.match(sql,/it\.adjunto_url, it\.nombre_proveedor, v_cn, 'Pendiente', it\.orden, 'CLP'\)/);
  assert.match(sql,/values \(r\.empleado_id, r\.empleado_nombre, r\.rut_empleado, 'Reembolso', 'Pendiente',/);
  assert.match(sql,/'accion', 'dividir_rendicion'/);
});

test('la app ofrece dividir solo si todos los gastos son pendientes, sin documento y en pesos, y reparte igual que la base',()=>{
  assert.match(app,/const divisible = items\.length && items\.every\(\(it\) => it\.estado === "Pendiente" && it\.tipo_item !== "ConDocumento" && \(it\.moneda \|\| "CLP"\) === "CLP"\);/);
  assert.match(app,/Math\.round\(Number\(it\.monto\) \* p \/ 100\)/);
  assert.match(app,/rpc\("admin_dividir_rendicion", \{ p_rendicion: r\.id, p_empresa_actual: actual\.emp\.value, p_cc_actual: actual\.cc\.value,/);
  const i=app.indexOf('if (pendienteLibre && sinFondo) {'),j=app.indexOf('titulo: "Dividir entre empresas"');
  assert.ok(i>0&&j>i&&j<app.indexOf('titulo: "Traspasar a otro empleado"'),'dentro del bloque de reembolsos pendientes sin Kame');
});
