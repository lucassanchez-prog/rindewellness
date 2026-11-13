// Netlify publica solo dist/ (scripts/publicar.sh). Antes publicaba el
// repositorio entero: SQL, código del servidor, pruebas y notas internas.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const leer=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const script=leer('scripts/publicar.sh'), toml=leer('netlify.toml');
const lista=script.slice(script.indexOf('ARCHIVOS=('),script.indexOf(')',script.indexOf('ARCHIVOS=('))).split(/\s+/).slice(1).filter(Boolean);

test('cada archivo que carga la página está en la lista de publicación',()=>{
  const html=leer('index.html');
  const locales=[...html.matchAll(/(?:src|href)="([a-z\-]+\.(?:js|css|json))(?:\?v=\d+)?"/g)].map(m=>m[1]);
  assert.ok(locales.length>=14);
  for(const f of [...locales,'sw.js','index.html']) assert.ok(lista.includes(f),f+' no se publicaría');
  for(const f of lista) assert.ok(fs.existsSync(path.join(__dirname,'..',f)),f+' no existe');
});

test('no se publica nada interno',()=>{
  for(const f of lista) assert.doesNotMatch(f,/\.(sql|md|docx|ts|py|cjs)$|^tests\/|^supabase\/|pruebas_lector/);
  assert.match(toml,/publish = "dist"/);assert.match(toml,/command = "bash scripts\/publicar\.sh"/);
  assert.match(script,/set -euo pipefail/);assert.match(script,/\[ "\$faltan" -eq 0 \] \|\| exit 1/,'si falta un archivo, no se publica');
});

test('el navegador no deja incrustar la app en otra página',()=>{
  assert.match(toml,/X-Frame-Options = "DENY"/);
  assert.match(toml,/frame-ancestors 'none'/);
  assert.match(toml,/X-Content-Type-Options = "nosniff"/);
  assert.doesNotMatch(toml,/script-src/,'no se restringen los scripts de CDN/Supabase');
});
