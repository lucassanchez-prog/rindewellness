const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const reportes=require('../reportes-exportacion.js');
test('CSV general conserva comas y neutraliza fórmulas sin convertir importes numéricos en texto',()=>{
 const core=require('../pure.js');assert.equal(core.campoCSVSeguro('Proveedor, sucursal'),'"Proveedor, sucursal"');assert.equal(core.campoCSVSeguro('=SUM(1,2)'), '"\'=SUM(1,2)"');assert.equal(core.campoCSVSeguro(' @SUM(A1)'),"' @SUM(A1)");assert.equal(core.campoCSVSeguro(-10),'-10');
});

// r1 pendiente (fondo S-2), r2 aprobada y repartida entre S-2 y S-3, r3 de otra empresa y otro mes.
const rendiciones=[
 {id:'r1',folio:18,empleado_nombre:'Persona Uno',empresa:'Dmoov Corp SpA',solicitud_fondo_id:'f',tipo_rendicion:'FondoPorRendir',estado:'Pendiente',monto_total:100,monto_rendido:115,fecha_rendicion:'2026-10-05',created_at:'2026-10-05T15:00:00Z'},
 {id:'r2',folio:19,empleado_nombre:'Persona Uno',empresa:'Dmoov Corp SpA',solicitud_fondo_id:'f',tipo_rendicion:'FondoPorRendir',estado:'Aprobado',monto_total:150,monto_rendido:150,fecha_rendicion:'2026-10-20',created_at:'2026-10-20T15:00:00Z',fecha_aprobacion:'2026-10-22T15:00:00Z',kame_exportado_en:'2026-10-23T12:00:00Z'},
 {id:'r3',folio:20,empleado_nombre:'Persona Dos',empresa:'Neo Gym Chile SpA',tipo_rendicion:'Reembolso',estado:'Aprobado',monto_total:40,monto_rendido:40,created_at:'2026-09-10T02:00:00Z',fecha_aprobacion:'2026-09-15T12:00:00Z'},
];
const items=[
 {id:'i1',rendicion_id:'r1',monto:70,estado:'Aprobado',nro_documento:'00123',adjunto_url:'u/x-0-a',cuenta_contable:'4.01',tipo_item:'ConDocumento',existe_en_contabilidad:true,centro_costo:'Casa Matriz',categoria:'Materiales'},
 {id:'i2',rendicion_id:'r1',monto:15,estado:'Rechazado',motivo_rechazo:'Documento duplicado',adjunto_url:'u/x-1-b',centro_costo:'Casa Matriz'},
 {id:'i3',rendicion_id:'r1',monto:30,estado:'Pendiente',adjunto_url:'u/x-2-c',centro_costo:'Sede Norte'},
 {id:'i4',rendicion_id:'r2',monto:150,estado:'Aprobado',adjunto_url:'u/y-0-d',cuenta_contable:'4.01',centro_costo:'Casa Matriz',categoria:'Materiales'},
 {id:'i5',rendicion_id:'r3',monto:40,estado:'Aprobado',cuenta_contable:'4.02',centro_costo:'Casa Matriz'},
];
const solicitudes=[{id:'f',folio:2,monto_solicitado:100,estado:'Aprobado',empresa:'Dmoov Corp SpA'},{id:'g',folio:3,monto_solicitado:500,estado:'Aprobado',empresa:'Dmoov Corp SpA'}];
// Como la vista rendiciones_por_fondo: r2 aporta 100 a S-2 (tope) y 50 a S-3 (resto).
const porFondo=[
 {id:'r1',folio:18,estado:'Pendiente',solicitud_fondo_id:'f',orden:0,monto_total:100,monto_aprobado:70},
 {id:'r2',folio:19,estado:'Aprobado',solicitud_fondo_id:'f',orden:0,monto_total:100,monto_aprobado:100},
 {id:'r2',folio:19,estado:'Aprobado',solicitud_fondo_id:'g',orden:1,monto_total:50,monto_aprobado:50},
];
const nombreCuenta=c=>({'4.01':'Materiales','4.02':'Viáticos'})[c]||'';

test('filtra por período (fecha de la rendición o de envío), empresa y estado',()=>{
 const oct=reportes.preparar(rendiciones,items,solicitudes,{filtro:{desde:'2026-10-01',hasta:'2026-10-31'},porFondo});
 assert.deepEqual(oct.rendiciones.map(r=>r.Folio),[18,19]);
 assert.match(oct.filtroTexto,/del 01-10-2026 al 31-10-2026/);
 assert.deepEqual(reportes.preparar(rendiciones,items,solicitudes,{filtro:{empresa:'Neo Gym Chile SpA'}}).rendiciones.map(r=>r.Folio),[20]);
 assert.deepEqual(reportes.preparar(rendiciones,items,solicitudes,{filtro:{estado:'Aprobado'}}).rendiciones.map(r=>r.Folio),[19,20]);
 // r3 no tiene fecha_rendicion: se usa la de envío en hora de Chile (09-09, no 10-09).
 assert.deepEqual(reportes.preparar(rendiciones,items,solicitudes,{filtro:{desde:'2026-09-09',hasta:'2026-09-09'}}).rendiciones.map(r=>r.Folio),[20]);
});

