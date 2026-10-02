// Respaldo independiente. Se activa solo después de configurar cuenta gratuita y consentimiento.
export function habilitado(config: Record<string,string|undefined>): boolean {
  return config.GROQ_OCR_ENABLED==='true' && config.GROQ_OCR_CONSENT==='true' && config.GROQ_PLAN==='free' && !!config.GROQ_API_KEY;
}
export async function consultarGroq(imageBase64:string,mimeType:string,prompt:string,config:Record<string,string|undefined>,timeoutMs:number,solicitar:typeof fetch=fetch):Promise<any>{
  if(!habilitado(config))throw new Error('El respaldo de nube no está activado.');
  if(!['image/jpeg','image/png','image/webp'].includes(mimeType))throw new Error('El respaldo de nube requiere una imagen del comprobante; selecciona una página del PDF.');
  if(imageBase64.length>19_000_000)throw new Error('La imagen supera el tamaño admitido por el respaldo de nube.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1000,timeoutMs));
  try{
    // El plan gratuito comparte 8000 tokens/minuto entre imagen, prompt y salida.
    // Reservar 6000 de salida podía rechazar la solicitud antes de leer nada.
    const respuesta=await solicitar('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+config.GROQ_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'qwen/qwen3.8-27b',messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:'data:'+mimeType+';base64,'+imageBase64}}]}],response_format:{type:'json_object'},temperature:0,max_completion_tokens:2048,stream:false}),signal:controller.signal});
    if(respuesta.status===429){
      const error=new Error('El respaldo Groq alcanzó su límite gratuito; se pospone el reintento.') as Error & {retryAfterMs?:number};
      const valor=respuesta.headers.get('retry-after');
      const segundos=valor&&/^\d+(?:\.\d+)?$/.test(valor.trim())?Number(valor):NaN;
      if(Number.isFinite(segundos))error.retryAfterMs=Math.min(86400000,Math.max(30000,Math.ceil(segundos*1000)));
      throw error;
    }
    if(!respuesta.ok)throw new Error(respuesta.status===429?'El respaldo Groq agotó su cuota gratuita; se pospone el reintento.':respuesta.status>=500?'El respaldo Groq no está disponible; se pospone el reintento.':'El respaldo Groq rechazó la solicitud (HTTP '+respuesta.status+'). Revisa su configuración.');
    const resultado=await respuesta.json(),texto=resultado?.choices?.[0]?.message?.content;
    if(typeof texto!=='string'||!texto.trim())throw new Error('Groq no devolvió una lectura utilizable.');
    return {candidates:[{content:{parts:[{text:texto}]}}]};
  }catch(error){if(controller.signal.aborted)throw new Error('Tiempo de espera agotado en el respaldo Groq; se pospone el reintento.');throw error;}
  finally{clearTimeout(timer);}
}
