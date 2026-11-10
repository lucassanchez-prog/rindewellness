const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const core=require('../pure.js');

// Mismos montos que los fondos S-1, 2, 3, 5, 6, 7 y 8 de Miguel Espinoza al
// 09-11-2026 (vista previa real de preparar_liquidacion_fondos).
const detalleMiguel=[
 {folio_fondo:1,otorgado:300000,aprobado:326462,restante:0,exceso:26462,excesos:[{folio:19,monto:26462}]},
 {folio_fondo:2,otorgado:350000,aprobado:292071,restante:57929,exceso:0,excesos:[]},
 {folio_fondo:3,otorgado:650000,aprobado:1163283,restante:0,exceso:513283,excesos:[{folio:55,monto:513283}]},
 {folio_fondo:5,otorgado:2000000,aprobado:1803296,restante:196704,exceso:0,excesos:[]},
 {folio_fondo:6,otorgado:800000,aprobado:658566,restante:141434,exceso:0,excesos:[]},
 {folio_fondo:7,otorgado:1200000,aprobado:1291088,restante:0,exceso:91088,excesos:[{folio:45,monto:91088}]},
 {folio_fondo:8,otorgado:1200000,aprobado:1645043,restante:0,exceso:445043,excesos:[{folio:52,monto:445043}]},
];
const base={folio:1,empresa:'Centros Deportivos SpA',empleado_nombre:'Persona Prueba',rut_empleado:'11.111.111-1',fecha:'2026-11-09',cuenta_banco:'1.01.02.01',nombre_banco:'Banco'};

test('compensa excesos con restantes y deja la diferencia en su documento de Kame, sin banco',()=>{
 const c=core.comprobanteLiquidacionFondos({...base,resultado:'Pago',total_restante:396067,total_exceso:1075876,monto_neto:679809},[...detalleMiguel].reverse());
 assert.equal(c.tipo,'TRASPASO');assert.equal(c.total,396067);assert.equal(c.compensado,396067);assert.equal(c.fileName,'comprobante_liquidacion_L-1.csv');
 assert.ok(c.filas.every(f=>f[0]==='TRASPASO'&&(f[5]==='2.01.07.29'||f[5]==='1.01.11.05')),'no hay línea de banco');
 const exc=c.filas.filter(f=>f[5]==='2.01.07.29'),rest=c.filas.filter(f=>f[5]==='1.01.11.05');
 assert.deepEqual(exc.map(f=>[f[6],f[12]]),[[26462,'19'],[369605,'55']],'se compensa por orden de folio; el último en parte');
 assert.deepEqual(rest.map(f=>[f[7],f[12]]),[[57929,'2'],[196704,'5'],[141434,'6']],'cada restante sale con el folio del fondo');
 assert.match(exc[1][8],/^Compensa en parte exceso rendición N° 55/);
 assert.deepEqual(c.pendientes.map(p=>[p.cuenta,p.folio,p.monto]),[['2.01.07.29',55,143678],['2.01.07.29',45,91088],['2.01.07.29',52,445043]]);
 assert.equal(c.pendientes.reduce((s,p)=>s+p.monto,0),679809);
 assert.equal(c.filas.reduce((s,f)=>s+f[6],0),c.filas.reduce((s,f)=>s+f[7],0));
 assert.equal(exc[0][9],'11.111.111-1');assert.equal(exc[0][11],'Otros');assert.equal(exc[0][3],'09/11/2026');
 assert.equal(c.filas[0].length,17);assert.doesNotMatch(c.glosa,/REF/);
});