test('los totales concilian por estado y los cortes suman lo mismo',()=>{
 const d=reportes.preparar(rendiciones,items,solicitudes,{nombreCuenta,porFondo});
 assert.equal(d.rendiciones[0].Rendido,115);assert.equal(d.rendiciones[0].Aprobado,70);assert.equal(d.rendiciones[0].Rechazado,15);assert.equal(d.rendiciones[0].Pendiente,30);
 assert.deepEqual([d.totales.rendido,d.totales.aprobado,d.totales.rechazado,d.totales.pendiente],[305,260,15,30]);
 for(const corte of ['porEmpresa','porMes','porCategoria','porEmpleado','porCentro','porCuenta'])assert.equal(d[corte].reduce((s,g)=>s+g.aprobado,0),260,corte);
 assert.equal(d.porCentro.find(g=>g.centro==='Sede Norte').pendiente,30);
 assert.equal(d.porCuenta.find(g=>g.clave==='4.02').nombre,'Viáticos');
 assert.equal(d.gastos[0]['N° documento'],'00123');assert.equal(d.gastos[0]['En contabilidad'],'Sí');assert.equal(d.gastos[1]['Motivo rechazo'],'Documento duplicado');
 assert.equal(d.rendiciones[1]['Días en aprobar'],2);assert.equal(d.rendiciones[1]['CSV Kame'],'Descargado');assert.equal(d.rendiciones[2]['CSV Kame'],'Falta');
 assert.equal(d.totales.faltaKame,1);
});

test('fondos con multifondo: cada fondo cuenta solo su parte',()=>{
 const d=reportes.preparar(rendiciones,items,solicitudes,{porFondo});
 const s2=d.fondos.find(f=>f.Folio==='S-2'),s3=d.fondos.find(f=>f.Folio==='S-3');
 assert.equal(s2.Consumido,200);assert.equal(s2.Exceso,100);assert.equal(s2.Saldo,0);assert.equal(s2.Rendiciones,'N° 18, N° 19');
 assert.equal(s3.Consumido,50);assert.equal(s3.Saldo,450);
 assert.equal(d.rendiciones.find(r=>r.Folio===19).Fondo,'S-2 + S-3');
 // Sin la vista (antes): el Excel atribuía la rendición entera al fondo principal.
 assert.equal(d.fondos.reduce((s,f)=>s+f.Consumido,0),250);
});

test('la cuadratura marca lo que no cuadra',()=>{
 const ok=reportes.preparar(rendiciones,items,solicitudes,{porFondo});
 assert.equal(ok.cuadratura.filter(c=>c.Estado==='Revisar').length,1,'solo falta un comprobante');
 assert.match(ok.cuadratura.find(c=>/comprobante adjunto/.test(c.Control)).Resultado,/1 sin comprobante/);
 const malo=reportes.preparar(rendiciones.map(r=>r.id==='r2'?{...r,monto_rendido:999}:r),items,solicitudes,{porFondo});
 assert.match(malo.cuadratura[0].Resultado,/N° 19/);assert.equal(malo.cuadratura[0].Estado,'Revisar');
 assert.throws(()=>reportes.preparar(rendiciones,[{rendicion_id:'invisible',monto:10}],solicitudes),/no coinciden/);
});

test('Excel descargable: hojas, formatos, tablas y textos que no se vuelven fórmulas',async()=>{
 const ExcelJS=require('../assets/vendor/exceljs-4.4.0.min.js');
 const datos=reportes.preparar(rendiciones,items,solicitudes,{nombreCuenta,porFondo,filtro:{desde:'2026-09-01',hasta:'2026-10-31'}});datos.gastos[0]['Descripción']='=HYPERLINK("https://ejemplo.invalid")';
 const wb=reportes.crearLibro(ExcelJS,datos,new Date('2026-11-01T12:00:00Z')),guardado=await wb.xlsx.writeBuffer();const leido=new ExcelJS.Workbook();await leido.xlsx.load(guardado);
 assert.deepEqual(leido.worksheets.map(w=>w.name),['Resumen','Rendiciones','Gastos','Por centro de costo','Por cuenta contable','Fondos','Cuadratura']);
 const res=leido.getWorksheet('Resumen');assert.equal(res.getCell('A5').value,305);assert.equal(res.getCell('C5').value,260);assert.equal(res.getCell('A5').numFmt,'"$"#,##0');assert.match(res.getCell('A2').value,/del 01-09-2026 al 31-10-2026/);
 const r=leido.getWorksheet('Rendiciones');assert.equal(r.getCell('A4').value,'Folio');assert.equal(r.getCell('J5').value,115);assert.equal(r.getCell('J5').numFmt,'"$"#,##0');assert(r.getCell('B5').value instanceof Date);assert.equal(r.getCell('B5').value.toISOString().slice(0,10),'2026-10-05');assert.equal(r.views[0].ySplit,4);
 const g=leido.getWorksheet('Gastos');assert.equal(g.getCell('J5').value,'00123');assert.equal(g.getCell('T5').value,'=HYPERLINK("https://ejemplo.invalid")');assert.equal(typeof g.getCell('T5').value,'string');
 const q=leido.getWorksheet('Cuadratura');assert.equal(q.getCell('A4').value,'Control');assert.ok(q.getCell('C5').value);
});

test('CSV contable bloquea diferencias entre gastos aprobados y contrapartida',()=>{
 const a=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),c=vm.createContext({fmtDateSlash:String,campoCSV:v=>String(v??''),CUENTA_CONTRAPARTIDA:{Reembolso:{cuenta:'2.1'}}});vm.runInContext(a.slice(a.indexOf('function csvRow('),a.indexOf('async function calcularSplitFondo(')),c);
 assert.throws(()=>c.construirFilasCSV({id:'r',created_at:'2026-10-01',tipo_rendicion:'Reembolso',monto_total:100},[{monto:120,estado:'Aprobado'}]),/no coinciden/);
});
