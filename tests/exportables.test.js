const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const reportes=require('../reportes-exportacion.js');
const rendiciones=[{id:'r1',folio:18,empleado_nombre:'Persona de prueba',solicitud_fondo_id:'f',tipo_rendicion:'FondoPorRendir',estado:'Pendiente',monto_total:999,created_at:'2026-10-01T01:00:00Z'},{id:'r2',folio:19,empleado_nombre:'Persona de prueba',solicitud_fondo_id:'f',tipo_rendicion:'FondoPorRendir',estado:'Aprobado'}];
const items=[{id:'i1',rendicion_id:'r1',monto:70,estado:'Aprobado',nro_documento:'00123',adjunto_url:'privado/foto',cuenta_contable:'4.01'},{id:'i2',rendicion_id:'r1',monto:15,estado:'Rechazado',motivo_rechazo:'Documento duplicado'},{id:'i3',rendicion_id:'r1',monto:30,estado:'Pendiente'},{id:'i4',rendicion_id:'r2',monto:50,estado:'Aprobado'}];
const solicitudes=[{id:'f',folio:2,monto_solicitado:100,estado:'Aprobado'}];
test('los exportables concilian los estados del detalle y distinguen el exceso del fondo',()=>{
 const d=reportes.preparar(rendiciones,items,solicitudes,()=> 'Gastos cafetería');
 assert.equal(d.resumen[0]['Monto rendido'],115);assert.equal(d.resumen[0]['Monto aprobado'],70);assert.equal(d.resumen[0]['Monto rechazado'],15);assert.equal(d.resumen[0]['Monto pendiente'],30);
 assert.equal(d.detalle[0]['Fondo Asociado'],'S-2');assert.equal(d.detalle[0]['N° Documento'],'00123');assert.equal(d.detalle[1]['Estado'],'Rechazado');assert.equal(d.detalle[1]['Motivo Rechazo'],'Documento duplicado');assert.equal(d.detalle[0]['Nombre Cuenta'],'Gastos cafetería');
 assert.equal(d.fondos[0]['Monto Consumido'],150);assert.equal(d.fondos[0]['Saldo Disponible'],0);assert.equal(d.fondos[0]['Exceso Sobre Fondo'],50);
 assert.equal(d.resumen[0].Fecha.toISOString().slice(0,10),'2026-09-30');assert.equal(reportes.fecha('2026-10-01').toISOString().slice(0,10),'2026-10-01');
 assert.throws(()=>reportes.preparar(rendiciones,[{rendicion_id:'invisible',monto:10}],solicitudes),/no coinciden/);
});
test('Excel descargable conserva formatos, filtros, encabezados, fechas y folios al reabrirlo',async()=>{
 const ExcelJS=require('../assets/vendor/exceljs-4.4.0.min.js');const datos=reportes.preparar(rendiciones,items,solicitudes);datos.detalle[0].Descripción='=HYPERLINK("https://ejemplo.invalid")';
 const wb=reportes.crearLibro(ExcelJS,datos,new Date('2026-10-01T12:00:00Z')),guardado=await wb.xlsx.writeBuffer();const leido=new ExcelJS.Workbook();await leido.xlsx.load(guardado);
 const r=leido.getWorksheet('Resumen');assert.equal(r.views[0].state,'frozen');assert.equal(r.views[0].ySplit,5);assert(r.autoFilter);assert.equal(r.getCell('J6').numFmt,'"$"#,##0');assert.equal(r.getCell('J6').value,115);assert.equal(r.getCell('J8').value.result,165);assert(r.getCell('B6').value instanceof Date);assert.equal(r.getCell('B6').value.toISOString().slice(0,10),'2026-09-30');assert.equal(r.getCell('A5').fill.fgColor.argb,'FF167F76');
 const detalle=leido.getWorksheet('Detalle');assert.equal(detalle.getCell('K6').value,'00123');assert.equal(detalle.getCell('S6').value,'=HYPERLINK("https://ejemplo.invalid")');assert.equal(typeof detalle.getCell('S6').value,'string');
});
test('CSV contable bloquea diferencias entre gastos aprobados y contrapartida',()=>{
 const a=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),c=vm.createContext({fmtDateSlash:String,campoCSV:v=>String(v??''),CUENTA_CONTRAPARTIDA:{Reembolso:{cuenta:'2.1'}}});vm.runInContext(a.slice(a.indexOf('function csvRow('),a.indexOf('async function calcularSplitFondo(')),c);
 assert.throws(()=>c.construirFilasCSV({id:'r',created_at:'2026-10-01',tipo_rendicion:'Reembolso',monto_total:100},[{monto:120,estado:'Aprobado'}]),/no coinciden/);
});
