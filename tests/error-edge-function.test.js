// supabase-js responde a un status no 2xx con un error genérico ("Edge Function
// returned a non-2xx status code") y deja el mensaje real en error.context, que
// es el Response. Estos helpers lo recuperan para mostrárselo a quien usa la app.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const ctx=vm.createContext({});
const inicio=app.indexOf('async function cuerpoErrorFuncion(');
vm.runInContext(app.slice(inicio,app.indexOf('async function llamarOcrRecibo(',inicio)),ctx);

const GENERICO='Edge Function returned a non-2xx status code';
const conCuerpo=(cuerpo)=>({message:GENERICO,context:{json:async()=>cuerpo}});

test('usa el mensaje real que armó la función',async()=>{
  assert.equal(await ctx.mensajeErrorFuncion(conCuerpo({error:'Falta configurar el secret RESEND_API_KEY'})),'Falta configurar el secret RESEND_API_KEY');
});

test('si el cuerpo no es JSON cae al mensaje genérico',async()=>{
  const error={message:GENERICO,context:{json:async()=>{throw new SyntaxError('Unexpected token <');}}};
  assert.equal(await ctx.mensajeErrorFuncion(error),GENERICO);
});

test('si el cuerpo no trae "error" cae al mensaje genérico',async()=>{
  assert.equal(await ctx.mensajeErrorFuncion(conCuerpo({ok:false})),GENERICO);
});

test('sin context (error de red) cae al mensaje del error',async()=>{
  assert.equal(await ctx.mensajeErrorFuncion({message:'Failed to fetch'}),'Failed to fetch');
});

test('cuerpoErrorFuncion devuelve el cuerpo completo, con previaId',async()=>{
  const cuerpo=await ctx.cuerpoErrorFuncion(conCuerpo({error:'high demand',previaId:'abc-123'}));
  assert.equal(cuerpo.previaId,'abc-123');
});

test('cuerpoErrorFuncion devuelve null cuando no hay cuerpo legible',async()=>{
  assert.equal(await ctx.cuerpoErrorFuncion({message:'x'}),undefined);
  assert.equal(await ctx.cuerpoErrorFuncion({context:{json:async()=>{throw new Error('x');}}}),null);
});
