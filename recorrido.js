/* Recorrido guiado de RindeWellness.
   Ilumina una parte de la pantalla y la explica en un recuadro, con Atrás,
   Siguiente y Saltar. Se muestra solo la primera vez que alguien entra (por
   persona y dispositivo) y se puede repetir con "Ver recorrido" en el menú.
   Los pasos dependen del rol: empleado, aprobador y administrador.
   No toca datos ni navega entre pantallas: todo ocurre sobre Inicio y el menú,
   que existen tanto en computador como en teléfono. */
(function (raiz) {
  const VERSION = 1; // subirla si el recorrido cambia y conviene volver a mostrarlo

  // Pasos del recorrido. "selector" null = recuadro centrado sin iluminar nada.
  // "menu": el elemento vive dentro del menú lateral (en el teléfono hay que abrirlo).
  function pasosRecorrido({ nombre = "", rol = "empleado", aprobador = false } = {}) {
    const esAdmin = rol === "admin";
    const revisa = aprobador || esAdmin;
    const pasos = [
      { selector: null, titulo: "Hola" + (nombre ? ", " + String(nombre).split(" ")[0] : "") + " 👋",
        texto: "Te muestro RindeWellness en un minuto. Puedes saltarlo y volver a verlo cuando quieras desde el menú, en \"Ver recorrido\"." },
      { selector: "#portal-home-content .portal-metrics", titulo: "Tu resumen",
        texto: revisa ? "Aquí ves de un vistazo las rendiciones por revisar, lo rendido y lo ya aprobado." : "Aquí ves de un vistazo tus rendiciones pendientes, lo rendido y lo que ya te aprobaron." },
      { selector: '#view-inicio [data-portal-route="nueva"]', titulo: "Nueva rendición",
        texto: "Sube la foto o el PDF de cada boleta o factura. La app lee sola el proveedor, el RUT, el folio, la fecha y el monto: tú solo revisas y envías. Junta en una misma rendición todos los gastos de un mismo evento." },
      { selector: '#view-inicio [data-portal-route="nueva-solicitud"]', titulo: "Solicitar fondos",
        texto: "Si necesitas dinero por adelantado, pide un fondo. Cuando te lo aprueben, rindes tus gastos contra ese fondo." },
      { selector: '#portal-nav [data-route="dashboard"]', menu: true, titulo: "Rendiciones",
        texto: "El estado de cada rendición: Pendiente, Aprobada o Rechazada. Si te rechazan un gasto, aquí verás el motivo." },
      { selector: '#portal-nav [data-route="fondos"]', menu: true, titulo: "Fondos",
        texto: "Cuánto se entregó en cada fondo, cuánto ya se rindió y cuánto queda." },
      { selector: '#portal-nav [data-route="borradores"]', menu: true, titulo: "Borradores",
        texto: "Si sales a mitad de una rendición, tu avance queda guardado aquí por 7 días." },
    ];
    if (revisa) pasos.push({ selector: "#portal-home-content .card", titulo: "Lo que te toca revisar",
      texto: "Las rendiciones que esperan tu revisión. En cada una apruebas o rechazas gasto por gasto (con el motivo), verificas las facturas contra contabilidad y la finalizas. La persona recibe un correo con el resultado." });
    if (esAdmin) {
      pasos.push({ selector: '#portal-nav [data-route="reportes"]', menu: true, titulo: "Reportes",
        texto: "Excel por empresa y el archivo CSV para importar en Kame." });
      pasos.push({ selector: '#portal-nav [data-route="admin"]', menu: true, titulo: "Usuarios y salud del sistema",
        texto: "Roles y cuentas permitidas de cada persona, fondos ya entregados, y \"Salud del sistema\": fallas de lectura o correo y el costo de la lectura con IA." });
      pasos.push({ selector: null, titulo: "Correcciones",
        texto: "En el detalle de cada rendición tienes \"Correcciones de administrador\": cambiar la empresa o el dueño, unir rendiciones o anular una aprobación (con reverso para Kame). Todo pide un motivo y queda registrado." });
    }
    pasos.push({ selector: null, titulo: "Tres consejos",
      texto: "1) Foto nítida y completa, con el total y el RUT a la vista. 2) Factura o boleta de honorarios: \"Documento electrónico\". Boleta, ticket o voucher: \"Comprobante/Boleta\". 3) Revisa siempre lo que leyó la app antes de enviar." });
    pasos.push({ selector: "#btn-recorrido", menu: true, titulo: "Listo",
      texto: "Puedes volver a ver este recorrido cuando quieras desde aquí." });
    return pasos;
  }

  if (typeof module !== "undefined" && module.exports) { module.exports = { pasosRecorrido, VERSION }; return; }
  const doc = raiz.document;

  const clave = (usuarioId) => "rinde.recorrido.v" + VERSION + "." + usuarioId;
  const leer = (k) => { try { return raiz.localStorage.getItem(k); } catch { return null; } };
  const guardar = (k, v) => { try { raiz.localStorage.setItem(k, v); } catch { /* sin almacenamiento: se vuelve a ofrecer */ } };

  let activo = null; // estado del recorrido en curso
  let contexto = null; // { usuarioId, nombre, rol, aprobador }

  const nodo = (tag, attrs = {}, hijos = []) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k.startsWith("on") ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
    for (const h of [hijos].flat()) if (h != null) n.append(typeof h === "string" ? doc.createTextNode(h) : h);
    return n;
  };

  const esMovil = () => raiz.matchMedia("(max-width: 900px)").matches;
  const menu = () => ({ nav: doc.getElementById("portal-nav"), boton: doc.getElementById("portal-menu-toggle") });
  function abrirMenu(abrir) {
    const { nav, boton } = menu();
    if (!nav || !boton || !esMovil()) return;
    nav.classList.toggle("is-open", abrir);
    boton.setAttribute("aria-expanded", String(abrir));
  }
  const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  function cerrar(completo) {
    if (!activo) return;
    if (contexto?.usuarioId) guardar(clave(contexto.usuarioId), completo ? "visto" : "saltado");
    // Terminado o saltado, cuenta como visto: queda en el perfil y no vuelve a
    // aparecer solo en ningún dispositivo (se puede repetir desde el menú).
    try { contexto?.alTerminar?.(); } catch { /* el aviso al servidor no debe trabar el cierre */ }
    raiz.removeEventListener("resize", activo.reubicar);
    raiz.removeEventListener("scroll", activo.reubicar, true);
    doc.removeEventListener("keydown", activo.teclas, true);
    activo.capa.remove();
    abrirMenu(false);
    const volver = activo.foco;
    activo = null;
    if (volver && doc.contains(volver)) volver.focus?.({ preventScroll: true });
  }

  function ubicar() {
    if (!activo) return;
    const { pasos, i, foco: _f, luz, caja } = activo;
    const paso = pasos[i];
    const objetivo = paso.selector ? doc.querySelector(paso.selector) : null;
    const margen = 16, vw = raiz.innerWidth, vh = raiz.innerHeight;
    caja.style.maxWidth = Math.min(360, vw - 2 * margen) + "px";
    if (!objetivo || !visible(objetivo)) {
      luz.hidden = true;
      caja.style.left = Math.max(margen, (vw - caja.offsetWidth) / 2) + "px";
      caja.style.top = Math.max(margen, (vh - caja.offsetHeight) / 2) + "px";
      return;
    }
    const r = objetivo.getBoundingClientRect(), pad = 6;
    luz.hidden = false;
    Object.assign(luz.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + 2 * pad + "px", height: r.height + 2 * pad + "px" });
    const ancho = caja.offsetWidth, alto = caja.offsetHeight;
    let top = r.bottom + pad + 12;
    if (top + alto > vh - margen) top = r.top - pad - 12 - alto; // no cabe abajo: arriba
    if (top < margen) top = Math.max(margen, vh - alto - margen); // tampoco arriba: al pie
    const left = Math.min(Math.max(margen, r.left + r.width / 2 - ancho / 2), vw - ancho - margen);
    caja.style.left = left + "px";
    caja.style.top = top + "px";
  }

  function mostrar(i) {
    if (!activo) return;
    const { pasos } = activo;
    // Salta los pasos cuyo elemento no existe en esta pantalla (p. ej. sin pendientes).
    let n = i;
    const dir = i >= activo.i ? 1 : -1;
    while (n >= 0 && n < pasos.length && pasos[n].selector && !doc.querySelector(pasos[n].selector)) n += dir;
    if (n < 0) n = 0;
    if (n >= pasos.length) { cerrar(true); return; }
    activo.i = n;
    const paso = pasos[n];
    abrirMenu(!!paso.menu);
    const objetivo = paso.selector ? doc.querySelector(paso.selector) : null;
    if (objetivo && visible(objetivo)) objetivo.scrollIntoView({ block: "center", behavior: "instant" });
    activo.titulo.textContent = paso.titulo;
    activo.texto.textContent = paso.texto;
    activo.contador.textContent = (n + 1) + " de " + pasos.length;
    activo.atras.disabled = n === 0;
    activo.siguiente.textContent = n === pasos.length - 1 ? "Terminar" : "Siguiente";
    // Mide ya y otra vez tras abrir el menú y terminar el scroll. Con temporizador y
    // no con requestAnimationFrame, que el navegador pausa en pestañas no visibles.
    ubicar();
    raiz.setTimeout(() => { ubicar(); activo?.siguiente.focus({ preventScroll: true }); }, 80);
  }

  function iniciar() {
    if (activo || !contexto) return;
    const pasos = pasosRecorrido(contexto);
    const titulo = nodo("h2", { id: "recorrido-titulo", class: "recorrido-titulo" });
    const texto = nodo("p", { id: "recorrido-texto", class: "recorrido-texto" });
    const contador = nodo("span", { class: "recorrido-contador", "aria-live": "polite" });
    const atras = nodo("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => mostrar(activo.i - 1) }, "Atrás");
    const siguiente = nodo("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => mostrar(activo.i + 1) }, "Siguiente");
    const saltar = nodo("button", { type: "button", class: "btn btn-ghost btn-sm recorrido-saltar", onclick: () => cerrar(false) }, "Saltar");
    const caja = nodo("div", { class: "recorrido-caja", role: "dialog", "aria-modal": "true", "aria-labelledby": "recorrido-titulo", "aria-describedby": "recorrido-texto" },
      [titulo, texto, nodo("div", { class: "recorrido-acciones" }, [contador, saltar, atras, siguiente])]);
    const luz = nodo("div", { class: "recorrido-luz", "aria-hidden": "true" });
    const fondo = nodo("div", { class: "recorrido-fondo", "aria-hidden": "true" });
    const capa = nodo("div", { class: "recorrido-capa" }, [fondo, luz, caja]);
    doc.body.append(capa);
    const reubicar = () => ubicar();
    const teclas = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cerrar(false); }
      else if (e.key === "ArrowRight") { e.preventDefault(); mostrar(activo.i + 1); }
      else if (e.key === "ArrowLeft" && activo.i > 0) { e.preventDefault(); mostrar(activo.i - 1); }
      else if (e.key === "Tab") { // el foco no sale del recuadro
        const botones = [...caja.querySelectorAll("button:not(:disabled)")];
        const k = botones.indexOf(doc.activeElement);
        e.preventDefault();
        botones[(k + (e.shiftKey ? -1 : 1) + botones.length) % botones.length]?.focus();
      }
    };
    activo = { pasos, i: 0, capa, luz, caja, titulo, texto, contador, atras, siguiente, reubicar, teclas, foco: doc.activeElement };
    raiz.addEventListener("resize", reubicar);
    raiz.addEventListener("scroll", reubicar, true);
    doc.addEventListener("keydown", teclas, true);
    mostrar(0);
  }

  // La app lo llama al terminar de pintar Inicio con los datos de la persona.
  function preparar(datos) {
    contexto = datos;
    if (!doc.getElementById("btn-recorrido")) {
      const nav = doc.getElementById("portal-nav");
      nav?.append(nodo("button", { type: "button", id: "btn-recorrido", class: "btn btn-ghost portal-recorrido", onclick: () => { abrirMenu(false); iniciar(); } }, "Ver recorrido"));
    }
    // Inicio se vuelve a pintar tras cada cambio: el recorrido se ofrece solo una
    // vez por sesión, aunque el navegador no permita guardar que ya se vio.
    const enInicio = doc.getElementById("view-inicio")?.classList.contains("active");
    if (enInicio && datos?.usuarioId && !datos.yaVisto && !ofrecido.has(datos.usuarioId) && !leer(clave(datos.usuarioId))) {
      ofrecido.add(datos.usuarioId);
      iniciar();
    }
  }
  const ofrecido = new Set();

  raiz.RindeRecorrido = { preparar, iniciar, cerrar: () => cerrar(false), pasosRecorrido, VERSION };
})(typeof window !== "undefined" ? window : globalThis);
