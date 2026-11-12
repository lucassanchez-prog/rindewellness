// Rendir gastos en dólares: el monto en pesos es USD x dólar observado del día,
// redondeado al peso igual que la base. Casos reales: comprobantes de Netlify
// (USD 9,00 del 9-sep y del 9-nov; USD 8,71 del 9-nov tras un crédito de 0,29).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const core=require('../pure.js');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261113120000_rendir_en_dolares.sql'),'utf8');

test('lee montos en dólares escritos de cualquier forma',()=>{
  for(const [texto,esperado] of [['9.00',9],['9,00',9],['8.71',8.71],['8,71',8.71],['USD 8.71',8.71],['$9.00',9],['1.234,56',1234.56],['1,234.56',1234.56],['1.234',1234],['979,88',979.88],['979.88',979.88],['12',12]])
    assert.equal(core.parseDecimal(texto),esperado,texto);
  for(const vacio of ['','abc',null]) assert.equal(core.parseDecimal(vacio),null);
});

test('pasa a pesos redondeando al peso, sin errores de punto flotante',()=>{
  assert.equal(core.pesosDesdeDolares(9,979.88),8819,'9 x 979,88 = 8.818,92');
  assert.equal(core.pesosDesdeDolares(8.71,979.88),8535,'8,71 x 979,88 = 8.534,75');
  assert.equal(core.pesosDesdeDolares(9,926.94),8342,'Netlify de septiembre: 9 x 926,94 = 8.342,46');
  assert.equal(core.pesosDesdeDolares(0.1,1000.5),100,'0,1 x 1.000,5 = 100,05');
  assert.equal(core.pesosDesdeDolares(0,979.88),null);assert.equal(core.pesosDesdeDolares(9,0),null);
});

test('la app manda la moneda al enviar y no confunde USD 9.00 con 900 pesos al leer',()=>{
  const envio=app.slice(app.indexOf('async function submitRendicion('),app.indexOf('const usuarioEnvio = currentUser.id;'));
  assert.match(envio,/const monedaGasto = leerMonedaGasto\(id, monto\);\s*if \(monedaGasto\.error\)/);
  assert.match(envio,/tipo_item: "SinDocumento",\s*\.\.\.monedaGasto\.datos,/);
  assert.match(app,/if \(montoIA2 && document\.getElementById\(`\$\{id\}-moneda`\)\?\.value !== "USD"\)/,'en dólares la lectura no escribe pesos');
  assert.match(app,/if \(window\.RindeCore\.pesosDesdeDolares\(usd, tc\) !== montoPesos\)/,'no envía pesos que no calcen');
  assert.match(app,/db\.rpc\("dolar_observado", \{ p_fecha: fechaISO \}\)/);
});

test('la base valida que cuadre, solo en Comprobante/Boleta, y guarda la moneda al enviar',()=>{
  assert.match(sql,/abs\(new\.monto - round\(new\.monto_original \* new\.tipo_cambio\)\) > 1/);
  assert.match(sql,/if new\.tipo_item <> 'SinDocumento' then/);
  assert.match(sql,/where moneda = 'USD' and fecha <= p_fecha and fecha >= p_fecha - 10/,'fin de semana o feriado: el último publicado, máximo 10 días');
  assert.match(sql,/moneda text,monto_original numeric,tipo_cambio numeric,fecha_tipo_cambio date\);/,'crear_rendicion_completa recibe los datos de moneda');
  assert.match(sql,/revoke insert, update, delete on public\.tipos_cambio from anon, authenticated;/,'nadie escribe el dólar a mano en la tabla');
});
