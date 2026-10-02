(function(root){
  const gris=(data,i)=>data[i]*.299+data[i+1]*.587+data[i+2]*.114;
  function detectarPapel({width:w,height:h,data}){
    if(w<30||h<30||data.length!==w*h*4)return null;
    const hist=new Uint32Array(256),g=new Uint8Array(w*h);let suma=0;
    for(let i=0;i<g.length;i++){g[i]=Math.round(gris(data,i*4));hist[g[i]]++;suma+=g[i];}
    let fondo=0,totalF=0,max=0,umbral=180;
    for(let t=0;t<255;t++){totalF+=hist[t];fondo+=hist[t]*t;const otro=g.length-totalF;if(!totalF||!otro)continue;const v=totalF*otro*(fondo/totalF-(suma-fondo)/otro)**2;if(v>max){max=v;umbral=t;}}
    umbral=Math.max(100,umbral);const visitado=new Uint8Array(g.length),cola=new Int32Array(g.length);let mejor=null;
    for(let inicio=0;inicio<g.length;inicio++){
      if(visitado[inicio]||g[inicio]<=umbral)continue;
      let n=1,j=0;cola[0]=inicio;visitado[inicio]=1;let minS=Infinity,maxS=-Infinity,minD=Infinity,maxD=-Infinity;const q=[];
      while(j<n){const p=cola[j++],x=p%w,y=Math.floor(p/w),s=x+y,d=x-y;if(s<minS){minS=s;q[0]=[x,y];}if(d>maxD){maxD=d;q[1]=[x,y];}if(s>maxS){maxS=s;q[2]=[x,y];}if(d<minD){minD=d;q[3]=[x,y];}
        for(const v of [x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1])if(v>=0&&!visitado[v]&&g[v]>umbral){visitado[v]=1;cola[n++]=v;}
      }
      if(!mejor||n>mejor.n)mejor={n,q};
    }
    if(!mejor)return null;const {q,n}=mejor,area=Math.abs(q.reduce((s,p,i)=>s+p[0]*q[(i+1)%4][1]-p[1]*q[(i+1)%4][0],0))/2;
    if(area<w*h*.25||area>w*h*.94||n/area<.70||q.some(p=>p[0]<w*.015||p[1]<h*.015||p[0]>w*.985||p[1]>h*.985))return null;
    const cruces=q.map((p,i)=>{const b=q[(i+1)%4],c=q[(i+2)%4];return (b[0]-p[0])*(c[1]-b[1])-(b[1]-p[1])*(c[0]-b[0]);});if(cruces.some(v=>v<=0))return null;
    const borde=[];for(let x=0;x<w;x++)borde.push(g[x],g[(h-1)*w+x]);for(let y=0;y<h;y++)borde.push(g[y*w],g[y*w+w-1]);
    if(suma/g.length-borde.reduce((s,v)=>s+v,0)/borde.length<18)return null;
    return q.map(([x,y])=>[x/w,y/h]);
  }
  function homografia(q){
    const a=[];for(let i=0;i<4;i++){const [u,v]=[[0,0],[1,0],[1,1],[0,1]][i],[x,y]=q[i];a.push([u,v,1,0,0,0,-u*x,-v*x,x],[0,0,0,u,v,1,-u*y,-v*y,y]);}
    for(let k=0;k<8;k++){let piv=k;for(let r=k+1;r<8;r++)if(Math.abs(a[r][k])>Math.abs(a[piv][k]))piv=r;[a[k],a[piv]]=[a[piv],a[k]];if(Math.abs(a[k][k])<1e-10)return null;const d=a[k][k];for(let c=k;c<9;c++)a[k][c]/=d;for(let r=0;r<8;r++)if(r!==k){const m=a[r][k];for(let c=k;c<9;c++)a[r][c]-=m*a[k][c];}}
    return a.map(r=>r[8]);
  }
  function rectificar(imagen,q){
    const {width,height,data}=imagen,pts=q.map(([x,y])=>[x*width,y*height]),dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
    const w=Math.max(1,Math.round(Math.max(dist(pts[0],pts[1]),dist(pts[3],pts[2])))),h=Math.max(1,Math.round(Math.max(dist(pts[0],pts[3]),dist(pts[1],pts[2]))));
    const t=homografia(pts);if(!t)return imagen;const salida=new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const u=x/Math.max(1,w-1),v=y/Math.max(1,h-1),d=t[6]*u+t[7]*v+1,sx=(t[0]*u+t[1]*v+t[2])/d,sy=(t[3]*u+t[4]*v+t[5])/d;const px=Math.max(0,Math.min(width-1,sx)),py=Math.max(0,Math.min(height-1,sy)),x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),fx=px-x0,fy=py-y0,i=(y*w+x)*4;
      for(let c=0;c<3;c++)salida[i+c]=data[(y0*width+x0)*4+c]*(1-fx)*(1-fy)+data[(y0*width+x1)*4+c]*fx*(1-fy)+data[(y1*width+x0)*4+c]*(1-fx)*fy+data[(y1*width+x1)*4+c]*fx*fy;salida[i+3]=255;
    }return {width:w,height:h,data:salida};
  }
  function normalizarCaja(valor){if(!Array.isArray(valor)||valor.length!==4||valor.some(n=>!Number.isFinite(n)||n<0||n>1000))return null;const [y0,x0,y1,x1]=valor;return y1>y0&&x1>x0?valor:null;}
  async function preparar(file,{giro=0,contraste=false,recortar=true}={}){
    const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});try{
      const escala=Math.min(1,2000/Math.max(bitmap.width,bitmap.height));let canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*escala);canvas.height=Math.round(bitmap.height*escala);
      let ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);let corregido=false;
      if(recortar){const pequeno=document.createElement('canvas'),s=320/Math.max(canvas.width,canvas.height);pequeno.width=Math.max(1,Math.round(canvas.width*s));pequeno.height=Math.max(1,Math.round(canvas.height*s));const p=pequeno.getContext('2d',{willReadFrequently:true});p.drawImage(canvas,0,0,pequeno.width,pequeno.height);const q=detectarPapel(p.getImageData(0,0,pequeno.width,pequeno.height));if(q){const salida=rectificar(ctx.getImageData(0,0,canvas.width,canvas.height),q);canvas.width=salida.width;canvas.height=salida.height;ctx=canvas.getContext('2d');ctx.putImageData(new ImageData(salida.data,salida.width,salida.height),0,0);corregido=true;}}
      const vueltas=((giro%4)+4)%4;if(vueltas||contraste){const otro=document.createElement('canvas');otro.width=vueltas%2?canvas.height:canvas.width;otro.height=vueltas%2?canvas.width:canvas.height;const c=otro.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,otro.width,otro.height);c.translate(otro.width/2,otro.height/2);c.rotate(vueltas*Math.PI/2);if(contraste)c.filter='grayscale(1) contrast(1.2)';c.drawImage(canvas,-canvas.width/2,-canvas.height/2);canvas=otro;}
      const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.96));if(!blob)throw Error('No se pudo preparar la foto');return {file:new File([blob],file.name.replace(/\.[^.]+$/,'')+'-lectura.jpg',{type:'image/jpeg'}),corregido,giro:vueltas,contraste};
    }finally{bitmap.close();}
  }
  const api={detectarPapel,homografia,rectificar,normalizarCaja,preparar};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RindeFoto=api;
})(typeof globalThis!=='undefined'?globalThis:this);
