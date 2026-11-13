// Avisos de fondos (revisión de procesos 2026-11-12: 17 fondos abiertos, $2,8
// millones sin rendir, ninguno liquidado, nadie recibía aviso). Una sola fuente,
// estado_fondos_abiertos(), y una sola regla, clasificarFondos, escrita dos veces
// (pure.js para la app y _shared/avisos-fondos.ts para el correo).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const core=require('../pure.js');
const leer=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const app=leer('app.js'), ts=leer('supabase/functions/_shared/avisos-fondos.ts');
const fn=leer('supabase/functions/recordatorios-pendientes/index.ts');
const sql=leer('supabase/migrations/20261113140000_avisos_fondos.sql');

const fila=(o)=>({id:'f'+o.folio,empleado_id:'e1',empleado_nombre:'Ana Pérez',empresa:'Neo Gym',motivo:'Insumos',otorgado:100000,aprobado:0,pendiente:0,sin_rendir:100000,exceso:0,rendiciones_pendientes:0,dias_abierto:10,dias_sin_movimiento:10,ultimo_aviso_empleado:null,...o});

test('fondo quieto 7 días con plata sin rendir: aviso a la persona',()=>{
  const {porRendir,porLiquidar}=core.clasificarFondos([fila({folio:5,dias_sin_movimiento:7})]);
  assert.equal(porRendir.length,1);assert.equal(porRendir[0].sin_rendir,100000);
  assert.equal(porLiquidar.length,0,'a los 7 días todavía no se liquida');
  assert.equal(core.clasificarFondos([fila({folio:5,dias_sin_movimiento:6})]).porRendir.length,0,'6 días: nada');
});

test('con una rendición en revisión no se avisa nada: hay que revisarla primero',()=>{
  const r=core.clasificarFondos([fila({folio:5,dias_sin_movimiento:40,rendiciones_pendientes:1,pendiente:30000,sin_rendir:70000})]);
  assert.deepEqual([r.porRendir.length,r.porLiquidar.length],[0,0]);
});

test('para liquidar: gastado entero, o quieto 15 días; se agrupa por persona y empresa',()=>{
  const filas=[
    fila({folio:2,aprobado:100000,sin_rendir:0,dias_abierto:43,dias_sin_movimiento:3}),
    fila({folio:6,otorgado:50000,aprobado:20000,sin_rendir:30000,dias_abierto:20,dias_sin_movimiento:15}),
    fila({folio:9,empresa:'Grupo Wellness SpA',otorgado:80000,aprobado:90000,sin_rendir:0,exceso:10000,dias_abierto:5,dias_sin_movimiento:1}),
    fila({folio:11,otorgado:40000,sin_rendir:40000,dias_abierto:14,dias_sin_movimiento:14}),
  ];
  const {porRendir,porLiquidar}=core.clasificarFondos(filas);
  assert.equal(porLiquidar.length,2);
  const neo=porLiquidar.find((g)=>g.empresa==='Neo Gym');
  assert.deepEqual(neo.fondos.map((f)=>f.folio),[2,6],'S-11 (14 días) todavía no');
  assert.deepEqual([neo.otorgado,neo.aprobado,neo.neto,neo.dias],[150000,120000,30000,43],'devuelve $30.000');
  assert.equal(porLiquidar.find((g)=>g.empresa!=='Neo Gym').neto,-10000,'exceso: se le paga');
  assert.equal(porLiquidar[0].dias,43,'el más antiguo primero');
  assert.deepEqual(porRendir[0].fondos.map((f)=>f.folio),[6,11],'a la persona se le avisan los dos quietos con saldo');
});

test('un vuelto chico (caso real: S-14 con $27) no genera correo y queda para liquidar',()=>{
  const r=core.clasificarFondos([fila({folio:14,otorgado:20000,aprobado:19973,sin_rendir:27,dias_abierto:8,dias_sin_movimiento:8})]);
  assert.equal(r.porRendir.length,0);
  assert.equal(r.porLiquidar.length,1);assert.equal(r.porLiquidar[0].neto,27);
  assert.equal(core.clasificarFondos([fila({folio:14,sin_rendir:1000,dias_sin_movimiento:8})]).porRendir.length,1,'desde $1.000 sí se avisa');
});

