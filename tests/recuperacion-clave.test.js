const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
test('recuperación vuelve al destino publicado aun desde localhost o una ruta alternativa',async()=>{
  for(const origin of ['http://localhost:3000','https://rindewellness.netlify.app']){
    const elements=new Map(),envios=[];
    function element(id){if(!elements.has(id))elements.set(id,{value:'prueba@example.com',style:{},handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}});return elements.get(id);}
    const ctx=vm.createContext({window:{location:{origin,pathname:'/index.html'}},document:{getElementById:element},db:{auth:{resetPasswordForEmail:async(email,options)=>{envios.push({email,options});return {error:null};}}}});
    vm.runInContext(app.slice(app.indexOf('function wireRecuperarClave()'),app.indexOf('async function onLoggedIn(')),ctx);
    ctx.wireRecuperarClave();await element('form-recuperar').handlers.submit({preventDefault(){}});
    assert.equal(envios.length,1);assert.equal(envios[0].options.redirectTo,'https://rindewellness.netlify.app/');
    assert.equal(element('btn-recuperar-submit').disabled,false);assert.match(element('recuperar-error').textContent,/Revisa tu correo/);
  }
});
