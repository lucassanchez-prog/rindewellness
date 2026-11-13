// jsPDF 2.5.1 -> 4.2.1, jspdf-autotable 3.8.2 -> 5.0.9, pdf.js 3.11.174 -> 6.4.299
// (2026-11-13). Probado en el navegador con 3 facturas reales y una chilena:
// mismo texto, misma imagen (0,00% de píxeles distintos) y misma lectura local.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const leer=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const app=leer('app.js'), html=leer('index.html'), data=require('../data-access.js');

test('versiones fijadas y pdf.js cargado una sola vez, a pedido',()=>{
  assert.match(html,/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/4\.2\.1\/jspdf\.umd\.min\.js/);
  assert.match(html,/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf-autotable\/5\.0\.9\/jspdf\.plugin\.autotable\.min\.js/);
  assert.doesNotMatch(html,/pdf\.js\/|pdfjs-dist|pdf\.min\.m?js/,'pdf.js ya no se descarga al abrir la app');
  assert.match(app,/const PDFJS_URL = "https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@6\.4\.299\/legacy\/build\/pdf\.min\.mjs";/);
  assert.match(app,/const PDFJS_WORKER_URL = "https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@6\.4\.299\/legacy\/build\/pdf\.worker\.min\.mjs";/);
  assert.match(app,/import\(PDFJS_URL\)/);
});

test('pdf.js 6 quitó pdf.destroy(): se libera siempre con cerrarPdf',()=>{
  assert.doesNotMatch(app,/\bpdf\.destroy\(\)/);
  assert.equal((app.match(/window\.RindeData\.cerrarPdf\(pdf\)/g)||[]).length,10);
});

test('cerrarPdf funciona con pdf.js 6, con pdf.js 3 y sin documento',async()=>{
  const llamadas=[];
  await data.cerrarPdf({loadingTask:{destroy:async()=>llamadas.push('tarea')}});
  await data.cerrarPdf({destroy:async()=>llamadas.push('documento')});
  await data.cerrarPdf(null);
  assert.deepEqual(llamadas,['tarea','documento']);
});

test('la tabla del informe usa la forma de jspdf-autotable 5',()=>{
  assert.doesNotMatch(app,/doc\.autoTable\(/);
  assert.equal((app.match(/autoTable\(doc, ?\{/g)||[]).length,3,'resumen, gastos sin comprobante y anexo');
  assert.match(app,/const autoTable = window\.autoTable \|\| \(\(d, o\) => d\.autoTable\(o\)\);/);
});
