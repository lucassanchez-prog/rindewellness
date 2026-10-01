// Evaluación local: no sube archivos ni llama a proveedores de IA.
const fs=require('node:fs');
const CAMPOS=['nombre_proveedor','rut_proveedor','tipo_documento','nro_documento','fecha','monto'];
function normalizar(campo,valor){
 if(valor===null || valor===undefined || valor==='')return null;
 if(campo==='monto')return Number.isFinite(Number(valor))?Number(valor):String(valor);
 if(campo==='rut_proveedor')return String(valor).replace(/[^0-9kK]/g,'').toUpperCase();
 if(campo==='nro_documento')return String(valor).trim().replace(/^0+(?=\d)/,'');
 return String(valor).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();
}
function evaluar(referencias,lecturas){
 const porId=new Map(lecturas.map(l=>[l.id,l.datos || l.resultado || {}]));
 const etiquetas=referencias.filter(r=>r.referencia && typeof r.referencia==='object');
 if(!etiquetas.length)throw Error('No hay referencias humanas: no se puede calcular precisión.');
 const porCampo=Object.fromEntries(CAMPOS.map(c=>[c,{evaluados:0,correctos:0,omitidos:0}]));let documentosCorrectos=0;
 for(const r of etiquetas){const lectura=porId.get(r.id)||{};let correcto=true,evaluados=0;
  for(const campo of CAMPOS){if(!Object.hasOwn(r.referencia,campo))continue;evaluados++;const esperado=normalizar(campo,r.referencia[campo]),observado=normalizar(campo,lectura[campo]);const p=porCampo[campo];p.evaluados++;if(esperado===observado)p.correctos++;else correcto=false;if(esperado!==null && observado===null)p.omitidos++;}
  if(correcto && evaluados)documentosCorrectos++;
 }
 for(const p of Object.values(porCampo))p.exactitud=p.evaluados?p.correctos/p.evaluados:null;
 return {documentos_etiquetados:etiquetas.length,documentos_con_campos_evaluados_correctos:documentosCorrectos,porCampo,nota:'Solo mide los campos etiquetados. No demuestra exactitud en documentos o campos sin referencia.'};
}
if(require.main===module){const [referencias,lecturas,salida]=process.argv.slice(2);if(!referencias || !lecturas){console.error('Uso: node scripts/evaluar-ocr.cjs referencias.json lecturas.json [resultado.json]');process.exitCode=2;}else{try{const informe=evaluar(JSON.parse(fs.readFileSync(referencias,'utf8')),JSON.parse(fs.readFileSync(lecturas,'utf8')));if(salida)fs.writeFileSync(salida,JSON.stringify(informe,null,2));console.log(JSON.stringify(informe,null,2));}catch(e){console.error(e.message);process.exitCode=1;}}}
module.exports={evaluar,normalizar};
