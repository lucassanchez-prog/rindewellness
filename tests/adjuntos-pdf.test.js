const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('el informe incluye todas las páginas de un PDF adjunto y libera sus recursos',async()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8'),renderizadas=[];let cerrado=false;
 const pdf={numPages:3,destroy:async()=>{cerrado=true},getPage:async n=>({getViewport:()=>({width:600,height:800}),render:()=>{renderizadas.push(n);return {promise:Promise.resolve()}},cleanup(){}})};
 const ctx=vm.createContext({window:{RindeData:require("../data-access.js")},db:{storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://test.invalid/adjunto'},error:null})})}},fetch:async()=>({ok:true,blob:async()=>({type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})}),cargarPdfJs:async()=>({getDocument:()=>({promise:Promise.resolve(pdf)})}),document:{createElement:()=>({getContext:()=>({})})},canvasAJpegRedimensionado:()=> 'data:image/jpeg;base64,ejemplo'});
 vm.runInContext(app.slice(app.indexOf('async function* iterarImagenesAdjunto('),app.indexOf('// Informe completo de una rendición:')),ctx);
 const paginas=[];for await(const page of ctx.iterarImagenesAdjunto('ejemplo.pdf'))paginas.push(page);
 assert.deepEqual(renderizadas,[1,2,3]);assert.equal(paginas.length,3);assert.equal(paginas[2].pagina,3);assert.equal(paginas[2].total,3);assert.equal(cerrado,true);
});
test('un fallo de descarga de adjunto no se trata como comprobante vacío',async()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8'),ctx=vm.createContext({window:{RindeData:require("../data-access.js")},db:{storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://test.invalid/adjunto'},error:null})})}},fetch:async()=>({ok:false})});
 vm.runInContext(app.slice(app.indexOf('async function* iterarImagenesAdjunto('),app.indexOf('// Informe completo de una rendición:')),ctx);
 await assert.rejects(async()=>{for await(const x of ctx.iterarImagenesAdjunto('ejemplo.pdf')){}},/descargar/);
});
