const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const core=require('../pure.js');
const fondo={id:'fondo-prueba',folio:5,empleado_id:'empleado',empleado_nombre:'Persona de prueba',rut_empleado:'12.345.678-5',empresa:'Empresa de prueba',estado:'Aprobado',monto_solicitado:2000000};
const opciones={fecha:'2026-01-15',cuentaBanco:'1.01.01.01',nombreBanco:'Banco de prueba',referencia:'TR-123',entregaConfirmada:true};
test('entrega de fondo: egreso equilibrado, ficha del empleado y folio en ambas glosas',()=>{
 const c=core.comprobanteEntregaFondo({...fondo,saldo:0,consumo_aprobado:2000000},opciones);
 assert.equal(c.filas.length,2);assert.equal(c.monto,2000000);
 assert.equal(c.filas.reduce((n,r)=>n+r[6],0),2000000);assert.equal(c.filas.reduce((n,r)=>n+r[7],0),2000000);
 for(const row of c.filas){assert.equal(row.length,17);assert.equal(row[0],'EGRESO');assert.equal(row[3],'15/01/2026');assert.match(row[4],/ENTREGA FONDO S-5/);assert.equal(row[4],row[8]);assert.match(row[4],/REF TR-123/);}
 assert.equal(c.filas[0][5],'1.01.11.05');assert.equal(c.filas[0][9],'12.345.678-5');assert.equal(c.filas[0][12],'5');
 assert.equal(c.filas[1][5],opciones.cuentaBanco);assert.equal(c.filas[1][9],'');assert.equal(c.fileName,'comprobante_entrega_fondo_S-5.csv');
});
test('no permite exportar estados no aprobados ni montos inválidos',()=>{
 for(const estado of ['Pendiente','Rechazado',null])assert.throws(()=>core.comprobanteEntregaFondo({...fondo,estado},opciones),/aprobado/);
 for(const monto_solicitado of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>core.comprobanteEntregaFondo({...fondo,monto_solicitado},opciones),/monto/);
});
test('exige fecha real no futura, banco distinto del fondo y confirmación de entrega',()=>{
 for(const fecha of ['', '2026-02-30','2026-13-01','2026-1-1','2999-01-01'])assert.throws(()=>core.comprobanteEntregaFondo(fondo,{...opciones,fecha}),/fecha/);
 for(const cuentaBanco of ['', '=1+1','1.01.11.05','1;2','caja'])assert.throws(()=>core.comprobanteEntregaFondo(fondo,{...opciones,cuentaBanco}),/cuenta/);
 assert.throws(()=>core.comprobanteEntregaFondo(fondo,{...opciones,nombreBanco:''}),/nombre/);
 assert.throws(()=>core.comprobanteEntregaFondo(fondo,{...opciones,entregaConfirmada:false}),/Confirma/);
 assert.throws(()=>core.comprobanteEntregaFondo({...fondo,rut_empleado:'12345678-0'},opciones),/RUT/);
 assert.throws(()=>core.comprobanteEntregaFondo({...fondo,folio:null},opciones),/folio/);
});
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function context({solicitud=fondo,perfil={nombre:'Persona actualizada',rut:'12.345.678-5'},rol='admin',error=null,errorPerfil=null}={}){
 const ctx=vm.createContext({window:{RindeCore:core},esAprobadorEfectivo:core.esAprobadorEfectivo,currentProfile:{rol},CSV_HEADER:'cabecera',campoCSVSeguro:core.campoCSVSeguro,db:{from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>table==='profiles'?{data:perfil,error:errorPerfil}:{data:solicitud,error}})})})}});
 vm.runInContext(app.slice(app.indexOf('async function prepararComprobanteEntregaFondo('),app.indexOf('function panelContabilizarFondo(')),ctx);return ctx;
}
test('reconsulta fondo y perfil vigente antes de generar; conserva CSV con comillas y separadores',async()=>{
 const ctx=context({perfil:{nombre:'Persona; "Nueva"',rut:'12.345.678-5'}});
 const c=await ctx.prepararComprobanteEntregaFondo('fondo-prueba',opciones);
 assert.match(c.content,/"Persona; ""Nueva"""/);assert.match(c.content,/ENTREGA FONDO S-5/);
});
test('bloquea falta de permisos, errores de lectura y rechazo posterior a abrir el detalle',async()=>{
 await assert.rejects(()=>context({rol:'empleado'}).prepararComprobanteEntregaFondo('id',opciones),/administradores/);
 await assert.rejects(()=>context({error:{message:'sin red'}}).prepararComprobanteEntregaFondo('id',opciones),/actualizar/);
 await assert.rejects(()=>context({errorPerfil:{message:'sin red'}}).prepararComprobanteEntregaFondo('id',opciones),/RUT/);
 await assert.rejects(()=>context({solicitud:{...fondo,estado:'Rechazado'}}).prepararComprobanteEntregaFondo('id',opciones),/aprobado/);
});
test('protege texto de la ficha que Excel podría interpretar como fórmula',async()=>{
 const c=await context({perfil:{nombre:'=1+1',rut:'12.345.678-5'}}).prepararComprobanteEntregaFondo('id',opciones);
 assert.match(c.content,/;'=1\+1;/);
});
