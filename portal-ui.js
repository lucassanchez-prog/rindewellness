/* Presentación del portal aprobado. Las consultas y decisiones permanecen en app.js. */
(function () {
  const core = window.RindeCore;
  const node = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => k.startsWith('on') ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v));
    for (const child of [children].flat()) if (child != null) n.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return n;
  };
  let actions, profile, destroyPreview = null;
  const money = n => core.fmtCLP(Number(n || 0));
  const metric = (label, value, help, tone = '') => node('div', {class: 'portal-metric '+tone}, [node('span', {}, label), node('strong', {}, value), node('small', {}, help)]);
  const heading = (title, text) => node('div', {class:'hero-row'}, [node('div', {}, [node('h1', {}, title),node('p', {}, text)])]);
  function navigate(route) { actions.navigate(route); }
  function link(title, route, primary = false) {
    return node('a', {href:'#'+route, class:'btn '+(primary?'btn-primary':'btn-secondary'), onclick:e=>{e.preventDefault();navigate(route);}},title);
  }
  function init(callbacks) {
    actions = callbacks;
    const nav = document.getElementById('portal-nav');
    const menu=document.getElementById('portal-menu-toggle');
    menu.addEventListener('click',()=>{const open=nav.classList.toggle('is-open');menu.setAttribute('aria-expanded',String(open));});
    const routes = [['inicio','Inicio'],['dashboard','Rendiciones'],['fondos','Fondos'],['reportes','Reportes'],['admin','Usuarios'],['plantillas','Plantillas']];
    for (const [route, label] of routes) nav.append(node('a',{href:'#'+route,'data-route':route,onclick:e=>{e.preventDefault();navigate(route);}},label));
    nav.append(node('p',{},'Crear y revisar'),link('Solicitar fondos','nueva-solicitud'),link('Nueva rendición','nueva'));
    document.getElementById('portal-brand').onclick = e => {e.preventDefault();navigate('inicio');};
    createFormLayouts();
  }
  function setProfile(p) {
    profile=p;
    for (const a of document.querySelectorAll('#portal-nav [data-route]')) a.hidden = ['admin','plantillas','reportes'].includes(a.dataset.route) && p?.rol !== 'admin';
    updateFormSummary();
  }
  function show(view, section) {
    if (destroyPreview && view !== 'view-detalle') {destroyPreview();destroyPreview=null;}
    const route = view==='view-dashboard' ? (section==='fondos'?'fondos':'dashboard') : view.replace('view-','');
    for (const a of document.querySelectorAll('#portal-nav a')) {
      const active=a.getAttribute('href')==='#'+route || (route==='detalle' && a.dataset.route==='dashboard') || (route==='detalle-solicitud' && a.dataset.route==='fondos');
      a.classList.toggle('active',active);
      if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    }
    const nav=document.getElementById('portal-nav'),menu=document.getElementById('portal-menu-toggle');
    const active=nav.querySelector('.active');
    menu.textContent='Menú · '+(active?.textContent||'RindeWellness');
    const wasOpen=nav.classList.contains('is-open');nav.classList.remove('is-open');menu.setAttribute('aria-expanded','false');
    if(wasOpen){const title=document.getElementById(view)?.querySelector('h1,h2');if(title){title.tabIndex=-1;title.focus({preventScroll:true});}}
    updateFormSummary();
    // Una vista nueva comienza por su título, sin desplazar cuando se actualiza un gasto.
  }
  function renderHome(data, canReview, consumption, renderList) {
    const rows=canReview?data.aprobaciones:data.mias;
    const pending=rows.filter(r=>r.estado==='Pendiente');
    const home=document.getElementById('portal-home-content');
    home.replaceChildren();
    home.append(node('div',{class:'portal-metrics'},[
      metric('Por revisar',String(pending.length), 'Rendiciones pendientes','warning'),
      metric('Monto rendido',money(rows.reduce((s,r)=>s+Number(r.monto_rendido??r.monto_total??0),0)),rows.length+(rows.length===1?' rendición':' rendiciones')),
      metric('Monto aprobado',money(rows.reduce((s,r)=>s+Number(r.monto_aprobado??(r.estado==='Aprobado'?r.monto_total:0)),0)),'Solo gastos aceptados','positive')
    ]));
    const attention=node('section',{class:'card'},[node('h2',{},'Requiere tu atención')]);
    for(const r of pending.slice(0,4)) attention.append(node('a',{class:'portal-attention',href:'#detalle/'+r.id,onclick:e=>{e.preventDefault();actions.detail(r.id);}},[
      node('div',{},[node('strong',{},r.empleado_nombre||'Rendición'),node('span',{},r.comentario||'Nº '+r.folio),node('small',{},'Rendición Nº '+r.folio)]),node('b',{},money(r.monto_rendido??r.monto_total))
    ]));
    if(pending.length>4)attention.append(link('Ver todas las rendiciones','dashboard'));
    if(!pending.length)attention.append(node('p',{class:'portal-muted'},'No tienes rendiciones pendientes de revisión.'));
    const fundPanel=node('section',{class:'card'},[node('h2',{},'Fondos por rendir')]);
    const funds=(profile?.rol==='admin'?data.solicitudesAprobacion:data.solicitudesMias).filter(s=>s.estado==='Aprobado');
    for(const s of funds.slice(0,4)) {
      const available=data.consumoFondos.get(s.id);
      const result=available?consumption(available,s.monto_solicitado):null;
      fundPanel.append(node('a',{class:'portal-attention',href:'#detalle-solicitud/'+s.id,onclick:e=>{e.preventDefault();actions.fund(s.id);}},[
        node('div',{},[node('strong',{},'S-'+s.folio+' · '+(s.motivo||'Fondo')),node('small',{},s.empleado_nombre||'')]),
        node('div',{class:result?.saldo<0?'portal-negative':''},[node('b',{},result?money(Math.abs(result.saldo)):'No disponible'),node('small',{},result?.saldo<0?'Exceso por regularizar':'Disponible para rendir')])
      ]));
    }
    if(funds.length>4)fundPanel.append(link('Ver todos los fondos','fondos'));
    if(!funds.length)fundPanel.append(node('p',{class:'portal-muted'},'Aquí aparecerán tus fondos aprobados.'));
    home.append(node('div',{class:'portal-two-columns'},[attention,fundPanel]));
    const latest=node('section',{class:'card'},[node('div',{class:'portal-section-heading'},[node('h2',{},'Últimas rendiciones'),link('Ver rendiciones','dashboard')])]);
    const list=node('div');renderList(list,rows.slice(0,5),canReview);latest.append(list);home.append(latest);
    const fundStats=document.getElementById('portal-fund-stats');
    const approvedFunds=(profile?.rol==='admin'?data.solicitudesAprobacion:data.solicitudesMias).filter(s=>s.estado==='Aprobado');
    const known=approvedFunds.every(s=>data.consumoFondos.has(s.id));
    const results=approvedFunds.map(s=>consumption(data.consumoFondos.get(s.id)||[],s.monto_solicitado));
    fundStats.replaceChildren(metric('Fondos aprobados',money(approvedFunds.reduce((n,s)=>n+Number(s.monto_solicitado||0),0)),approvedFunds.length+(approvedFunds.length===1?' fondo':' fondos')),
      metric('Consumo aprobado',known?money(results.reduce((n,s)=>n+s.aprobado,0)):'No disponible','Gastos aceptados','positive'),
      metric('En revisión',known?money(results.reduce((n,s)=>n+s.porRevisar,0)):'No disponible','Reservado hasta su revisión','warning'));
  }
  function createFormLayouts() {
    const sf=document.getElementById('view-nueva-solicitud');
    const form=sf.querySelector('.card');form.style.maxWidth='';form.style.margin='';
    const aside=node('aside',{class:'card portal-form-summary'},[node('h2',{},'Resumen de la solicitud'),node('dl',{id:'portal-sf-summary'}),node('p',{class:'portal-muted'},'Una vez aprobado, podrás asociar tus rendiciones a este fondo.')]);
    const layout=node('div',{class:'portal-form-layout'});form.before(layout);layout.append(form,aside);
    sf.addEventListener('input',updateFormSummary);sf.addEventListener('change',updateFormSummary);
    const nr=document.getElementById('view-nueva');
    const contents=Array.from(nr.children).filter(n=>!n.matches('.back-link,.hero-row'));
    const totals=nr.querySelector('.totals-bar'), submit=document.getElementById('btn-guardar-rendicion').parentElement;
    const left=node('div',{class:'portal-form-main'}), right=node('aside',{class:'card portal-form-summary'},[node('h2',{},'Resumen'),node('dl',{id:'portal-nr-summary'})]);
    const newLayout=node('div',{class:'portal-form-layout'},[left,right]);nr.append(newLayout);
    for(const c of contents)if(c!==totals && c!==submit)left.append(c);
    right.append(totals,node('p',{class:'portal-muted'},'Confirma proveedor, documento, fecha y monto antes de enviar.'),submit);
    nr.addEventListener('input',updateFormSummary);nr.addEventListener('change',updateFormSummary);
  }
  function updateFormSummary() {
    const text=id=>{const n=document.getElementById(id);return n?.tagName==='SELECT'?n.selectedOptions[0]?.textContent||'—':n?.value||'—';};
    const fill=(id,entries)=>{const box=document.getElementById(id);if(box)box.replaceChildren(...entries.flatMap(([k,v])=>[node('dt',{},k),node('dd',{},v)]));};
    fill('portal-sf-summary',[['Solicitante',profile?.nombre||'—'],['Empresa',text('sf-empresa')],['Centro de costo',text('sf-cc')],['Monto solicitado',money(core.parseMoneyValue(document.getElementById('sf-monto')?.value||''))]]);
    fill('portal-nr-summary',[['Gastos',String(document.querySelectorAll('#items-container .item-card').length)],['Tipo',text('nr-tipo')],['Fondo asociado',document.getElementById('nr-tipo')?.value==='FondoPorRendir'?text('nr-fondo'):'No aplica · Reembolso']]);
  }
  function createPreview(items, table, iterator, accountName, openOriginal, showAccount = false) {
    if(destroyPreview)destroyPreview();
    const aside=node('aside',{class:'portal-receipt', 'aria-label':'Comprobante seleccionado'});
    const title=node('h3',{},'Comprobante'),status=node('span',{class:'pill'}),stage=node('div',{class:'portal-receipt-stage'}),fields=node('dl',{class:'portal-receipt-fields'});
    const pageLabel=node('span',{role:'status','aria-live':'polite'});
    let generation=0,generator=null,pages=[],index=0,total=1,current=null,busy=false,zoom=1;
    const previous=node('button',{type:'button',class:'btn btn-sm',onclick:()=>{index--;paint();}},'Anterior');
    const next=node('button',{type:'button',class:'btn btn-sm',onclick:async()=>{if(index+1<pages.length){index++;paint();}else await readNext();}},'Siguiente');
    const zoomLabel=node('span',{'aria-live':'polite'},'100%');
    const zoomOut=node('button',{type:'button',class:'btn btn-sm','aria-label':'Alejar comprobante',onclick:()=>{zoom=Math.max(1,zoom-.25);paint();}},'−');
    const zoomIn=node('button',{type:'button',class:'btn btn-sm','aria-label':'Acercar comprobante',onclick:()=>{zoom=Math.min(3,zoom+.25);paint();}},'+');
    const original=node('button',{type:'button',class:'btn btn-secondary btn-sm',onclick:()=>current&&openOriginal(current)},'Abrir original');
    aside.append(node('div',{class:'portal-section-heading'},[node('div',{},[title,node('small',{},'Compara antes de aprobar')]),status]),node('div',{class:'portal-receipt-controls'},[previous,pageLabel,next]),stage,node('div',{class:'portal-receipt-zoom'},[node('small',{},'Ampliar documento'),zoomOut,zoomLabel,zoomIn]),original,fields);
    function paint(){zoomLabel.textContent=Math.round(zoom*100)+'%';zoomOut.disabled=zoom<=1||!pages.length;zoomIn.disabled=zoom>=3||!pages.length;stage.replaceChildren(node('img',{style:'width:'+zoom*100+'%;max-width:none',src:pages[index],alt:'Página '+(index+1)+' del comprobante seleccionado'}));pageLabel.textContent='Página '+(index+1)+' de '+total;previous.disabled=index===0;next.disabled=busy||index+1>=total;}
    async function readNext(){const gen=generation;busy=true;next.disabled=true;try{const value=await generator.next();if(gen!==generation)return;if(value.done){next.disabled=true;return;}pages.push(value.value.imagen);total=value.value.total;index=pages.length-1;busy=false;paint();}catch(error){if(gen!==generation)return;console.warn("No se pudo mostrar el comprobante:",error);stage.replaceChildren(node('p',{},'No se pudo mostrar el comprobante. Puedes abrir el original o volver a seleccionarlo.'));}finally{if(gen===generation)busy=false;}}
    async function select(item, card, focus=false){
      generation++;if(generator)void generator.return();generator=null;pages=[];index=0;total=1;current=item;zoom=1;zoomLabel.textContent="100%";zoomIn.disabled=zoomOut.disabled=true;
      for(const body of table.tBodies)body.classList.toggle('selected',body===card);
      title.textContent=item.nro_documento?'Documento Nº '+item.nro_documento:'Comprobante del gasto';status.textContent=item.estado||'Pendiente';status.className='pill '+(item.estado||'Pendiente');
      const values=[['Proveedor',item.nombre_proveedor||'—'],['Monto registrado',money(item.monto)],['Fecha del documento',core.fmtDate(item.fecha_vencimiento)||'—'],['Cuenta contable',item.cuenta_contable?item.cuenta_contable+' · '+accountName(item.cuenta_contable):'—']];
      fields.replaceChildren(...values.filter(([k])=>showAccount||k!=='Cuenta contable').flatMap(([k,v])=>[node('dt',{},k),node('dd',{},v)]));
      previous.disabled=true;next.disabled=true;pageLabel.textContent='';original.hidden=!item.adjunto_url;
      stage.replaceChildren(node('p',{},item.adjunto_url?'Cargando comprobante…':'Este gasto no tiene un archivo adjunto.'));
      if(focus)aside.scrollIntoView({behavior:'auto',block:'nearest'});
      if(item.adjunto_url){generator=iterator(item.adjunto_url);await readNext();}
    }
    destroyPreview=()=>{generation++;if(generator)void generator.return();generator=null;pages=[];stage.replaceChildren();};
    return {element:aside,select,first:()=>{if(items.length)void select(items[0],table.tBodies[0]);else stage.textContent='Esta rendición no tiene gastos.';}};
  }
  window.RindeUI={init,setProfile,show,renderHome,updateFormSummary,createPreview,metric,node,heading};
})();