test('texto del aviso al entregar otro fondo',()=>{
  assert.equal(core.textoFondosAbiertos([],'Ana'),'');
  const t=core.textoFondosAbiertos([fila({folio:11,sin_rendir:40000,dias_abierto:14}),fila({folio:2,sin_rendir:60000,pendiente:25000,dias_abierto:43})],'Ana Pérez');
  assert.equal(t,'Ana Pérez ya tiene 2 fondos abiertos (S-2, S-11): $100.000 sin rendir y $25.000 en revisión; el más antiguo se entregó hace 43 días.');
  assert.match(core.textoFondosAbiertos([fila({folio:3,dias_abierto:1,pendiente:0})],'Ana'),/^Ana ya tiene 1 fondo abierto \(S-3\): \$100\.000 sin rendir; el más antiguo se entregó hace 1 día\.$/);
});

test('la regla del correo es la misma que la de la app (pure.js = avisos-fondos.ts)',()=>{
  const pure=leer('pure.js');
  const cuerpo=(src)=>{const i=src.indexOf('function clasificarFondos(');return src.slice(src.indexOf('for (const f of',i),src.indexOf('return {',i));};
  const sinTipos=(s)=>s.replace(/<[^>]*>/g,'').replace(/\(filas \|\| \[\]\)/,'filas').replace(/\s+/g,' ').trim();
  assert.equal(sinTipos(cuerpo(ts)),sinTipos(cuerpo(pure)));
  for(const src of [ts,pure]) assert.match(src,/\{ diasRendir = 7, diasLiquidar = 15, montoMinimo = 1000 \} = \{\}/);
});

test('la app avisa antes de aprobar o registrar un fondo y muestra Fondos por cerrar',()=>{
  assert.match(app,/const abiertos = await avisoFondosAbiertos\(s\.empleado_id, s\.empleado_nombre, s\.id\);\s*if \(!confirm\(\(abiertos \? abiertos \+ "\\n\\n" : ""\) \+ `¿Aprobar la solicitud/);
  assert.match(app,/const abiertos = await avisoFondosAbiertos\(empleado\.id, empleado\.nombre\);\s*if \(!confirm\(\(abiertos \? abiertos \+ "\\n\\n" : ""\) \+ `¿Registrar un fondo APROBADO/);
  assert.match(app,/if \(esAprobadorEfectivo\(perfil\)\) void mostrarFondosPorCerrar\(gen\);/);
  const aviso=app.slice(app.indexOf('async function avisoFondosAbiertos('),app.indexOf('async function mostrarFondosPorCerrar('));
  assert.match(aviso,/catch \(error\) \{[^}]*return "";/,'si la consulta falla, el aviso no bloquea la aprobación');
  assert.match(app,/if \(gen !== dashboardCarga\) return;/,'no pinta datos de una carga vieja');
});

test('el correo: simulación sin envíos, un aviso por semana, y no depende de que haya pendientes',()=>{
  assert.match(fn,/import \{ clasificarFondos, type FilaFondo \} from "\.\.\/_shared\/avisos-fondos\.ts";/);
  assert.match(fn,/const DIAS_FONDO_SIN_RENDIR = 7;\s*const DIAS_FONDO_PARA_LIQUIDAR = 15;/);
  assert.match(fn,/if \(simular \|\| !correo\) continue;/);
  assert.match(fn,/if \(!simular && !yaAvisado\)/);
  assert.match(fn,/new Date\(f\.ultimo_aviso_empleado\)\.getTime\(\) < haceUnaSemana/);
  assert.match(fn,/admin\.rpc\("marcar_aviso_fondos", \{ p_ids: fondos\.map\(\(f\) => f\.id\) \}\)/);
  const i=fn.indexOf('avisarFondos(admin, destinatariosAprobadores, simular)'), j=fn.indexOf('if (totalPendientes === 0 || simular)');
  assert.ok(i>0 && j>i,'los avisos de fondos corren antes de la salida temprana');
  assert.match(fn,/try \{ fondos = await avisarFondos\(admin, destinatariosAprobadores, simular\); \}\s*catch \(e\) \{ [^\n]*logEvent\(admin, "aviso_fondos_fail"/,'si fallan, queda en Salud del sistema y sigue el resumen');
});

test('la base: solo admin/aprobador ven el estado; solo el servidor marca avisos',()=>{
  assert.match(sql,/coalesce\(auth\.role\(\), ''\) = 'service_role' or \(auth\.uid\(\) is not null and public\.is_activo\(\) and public\.is_admin_or_aprobador\(\)\)/);
  assert.match(sql,/revoke execute on function public\.marcar_aviso_fondos\(uuid\[\]\) from public, anon, authenticated;/);
  assert.match(sql,/revoke all on public\.avisos_fondos from anon, authenticated;/);
  assert.match(sql,/count\(\*\) filter \(where v\.estado = 'Pendiente'\)::integer rendiciones_pendientes/);
});