test('devolución pendiente, devolución parcial y compensación exacta',()=>{
 const dev=core.comprobanteLiquidacionFondos({...base,resultado:'Devolucion',total_restante:439216,total_exceso:0,monto_neto:439216,cuenta_banco:null},[{folio_fondo:9,otorgado:1225675,aprobado:786459,restante:439216,exceso:0,excesos:[]}]);
 assert.deepEqual(dev.filas,[],'sin excesos no hay nada que cruzar');
 assert.deepEqual(dev.pendientes.map(p=>[p.cuenta,p.folio,p.monto]),[['1.01.11.05',9,439216]]);
 const mix=core.comprobanteLiquidacionFondos({...base,resultado:'Devolucion',total_restante:800,total_exceso:500,monto_neto:300},
  [{folio_fondo:1,restante:0,exceso:500,excesos:[{folio:7,monto:500}]},{folio_fondo:2,restante:800,exceso:0,excesos:[]}]);
 assert.deepEqual(mix.filas.map(f=>[f[5],f[6],f[7],f[12]]),[['2.01.07.29',500,0,'7'],['1.01.11.05',0,500,'2']]);
 assert.deepEqual(mix.pendientes.map(p=>[p.cuenta,p.folio,p.monto]),[['1.01.11.05',2,300]]);
 const comp=core.comprobanteLiquidacionFondos({...base,cuenta_banco:null,nombre_banco:null,resultado:'Compensado',total_restante:500,total_exceso:500,monto_neto:0},
  [{folio_fondo:1,restante:0,exceso:500,excesos:[{folio:7,monto:500}]},{folio_fondo:2,restante:500,exceso:0,excesos:[]}]);
 assert.equal(comp.tipo,'TRASPASO');assert.deepEqual(comp.filas.map(f=>[f[5],f[6],f[7]]),[['2.01.07.29',500,0],['1.01.11.05',0,500]]);assert.deepEqual(comp.pendientes,[]);
 const exacto=core.comprobanteLiquidacionFondos({...base,resultado:'Compensado',total_restante:0,total_exceso:0,monto_neto:0},[{folio_fondo:4,restante:0,exceso:0,excesos:[]}]);
 assert.deepEqual(exacto.filas,[],'un fondo consumido exacto no necesita asiento');
});

test('rechaza liquidaciones que no cuadran o sin datos para Kame',()=>{
 const pago={...base,resultado:'Pago',total_restante:396067,total_exceso:1075876,monto_neto:679809};
 assert.throws(()=>core.comprobanteLiquidacionFondos({...pago,monto_neto:600000},detalleMiguel),/no cuadra/);
 assert.throws(()=>core.comprobanteLiquidacionFondos({...pago,resultado:'Devolucion'},detalleMiguel),/no cuadra/);
 assert.throws(()=>core.comprobanteLiquidacionFondos(pago,detalleMiguel.map(d=>d.folio_fondo===3?{...d,excesos:[]}:d)),/S-3 no cuadra/);
 assert.throws(()=>core.comprobanteLiquidacionFondos({...pago,rut_empleado:'11.111.111-2'},detalleMiguel),/RUT/);
 assert.throws(()=>core.comprobanteLiquidacionFondos({...pago,anulada_en:'2026-11-09T12:00:00Z'},detalleMiguel),/anulada/);
});

test('la app manda el neto que vio quien liquida y solo ofrece fondos abiertos',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 assert.match(app,/rpc\("liquidar_fondos", \{ p_fondos: previa\.ids, p_fecha: fecha\.value, p_neto_esperado: Number\(previa\.neto\),\s*p_observacion/);
 const armar=app.slice(app.indexOf('async function armarFormularioLiquidacion('),app.indexOf('async function bloqueLiquidacion('));
 assert.match(armar,/\.eq\("estado", "Aprobado"\)/);
 assert.match(armar,/r\.estado !== "Aprobado" && r\.estado !== "Rechazado"/,'un fondo con rendiciones en revisión no se puede marcar');
 assert.doesNotMatch(armar,/cuenta_banco|nombre_banco|p_referencia/,'no se pide banco al liquidar');
 const sinBanco=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261110140000_liquidacion_sin_banco.sql'),'utf8');
 assert.match(sinBanco,/drop constraint if exists liquidacion_banco/);assert.doesNotMatch(sinBanco,/Indica el código en Kame de la cuenta bancaria/);
 const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261110120000_liquidacion_fondos.sql'),'utf8');
 assert.match(sql,/s\.estado in \('Aprobado','Cerrado'\)/,'el CSV de una rendición sigue saliendo con el fondo cerrado');
});
