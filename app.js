// ============================================================
// RindeWellness - lógica de la app (vanilla JS + Supabase)
// ============================================================

// formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash y parseMoneyValue
// viven en pure.js (cargado antes que este archivo, ver index.html) -- son
// funciones puras sin DOM ni red, separadas para poder testearlas con Node
// (ver tests/pure.test.js) sin arrastrar el resto de la app.
const { formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash, parseMoneyValue, esAprobadorEfectivo, documentosDuplicados, campoCSV, campoCSVSeguro, resumenRendicion } = window.RindeCore;

const CFG = window.RINDE_WELLNESS_CONFIG || {};
let db = null; // proyecto propio de la app (lectura/escritura)
let dbContabilidad = null; // proyecto de contabilidad (SOLO LECTURA)
let currentUser = null;
let currentProfile = null;
let itemSeq = 0;
let envioRendicionId = null;
let enviandoRendicion = false;
const adjuntosBorrador = new Map();
// null = sin restricción (ve todas las cuentas de gasto directo);
// Set(...) = solo puede usar esas cuentas. La define el admin en "Usuarios".
let cuentasPermitidas = null;

const EMPRESAS = [
  "Grupo Wellness SpA", "Dmoov SpA", "Dmoov Zona Sur SpA", "Dmoov PT Zona Sur SpA",
  "Tactiq SpA", "Neo Gym Chile SpA", "Neo App SpA",
  "Centros Deportivos SpA", "Dmoov Corp SpA",
];
const RUT_POR_EMPRESA = {
  "Grupo Wellness SpA": "77.574.911-3",
  "Dmoov SpA": "76.717.691-0",
  "Dmoov Zona Sur SpA": "77.902.209-9",
  "Dmoov PT Zona Sur SpA": "77.902.214-5",
  "Tactiq SpA": "77.902.057-6",
  "Neo Gym Chile SpA": "76.717.692-9",
  "Neo App SpA": "78.236.354-9",
  "RFA SpA": "78.210.251-6", // fuera de EMPRESAS, pero su RUT sigue contando como RUT propio
  "Centros Deportivos SpA": "76.717.693-7",
  "Dmoov Corp SpA": "77.406.474-5",
};

// Centros de Costo (Unidad de Negocio en Kame) reales por empresa, sacados
// de "movimientos" filtrando por las cuentas de gasto (4.01.03.*). No son
// los nombres de las empresas -- son las sedes/unidades dentro de cada una.
const CENTROS_COSTO_POR_EMPRESA = {
  "Grupo Wellness SpA": ["Casa Matriz", "RFA CHILE"],
  "Dmoov SpA": ["Casa Matriz", "DMOOV CENTRAL", "DMOOV CHICUREO", "DMOOV MALL SPORT", "DMOOV PIRQUE", "DMOOV POLO", "DMOOV TALCA"],
  "Dmoov Corp SpA": ["Casa Matriz", "CORP CENTRAL", "CORP CHICUREO", "CORP MALL SPORT", "CORP PIRQUE", "CORP POLO", "CORP TALCA"],
  "Dmoov Zona Sur SpA": ["Casa Matriz"],
  "Dmoov PT Zona Sur SpA": ["Casa Matriz"],
  "Tactiq SpA": ["Casa Matriz"],
  "Neo Gym Chile SpA": ["Casa Matriz", "NEO APP", "NEO GYM", "NEO LA FLORIDA", "NEO INDEPENDENCIA", "NEO PLAZA OESTE", "NEO MALL PLAZA NORTE", "NEO MALL PLAZA SUR", "MALL PLAZA ALAMEDA"],
  "Neo App SpA": ["Casa Matriz", "NEO APP"],
  "Centros Deportivos SpA": ["Casa Matriz"],
};

// "Con documento" es solo para lo que realmente llega a contabilidad vía
// SII y se puede verificar (facturas y boletas de honorarios). Las boletas
// electrónicas comunes (de un local, bencinera, etc.) NUNCA llegan por SII
// a la contabilidad, así que van como "Gasto directo" -- se categorizan
// igual que cualquier otro gasto directo, con foto obligatoria igual.
const TIPOS_DOCUMENTO = ["Factura Electrónica", "Factura Exenta Electrónica", "Boleta de Honorario"];

function tipoItemLabel(tipoItem) {
  // "Comprobante/Boleta" y no solo "Boleta": por acá entra cualquier
  // respaldo de gasto que no sea un documento tributario electrónico
  // (vouchers, comprobantes de transferencia, boletas de papel), y decir
  // solo "Boleta" hacía dudar de dónde cargar el resto.
  return tipoItem === "ConDocumento" ? "Documento electrónico" : "Comprobante/Boleta";
}

// Ver folioDocumentoValido en pure.js (misma regla en la base).
const MENSAJE_FOLIO_INVALIDO = (n) => `El N° de documento${n ? " del Ítem " + n : ""} debe tener solo números (como el folio de una factura). Si es una boleta o un ticket con letras, cárgalo como "Comprobante/Boleta".`;

const CUENTA_POR_TIPO_DOC = {
  "Factura Electrónica": "2.01.07.01",
  "Factura Exenta Electrónica": "2.01.07.01",
  "Boleta de Honorario": "2.01.07.03",
};

const CUENTA_CONTRAPARTIDA = {
  Reembolso: { cuenta: "2.01.07.29", nombre: "Rendiciones por Pagar" },
  FondoPorRendir: { cuenta: "1.01.11.05", nombre: "Fondo por Rendir" },
};

// Nombres de cuentas que no son de gasto directo (proveedores/contrapartidas),
// para poder mostrar "código · nombre" en cualquier campo de cuenta contable.
const CUENTAS_CONOCIDAS = {
  "2.01.07.01": "Proveedores Nacionales",
  "2.01.07.03": "Honorarios por Pagar",
  "2.01.07.29": "Rendiciones por Pagar",
  "1.01.11.05": "Fondo por Rendir",
};

function nombreCuenta(codigo) {
  if (!codigo) return "";
  const enGasto = CATEGORIAS_GASTO.find((c) => c.cuenta === codigo);
  return (enGasto && enGasto.nombre) || CUENTAS_CONOCIDAS[codigo] || "";
}

// Cuentas de resultado (gasto) reales, sacadas de la tabla "movimientos" de contabilidad.
const CATEGORIAS_GASTO = [
  { nombre: "Gerenciamiento", cuenta: "4.01.03.01" },
  { nombre: "Arriendo Instalaciones", cuenta: "4.01.03.02" },
  { nombre: "Arriendo Instalaciones Variables", cuenta: "4.01.03.03" },
  { nombre: "Gastos Comunes", cuenta: "4.01.03.04" },
  { nombre: "Telefonía e Internet", cuenta: "4.01.03.05" },
  { nombre: "Electricidad", cuenta: "4.01.03.06" },
  { nombre: "Gas", cuenta: "4.01.03.07" },
  { nombre: "Agua", cuenta: "4.01.03.08" },
  { nombre: "Servicios Informaticos", cuenta: "4.01.03.09" },
  { nombre: "Servicio de Seguridad", cuenta: "4.01.03.10" },
  { nombre: "Implementos Gimnasio", cuenta: "4.01.03.12" },
  { nombre: "Servicios en Streaming", cuenta: "4.01.03.13" },
  { nombre: "Gasto Fee de Ventas y Marketing", cuenta: "4.01.03.14" },
  { nombre: "Patentes Comerciales", cuenta: "4.01.03.15" },
  { nombre: "Fletes", cuenta: "4.01.03.16" },
  { nombre: "Combustibles", cuenta: "4.01.03.18" },
  { nombre: "Arriendo de Vehiculos", cuenta: "4.01.03.20" },
  { nombre: "Estacionamiento", cuenta: "4.01.03.21" },
  { nombre: "Seguros", cuenta: "4.01.03.22" },
  { nombre: "Materiales", cuenta: "4.01.03.25" },
  { nombre: "Materiales de Aseo y Oficina", cuenta: "4.01.03.26" },
  { nombre: "Gastos Cafeteria", cuenta: "4.01.03.27" },
  { nombre: "Servicios Computacionales", cuenta: "4.01.03.29" },
  { nombre: "Donaciones", cuenta: "4.01.03.31" },
  { nombre: "Gastos de Administración", cuenta: "4.01.03.32" },
  { nombre: "Mantenciones Generales", cuenta: "4.01.03.33" },
  { nombre: "Mantenciones Extraordinarias", cuenta: "4.01.03.34" },
  { nombre: "Gastos de Representacion", cuenta: "4.01.03.35" },
  { nombre: "Prevencion de Riesgos", cuenta: "4.01.03.36" },
  { nombre: "Publicidad y Marketing", cuenta: "4.01.03.38" },
  { nombre: "Publicidad After Dmoov", cuenta: "4.01.03.41" },
  { nombre: "Publicidad en RRSS", cuenta: "4.01.03.42" },
  { nombre: "Licencias SCD", cuenta: "4.01.03.43" },
  { nombre: "Fitmewise", cuenta: "4.01.03.44" },
  { nombre: "Informatica y Licencias", cuenta: "4.01.03.45" },
  { nombre: "Gastos RFA", cuenta: "4.01.03.46" },
  { nombre: "Asesoria Legal", cuenta: "4.01.03.47" },
  { nombre: "Asesoria Tributaria", cuenta: "4.01.03.48" },
  { nombre: "Otras Asesorias", cuenta: "4.01.03.49" },
  { nombre: "Beneficios del Personal", cuenta: "4.01.03.50" },
  { nombre: "Traslados del Personal", cuenta: "4.01.03.51" },
  { nombre: "Viaticos del Personal", cuenta: "4.01.03.52" },
  { nombre: "Capacitaciones al Personal", cuenta: "4.01.03.55" },
  { nombre: "Honorarios Profesionales", cuenta: "4.01.03.56" },
  { nombre: "Honorarios Sin Retención", cuenta: "4.01.03.57" },
  { nombre: "Otro (elegir cuenta manualmente)", cuenta: "" },
];

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function show(viewId) {
  // Al salir del formulario de nueva rendición se guarda lo último escrito, sin
  // esperar a los 500 ms del autoguardado.
  if (viewId !== "view-nueva") guardarBorradorRendicion();
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
  window.RindeUI?.show(viewId, document.getElementById("view-dashboard").dataset.section);
}

// Navegación con historial: para que el botón "Atrás" del navegador
// se mueva dentro de la app en vez de salir de la página.
// El hash de la URL codifica el estado (no solo el pushState en memoria) --
// así, al recargar la página (F5), el navegador vuelve a pedir el mismo
// hash y podemos reabrir exactamente esa pantalla en vez de mandar siempre
// al dashboard.
function hashDeVista(viewId, params) {
  if (viewId === "view-dashboard" && params?.section === "fondos") return "fondos";
  if (viewId === "view-detalle" && params?.id) return `detalle/${params.id}`;
  if (viewId === "view-detalle-solicitud" && params?.id) return `detalle-solicitud/${params.id}`;
  if (viewId === "view-nueva" && params?.borradorId) return `nueva/${params.borradorId}`;
  return viewId.replace("view-", "");
}
function estadoDesdeHash() {
  const [base, param] = location.hash.replace(/^#/, "").split("/");
  if (base === "detalle" && param) return { viewId: "view-detalle", params: { id: param } };
  if (base === "detalle-solicitud" && param) return { viewId: "view-detalle-solicitud", params: { id: param } };
  if (base === "inicio" || !base) return {viewId:"view-inicio",params:{}};
  if (base === "fondos") return {viewId:"view-dashboard",params:{section:"fondos"}};
  if (base === "admin") return { viewId: "view-admin", params: {} };
  if (base === "plantillas") return { viewId: "view-plantillas", params: {} };
  if (base === "reportes") return { viewId: "view-reportes", params: {} };
  if (base === "nueva") return { viewId: "view-nueva", params: param ? { borradorId: param } : {} };
  if (base === "borradores") return { viewId: "view-borradores", params: {} };
  if (base === "nueva-solicitud") return { viewId: "view-nueva-solicitud", params: {} };
  return { viewId: "view-dashboard", params: {} };
}
function pushView(viewId, params = {}) {
  show(viewId);
  history.pushState({ viewId, params, portalDepth:(history.state?.portalDepth||0)+1 }, "", "#" + hashDeVista(viewId, params));
  window.scrollTo({top:0,behavior:"auto"});
}
function replaceView(viewId, params = {}) {
  show(viewId);
  history.replaceState({ viewId, params, portalDepth:history.state?.portalDepth||0 }, "", "#" + hashDeVista(viewId, params));
}
function renderRoute(state) {
  const resuelto = state || estadoDesdeHash();
  const viewId = resuelto?.viewId || "view-dashboard";
  const params = resuelto?.params || {};
  if (["view-admin","view-plantillas","view-reportes"].includes(viewId) && currentProfile?.rol !== "admin") {replaceView("view-inicio");loadDashboard();return;}
  if (viewId === "view-inicio") {show("view-inicio");loadDashboard();return;}
  if (viewId === "view-detalle" && params.id) { openDetalle(params.id, false); return; }
  if (viewId === "view-detalle-solicitud" && params.id) { openDetalleSolicitud(params.id, false); return; }
  if (viewId === "view-admin") { openAdminUsuarios(false); return; }
  if (viewId === "view-plantillas") { openAdminPlantillas(false); return; }
  if (viewId === "view-reportes") { openReportes(false); return; }
  if (viewId === "view-nueva") { openNuevaRendicion(false, { borradorId: params.borradorId }); return; }
  if (viewId === "view-borradores") { openBorradores(false); return; }
  if (viewId === "view-nueva-solicitud") { openNuevaSolicitud(false); return; }
  configurarSeccionDashboard(params.section || "rendiciones");
  show("view-dashboard");
  loadDashboard();
}
window.addEventListener("popstate", (e) => renderRoute(e.state));
let toastTimeoutId = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  // Duración proporcional al largo del mensaje -- antes eran siempre 2.6s
  // fijos, y los resúmenes de "se guardaron X de Y ítems: <errores>" (que
  // pueden ser bastante largos) se alcanzaban a cortar antes de leerlos.
  // Si se llama toast() de nuevo antes de que se cumpla el timeout anterior,
  // hay que cancelarlo -- si no, el toast viejo podía ocultar el nuevo
  // mensaje a mitad de camino.
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  const duracion = Math.min(9000, Math.max(2600, msg.length * 60));
  toastTimeoutId = setTimeout(() => { t.classList.remove("show"); toastTimeoutId = null; }, duracion);
}

// Traduce los errores técnicos más comunes de Supabase/Postgres a un
// mensaje que una persona sin conocimientos técnicos pueda entender. Los
// mensajes que la base ya redacta en español (los "raise exception" de
// nuestros propios triggers, ej. "ya fue procesada...") se muestran tal
// cual porque ya están pensados para el usuario final.
function mensajeErrorAmigable(err) {
  const msg = err?.message || String(err || "");
  if (/ya fue procesad/i.test(msg) || /no está habilitada para tu perfil/i.test(msg) || /No autorizado/i.test(msg)) return msg;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Sin conexión a internet. Revisa tu conexión e inténtalo de nuevo.";
  if (/JWT|session|not authenticated|auth/i.test(msg)) return "Tu sesión expiró. Vuelve a iniciar sesión.";
  if (/permission denied|RLS|row-level security/i.test(msg)) return "No tienes permiso para hacer esta acción.";
  return msg || "Ocurrió un error inesperado.";
}
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  });
  return e;
}

// Fila de tabla que abre un detalle al hacer clic -- una <tr> con onclick
// por sí sola no es alcanzable con teclado (no tiene tabindex ni responde a
// Enter), así que quedaba invisible para navegación por teclado. Esto la
// hace tabulable y activable con Enter, igual que un link/botón real.
function filaClickable(onActivar, celdas) {
  return el("tr", {
    class: "row-clickable", tabindex: "0",
    onclick: onActivar,
    onkeydown: (e) => { if (e.key === "Enter") onActivar(); },
  }, celdas);
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
// ------------------------------------------------------------
// Modo claro / oscuro
// ------------------------------------------------------------
function applyThemeIcon() {
  const current = document.documentElement.getAttribute("data-theme");
  const isDark = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const icon = isDark ? "☀️" : "🌙";
  document.querySelectorAll(".theme-toggle").forEach((b) => { b.textContent = icon; });
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const isDark = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("rw-theme", next); } catch (e) {}
  applyThemeIcon();
}
// Un solo listener por clase (".theme-toggle"), no por id -- antes había un
// id fijo por pantalla ("btn-theme-toggle-login"), así que agregar el botón
// a una pantalla nueva (ej. "Recuperar contraseña", que no lo tenía --
// hallazgo de una prueba visual en mobile) significaba acordarse de cablear
// un tercer addEventListener a mano. Así, cualquier botón con esta clase
// funciona solo con agregarlo al HTML.
function wireTheme() {
  applyThemeIcon();
  document.querySelectorAll(".theme-toggle").forEach((b) => b.addEventListener("click", toggleTheme));
}

// Muestra/oculta cualquier campo de contraseña marcado con
// class="btn-ver-password" -- generalizado (antes solo existía el de
// login) para poder reusarlo también en "Crea tu nueva contraseña", que no
// tenía forma de verificar lo tipeado antes de guardar (hallazgo de una
// prueba visual en mobile). Cada botón controla el <input> que tiene al
// lado dentro de su mismo .password-field, no un id fijo.
function wirePasswordToggles() {
  document.querySelectorAll(".btn-ver-password").forEach((btn) => {
    const input = btn.previousElementSibling;
    if (!input || input.tagName !== "INPUT") return;
    btn.addEventListener("click", () => {
      const verEmpezar = input.type === "password";
      input.type = verEmpezar ? "text" : "password";
      btn.textContent = verEmpezar ? "🙈" : "👁";
      btn.setAttribute("aria-label", verEmpezar ? "Ocultar contraseña" : "Mostrar contraseña");
    });
  });
}

// Registra el service worker (ver sw.js) para poder "Agregar a la
// pantalla de inicio" y tener una pantalla mínima si se abre sin señal --
// nunca bloquea la carga de la app si falla o si el navegador no lo
// soporta (ej. algunos navegadores in-app de WhatsApp/Instagram).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("No se pudo registrar el service worker:", err));
  });
}

function mostrarErrorInicio(mensaje) {
  document.getElementById("inicio-sesion-status").textContent=mensaje;
  document.getElementById("btn-reintentar-inicio").hidden=false;
}

async function restaurarSesionInicial() {
  const {data,error}=await db.auth.getSession();
  if(error)throw error;
  if(document.getElementById("view-nueva-clave").classList.contains("active"))return;
  if(data?.session)await onLoggedIn(data.session.user);
  else show("view-login");
}

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("btn-reintentar-inicio").addEventListener("click",()=>location.reload());
  const esperaInicio=setTimeout(()=>mostrarErrorInicio("La conexión está tardando más de lo esperado. Puedes esperar o reintentar."),15000);
  try {
  wireTheme();
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    throw new Error("Configuración de conexión no disponible");
  }
  db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  if (CFG.CONTABILIDAD_URL && CFG.CONTABILIDAD_ANON_KEY) {
    // Cliente separado, aparte, solo para lecturas contra el proyecto de contabilidad.
    dbContabilidad = window.supabase.createClient(CFG.CONTABILIDAD_URL, CFG.CONTABILIDAD_ANON_KEY);
  }

  wireLoginForm();
  wireRecuperarClave();
  wireDashboard();
  wireNuevaRendicion();
  wireNuevaSolicitud();
  window.RindeUI.init({navigate:navegarPortal,detail:openDetalle,fund:openDetalleSolicitud});
  document.querySelectorAll("[data-portal-route]").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();navegarPortal(a.dataset.portalRoute);}));

  // Si la persona llegó desde el link de recuperación de contraseña del
  // correo, Supabase arma una sesión temporal y dispara "PASSWORD_RECOVERY"
  // -- hay que registrar este listener ANTES de chequear la sesión manual de
  // abajo, porque supabase-js reproduce ese evento apenas alguien se
  // suscribe. Si no lo interceptamos acá, el chequeo de sesión de abajo la
  // metería directo al dashboard en vez de dejarla definir su clave nueva.
  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      show("view-nueva-clave");
    } else if (event === "SIGNED_OUT") {
      currentUser = null;
      currentProfile = null;
      document.getElementById("app-shell").style.display = "none";
      show("view-login");
    }
  });

  await restaurarSesionInicial();
  } catch(error) {
    console.error("No se pudo iniciar RindeWellness:",error);
    mostrarErrorInicio("No pudimos cargar tu espacio. Comprueba tu conexión y vuelve a intentar.");
  } finally {clearTimeout(esperaInicio);}
});

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
let signupMode = false;

function wireLoginForm() {
  document.getElementById("btn-toggle-mode").addEventListener("click", () => {
    signupMode = !signupMode;
    document.getElementById("signup-extra").style.display = signupMode ? "block" : "none";
    document.getElementById("btn-login-submit").textContent = signupMode ? "Crear cuenta" : "Ingresar";
    document.getElementById("login-toggle-text").textContent = signupMode ? "¿Ya tienes cuenta?" : "¿No tienes cuenta?";
    document.getElementById("btn-toggle-mode").textContent = signupMode ? "Ingresar" : "Crear una";
    document.getElementById("login-error").textContent = "";
  });

  const rutInputSignup = document.getElementById("login-rut");
  const rutHint = document.getElementById("login-rut-hint");
  rutInputSignup.addEventListener("blur", async () => {
    const valor = rutInputSignup.value.trim();
    if (!valor) { rutHint.className = "ocr-status"; return; }
    rutInputSignup.value = formatearRut(valor);
    if (!validarRut(rutInputSignup.value)) {
      rutHint.textContent = "Ese RUT no parece válido (revisa el dígito verificador).";
      rutHint.className = "ocr-status show err";
      return;
    }
    // Lo cruzamos contra la contabilidad real (solo lectura) para sugerir
    // el nombre tal como está registrado ahí, y detectar antes typos.
    const nombreReal = await buscarNombreProveedorPorRut(rutInputSignup.value);
    if (nombreReal) {
      rutHint.textContent = `✔ Coincide con: ${nombreReal}`;
      rutHint.className = "ocr-status show ok";
      const nombreInput = document.getElementById("login-nombre");
      if (!nombreInput.value.trim()) nombreInput.value = nombreReal;
    } else {
      rutHint.textContent = "RUT válido (todavía no aparece en contabilidad, es normal si es tu primera rendición).";
      rutHint.className = "ocr-status show";
    }
  });

  wirePasswordToggles();

  document.getElementById("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errBox = document.getElementById("login-error");
    errBox.textContent = "";
    const btn = document.getElementById("btn-login-submit");
    btn.disabled = true;

    try {
      if (signupMode) {
        const nombre = document.getElementById("login-nombre").value.trim() || email;
        const rutInput = document.getElementById("login-rut").value.trim();
        if (rutInput && !validarRut(rutInput)) {
          throw new Error("El RUT ingresado no es válido (revisa el dígito verificador).");
        }
        const rut = formatearRut(rutInput);
        // El nombre/RUT también quedan en los metadatos del usuario de Auth
        // (no solo en "profiles"): si Supabase exige confirmar el correo
        // antes de tener sesión, el upsert de abajo puede fallar por RLS
        // (auth.uid() todavía es null) y el perfil recién se crea al primer
        // login real -- sin esto, ese perfil de respaldo quedaría con el
        // email como nombre en vez del nombre real que la persona escribió.
        const { data, error } = await db.auth.signUp({ email, password, options: { data: { nombre, rut } } });
        if (error) throw error;
        if (data.user) {
          const { error: upsertErr } = await db.from("profiles").upsert({
            id: data.user.id, nombre, rut, rol: "empleado",
          });
          if (upsertErr) console.error("No se pudo crear el perfil de inmediato (se creará al confirmar el correo):", upsertErr);
        }
        if (data.session) {
          await onLoggedIn(data.user);
        } else {
          errBox.style.color = "var(--success)";
          errBox.textContent = "Cuenta creada. Revisa tu correo para confirmar la cuenta y luego inicia sesión.";
        }
      } else {
        const { data, error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await onLoggedIn(data.user);
      }
    } catch (err) {
      errBox.style.color = "var(--danger)";
      errBox.textContent = err.message || "No se pudo completar la operación.";
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await db.auth.signOut();
  });

  // El link "¿Olvidaste tu contraseña?" solo tiene sentido para entrar a una
  // cuenta que ya existe, no al crear una nueva.
  document.getElementById("btn-toggle-mode").addEventListener("click", () => {
    document.getElementById("olvide-clave-wrap").style.display = signupMode ? "none" : "block";
  });
}

// ------------------------------------------------------------
// Recuperar / cambiar contraseña olvidada
// ------------------------------------------------------------
function wireRecuperarClave() {
  document.getElementById("btn-olvide-clave").addEventListener("click", () => {
    document.getElementById("recuperar-email").value = document.getElementById("login-email").value.trim();
    document.getElementById("recuperar-error").textContent = "";
    show("view-recuperar");
  });

  document.getElementById("btn-volver-login").addEventListener("click", () => show("view-login"));

  document.getElementById("form-recuperar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("recuperar-email").value.trim();
    const errBox = document.getElementById("recuperar-error");
    errBox.style.color = "var(--danger)";
    errBox.textContent = "";
    const btn = document.getElementById("btn-recuperar-submit");
    btn.disabled = true;
    try {
      // redirectTo apunta a la propia app: cuando la persona hace clic en el
      // link del correo, Supabase la trae de vuelta acá con una sesión
      // temporal de recuperación, que detectamos más abajo (evento
      // PASSWORD_RECOVERY) para mostrarle el formulario de nueva contraseña.
      const { error } = await db.auth.resetPasswordForEmail(email, {
        redirectTo: "https://rindewellness.netlify.app/",
      });
      if (error) throw error;
      errBox.style.color = "var(--success)";
      errBox.textContent = "Listo. Revisa tu correo (y spam) y sigue el link para crear una contraseña nueva.";
    } catch (err) {
      errBox.style.color = "var(--danger)";
      errBox.textContent = err.message || "No se pudo enviar el correo de recuperación.";
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("form-nueva-clave").addEventListener("submit", async (e) => {
    e.preventDefault();
    const clave1 = document.getElementById("nueva-clave-1").value;
    const clave2 = document.getElementById("nueva-clave-2").value;
    const errBox = document.getElementById("nueva-clave-error");
    errBox.style.color = "var(--danger)";
    errBox.textContent = "";
    if (clave1.length < 6) { errBox.textContent = "La contraseña debe tener al menos 6 caracteres."; return; }
    if (clave1 !== clave2) { errBox.textContent = "Las contraseñas no coinciden."; return; }

    const btn = document.getElementById("btn-nueva-clave-submit");
    btn.disabled = true;
    try {
      const { data, error } = await db.auth.updateUser({ password: clave1 });
      if (error) throw error;
      toast("Contraseña actualizada.");
      // El link de recuperación ya dejó a la persona con una sesión activa
      // -- la mandamos directo adentro en vez de pedirle que inicie sesión
      // de nuevo con la clave que recién creó.
      await onLoggedIn(data.user);
    } catch (err) {
      errBox.textContent = err.message || "No se pudo actualizar la contraseña.";
    } finally {
      btn.disabled = false;
    }
  });
}

async function onLoggedIn(user) {
  currentUser = user;
  let { data: profile, error: selError } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if(currentUser?.id!==user.id) return;
  if (selError) {
    console.error("Error leyendo perfil:",selError);
    currentProfile = null;
    document.getElementById("app-shell").style.display = "none";
    show("view-login");
    toast("No se pudo comprobar tu perfil. Reintenta el ingreso.");
    return;
  }
  if (!profile) {
    // Si el registro original quedó bloqueado por RLS (sesión aún no
    // confirmada), acá está la segunda oportunidad: usamos el nombre/RUT
    // reales que quedaron guardados en los metadatos de Auth al registrarse,
    // no el email, para que nunca quede "email · empleado" en la barra.
    const meta = user.user_metadata || {};
    const { data: created, error: insError } = await db
      .from("profiles")
      .insert({ id: user.id, nombre: meta.nombre || user.email, rut: meta.rut || null, rol: "empleado" })
      .select()
      .maybeSingle();
    if (insError) { console.error("Error creando perfil:", insError); toast("No se pudo crear tu perfil: " + insError.message); }
    if(currentUser?.id!==user.id) return;
    profile = created;
  }
  // Desactivada en vez de eliminada (ver "Desactivar" en Usuarios): no se
  // borra su historial, pero no puede volver a entrar. No usamos throw acá
  // porque onLoggedIn se llama desde tres lugares distintos (login normal,
  // registro con sesión inmediata, restauración de sesión al cargar la
  // página) y no todos están en un try/catch con su propio cuadro de error.
  if (profile && profile.activo === false) {
    await db.auth.signOut();
    currentUser = null;
    const errBox = document.getElementById("login-error");
    if (errBox) errBox.textContent = "Tu cuenta fue desactivada. Contacta a un administrador.";
    return;
  }
  if(!profile){currentProfile=null;document.getElementById("app-shell").style.display="none";show("view-login");return;}
  currentProfile = profile;
  window.RindeUI?.setProfile(profile);
  actualizarContadorBorradores();

  document.getElementById("user-name").textContent = `${profile?.nombre || user.email} · ${profile?.rol || "empleado"}`;
  document.getElementById("app-shell").style.display = "block";
  // esAprobadorEfectivo() (no solo profile.rol) para que un "delegado
  // temporal" (ver renderEditarPerfilPanel) de verdad pueda ejercer el
  // permiso que ya tiene en la base -- si esto solo mirara el rol, un
  // delegado nunca vería los tabs/botones para aprobar nada, aunque la
  // base ya lo dejara. "Usuarios" y "Reportes" siguen siendo solo-admin a
  // propósito: la delegación cubre aprobar, no administrar usuarios.
  document.getElementById("tab-aprobaciones").style.display =
    esAprobadorEfectivo(profile) ? "inline-block" : "none";
  document.getElementById("tab-solicitudes-aprobacion").style.display =
    esAprobadorEfectivo(profile) ? "inline-block" : "none";
  document.getElementById("btn-admin-usuarios").style.display =
    profile && profile.rol === "admin" ? "inline-block" : "none";
  document.getElementById("btn-reportes").style.display =
    profile && profile.rol === "admin" ? "inline-block" : "none";
  document.getElementById("btn-exportar-excel").style.display =
    esAprobadorEfectivo(profile) ? "inline-block" : "none";
  document.getElementById("btn-comprobante-rango").style.display =
    esAprobadorEfectivo(profile) ? "inline-block" : "none";

  try {
    await cargarCuentasPermitidas();
  } catch(err) {
    if(currentUser?.id!==user.id) return;
    currentProfile=null;
    document.getElementById("app-shell").style.display="none";
    show("view-login");
    toast("No se pudieron comprobar tus cuentas permitidas. Reintenta el ingreso.");
    console.error("Error cargando permisos:",err);
    return;
  }
  if(currentUser?.id!==user.id) return;

  // Si venías de un F5 (recarga) en "Nueva rendición", el detalle de una
  // rendición o "Usuarios", te dejamos en esa misma pantalla en vez de
  // mandarte siempre al dashboard -- el hash de la URL sobrevive la recarga.
  const estadoInicial = estadoDesdeHash();
  const esVistaSoloAdmin = ["view-admin", "view-plantillas", "view-reportes"].includes(estadoInicial.viewId);
  if (esVistaSoloAdmin && profile?.rol !== "admin") {
    replaceView("view-dashboard");
    await loadDashboard();
  } else {
    renderRoute(estadoInicial);
  }
}

// Las cuentas permitidas de la persona son la unión de sus cuentas
// individuales (perfil_cuentas) + las de su plantilla asignada, si tiene una
// (ver migracion_plantillas_perfil.sql) -- una no reemplaza a la otra.
async function cargarCuentasPermitidas() {
  const usuarioId=currentUser.id;
  cuentasPermitidas=new Set();
  const consultas = [db.from("perfil_cuentas").select("cuenta_cod").eq("profile_id", currentUser.id)];
  if (currentProfile?.plantilla_id) {
    consultas.push(db.from("plantilla_cuentas").select("cuenta_cod").eq("plantilla_id", currentProfile.plantilla_id));
  }
  const resultados = await Promise.all(consultas);
  if(currentUser?.id!==usuarioId) return;
  const codigos = new Set();
  resultados.forEach(({ data, error }) => {
    if (error) throw error;
    (data || []).forEach((d) => codigos.add(d.cuenta_cod));
  });
  cuentasPermitidas = codigos.size ? codigos : null;
}

// ------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------
function navegarPortal(route) {
  const allowed=["inicio","dashboard","fondos","borradores","reportes","admin","plantillas","nueva","nueva-solicitud"];
  if(!allowed.includes(route))return;
  if(location.hash==="#"+route)return;
  const state=route==="fondos"?{viewId:"view-dashboard",params:{section:"fondos"}}:{viewId:"view-"+route,params:{}};
  history.pushState({...state,portalDepth:(history.state?.portalDepth||0)+1},"","#"+route);
  renderRoute(state);
  window.scrollTo({top:0,behavior:"auto"});
}
function configurarSeccionDashboard(section) {
  const funds=section==="fondos";
  const dashboard=document.getElementById("view-dashboard");
  dashboard.dataset.section=funds?"fondos":"rendiciones";
  dashboard.querySelector("h1").textContent=funds?"Solicitudes de fondos":"Rendiciones";
  dashboard.querySelector(".hero-row p").textContent=funds?"Revisa lo entregado, lo aprobado y el saldo de cada fondo.":"Encuentra gastos por empleado, empresa, estado o folio.";
  const tab=funds?(esAprobadorEfectivo(currentProfile)?"solicitudes-aprobacion":"solicitudes-mias"):(esAprobadorEfectivo(currentProfile)?"aprobaciones":"mias");
  document.querySelector('[data-tab="'+tab+'"]').click();
  window.RindeUI?.show("view-dashboard",dashboard.dataset.section);
}

function wireDashboard() {
  document.getElementById("btn-nueva").addEventListener("click", () => openNuevaRendicion());
  document.getElementById("btn-solicitar-fondos").addEventListener("click", () => openNuevaSolicitud());
  document.getElementById("btn-admin-usuarios").addEventListener("click", () => openAdminUsuarios());
  document.getElementById("btn-reportes").addEventListener("click", () => openReportes());
  // "Exportar a Excel" abre un panel para elegir período, empresa y estado.
  const panelExcel = document.getElementById("panel-excel");
  const selEmpresaExcel = document.getElementById("excel-empresa");
  EMPRESAS.forEach((emp) => selEmpresaExcel.appendChild(el("option", { value: emp }, emp)));
  const ponerPeriodoExcel = (tipo) => { const p = periodoExcel(tipo); document.getElementById("excel-desde").value = p.desde; document.getElementById("excel-hasta").value = p.hasta; };
  document.getElementById("btn-exportar-excel").addEventListener("click", () => {
    if (panelExcel.style.display === "none") { if (!document.getElementById("excel-hasta").value) ponerPeriodoExcel("mes"); document.getElementById("excel-status").className = "ocr-status"; }
    panelExcel.style.display = panelExcel.style.display === "none" ? "block" : "none";
  });
  document.querySelectorAll("#excel-atajos [data-periodo]").forEach((b) => b.addEventListener("click", () => ponerPeriodoExcel(b.dataset.periodo)));
  document.getElementById("btn-cancelar-excel").addEventListener("click", () => { panelExcel.style.display = "none"; });
  const btnDescargarExcel = document.getElementById("btn-descargar-excel");
  btnDescargarExcel.addEventListener("click", async () => {
    btnDescargarExcel.disabled = true;
    btnDescargarExcel.textContent = "Generando...";
    await exportarExcel({
      desde: document.getElementById("excel-desde").value, hasta: document.getElementById("excel-hasta").value,
      empresa: selEmpresaExcel.value, estado: document.getElementById("excel-estado").value,
    });
    btnDescargarExcel.disabled = false;
    btnDescargarExcel.textContent = "Descargar Excel";
  });
  document.getElementById("btn-comprobante-rango").addEventListener("click", () => {
    document.getElementById("panel-rango").style.display = "block";
  });
  document.getElementById("btn-cancelar-rango").addEventListener("click", () => {
    document.getElementById("panel-rango").style.display = "none";
    document.getElementById("rango-status").className = "ocr-status";
  });
  const btnGenerarRango = document.getElementById("btn-generar-rango");
  btnGenerarRango.addEventListener("click", async () => {
    const desde = document.getElementById("rango-desde").value;
    const hasta = document.getElementById("rango-hasta").value;
    if (!desde || !hasta) { toast("Elige ambas fechas."); return; }
    btnGenerarRango.disabled = true;
    await generarComprobantesPorRango(desde, hasta);
    btnGenerarRango.disabled = false;
  });
  document.querySelectorAll(".back-link").forEach((b) =>
    b.addEventListener("click", () => {if(history.state?.portalDepth>0)history.back();else navegarPortal(b.dataset.back||"inicio");})
  );

  const empresaSelect = document.getElementById("filtro-empresa");
  EMPRESAS.forEach((emp) => empresaSelect.appendChild(el("option", { value: emp }, emp)));
  ["filtro-estado", "filtro-empresa"].forEach((id) =>
    document.getElementById(id).addEventListener("change", applyDashboardFilters)
  );
  document.getElementById("filtro-texto").addEventListener("input", applyDashboardFilters);
  document.getElementById("filtro-empleado").addEventListener("input", applyDashboardFilters);
  const LISTAS_POR_TAB = {
    "mias": "list-mias",
    "aprobaciones": "list-aprobaciones",
    "solicitudes-mias": "list-solicitudes-mias",
    "solicitudes-aprobacion": "list-solicitudes-aprobacion",
  };
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const tab = b.dataset.tab;
      document.getElementById("campo-filtro-empleado").style.display = (tab === "aprobaciones" || tab === "solicitudes-aprobacion") ? "" : "none";
      Object.entries(LISTAS_POR_TAB).forEach(([t, listId]) => {
        document.getElementById(listId).style.display = t === tab ? "flex" : "none";
      });
    })
  );
}

// Cache de la última carga, para poder filtrar sin volver a golpear la base.
const dashboardData = { mias: [], aprobaciones: [], solicitudesMias: [], solicitudesAprobacion: [], consumoFondos: new Map() };

// Los indicadores y filtros se calculan sobre consultas completas.
function resumirConsumoFondo(rendiciones, montoFondo) {
  const vigentes = (rendiciones || []).filter(r => r.estado === "Pendiente" || r.estado === "Aprobado");
  const consumido = vigentes.reduce((sum,r) => sum + Number(r.monto_total || 0),0);
  const aprobado = vigentes.reduce((sum,r) => sum + Number(r.monto_aprobado ?? (r.estado === "Aprobado" ? r.monto_total : 0)),0);
  return {consumido, aprobado, porRevisar: Math.max(0,consumido-aprobado), saldo: Number(montoFondo || 0)-consumido};
}

async function cargarConsumoFondos(solicitudes) {
  const resultado = new Map();
  const ids = [...new Set(solicitudes.map(s => s.id))];
  for (let inicio = 0; inicio < ids.length; inicio += 100) {
    const lote = ids.slice(inicio,inicio+100);
    const rendiciones = [];
    let correcto = true;
    for (let pagina = 0; ;) {
      // rendiciones_por_fondo trae la PARTE de cada rendición que le toca a cada
      // fondo (una rendición multifondo aparece una vez por fondo).
      const {data,error,count} = await db.from("rendiciones_por_fondo")
        .select("id,solicitud_fondo_id,monto_total,monto_aprobado,estado", {count:"exact"})
        .in("solicitud_fondo_id",lote).order("id").order("solicitud_fondo_id").range(pagina,pagina+499);
      if (error) {console.error("No se pudo calcular el consumo de fondos",error); correcto=false; break;}
      rendiciones.push(...(data || []));
      if (!data || !data.length) {if (count && rendiciones.length < count) correcto=false; break;}
      pagina += data.length;
      if (count !== null && pagina >= count) break;
    }
    if (correcto) lote.forEach(id => resultado.set(id, rendiciones.filter(r => r.solicitud_fondo_id === id)));
  }
  return resultado;
}

// Recorre todas las páginas y rechaza resultados truncados o inconsistentes.
const {consultarTodas} = window.RindeData;

let dashboardCarga=0;
async function loadDashboard() {
  const gen=++dashboardCarga, usuario=currentUser, perfil=currentProfile;
  if(!usuario || !perfil)return;
  const nuevo={...dashboardData};
  const aviso=document.getElementById("dashboard-carga-status");
  if(aviso){aviso.hidden=false;aviso.textContent="Actualizando rendiciones y montos…";}
  try {
  nuevo.mias=await consultarTodas(() => db.from("rendiciones").select("*",{count:"exact"}).eq("empleado_id",usuario.id).order("created_at",{ascending:false}).order("id"));

  nuevo.solicitudesMias=await consultarTodas(() => db.from("solicitudes_fondos").select("*",{count:"exact"}).eq("empleado_id",usuario.id).order("created_at",{ascending:false}).order("id"));

  if (esAprobadorEfectivo(perfil)) {
    // Aprobadores y admin ven TODAS las rendiciones del grupo, en cualquier
    // estado. Antes un aprobador solo recibía las que estaban Pendiente, y
    // eso le tapaba justamente el contexto con el que se aprueba bien: qué
    // se le aprobó antes a esa persona, si un gasto parecido ya había
    // pasado, qué se rechazó y por qué. Para volver a la cola de trabajo
    // está el filtro por estado de la misma vista (ver
    // applyDashboardFilters), que es una elección de quien mira y no algo
    // impuesto por la consulta.
    //
    // La base ya lo permitía: la policy rendiciones_select habilita a
    // 'aprobador' y 'admin' por igual. El límite era solo de la app.
    const todas = await consultarTodas(() => db.from("rendiciones").select("*",{count:"exact"}).order("created_at", { ascending: false }).order("id"));
    nuevo.aprobaciones = todas || [];
    document.getElementById("tab-aprobaciones").textContent = "Todas las rendiciones";

    const crearQuerySolicitudes = () => { let querySolicitudes = db.from("solicitudes_fondos").select("*",{count:"exact"});
    querySolicitudes = perfil.rol === "admin"
      ? querySolicitudes.order("created_at", { ascending: false })
      : querySolicitudes.eq("estado", "Pendiente").order("created_at", { ascending: true });
    return querySolicitudes.order("id"); };
    const solicitudesPendientes = await consultarTodas(crearQuerySolicitudes);
    nuevo.solicitudesAprobacion = solicitudesPendientes || [];
    document.getElementById("tab-solicitudes-aprobacion").textContent =
      perfil.rol === "admin" ? "Todas las solicitudes de fondos" : "Solicitudes de fondos pendientes";
  } else {
    nuevo.aprobaciones = [];
    nuevo.solicitudesAprobacion = [];
  }

  nuevo.consumoFondos = await cargarConsumoFondos([...nuevo.solicitudesMias,...nuevo.solicitudesAprobacion]);

  // El admin ve totales de TODA la empresa (ya tiene los datos: nuevo.aprobaciones
  // trae cada rendición, sin filtrar por estado, cuando el rol es admin) --
  // antes siempre se mostraban los propios, aunque quien mirara fuera admin
  // y le sirviera más ver el conjunto completo de un vistazo.
  if(gen!==dashboardCarga || currentUser?.id!==usuario.id)return;
  Object.assign(dashboardData,nuevo);
  const esAdmin = perfil?.rol === "admin";
  const paraStats = esAdmin ? nuevo.aprobaciones : nuevo.mias;
  const pendienteStats = paraStats.filter((r) => r.estado === "Pendiente");
  const pendiente = pendienteStats.reduce((s, r) => s + Math.max(0,Number(r.monto_total||0)-Number(r.monto_aprobado||0)), 0);
  const aprobado = paraStats.reduce((s,r)=>s+Number(r.monto_aprobado??(r.estado==="Aprobado"?r.monto_total:0)),0);
  // Cuántas de las Pendientes llevan más de 7 días esperando -- antes no
  // había ninguna forma de detectar un cuello de botella sin abrir cada
  // rendición a mirar la fecha una por una.
  const haceUnaSemana = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const antiguas = pendienteStats.filter((r) => new Date(r.created_at).getTime() < haceUnaSemana).length;
  renderStats(pendiente, aprobado, paraStats.length, esAdmin, antiguas);

  applyDashboardFilters();
  window.RindeUI.renderHome(dashboardData,esAprobadorEfectivo(perfil),resumirConsumoFondo,renderList);
  if (esAprobadorEfectivo(perfil)) void mostrarFondosPorCerrar(gen);
  // Recorrido guiado: se ofrece la primera vez y queda en el menú ("Ver recorrido").
  // Solo la primera vez: el perfil guarda cuándo lo vio (recorrido_visto_en), en cualquier dispositivo.
  try { window.RindeRecorrido?.preparar({ usuarioId: usuario.id, nombre: perfil?.nombre || "", rol: perfil?.rol || "empleado", aprobador: esAprobadorEfectivo(perfil),
    yaVisto: !!perfil?.recorrido_visto_en,
    alTerminar: () => { if (perfil.recorrido_visto_en) return; perfil.recorrido_visto_en = new Date().toISOString();
      db.rpc("marcar_recorrido_visto").then(({ error }) => { if (error) console.error("No se pudo guardar que se vio el recorrido:", error); }); } }); }
  catch (error) { console.error("No se pudo preparar el recorrido:", error); }
  if(aviso)aviso.hidden=true;
  } catch (error) {
    if(gen!==dashboardCarga || currentUser?.id!==usuario.id)return;
    if(aviso){aviso.hidden=false;aviso.textContent="No se pudieron actualizar los datos. Se conserva la última lectura disponible. ";aviso.appendChild(el("button",{type:"button",class:"btn btn-ghost",onclick:loadDashboard},"Reintentar"));}
    if(document.getElementById("view-inicio").classList.contains("active")) document.getElementById("portal-home-content").replaceChildren(el("p",{},"No se pudieron cargar tus rendiciones."),el("button",{class:"btn btn-secondary",onclick:loadDashboard},"Reintentar"));
    console.error("No se pudo cargar el dashboard completo",error);
    toast("No se pudieron actualizar los datos completos. Intenta nuevamente; los montos no se han recalculado.");
  }
}

function normalizarBusquedaEmpleado(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLocaleLowerCase("es");
}

function applyDashboardFilters() {
  const estado = document.getElementById("filtro-estado").value;
  const empresa = document.getElementById("filtro-empresa").value;
  const texto = document.getElementById("filtro-texto").value.trim().toLowerCase();

  const pasaFiltro = (r) =>
    (!estado || r.estado === estado) &&
    (!empresa || r.empresa === empresa) &&
    (!texto || `${r.folio || ""} ${r.comentario || ""} ${r.empleado_nombre || ""}`.toLowerCase().includes(texto));

  const pasaFiltroSolicitud = (s) =>
    (!estado || s.estado === estado) &&
    (!empresa || s.empresa === empresa) &&
    (!texto || `${s.motivo || ""} ${s.empleado_nombre || ""}`.toLowerCase().includes(texto));

  // Con otros filtros, cada lista vuelve a mostrar las primeras 20 (ver limitarLista).
  const claveFiltros = [estado, empresa, texto, document.getElementById("filtro-empleado").value].join("|");
  for (const id of ["list-mias", "list-aprobaciones", "list-solicitudes-mias", "list-solicitudes-aprobacion"]) {
    const lista = document.getElementById(id);
    if (lista && lista.dataset.filtros !== claveFiltros) { lista.dataset.filtros = claveFiltros; delete lista.dataset.limite; }
  }
  renderList(document.getElementById("list-mias"), dashboardData.mias.filter(pasaFiltro), false);
  renderList(document.getElementById("list-aprobaciones"), dashboardData.aprobaciones.filter(r => pasaFiltro(r) && normalizarBusquedaEmpleado(r.empleado_nombre).includes(normalizarBusquedaEmpleado(document.getElementById("filtro-empleado").value))), true);
  renderListSolicitudes(document.getElementById("list-solicitudes-mias"), dashboardData.solicitudesMias.filter(pasaFiltroSolicitud), false);
  renderListSolicitudes(document.getElementById("list-solicitudes-aprobacion"), dashboardData.solicitudesAprobacion.filter(s => pasaFiltroSolicitud(s) && normalizarBusquedaEmpleado(s.empleado_nombre).includes(normalizarBusquedaEmpleado(document.getElementById("filtro-empleado").value))), true);
}

function renderStats(pendiente, aprobado, count, esAdmin, antiguas) {
  const row = document.getElementById("stat-row");
  row.innerHTML = "";
  row.appendChild(el("div", { class: "stat-card" }, [
    el("div", { class: "label" }, esAdmin ? "Rendiciones (toda la empresa)" : "Rendiciones"),
    el("div", { class: "value" }, String(count)),
  ]));
  row.appendChild(el("div", { class: "stat-card blue" }, [
    el("div", { class: "label" }, esAdmin ? "Pendiente de aprobar (empresa)" : "Pendiente de aprobar"),
    el("div", { class: "value" }, fmtCLP(pendiente)),
  ]));
  row.appendChild(el("div", { class: "stat-card teal" }, [
    el("div", { class: "label" }, esAdmin ? "Aprobado (empresa)" : "Aprobado"),
    el("div", { class: "value" }, fmtCLP(aprobado)),
  ]));
  if (antiguas > 0) {
    row.appendChild(el("div", { class: "stat-card", style: "border:1px solid var(--warn);" }, [
      el("div", { class: "label" }, "Pendientes hace +7 días"),
      el("div", { class: "value", style: "color:var(--warn);" }, String(antiguas)),
    ]));
  }
}

// En el teléfono una lista con todas las rendiciones medía más de 22.000 px: se
// muestran 20 y un botón agrega 20 más. Los filtros y la búsqueda siguen
// recorriendo todas; esto solo limita cuántas filas se dibujan.
const FILAS_POR_PAGINA = 20;
function limitarLista(container, rows, volverAPintar) {
  const limite = Math.max(FILAS_POR_PAGINA, Number(container.dataset.limite) || FILAS_POR_PAGINA);
  const pie = rows.length > limite ? el("div", { class: "lista-mas" }, [
    el("span", { class: "portal-muted" }, `Mostrando ${limite} de ${rows.length}`),
    el("button", { class: "btn btn-secondary", type: "button", onclick: () => { container.dataset.limite = String(limite + FILAS_POR_PAGINA); volverAPintar(); } },
      `Mostrar ${Math.min(FILAS_POR_PAGINA, rows.length - limite)} más`),
  ]) : null;
  return { visibles: rows.slice(0, limite), pie };
}

function renderList(container, rows, showEmpleado) {
  container.replaceChildren();
  if(!rows.length){container.appendChild(el("div",{class:"empty-state"},"No hay rendiciones para estos filtros."));return;}
  const todas = rows, pagina = limitarLista(container, todas, () => renderList(container, todas, showEmpleado));
  rows = pagina.visibles;
  const cols=["Folio",showEmpleado?"Empleado / Empresa":"Empresa","Motivo / Fecha","Rendido","Aprobado","Estado"];
  const table=el("table",{class:"items-table portal-list-table portal-rendiciones-table","aria-label":"Rendiciones"},[
    el("colgroup",{},[8,23,27,15,15,12].map(width=>el("col",{style:"width:"+width+"%"}))),
    el("thead",{},el("tr",{},cols.map((c,i)=>el("th",{scope:"col",class:i===3||i===4?"right":i===5?"center":""},c))))]);
  const tbody=el("tbody");
  rows.forEach(r=>{
    const cells=[el("td",{},"Nº "+(r.folio??"—")),el("td",{},[el("strong",{},showEmpleado?(r.empleado_nombre||"—"):(r.empresa||"—")),el("small",{},showEmpleado?(r.empresa||"—"):"")]),
      el("td",{},[el("span",{},r.comentario||"Sin comentario"),el("small",{},(r.tipo_rendicion==="FondoPorRendir"?"Fondo por rendir":"Reembolso")+" · "+fmtDate(r.fecha_rendicion||r.created_at))]),
      el("td",{class:"monto"},fmtCLP(r.monto_rendido??r.monto_total)),el("td",{class:"monto portal-approved"},fmtCLP(r.monto_aprobado??(r.estado==="Aprobado"?r.monto_total:0))),el("td",{class:"center portal-status"},el("span",{class:"pill "+r.estado},r.estado))];
    cells.forEach((c,i)=>c.setAttribute("data-label",cols[i]));tbody.appendChild(filaClickable(()=>openDetalle(r.id),cells));
  });table.append(tbody);container.appendChild(el("div",{class:"table-scroll"},table));
  if (pagina.pie) container.appendChild(pagina.pie);
}

function renderListSolicitudes(container, rows, showEmpleado) {
  container.replaceChildren();
  if(!rows.length){container.appendChild(el("div",{class:"empty-state"},"No hay solicitudes de fondos para estos filtros."));return;}
  const todas = rows, pagina = limitarLista(container, todas, () => renderListSolicitudes(container, todas, showEmpleado));
  rows = pagina.visibles;
  const cols=[showEmpleado?"Folio / Empleado":"Folio","Motivo / Empresa","Solicitado","Consumo aprobado","En revisión","Saldo / Exceso","Estado"];
  const table=el("table",{class:"items-table portal-list-table fondos-tabla","aria-label":"Solicitudes de fondos"},[
    el("colgroup",{},[16,24,12,14,11,13,10].map(width=>el("col",{style:"width:"+width+"%"}))),
    el("thead",{},el("tr",{},cols.map((c,i)=>el("th",{scope:"col",class:i>=2&&i<=5?"right":i===6?"center":""},c))))]);
  const tbody=el("tbody");
  rows.forEach(s=>{
    const available=dashboardData.consumoFondos.get(s.id),c=available?resumirConsumoFondo(available,s.monto_solicitado):null,cerrado=s.estado==="Cerrado",approved=s.estado==="Aprobado"||cerrado;
    const amount=v=>!approved?"—":c?fmtCLP(v):"No disponible";
    const cells=[el("td",{},[el("strong",{},"S-"+(s.folio??"—")),el("small",{},showEmpleado?(s.empleado_nombre||"—"):"")]),
      el("td",{},[el("span",{},s.motivo||"Sin motivo"),el("small",{},s.empresa||"—"),el("small",{},(s.centro_costo||"—")+" · "+fmtDate(s.created_at))]),el("td",{class:"monto"},fmtCLP(s.monto_solicitado)),el("td",{class:"monto portal-approved"},amount(c?.aprobado)),el("td",{class:"monto"},amount(c?.porRevisar)),
      cerrado?el("td",{class:"monto"},["—",el("small",{},"Liquidado")]):el("td",{class:"monto "+(c?.saldo<0?"portal-negative":"")},[amount(Math.abs(c?.saldo||0)),el("small",{},approved&&c?(c.saldo<0?"Exceso":"Disponible para rendir"):"")]),el("td",{class:"center portal-status"},el("span",{class:"pill "+s.estado},s.estado))];
    cells.forEach((cell,i)=>cell.setAttribute("data-label",cols[i]));tbody.appendChild(filaClickable(()=>openDetalleSolicitud(s.id),cells));
  });table.append(tbody);container.append(el("div",{class:"table-scroll"},table),el("p",{class:"portal-muted"},"El saldo descuenta gastos aprobados y pendientes de revisión. Los rechazados quedan excluidos."));
  if (pagina.pie) container.appendChild(pagina.pie);
}

// ------------------------------------------------------------
// Reportes (solo admin): gasto acumulado por empresa y por categoría, en
// el rango de fechas elegido. No pega una consulta nueva a la base -- el
// admin ya trae TODAS las rendiciones en dashboardData.aprobaciones (ver
// loadDashboard), así que esto solo agrupa lo que ya está en memoria.
// ------------------------------------------------------------
async function openReportes(pushHistory = true) {
  if (pushHistory) pushView("view-reportes"); else show("view-reportes");
  const desdeInput = document.getElementById("reportes-desde");
  const hastaInput = document.getElementById("reportes-hasta");
  if (!desdeInput.value) {
    const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    desdeInput.value = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(hace30);
  }
  if (!hastaInput.value) hastaInput.value = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

  desdeInput.onchange = renderReportes;
  hastaInput.onchange = renderReportes;
  const card=desdeInput.closest(".card");
  if(!document.getElementById("portal-reporte-empresa")) {
    const empresa=el("select",{id:"portal-reporte-empresa"},[el("option",{value:""},"Todas las empresas"),...EMPRESAS.map(e=>el("option",{value:e},e))]);
    const empleado=el("input",{id:"portal-reporte-empleado",type:"search",placeholder:"Buscar empleado…"});
    card.appendChild(el("div",{class:"field-row"},[el("div",{class:"field"},[el("label",{for:empresa.id},"Empresa"),empresa]),el("div",{class:"field"},[el("label",{for:empleado.id},"Empleado"),empleado])]));
    empresa.onchange=renderReportes;empleado.onchange=renderReportes;
  }

  // Si todavía no se cargó el dashboard en esta sesión (ej. F5 directo en
  // #reportes), dashboardData.aprobaciones viene vacío -- lo pedimos antes
  // de renderizar para no mostrar "sin datos" de entrada.
  if (!dashboardData.aprobaciones.length) await loadDashboard();
  renderReportes();
}

// Suma cuánto lleva aprobado una empresa en cada mes calendario, usando
// TODO el histórico ya cargado en dashboardData.aprobaciones (no depende
// del rango elegido) -- lo usa calcularAnomalias() para comparar el rango
// actual contra el promedio de los 3 meses previos.
function montoMensualPorEmpresa() {
  const porEmpresaMes = {};
  dashboardData.aprobaciones.forEach((r) => {
    if (r.estado !== "Aprobado") return;
    const empresa = r.empresa || "Sin empresa";
    const mesKey = String(r.created_at).slice(0, 7);
    if (!porEmpresaMes[empresa]) porEmpresaMes[empresa] = {};
    porEmpresaMes[empresa][mesKey] = (porEmpresaMes[empresa][mesKey] || 0) + Number(r.monto_total || 0);
  });
  return porEmpresaMes;
}

// Compara el gasto del rango elegido (normalizado a "por mes", para poder
// comparar rangos de cualquier largo) contra el promedio de los 3 meses
// calendario previos al "hasta" -- si supera ese promedio en 30% o más, se
// marca como algo que vale la pena que un humano revise. Con menos de una
// semana de rango no se calcula nada: normalizar un par de días a "por mes"
// multiplica cualquier ruido y da falsos positivos.
function calcularAnomalias(porEmpresaRango, desdeMs, hastaMs) {
  const diasRango = (hastaMs - desdeMs) / (24 * 60 * 60 * 1000);
  if (!isFinite(diasRango) || diasRango < 7) return [];
  const factorMensual = 30 / diasRango;
  const porEmpresaMes = montoMensualPorEmpresa();
  const mesHasta = new Date(hastaMs);
  const resultados = [];
  Object.entries(porEmpresaRango).forEach(([empresa, montoRango]) => {
    const meses = porEmpresaMes[empresa] || {};
    const mesesPrevios = [1, 2, 3].map((i) => {
      const d = new Date(mesHasta.getFullYear(), mesHasta.getMonth() - i, 1);
      return meses[d.toISOString().slice(0, 7)] || 0;
    }).filter((v) => v > 0);
    if (!mesesPrevios.length) return;
    const promedio = mesesPrevios.reduce((s, v) => s + v, 0) / mesesPrevios.length;
    if (promedio <= 0) return;
    const montoNormalizado = montoRango * factorMensual;
    const variacion = (montoNormalizado - promedio) / promedio;
    if (variacion >= 0.3) resultados.push({ empresa, variacion, promedio, montoNormalizado });
  });
  return resultados.sort((a, b) => b.variacion - a.variacion);
}

let generacionReportes = 0;
async function renderReportes() {
  const generation = ++generacionReportes;
  const target = document.getElementById("reportes-contenido");
  const cont = el("div", {class:"portal-report-body"});
  target.replaceChildren(el("p",{role:"status"},"Preparando reportes…"));
  try {
  const desde = document.getElementById("reportes-desde").value;
  const hasta = document.getElementById("reportes-hasta").value;
  const desdeMs = desde ? new Date(desde + "T00:00:00").getTime() : -Infinity;
  const hastaMs = hasta ? new Date(hasta + "T23:59:59").getTime() : Infinity;
  if(desdeMs>hastaMs){document.getElementById("portal-report-summary").replaceChildren();target.replaceChildren(el("p",{class:"ocr-status show err"},"La fecha Hasta debe ser igual o posterior a Desde."));return;}
  const enRango = (r, dMs, hMs) => {
    const t = new Date(r.created_at).getTime();
    return t >= dMs && t <= hMs;
  };

  const empresa=document.getElementById("portal-reporte-empresa")?.value||"";
  const empleado=normalizarBusquedaEmpleado(document.getElementById("portal-reporte-empleado")?.value);
  const porPersonaEmpresa=r=>(!empresa||r.empresa===empresa)&&(!empleado||normalizarBusquedaEmpleado(r.empleado_nombre).includes(empleado));
  const seleccion=dashboardData.aprobaciones.filter(r=>enRango(r,desdeMs,hastaMs)&&porPersonaEmpresa(r));
  const rendicionesEnRango = seleccion.filter(r=>r.estado==="Aprobado");
  const ui=window.RindeUI;
  document.getElementById("portal-report-summary").replaceChildren(
    ui.metric("Monto rendido",fmtCLP(seleccion.reduce((n,r)=>n+Number(r.monto_rendido??r.monto_total??0),0)),seleccion.length+" rendiciones"),
    ui.metric("Monto aprobado",fmtCLP(seleccion.reduce((n,r)=>n+Number(r.monto_aprobado??(r.estado==="Aprobado"?r.monto_total:0)),0)),"Gastos aceptados","positive"),
    ui.metric("Pendiente de revisión",fmtCLP(seleccion.filter(r=>r.estado==="Pendiente").reduce((n,r)=>n+Number(r.monto_total||0)-Number(r.monto_aprobado||0),0)),"Período seleccionado","warning"));

  const { data: presupuestosData, error: errPresupuestos } = await db.from("presupuestos").select("*");
  if (errPresupuestos) console.error("Error cargando presupuestos:", errPresupuestos);
  const presupuestoPorEmpresa = {};
  (presupuestosData || []).forEach((p) => { presupuestoPorEmpresa[p.empresa] = p.monto_limite_mensual; });

  cont.innerHTML = "";
  cont.appendChild(el("p",{class:"portal-muted"},"Las distribuciones y el CSV incluyen rendiciones finalizadas aprobadas. El resumen superior también muestra los ítems aprobados en rendiciones todavía pendientes."));

  // Tabla genérica "nombre · monto", ordenada de mayor a menor -- la
  // reusan casi todos los reportes de abajo (empresa, categoría, cuenta
  // contable, centro de costo, empleado, tipo de rendición).
  const tabla = (titulo, datos) => {
    cont.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.95rem" }, titulo));
    const t = el("table", { class: "items-table" });
    t.appendChild(el("thead", {}, [el("tr", {}, [el("th", {}, "Nombre"), el("th", { class: "right" }, "Monto")])]));
    const tbody = el("tbody");
    Object.entries(datos).sort((a, b) => b[1] - a[1]).forEach(([nombre, monto]) => {
      tbody.appendChild(el("tr", {}, [
        el("td", { "data-label": "Nombre" }, nombre),
        el("td", { class: "monto", "data-label": "Monto" }, fmtCLP(monto)),
      ]));
    });
    t.appendChild(tbody);
    cont.appendChild(el("div", { class: "table-scroll" }, [t]));
  };

  if (!rendicionesEnRango.length) {
    cont.appendChild(el("div", { class: "empty-state" }, "No hay rendiciones finalizadas aprobadas para estos filtros."));
  } else {
    const totalGeneral = rendicionesEnRango.reduce((s, r) => s + Number(r.monto_total || 0), 0);

    // Comparación contra el período inmediatamente anterior, de igual
    // duración -- ej. si el rango es "últimos 30 días", se compara contra
    // los 30 días antes de eso. Sin esto, un número suelto ("$237.690
    // aprobado") no dice si eso es mucho o poco comparado con lo normal.
    const duracionMs = hastaMs - desdeMs;
    let deltaTexto = null;
    if (isFinite(duracionMs) && duracionMs > 0) {
      const hastaAnteriorMs = desdeMs - 1;
      const desdeAnteriorMs = hastaAnteriorMs - duracionMs;
      const totalAnterior = dashboardData.aprobaciones
        .filter((r) => r.estado === "Aprobado" && enRango(r, desdeAnteriorMs, hastaAnteriorMs) && porPersonaEmpresa(r))
        .reduce((s, r) => s + Number(r.monto_total || 0), 0);
      if (totalAnterior > 0) {
        const variacion = ((totalGeneral - totalAnterior) / totalAnterior) * 100;
        deltaTexto = `${variacion >= 0 ? "+" : ""}${variacion.toFixed(0)}% vs. período anterior (${fmtCLP(totalAnterior)})`;
      } else if (totalGeneral > 0) {
        deltaTexto = "Sin gasto aprobado en el período anterior equivalente.";
      }
    }

    cont.appendChild(el("div", { class: "totals-bar", style: "margin-bottom:4px;" }, [
      el("span", {}, `Rendiciones finalizadas aprobadas (${rendicionesEnRango.length})`),
      el("span", { class: "amount" }, fmtCLP(totalGeneral)),
    ]));
    if (deltaTexto) {
      cont.appendChild(el("p", { style: "margin:0 0 10px;color:var(--ink-soft);font-size:0.85rem;" }, deltaTexto));
    }

    // El contenido real se arma más abajo (después de la consulta a
    // rendicion_items) -- el botón ya queda visible acá arriba, pero el
    // clic recién lee "csvContenido" al momento de apretarlo, cuando ya
    // está listo.
    let csvContenido = "";
    const btnCSV = el("button", { class: "btn btn-secondary btn-sm", type: "button", style: "margin-bottom:18px;" }, "Descargar CSV");
    btnCSV.addEventListener("click", () => {
      if (!csvContenido) { toast("Todavía se está armando el reporte, espera un segundo."); return; }
      const blob = new Blob(["﻿" + csvContenido], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `reportes_${desde || "inicio"}_a_${hasta || "hoy"}.csv`;
      a.click();
    });
    cont.appendChild(btnCSV);

    // Agrupaciones que salen directo de rendicionesEnRango, sin pedir nada
    // nuevo a la base (ya está todo cargado en dashboardData).
    const porEmpresa = {};
    const porEmpleado = {};
    const porTipoRendicion = {};
    const porMes = {};
    rendicionesEnRango.forEach((r) => {
      const monto = Number(r.monto_total || 0);
      const empresa = r.empresa || "Sin empresa";
      porEmpresa[empresa] = (porEmpresa[empresa] || 0) + monto;
      porEmpleado[r.empleado_nombre || "Sin nombre"] = (porEmpleado[r.empleado_nombre || "Sin nombre"] || 0) + monto;
      const tipoLabel = r.tipo_rendicion === "FondoPorRendir" ? "Fondo por Rendir" : "Reembolso";
      porTipoRendicion[tipoLabel] = (porTipoRendicion[tipoLabel] || 0) + monto;
      porMes[String(r.created_at).slice(0, 7)] = (porMes[String(r.created_at).slice(0, 7)] || 0) + monto;
    });

    // Top 5 como tarjetas compactas, para ver lo más importante de un
    // vistazo antes de bajar a las tablas completas.
    const tarjetaTop = (titulo, datos) => el("div", { class: "card", style: "flex:1;min-width:220px;" }, [
      el("p", { style: "margin:0 0 10px;font-weight:600;font-size:0.85rem;color:var(--ink-soft);" }, titulo),
      ...Object.entries(datos).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([nombre, monto], i) =>
        el("p", { style: "margin:0 0 6px;font-size:0.85rem;display:flex;justify-content:space-between;gap:10px;" }, [
          el("span", { style: "color:var(--ink-soft);" }, `${i + 1}. ${nombre}`),
          el("strong", {}, fmtCLP(monto)),
        ])
      ),
    ]);
    cont.appendChild(el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;" }, [
      tarjetaTop("Top 5 empresas", porEmpresa),
      tarjetaTop("Top 5 empleados", porEmpleado),
    ]));

    // Aviso si alguna empresa gastó notoriamente más de lo normal en el
    // rango elegido -- mismo estilo que la tarjeta de "Pendientes hace +7
    // días" del dashboard, para que se note sin tener que leer las tablas.
    const anomalias = calcularAnomalias(porEmpresa, desdeMs, hastaMs);
    anomalias.forEach(({ empresa, variacion, promedio }) => {
      cont.appendChild(el("div", { class: "card", style: "border:1px solid var(--warn);margin-bottom:10px;" }, [
        el("p", { style: "margin:0;font-size:0.85rem;" }, [
          "⚠ ", el("strong", {}, empresa), ` gastó ${Math.round(variacion * 100)}% más de lo normal en este período `,
          `(promedio de los últimos 3 meses: ${fmtCLP(promedio)}/mes).`,
        ]),
      ]));
    });

    // "Por empresa" con presupuesto: a diferencia de las demás tablas
    // (que solo muestran el monto), esta agrega el límite mensual (si el
    // admin configuró uno para esa empresa, ver "Configurar presupuestos"
    // más abajo) y una barra de progreso simple -- OJO: el presupuesto es
    // MENSUAL, así que la comparación es más precisa cuando el rango
    // elegido arriba cubre ~1 mes; para rangos más largos/cortos igual se
    // muestra, pero es una referencia menos exacta (se avisa en la etiqueta).
    cont.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.95rem" }, "Por empresa"));
    const tablaEmp = el("table", { class: "items-table" });
    tablaEmp.appendChild(el("thead", {}, [el("tr", {}, ["Nombre", "Monto", "Presupuesto mensual"].map((c) => el("th", { class: c === "Nombre" ? "" : "right" }, c)))]));
    const tbodyEmp = el("tbody");
    Object.entries(porEmpresa).sort((a, b) => b[1] - a[1]).forEach(([nombre, monto]) => {
      const limite = presupuestoPorEmpresa[nombre];
      let celdaPresupuesto;
      if (limite) {
        const pct = Math.min(999, Math.round((monto / limite) * 100));
        const color = pct >= 100 ? "var(--danger)" : pct >= 80 ? "var(--warn)" : "var(--success)";
        celdaPresupuesto = el("div", {}, [
          el("div", { style: "font-size:0.78rem;color:var(--ink-soft);margin-bottom:3px;" }, `${fmtCLP(limite)} (${pct}%)`),
          el("div", { style: "height:6px;border-radius:3px;background:var(--line);overflow:hidden;" }, [
            el("div", { style: `height:100%;border-radius:3px;background:${color};width:${Math.min(100, pct)}%;` }),
          ]),
        ]);
      } else {
        celdaPresupuesto = "Sin definir";
      }
      tbodyEmp.appendChild(el("tr", {}, [
        el("td", { "data-label": "Nombre" }, nombre),
        el("td", { class: "monto", "data-label": "Monto" }, fmtCLP(monto)),
        el("td", { class: "right", "data-label": "Presupuesto mensual", style: "min-width:140px;" }, celdaPresupuesto),
      ]));
    });
    tablaEmp.appendChild(tbodyEmp);
    cont.appendChild(el("div", { class: "table-scroll" }, [tablaEmp]));

    // Panel para editar los presupuestos, colapsado por default -- Reportes
    // ya es una vista solo-admin, así que no hace falta otro chequeo de rol.
    const presupuestosBox = el("div", { style: "display:none; margin:10px 0 16px;" });
    const btnConfigPresupuestos = el("button", { class: "btn btn-secondary btn-sm", type: "button", style: "margin-bottom:16px;" }, "Configurar presupuestos");
    btnConfigPresupuestos.addEventListener("click", () => {
      presupuestosBox.style.display = presupuestosBox.style.display === "none" ? "block" : "none";
    });
    EMPRESAS.forEach((empresa) => {
      const input = el("input", { type: "text", inputmode: "numeric", placeholder: "Sin límite", style: "width:140px;" });
      if (presupuestoPorEmpresa[empresa]) input.value = Number(presupuestoPorEmpresa[empresa]).toLocaleString("es-CL");
      input.addEventListener("input", () => formatearInputMoney(input));
      const btnGuardar = el("button", { class: "btn btn-sm", type: "button" }, "Guardar");
      btnGuardar.addEventListener("click", async () => {
        const monto = parseMoneyValue(input.value);
        if (!monto) {
          const { error } = await db.from("presupuestos").delete().eq("empresa", empresa);
          if (error) { toast(mensajeErrorAmigable(error)); return; }
          delete presupuestoPorEmpresa[empresa];
          toast(`Presupuesto de ${empresa} eliminado.`);
        } else {
          const { error } = await db.from("presupuestos").upsert({ empresa, monto_limite_mensual: monto, updated_at: new Date().toISOString() }, { onConflict: "empresa" });
          if (error) { toast(mensajeErrorAmigable(error)); return; }
          presupuestoPorEmpresa[empresa] = monto;
          toast(`Presupuesto de ${empresa} actualizado.`);
        }
        renderReportes();
      });
      presupuestosBox.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;" }, [
        el("span", { style: "flex:1;font-size:0.85rem;" }, empresa),
        input,
        btnGuardar,
      ]));
    });
    cont.appendChild(btnConfigPresupuestos);
    cont.appendChild(presupuestosBox);

    tabla("Por empleado", porEmpleado);
    tabla("Reembolso vs. Fondo por Rendir", porTipoRendicion);

    // Tendencia mensual: a diferencia de las demás, esta va ordenada
    // cronológicamente (no de mayor a menor monto) para poder leerla como
    // una serie de tiempo.
    cont.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.95rem" }, "Tendencia mensual"));
    const tablaMes = el("table", { class: "items-table" });
    tablaMes.appendChild(el("thead", {}, [el("tr", {}, [el("th", {}, "Mes"), el("th", { class: "right" }, "Monto")])]));
    const tbodyMes = el("tbody");
    const maxMes = Math.max(...Object.values(porMes));
    Object.entries(porMes).sort((a, b) => a[0].localeCompare(b[0])).forEach(([mes, monto]) => {
      const [y, m] = mes.split("-");
      const etiquetaMes = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("es-CL", { month: "long", year: "numeric" });
      tbodyMes.appendChild(el("tr", {}, [
        el("td", { "data-label": "Mes" }, [
          etiquetaMes,
          // Barra simple con CSS puro (sin librería de gráficos) para ver
          // el peso relativo de cada mes de un vistazo.
          el("div", { style: `height:4px;border-radius:2px;background:var(--blue);margin-top:4px;width:${Math.max(4, (monto / maxMes) * 100)}%;` }),
        ]),
        el("td", { class: "monto", "data-label": "Monto" }, fmtCLP(monto)),
      ]));
    });
    tablaMes.appendChild(tbodyMes);
    cont.appendChild(el("div", { class: "table-scroll" }, [tablaMes]));

    // Por categoría / cuenta contable / centro de costo hace falta el
    // detalle de ítems, que dashboardData no trae (solo cabeceras de
    // rendiciones) -- se pide una sola vez, ya filtrado por las
    // rendiciones del rango, y se reusa para los tres reportes en vez de
    // repetir la consulta.
    let items=[],error=null;
    try {
      const ids=rendicionesEnRango.map(r=>r.id);
      for(let i=0;i<ids.length;i+=100)items.push(...await consultarTodas(()=>db.from("rendicion_items").select("id,categoria, monto, empresa, tipo_item, estado, cuenta_contable, centro_costo",{count:"exact"}).in("rendicion_id",ids.slice(i,i+100)).eq("estado","Aprobado").order("id")));
    }catch(err){error=err;}
    if (error) {
      console.error("Error cargando ítems para reportes:", error);
    } else {
      const porCategoria = {};
      const porCuenta = {};
      const porCentroCosto = {};
      (items || []).forEach((it) => {
        // Ahora "Documento electrónico" también puede tener categoría
        // propia (ver buildConDocumentoFields) -- si la tiene, se agrupa
        // por esa; si no (ítems viejos, de antes de este cambio), cae al
        // rótulo genérico de siempre.
        const claveCategoria = it.categoria || (it.tipo_item === "SinDocumento" ? "Sin categoría" : "Documento electrónico (sin categoría)");
        porCategoria[claveCategoria] = (porCategoria[claveCategoria] || 0) + Number(it.monto || 0);
        if (it.cuenta_contable) {
          const nombre = nombreCuenta(it.cuenta_contable);
          const claveCuenta = `${it.cuenta_contable}${nombre ? " · " + nombre : ""}`;
          porCuenta[claveCuenta] = (porCuenta[claveCuenta] || 0) + Number(it.monto || 0);
        }
        const claveCC = it.centro_costo || "Sin centro de costo";
        porCentroCosto[claveCC] = (porCentroCosto[claveCC] || 0) + Number(it.monto || 0);
      });
      tabla("Por categoría", porCategoria);
      tabla("Por cuenta contable (código Kame)", porCuenta);
      tabla("Por centro de costo", porCentroCosto);

      // Arma el CSV para el botón "Descargar CSV" -- se calcula acá porque
      // recién en este punto están listos porCategoria/porCuenta/
      // porCentroCosto (dependen de la consulta a rendicion_items de más
      // arriba); csvContenido se declaró antes, así que el botón (ya
      // insertado en pantalla más arriba) simplemente lee esta variable al
      // momento del clic, sin importar en qué orden se calculó cada cosa.
      const seccionCSV = (titulo, datos) => {
        const filas = [[titulo], ["Nombre", "Monto"]];
        Object.entries(datos).sort((a, b) => b[1] - a[1]).forEach(([n, m]) => filas.push([n, Math.round(m)]));
        filas.push([]);
        return filas;
      };
      const todasLasFilas = [
        ["Reporte RindeWellness", `${desde || "inicio"} a ${hasta || "hoy"}`], [],
        ...seccionCSV("Por empresa", porEmpresa),
        ...seccionCSV("Por empleado", porEmpleado),
        ...seccionCSV("Reembolso vs. Fondo por Rendir", porTipoRendicion),
        ...seccionCSV("Por categoría", porCategoria),
        ...seccionCSV("Por cuenta contable", porCuenta),
        ...seccionCSV("Por centro de costo", porCentroCosto),
        ...seccionCSV("Tendencia mensual", porMes),
      ];
      csvContenido = todasLasFilas.map(fila => fila.map(c => campoCSVSeguro(c)).join(",")).join("\r\n");
    }

    // Métricas de aprobación: tiempo promedio y % de rechazo por
    // aprobador, sobre lo procesado (Aprobado + Rechazado) en el rango --
    // a diferencia del resto de los reportes de esta pantalla, este SÍ
    // necesita mirar también lo Rechazado, no solo lo Aprobado.
    const procesadasEnRango = dashboardData.aprobaciones.filter((r) =>
      (r.estado === "Aprobado" || r.estado === "Rechazado") && r.fecha_aprobacion && enRango(r, desdeMs, hastaMs)
    );
    if (procesadasEnRango.length) {
      const porAprobador = {};
      procesadasEnRango.forEach((r) => {
        const nombre = r.aprobador_nombre || "Sin asignar";
        if (!porAprobador[nombre]) porAprobador[nombre] = { total: 0, rechazadas: 0, sumaDias: 0 };
        const dias = (new Date(r.fecha_aprobacion).getTime() - new Date(r.created_at).getTime()) / (24 * 60 * 60 * 1000);
        porAprobador[nombre].total++;
        porAprobador[nombre].sumaDias += Math.max(0, dias);
        if (r.estado === "Rechazado") porAprobador[nombre].rechazadas++;
      });
      cont.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.95rem" }, "Métricas de aprobación"));
      const tablaAprob = el("table", { class: "items-table" });
      tablaAprob.appendChild(el("thead", {}, [el("tr", {}, ["Aprobador", "Procesadas", "Días promedio", "% rechazo"].map((c) => el("th", { class: c === "Aprobador" ? "" : "right" }, c)))]));
      const tbodyAprob = el("tbody");
      Object.entries(porAprobador).sort((a, b) => b[1].total - a[1].total).forEach(([nombre, d]) => {
        tbodyAprob.appendChild(el("tr", {}, [
          el("td", { "data-label": "Aprobador" }, nombre),
          el("td", { class: "right", "data-label": "Procesadas" }, String(d.total)),
          el("td", { class: "right", "data-label": "Días promedio" }, (d.sumaDias / d.total).toFixed(1)),
          el("td", { class: "right", "data-label": "% rechazo" }, `${Math.round((d.rechazadas / d.total) * 100)}%`),
        ]));
      });
      tablaAprob.appendChild(tbodyAprob);
      cont.appendChild(el("div", { class: "table-scroll" }, [tablaAprob]));
    }
  }

  // Saldo actual: incluye reservas pendientes, independiente del rango de fechas.
  const solicitudesAprobadas = dashboardData.solicitudesAprobacion.filter(s=>s.estado==="Aprobado"&&porPersonaEmpresa(s));
  if(solicitudesAprobadas.length){
    cont.appendChild(el("h2",{},"Saldo actual de fondos"));
    cont.appendChild(el("p",{class:"portal-muted"},"Saldo al día de hoy. Incluye lo aprobado y lo reservado en revisión; no depende del rango de fechas."));
    const table=el("table",{class:"items-table"}),cols=["Fondo / Empleado","Empresa","Otorgado","Consumo aprobado","En revisión","Saldo / Exceso"];
    table.appendChild(el("thead",{},[el("tr",{},cols.map(c=>el("th",{},c)))]));
    const body=el("tbody");
    for(const fund of solicitudesAprobadas){
      const filasFondo=dashboardData.consumoFondos.get(fund.id),consumption=filasFondo?resumirConsumoFondo(filasFondo,fund.monto_solicitado):null;
      const values=["S-"+(fund.folio??"—")+" · "+(fund.empleado_nombre||"—"),fund.empresa||"—",fmtCLP(fund.monto_solicitado),...(consumption?[fmtCLP(consumption.aprobado),fmtCLP(consumption.porRevisar),fmtCLP(Math.abs(consumption.saldo))+(consumption.saldo<0?" · Exceso":" · Disponible")]:["No disponible","No disponible","No disponible"])];
      body.appendChild(el("tr",{},values.map((value,i)=>el("td",{"data-label":cols[i],class:i>1?"monto":""},value))));
    }
    table.appendChild(body);cont.appendChild(el("div",{class:"table-scroll"},[table]));
  }

  // Posibles gastos recurrentes: mismo proveedor apareciendo en 3 o más
  // meses distintos entre los "Gasto directo" -- candidato a pasar a
  // gasto fijo de la empresa en vez de reembolso manual todos los meses.
  // Independiente del rango de fechas elegido arriba (mira TODO el
  // histórico aprobado), porque el patrón solo se ve mirando varios meses
  // a la vez -- por eso es una consulta aparte, no reusa "items" de arriba.
  const idsHistoricos = dashboardData.aprobaciones.filter(r=>r.estado==="Aprobado"&&porPersonaEmpresa(r)).map(r=>r.id);
  const { data: itemsHistoricos, error: errHistoricos } = idsHistoricos.length ? await db
    .from("rendicion_items")
    .select("nombre_proveedor, monto, rendiciones!inner(created_at, estado)")
    .eq("tipo_item", "SinDocumento")
    .eq("estado", "Aprobado")
    .eq("rendiciones.estado", "Aprobado")
    .not("nombre_proveedor", "is", null)
    .in("rendicion_id",idsHistoricos) : {data:[],error:null};
  if (errHistoricos) {
    console.error("Error buscando gastos recurrentes:", errHistoricos);
  } else if (itemsHistoricos && itemsHistoricos.length) {
    const porProveedor = {};
    itemsHistoricos.forEach((it) => {
      const clave = String(it.nombre_proveedor).trim().toLowerCase();
      if (!clave) return;
      if (!porProveedor[clave]) porProveedor[clave] = { nombre: it.nombre_proveedor, meses: new Set(), total: 0, cantidad: 0 };
      porProveedor[clave].meses.add(String(it.rendiciones.created_at).slice(0, 7));
      porProveedor[clave].total += Number(it.monto || 0);
      porProveedor[clave].cantidad++;
    });
    const recurrentes = Object.values(porProveedor)
      .filter((p) => p.meses.size >= 3)
      .sort((a, b) => b.meses.size - a.meses.size);
    if (recurrentes.length) {
      cont.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.95rem" }, "Posibles gastos recurrentes"));
      cont.appendChild(el("p", { style: "margin:0 0 8px;color:var(--ink-soft);font-size:0.82rem;" },
        "Mismo proveedor en 3 o más meses distintos -- podría convenir pasarlo a gasto fijo de la empresa en vez de reembolso manual cada vez."));
      const tablaRec = el("table", { class: "items-table" });
      tablaRec.appendChild(el("thead", {}, [el("tr", {}, ["Proveedor", "Meses distintos", "Promedio", "Total histórico"].map((c) => el("th", { class: c === "Proveedor" ? "" : "right" }, c)))]));
      const tbodyRec = el("tbody");
      recurrentes.forEach((p) => {
        tbodyRec.appendChild(el("tr", {}, [
          el("td", { "data-label": "Proveedor" }, p.nombre),
          el("td", { class: "right", "data-label": "Meses distintos" }, String(p.meses.size)),
          el("td", { class: "monto", "data-label": "Promedio" }, fmtCLP(p.total / p.cantidad)),
          el("td", { class: "monto", "data-label": "Total histórico" }, fmtCLP(p.total)),
        ]));
      });
      tablaRec.appendChild(tbodyRec);
      cont.appendChild(el("div", { class: "table-scroll" }, [tablaRec]));
    }
  }
  if(generation===generacionReportes)target.replaceChildren(cont);
  } catch(error) {
    if(generation===generacionReportes)target.replaceChildren(el("p",{class:"ocr-status show err"},"No se pudo completar el reporte. Cambia el filtro o vuelve a abrirlo para reintentar."));
    console.error("Error preparando reportes:",error);
  }
}

// ------------------------------------------------------------
// Administración de usuarios (solo admin)
// ------------------------------------------------------------
const ROLES = ["empleado", "aprobador", "admin"];

async function openAdminUsuarios(pushHistory = true) {
  if (pushHistory) pushView("view-admin"); else show("view-admin");
  const list = document.getElementById("list-usuarios");
  list.innerHTML = "<p style='color:var(--ink-soft)'>Cargando...</p>";

  const [{ data: usuarios, error }, { data: permisos, error: permError }, { data: plantillas, error: plantError }] = await Promise.all([
    db.from("profiles").select("*").order("nombre"),
    db.from("perfil_cuentas").select("*"),
    db.from("perfil_plantillas").select("*").order("nombre"),
  ]);
  if (error) { list.innerHTML = ""; toast("Error cargando usuarios: " + error.message); return; }
  if (permError) console.error("Error cargando cuentas permitidas:", permError);
  if (plantError) console.error("Error cargando plantillas de perfil:", plantError);

  const permisosPorUsuario = {};
  (permisos || []).forEach((p) => {
    if (!permisosPorUsuario[p.profile_id]) permisosPorUsuario[p.profile_id] = new Set();
    permisosPorUsuario[p.profile_id].add(p.cuenta_cod);
  });
  const listaPlantillas = plantillas || [];

  list.innerHTML = "";

  if (!usuarios || !usuarios.length) {
    list.appendChild(el("div", { class: "empty-state" }, "No hay usuarios registrados todavía."));
    return;
  }

  document.getElementById("btn-ir-plantillas").onclick = () => openAdminPlantillas();
  document.getElementById("btn-registrar-fondo").onclick = () => abrirFormularioFondoEntregado(list, usuarios);

  const btnRecordatorios = document.getElementById("btn-recordatorios");
  btnRecordatorios.onclick = async () => {
    btnRecordatorios.disabled = true;
    const textoOriginal = btnRecordatorios.textContent;
    btnRecordatorios.textContent = "Enviando...";
    const { data, error } = await db.functions.invoke("recordatorios-pendientes", {});
    if (error || !data?.ok) {
      const mensaje = error ? await mensajeErrorFuncion(error) : data?.error;
      toast("No se pudo enviar: " + (mensaje || "revisa los logs de la función en Supabase."));
    } else if (data.total_pendientes) {
      toast(`Recordatorio enviado a ${data.enviados} persona(s) sobre ${data.total_pendientes} pendiente(s).`);
    } else {
      toast(data.nota || "No había nada pendiente hace más de 3 días.");
    }
    btnRecordatorios.disabled = false;
    btnRecordatorios.textContent = textoOriginal;
  };

  const btnLimpiarStorage = document.getElementById("btn-limpiar-storage");
  btnLimpiarStorage.onclick = async () => {
    if (!confirm("¿Borrar comprobantes en Storage que ya no están referenciados por ningún ítem? Solo se borran archivos de más de 24 horas, esto no se puede deshacer.")) return;
    btnLimpiarStorage.disabled = true;
    const textoOriginal = btnLimpiarStorage.textContent;
    btnLimpiarStorage.textContent = "Limpiando...";
    const { data, error } = await db.functions.invoke("limpiar-storage-huerfano", {});
    if (error || !data?.ok) {
      const mensaje = error ? await mensajeErrorFuncion(error) : data?.error;
      toast("No se pudo limpiar: " + (mensaje || "revisa los logs de la función en Supabase."));
    } else {
      toast(data.borrados ? `Se borraron ${data.borrados} archivo(s) huérfano(s).` : (data.nota || "No había archivos huérfanos."));
    }
    btnLimpiarStorage.disabled = false;
    btnLimpiarStorage.textContent = textoOriginal;
  };

  // Salud del sistema: cuántos fallos de OCR/correo dejó registrados
  // system_events en los últimos 7 días -- sin esto, nadie tenía ningún
  // motivo para pensar en ir a mirar esa tabla directamente en Supabase.
  const desdeSalud = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  Promise.all([
    db.from("system_events").select("tipo, detalle").gte("created_at", desdeSalud).like("tipo", "%_fail"),
    db.from("system_events").select("metadata").eq("tipo", "ocr_resultado").gte("created_at", desdeSalud),
    db.from("system_events").select("metadata").eq("tipo", "ocr_reintento_run").neq("metadata->>procesados", "0").gte("created_at", desdeSalud),
  ])
    .then(([fallos, enVivo, delBot]) => {
      const eventos = fallos.error ? [] : (fallos.data || []);
      const lecturas = contarLecturasPorProveedor(enVivo.error ? [] : enVivo.data, delBot.error ? [] : delBot.data);
      const nombresProveedor = Object.keys(lecturas.total);
      if (!eventos.length && !nombresProveedor.length) return;
      const porTipo = {};
      eventos.forEach((e) => {
        const grupo = porTipo[e.tipo] || (porTipo[e.tipo] = { n: 0, causas: {} });
        grupo.n++;
        const causa = (e.detalle || "").trim();
        if (causa) grupo.causas[causa] = (grupo.causas[causa] || 0) + 1;
      });
      const lineas = Object.entries(porTipo).sort((a, b) => b[1].n - a[1].n).map(([tipo, { n, causas }]) => {
        const principal = Object.entries(causas).sort((a, b) => b[1] - a[1])[0];
        return `${tipo} (${n})` + (principal ? ` · causa más frecuente (${principal[1]}): ${principal[0].slice(0, 160)}` : "");
      });
      if (nombresProveedor.length) {
        const detalle = nombresProveedor.sort((a, b) => lecturas.total[b] - lecturas.total[a]).map((p) => `${p} ${lecturas.total[p]}`).join(" · ");
        lineas.push(`Lecturas con IA: ${detalle}` + (lecturas.delBot ? ` (${lecturas.delBot} las hizo el bot de reintentos)` : ""));
        // Costo medido con Claude Haiku 5.5 (~US$0,0013 por foto, 2026-11-11). Gemini y Groq son gratuitos.
        if (lecturas.total.claude) lineas.push(`Costo estimado de Claude en 7 días: ~US$${(lecturas.total.claude * 0.0013).toFixed(2)} (${lecturas.total.claude} lecturas). Si se pausa por falta de crédito, aparece arriba como ocr_claude_cuenta_fail.`);
      }
      list.insertBefore(
        el("div", { class: "card", style: "border:1px solid " + (eventos.length ? "var(--warn)" : "var(--border, #2c3a44)") + ";margin-bottom:16px;" }, [
          el("p", { style: "margin:0 0 4px;font-size:0.85rem;font-weight:600;" }, (eventos.length ? "⚠ " : "") + "Salud del sistema (últimos 7 días)"),
          ...lineas.map((linea) => el("p", { style: "margin:0;font-size:0.85rem;" }, linea)),
        ]),
        list.firstChild
      );
    });

  const filtroRol = document.getElementById("filtro-usuarios-rol");
  const filtroTexto = document.getElementById("filtro-usuarios-texto");
  filtroRol.value = "";
  filtroTexto.value = "";

  const tablaBox = el("div", { class: "table-scroll" });
  list.appendChild(tablaBox);

  function renderTabla() {
    const rol = filtroRol.value;
    const texto = filtroTexto.value.trim().toLowerCase();
    const filtrados = usuarios.filter((u) =>
      (!rol || u.rol === rol) &&
      (!texto || (u.nombre || "").toLowerCase().includes(texto) || (u.rut || "").toLowerCase().includes(texto))
    );

    tablaBox.innerHTML = "";
    if (!filtrados.length) {
      tablaBox.appendChild(el("div", { class: "empty-state" }, "Ningún usuario coincide con el filtro."));
      return;
    }

    const tabla = el("table", { class: "items-table" });
    tabla.appendChild(el("thead", {}, [
      el("tr", {}, ["Nombre", "RUT", "Rol", "Perfil", "Acciones"].map((c) => el("th", {}, c))),
    ]));
    const tbody = el("tbody");
    tabla.appendChild(tbody);

    filtrados.forEach((u) => {
      const select = el("select", { style: "width:auto", "aria-label":"Rol de "+(u.nombre||"usuario") }, ROLES.map((r) => el("option", { value: r }, r)));
      select.value = u.rol;
      select.addEventListener("change", async () => {
        const nuevoRol = select.value;
        if (nuevoRol === "admin" && !confirm(`¿Dar permisos de administrador a ${u.nombre}? Podrá ver y aprobar todo, y cambiar el rol de cualquier persona.`)) {
          select.value = u.rol;
          return;
        }
        const res = await updateChecked("profiles", u.id, { rol: nuevoRol });
        if (!res.ok) { toast(res.mensaje); select.value = u.rol; }
        else { toast(`${u.nombre} ahora es ${nuevoRol}.`); u.rol = nuevoRol; }
      });

      // "Sin plantilla" + una opción por plantilla existente. Las cuentas
      // permitidas de la persona son la plantilla (si elige una) MÁS sus
      // cuentas individuales -- una no reemplaza a la otra.
      const selectPlantilla = el("select", { style: "width:auto", "aria-label":"Plantilla de "+(u.nombre||"usuario") }, [
        el("option", { value: "" }, "Sin plantilla"),
        ...listaPlantillas.map((p) => el("option", { value: p.id }, p.nombre)),
      ]);
      selectPlantilla.value = u.plantilla_id || "";
      selectPlantilla.addEventListener("change", async () => {
        const nuevaPlantillaId = selectPlantilla.value || null;
        const res = await updateChecked("profiles", u.id, { plantilla_id: nuevaPlantillaId });
        if (!res.ok) { toast(res.mensaje); selectPlantilla.value = u.plantilla_id || ""; return; }
        u.plantilla_id = nuevaPlantillaId;
        toast(`Perfil de ${u.nombre} actualizado.`);
      });

      const filaExtra = el("tr", { class: "item-extra-row", style: "display:none;" });
      const extraCell = el("td", { colspan: "5" });
      filaExtra.appendChild(extraCell);

      const nombreCell = el("td", {}, u.nombre || "(sin nombre)");

      // Un solo panel expandible por fila, que se reutiliza para "Cuentas
      // permitidas" o "Editar perfil" según qué botón se apretó.
      const mostrarPanel = (tipo, render) => {
        const yaAbiertoConEsto = filaExtra.style.display !== "none" && extraCell.dataset.tipo === tipo;
        if (yaAbiertoConEsto) { filaExtra.style.display = "none"; return; }
        // "" (no "table-row" fijo): deja que el CSS decida -- en mobile
        // (@media max-width:700px) .items-table tr pasa a display:block para
        // apilarse como tarjeta, pero un estilo inline le gana a esa regla
        // (no tiene !important) y dejaba la fila trabada en table-row dentro
        // de un tbody ya puesto en block, rompiendo el ancho de esta celda.
        filaExtra.style.display = "";
        extraCell.dataset.tipo = tipo;
        render(extraCell);
      };

      const btnCuentas = el("button", { class: "btn btn-sm", type: "button" }, "Cuentas permitidas");
      btnCuentas.addEventListener("click", () => {
        mostrarPanel("cuentas", (cell) =>
          renderCuentasPanel(cell, u, permisosPorUsuario[u.id] || new Set(), usuarios, permisosPorUsuario, listaPlantillas)
        );
      });

      const btnEditar = el("button", { class: "btn btn-sm", type: "button" }, "Editar perfil");
      btnEditar.addEventListener("click", () => {
        mostrarPanel("perfil", (cell) => renderEditarPerfilPanel(cell, u, nombreCell));
      });

      // Ni elimina ni deja entrar de nuevo, pero mantiene intacto todo lo que
      // esa persona ya rindió o aprobó (ver comentario en la migración).
      const btnActivo = el("button", { class: "btn btn-sm", type: "button" }, u.activo === false ? "Reactivar" : "Desactivar");
      btnActivo.addEventListener("click", async () => {
        const nuevoActivo = u.activo === false;
        const mensaje = nuevoActivo
          ? `¿Reactivar a ${u.nombre}? Podrá volver a iniciar sesión.`
          : `¿Desactivar a ${u.nombre}? No podrá volver a iniciar sesión hasta que la reactives. Su historial de rendiciones no se toca.`;
        if (!confirm(mensaje)) return;
        const res = await updateChecked("profiles", u.id, { activo: nuevoActivo });
        if (!res.ok) { toast(res.mensaje); return; }
        u.activo = nuevoActivo;
        btnActivo.textContent = nuevoActivo ? "Desactivar" : "Reactivar";
        toast(`${u.nombre} ${nuevoActivo ? "reactivado" : "desactivado"}.`);
      });

      nombreCell.setAttribute("data-label", "Nombre");
      if (u.activo === false) nombreCell.appendChild(el("span", { class: "pill Rechazado", style: "margin-left:8px;font-size:0.7rem;" }, "Desactivado"));
      tbody.appendChild(el("tr", {}, [
        nombreCell,
        el("td", { "data-label": "RUT" }, u.rut || "-"),
        el("td", { "data-label": "Rol" }, select),
        el("td", { "data-label": "Perfil" }, selectPlantilla),
        el("td", { class: "acciones-cell", "data-label": "Acciones" }, [btnEditar, btnCuentas, btnActivo]),
      ]));
      tbody.appendChild(filaExtra);
    });

    tablaBox.appendChild(tabla);
  }

  filtroRol.onchange = renderTabla;
  filtroTexto.oninput = renderTabla;
  renderTabla();
}

function renderEditarPerfilPanel(cell, usuario, nombreCell) {
  cell.innerHTML = "";
  const nombreField = fieldInput("edit-perfil-nombre", "Nombre completo", "text");
  nombreField.querySelector("input").value = usuario.nombre || "";
  const rutField = fieldInput("edit-perfil-rut", "RUT", "text");
  const rutFieldInput = rutField.querySelector("input");
  rutFieldInput.value = usuario.rut || "";
  rutFieldInput.addEventListener("blur", () => { rutFieldInput.value = formatearRut(rutFieldInput.value); });
  const cargoField = fieldInput("edit-perfil-cargo", "Cargo", "text");
  cargoField.querySelector("input").value = usuario.cargo || "";
  const empresaField = fieldSelect("edit-perfil-empresa", "Empresa a la que pertenece", ["(Sin asignar)", ...EMPRESAS]);
  empresaField.querySelector("select").value = usuario.empresa_default || "(Sin asignar)";

  // Delegación temporal de aprobación: para cuando el único aprobador/admin
  // de turno está de vacaciones o con licencia. Mientras está activa y no
  // vencida, esta persona cuenta como aprobador para todo efecto (ver
  // is_admin_or_aprobador en migracion_mejoras_v2.sql), aunque su rol
  // normal siga siendo "empleado".
  const delegadoCheckbox = el("input", { type: "checkbox", id: "edit-perfil-delegado" });
  delegadoCheckbox.checked = !!usuario.delegado_activo;
  const delegadoHastaField = fieldInput("edit-perfil-delegado-hasta", "Delegado hasta (opcional, vacío = indefinido)", "date");
  delegadoHastaField.querySelector("input").value = usuario.delegado_hasta ? String(usuario.delegado_hasta).slice(0, 10) : "";
  const delegadoBox = el("div", { class: "field-row", style: "align-items:flex-end;" }, [
    el("div", { class: "field" }, [
      el("label", { for: "edit-perfil-delegado", class: "cuenta-check" }, [delegadoCheckbox, el("span", {}, "Delegado temporal (puede aprobar)")]),
    ]),
    delegadoHastaField,
  ]);

  const guardar = el("button", {
    class: "btn btn-primary btn-sm", type: "button",
    onclick: async () => {
      const nombre = nombreField.querySelector("input").value.trim();
      const rutInput = rutField.querySelector("input").value.trim();
      if (rutInput && !validarRut(rutInput)) { toast("Ese RUT no es válido."); return; }
      const rut = rutInput ? formatearRut(rutInput) : null;
      const cargo = cargoField.querySelector("input").value.trim() || null;
      const empresaElegida = empresaField.querySelector("select").value;
      const empresa_default = empresaElegida === "(Sin asignar)" ? null : empresaElegida;
      const delegado_activo = delegadoCheckbox.checked;
      const delegadoHastaValor = delegadoHastaField.querySelector("input").value;
      const delegado_hasta = delegado_activo && delegadoHastaValor ? new Date(delegadoHastaValor + "T23:59:59").toISOString() : null;
      const res = await updateChecked("profiles", usuario.id, { nombre, rut, cargo, empresa_default, delegado_activo, delegado_hasta });
      if (!res.ok) { toast(res.mensaje); return; }
      usuario.nombre = nombre;
      usuario.rut = rut;
      usuario.cargo = cargo;
      usuario.empresa_default = empresa_default;
      usuario.delegado_activo = delegado_activo;
      usuario.delegado_hasta = delegado_hasta;
      nombreCell.textContent = nombre || "(sin nombre)";
      cell.parentElement.previousElementSibling.children[1].textContent = rut || "-";
      cell.closest(".item-extra-row").style.display = "none";
      toast("Perfil actualizado.");
    },
  }, "Guardar");
  const cancelar = el("button", {
    class: "btn btn-ghost btn-sm", type: "button",
    onclick: () => { cell.closest(".item-extra-row").style.display = "none"; },
  }, "Cancelar");

  cell.appendChild(el("div", { class: "field-row" }, [nombreField, rutField]));
  cell.appendChild(el("div", { class: "field-row" }, [cargoField, empresaField]));
  cell.appendChild(delegadoBox);
  cell.appendChild(el("div", { style: "display:flex; gap:8px; margin-top:8px;" }, [guardar, cancelar]));
}

function renderCuentasPanel(panel, usuario, cuentasActuales, todosLosUsuarios = [], permisosPorUsuario = {}, listaPlantillas = []) {
  panel.innerHTML = "";
  const ficha = el("div", { class: "cuentas-ficha" });

  // Si tiene una plantilla asignada, esas cuentas se suman a las
  // individuales de abajo (no las reemplazan) -- se muestran aparte, de
  // solo lectura, porque se editan desde "Plantillas de perfil", no acá.
  const plantilla = listaPlantillas.find((p) => p.id === usuario.plantilla_id);
  const plantillaBox = el("div");
  ficha.appendChild(plantillaBox);
  if (plantilla) {
    plantillaBox.appendChild(el("p", { class: "ocr-status show" }, `Cargando cuentas de la plantilla "${plantilla.nombre}"...`));
    db.from("plantilla_cuentas").select("cuenta_cod, cuenta_nombre").eq("plantilla_id", plantilla.id).then(({ data, error }) => {
      plantillaBox.innerHTML = "";
      if (error) {
        plantillaBox.appendChild(el("p", { class: "ocr-status show err" }, "No se pudieron cargar las cuentas de la plantilla."));
        return;
      }
      if (!data || !data.length) {
        plantillaBox.appendChild(el("p", { style: "margin:0 0 10px;color:var(--ink-soft);font-size:0.85rem" },
          `La plantilla "${plantilla.nombre}" todavía no tiene cuentas asignadas.`));
        return;
      }
      plantillaBox.appendChild(el("div", { style: "margin-bottom:10px;" }, [
        el("p", { style: "margin:0 0 6px;font-size:0.85rem;color:var(--ink-soft);" },
          `Incluidas por la plantilla "${plantilla.nombre}" (se editan en "Plantillas de perfil", no acá):`),
        el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;" },
          data.map((c) => el("span", { class: "pill Pendiente", style: "font-size:0.72rem;" }, `${c.cuenta_cod} · ${c.cuenta_nombre || c.cuenta_cod}`))
        ),
      ]));
    });
  }

  const contador = el("span", { class: "cuentas-ficha-contador" }, `${cuentasActuales.size} seleccionadas`);
  const buscador = el("input", { type: "text", class: "cuentas-buscar", placeholder: "Buscar cuenta...", "aria-label":"Buscar cuenta contable" });
  ficha.appendChild(el("div", { class: "cuentas-ficha-header" }, [
    el("p", { class: "cuentas-panel-hint", style: "margin:0;" },
      plantilla
        ? "Cuentas individuales adicionales a las de su plantilla (arriba). Si ni la plantilla ni acá tienen nada marcado, puede usar todas."
        : "Cuentas de \"gasto directo\" que puede usar. Si no marcas ninguna, puede usar todas."),
    contador,
  ]));
  ficha.appendChild(el("div", { style: "margin-bottom:10px;" }, [buscador]));

  const otrosUsuarios = todosLosUsuarios.filter((u) => u.id !== usuario.id);
  if (otrosUsuarios.length) {
    const selectCopiar = el("select", { class: "cuentas-buscar", style: "width:auto;" }, [
      el("option", { value: "" }, "Copiar cuentas de..."),
      ...otrosUsuarios.map((u) => el("option", { value: u.id }, u.nombre || u.id)),
    ]);
    const btnCopiar = el("button", { class: "btn btn-sm", type: "button" }, "Copiar");
    btnCopiar.addEventListener("click", async () => {
      const origenId = selectCopiar.value;
      if (!origenId) { toast("Elige de quién copiar las cuentas."); return; }
      const cuentasOrigen = permisosPorUsuario[origenId] || new Set();
      const { error: delErr } = await db.from("perfil_cuentas").delete().eq("profile_id", usuario.id);
      if (delErr) { toast("No se pudo copiar: " + delErr.message); return; }
      if (cuentasOrigen.size) {
        const filas = [...cuentasOrigen].map((cod) => {
          const cat = CATEGORIAS_GASTO.find((c) => c.cuenta === cod);
          return { profile_id: usuario.id, cuenta_cod: cod, cuenta_nombre: cat ? cat.nombre : cod };
        });
        const { error: insErr } = await db.from("perfil_cuentas").insert(filas);
        if (insErr) { toast("No se pudo copiar: " + insErr.message); return; }
      }
      cuentasActuales.clear();
      cuentasOrigen.forEach((c) => cuentasActuales.add(c));
      permisosPorUsuario[usuario.id] = cuentasActuales;
      renderCuentasPanel(panel, usuario, cuentasActuales, todosLosUsuarios, permisosPorUsuario, listaPlantillas);
      toast("Cuentas copiadas.");
    });
    ficha.appendChild(el("div", { style: "display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;" }, [selectCopiar, btnCopiar]));
  }

  const grid = el("div", { class: "cuentas-grid" });
  const filas = [];
  CATEGORIAS_GASTO.filter((c) => c.cuenta).forEach((c) => {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.checked = cuentasActuales.has(c.cuenta);
    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) {
        const { error } = await db.from("perfil_cuentas")
          .insert({ profile_id: usuario.id, cuenta_cod: c.cuenta, cuenta_nombre: c.nombre });
        if (error) { toast("No se pudo asignar: " + error.message); checkbox.checked = false; return; }
        cuentasActuales.add(c.cuenta);
      } else {
        const { data: borrada, error } = await db.from("perfil_cuentas")
          .delete().eq("profile_id", usuario.id).eq("cuenta_cod", c.cuenta).select();
        if (error) { toast(mensajeErrorAmigable(error)); checkbox.checked = true; return; }
        if (!borrada || !borrada.length) { toast("No tienes permiso para quitar esta cuenta."); checkbox.checked = true; return; }
        cuentasActuales.delete(c.cuenta);
      }
      contador.textContent = `${cuentasActuales.size} seleccionadas`;
    });
    const label = el("label", { class: "cuenta-check" }, [checkbox, el("span", {}, `${c.cuenta} · ${c.nombre}`)]);
    filas.push({ label, texto: `${c.cuenta} ${c.nombre}`.toLowerCase() });
    grid.appendChild(label);
  });

  buscador.addEventListener("input", () => {
    const q = buscador.value.trim().toLowerCase();
    filas.forEach(({ label, texto }) => label.classList.toggle("oculto", !texto.includes(q)));
  });

  ficha.appendChild(grid);
  panel.appendChild(ficha);
}

// ------------------------------------------------------------
// Plantillas de perfil (solo admin) -- ver migracion_plantillas_perfil.sql.
// Un grupo de cuentas (ej. "Analista") que se le asigna a varias personas a
// la vez desde la columna "Perfil" en Usuarios, en vez de marcarles las
// cuentas una por una.
// ------------------------------------------------------------
// Cuántas lecturas con IA hizo cada proveedor (gemini, groq), sumando las de en
// vivo (ocr-recibo guarda "proveedor" en cada ocr_resultado) y las del bot de
// reintentos (cada ocr_reintento_run guarda "proveedores" con su conteo).
function contarLecturasPorProveedor(eventosEnVivo, eventosBot) {
  const total = {};
  let delBot = 0;
  const sumar = (proveedor, n) => { total[proveedor] = (total[proveedor] || 0) + n; };
  (eventosEnVivo || []).forEach((e) => { if (e.metadata?.proveedor) sumar(e.metadata.proveedor, 1); });
  (eventosBot || []).forEach((e) => {
    Object.entries(e.metadata?.proveedores || {}).forEach(([proveedor, n]) => {
      const cantidad = Number(n) || 0;
      if (cantidad > 0) { sumar(proveedor, cantidad); delBot += cantidad; }
    });
  });
  return { total, delBot };
}

// Registra un fondo por rendir que Finanzas ya entregó fuera de la app: queda
// Aprobado a nombre de quien lo registra y deja un evento de auditoría. La
// función de base de datos exige rol admin y no deja registrarse uno mismo.
function abrirFormularioFondoEntregado(contenedor, usuarios) {
  const previo = document.getElementById("form-fondo-entregado");
  if (previo) { previo.remove(); return; }

  const empleados = usuarios.filter((u) => u.activo !== false && u.id !== currentUser.id);
  const selEmpleado = el("select", { id: "ff-empleado" }, [
    el("option", { value: "" }, "Selecciona un empleado"),
    ...empleados.map((u) => el("option", { value: u.id }, u.nombre)),
  ]);
  const selEmpresa = el("select", { id: "ff-empresa" }, EMPRESAS.map((e) => el("option", { value: e }, e)));
  const selCC = el("select", { id: "ff-cc" });
  const llenarCentros = () => {
    selCC.innerHTML = "";
    (CENTROS_COSTO_POR_EMPRESA[selEmpresa.value] || ["Casa Matriz"]).forEach((o) => selCC.appendChild(el("option", { value: o }, o)));
  };
  selEmpresa.addEventListener("change", llenarCentros);
  llenarCentros();
  const inpMonto = el("input", { id: "ff-monto", type: "text", inputmode: "numeric", placeholder: "0" });
  inpMonto.addEventListener("input", () => formatearInputMoney(inpMonto));
  const inpMotivo = el("input", { id: "ff-motivo", type: "text", placeholder: "Ej. Fondo transferido desde Neo para insumos" });
  const btnRegistrar = el("button", { class: "btn btn-primary", type: "button" }, "Registrar fondo aprobado");
  const btnCancelar = el("button", { class: "btn btn-secondary", type: "button" }, "Cancelar");

  const tarjeta = el("div", { class: "card", id: "form-fondo-entregado", style: "margin-bottom:16px;" }, [
    el("h3", { style: "margin:0 0 4px;" }, "Registrar fondo ya entregado"),
    el("p", { style: "margin:0 0 12px;font-size:0.85rem;" }, "Queda aprobado de inmediato y el empleado lo verá disponible para rendir. Úsalo solo si el dinero ya fue transferido."),
    el("div", { class: "field" }, [el("label", { for: "ff-empleado" }, "Empleado"), selEmpleado]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field" }, [el("label", { for: "ff-empresa" }, "Empresa"), selEmpresa]),
      el("div", { class: "field" }, [el("label", { for: "ff-cc" }, "Centro de costo"), selCC]),
    ]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field" }, [el("label", { for: "ff-monto" }, "Monto transferido"), inpMonto]),
      el("div", { class: "field" }, [el("label", { for: "ff-motivo" }, "Motivo"), inpMotivo]),
    ]),
    el("div", { style: "display:flex;gap:10px;margin-top:12px;" }, [btnRegistrar, btnCancelar]),
  ]);
  btnCancelar.addEventListener("click", () => tarjeta.remove());

  btnRegistrar.addEventListener("click", async () => {
    const empleado = empleados.find((u) => u.id === selEmpleado.value);
    const monto = parseMoneyValue(inpMonto.value);
    const motivo = inpMotivo.value.trim();
    if (!empleado) { toast("Selecciona al empleado."); return; }
    if (!monto) { toast("Ingresa el monto transferido."); return; }
    if (!motivo) { toast("Indica el motivo del fondo."); return; }
    if (btnRegistrar.disabled) return;
    btnRegistrar.disabled = true;
    const abiertos = await avisoFondosAbiertos(empleado.id, empleado.nombre);
    if (!confirm((abiertos ? abiertos + "\n\n" : "") + `¿Registrar un fondo APROBADO de ${fmtCLP(monto)} para ${empleado.nombre} en ${selEmpresa.value} (${selCC.value})?`)) { btnRegistrar.disabled = false; return; }

    btnRegistrar.textContent = "Registrando...";
    const { data: folio, error } = await db.rpc("registrar_fondo_entregado", {
      p_empleado_id: empleado.id,
      p_empresa: selEmpresa.value,
      p_centro_costo: selCC.value,
      p_monto: monto,
      p_motivo: motivo,
    });
    if (error) {
      toast("No se pudo registrar el fondo: " + mensajeErrorAmigable(error));
      btnRegistrar.disabled = false;
      btnRegistrar.textContent = "Registrar fondo aprobado";
      return;
    }
    toast(`Fondo S-${folio} registrado para ${empleado.nombre}.`);
    tarjeta.remove();
  });

  contenedor.insertBefore(tarjeta, contenedor.firstChild);
}

async function openAdminPlantillas(pushHistory = true) {
  if (pushHistory) pushView("view-plantillas"); else show("view-plantillas");
  const list = document.getElementById("list-plantillas");
  list.innerHTML = "<p style='color:var(--ink-soft)'>Cargando...</p>";

  const [{ data: plantillas, error }, { data: cuentas, error: cuentasError }, { data: usuarios, error: usuariosError }] = await Promise.all([
    db.from("perfil_plantillas").select("*").order("nombre"),
    db.from("plantilla_cuentas").select("*"),
    db.from("profiles").select("id, plantilla_id"),
  ]);
  if (error) { list.innerHTML = ""; toast("Error cargando plantillas: " + error.message); return; }
  if (cuentasError) console.error("Error cargando cuentas de plantillas:", cuentasError);
  if (usuariosError) console.error("Error cargando usuarios:", usuariosError);

  const cuentasPorPlantilla = {};
  (cuentas || []).forEach((c) => {
    if (!cuentasPorPlantilla[c.plantilla_id]) cuentasPorPlantilla[c.plantilla_id] = new Set();
    cuentasPorPlantilla[c.plantilla_id].add(c.cuenta_cod);
  });
  const personasPorPlantilla = {};
  (usuarios || []).forEach((u) => {
    if (!u.plantilla_id) return;
    personasPorPlantilla[u.plantilla_id] = (personasPorPlantilla[u.plantilla_id] || 0) + 1;
  });

  list.innerHTML = "";

  // Panel para crear una plantilla nueva, oculto hasta que se aprieta el
  // botón "Nueva plantilla" del encabezado (ver index.html) -- mismo patrón
  // de formulario inline que el resto de la app, sin prompt() nativo.
  const nuevaBox = el("div", { class: "card", style: "display:none; margin-bottom:16px;" });
  const nombreNueva = fieldInput("nueva-plantilla-nombre", "Nombre de la plantilla", "text", "Analista, Comercial RFA...");
  nuevaBox.appendChild(nombreNueva);
  nuevaBox.appendChild(el("div", { style: "display:flex; gap:8px;" }, [
    el("button", {
      class: "btn btn-primary btn-sm", type: "button",
      onclick: async () => {
        const nombre = nombreNueva.querySelector("input").value.trim();
        if (!nombre) { toast("Ponle un nombre a la plantilla."); return; }
        const { error: insErr } = await db.from("perfil_plantillas").insert({ nombre });
        if (insErr) { toast("No se pudo crear: " + insErr.message); return; }
        toast("Plantilla creada.");
        openAdminPlantillas(false);
      },
    }, "Crear"),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { nuevaBox.style.display = "none"; } }, "Cancelar"),
  ]));
  list.appendChild(nuevaBox);

  document.getElementById("btn-nueva-plantilla").onclick = () => {
    nuevaBox.style.display = nuevaBox.style.display === "none" ? "block" : "none";
    if (nuevaBox.style.display === "block") nombreNueva.querySelector("input").focus();
  };

  if (!plantillas || !plantillas.length) {
    list.appendChild(el("div", { class: "empty-state" }, "No hay plantillas creadas todavía."));
    return;
  }

  const tabla = el("table", { class: "items-table" });
  tabla.appendChild(el("thead", {}, [
    el("tr", {}, ["Nombre", "Cuentas", "Personas", "Acciones"].map((c) => el("th", {}, c))),
  ]));
  const tbody = el("tbody");
  tabla.appendChild(tbody);

  plantillas.forEach((p) => {
    const cuentasSet = cuentasPorPlantilla[p.id] || new Set();
    const personas = personasPorPlantilla[p.id] || 0;

    const nombreCell = el("td", { "data-label": "Nombre" }, p.nombre);

    const filaExtra = el("tr", { class: "item-extra-row", style: "display:none;" });
    const extraCell = el("td", { colspan: "4" });
    filaExtra.appendChild(extraCell);

    // Un solo panel expandible por fila, reutilizado para "Cuentas de la
    // plantilla" o "Renombrar" según qué botón se apretó -- mismo patrón que
    // openAdminUsuarios.
    const mostrarPanel = (tipo, render) => {
      const yaAbiertoConEsto = filaExtra.style.display !== "none" && extraCell.dataset.tipo === tipo;
      if (yaAbiertoConEsto) { filaExtra.style.display = "none"; return; }
      filaExtra.style.display = ""; // deja que el CSS decida (ver comentario en openAdminUsuarios)
      extraCell.dataset.tipo = tipo;
      render(extraCell);
    };

    const cuentasCountCell = el("td", { "data-label": "Cuentas" }, String(cuentasSet.size));

    const btnCuentas = el("button", { class: "btn btn-sm", type: "button" }, "Cuentas de la plantilla");
    btnCuentas.addEventListener("click", () => {
      mostrarPanel("cuentas", (cell) => renderPlantillaCuentasPanel(cell, p, cuentasSet, cuentasCountCell));
    });

    const btnRenombrar = el("button", { class: "btn btn-sm", type: "button" }, "Renombrar");
    btnRenombrar.addEventListener("click", () => {
      mostrarPanel("renombrar", (cell) => {
        cell.innerHTML = "";
        const campo = fieldInput("renombrar-plantilla", "Nombre", "text");
        campo.querySelector("input").value = p.nombre;
        cell.appendChild(campo);
        cell.appendChild(el("div", { style: "display:flex; gap:8px;" }, [
          el("button", {
            class: "btn btn-primary btn-sm", type: "button",
            onclick: async () => {
              const nuevoNombre = campo.querySelector("input").value.trim();
              if (!nuevoNombre) { toast("El nombre no puede quedar vacío."); return; }
              const res = await updateChecked("perfil_plantillas", p.id, { nombre: nuevoNombre });
              if (!res.ok) { toast(res.mensaje); return; }
              p.nombre = nuevoNombre;
              nombreCell.textContent = nuevoNombre;
              filaExtra.style.display = "none";
              toast("Plantilla renombrada.");
            },
          }, "Guardar"),
          el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { filaExtra.style.display = "none"; } }, "Cancelar"),
        ]));
      });
    });

    const btnEliminar = el("button", { class: "btn btn-sm btn-danger", type: "button" }, "Eliminar");
    btnEliminar.addEventListener("click", async () => {
      const aviso = personas > 0
        ? `¿Eliminar "${p.nombre}"? ${personas} persona(s) la tienen asignada y perderían esas cuentas (conservan sus cuentas individuales, si tienen). No se puede deshacer.`
        : `¿Eliminar "${p.nombre}"? No se puede deshacer.`;
      if (!confirm(aviso)) return;
      const { data: borrada, error: delErr } = await db.from("perfil_plantillas").delete().eq("id", p.id).select();
      if (delErr) { toast(mensajeErrorAmigable(delErr)); return; }
      if (!borrada || !borrada.length) { toast("No tienes permiso para eliminar esta plantilla, o ya no existe."); return; }
      toast("Plantilla eliminada.");
      openAdminPlantillas(false);
    });

    tbody.appendChild(el("tr", {}, [
      nombreCell,
      cuentasCountCell,
      el("td", { "data-label": "Personas" }, String(personas)),
      el("td", { class: "acciones-cell", "data-label": "Acciones" }, [btnCuentas, btnRenombrar, btnEliminar]),
    ]));
    tbody.appendChild(filaExtra);
  });

  list.appendChild(el("div", { class: "table-scroll" }, [tabla]));
}

function renderPlantillaCuentasPanel(panel, plantilla, cuentasActuales, cuentasCountCell = null) {
  panel.innerHTML = "";
  const ficha = el("div", { class: "cuentas-ficha" });

  const contador = el("span", { class: "cuentas-ficha-contador" }, `${cuentasActuales.size} seleccionadas`);
  const buscador = el("input", { type: "text", class: "cuentas-buscar", placeholder: "Buscar cuenta..." });
  ficha.appendChild(el("div", { class: "cuentas-ficha-header" }, [
    el("p", { class: "cuentas-panel-hint", style: "margin:0;" },
      `Cuentas que otorga la plantilla "${plantilla.nombre}" a quien la tenga asignada (además de sus cuentas individuales, si tiene).`),
    contador,
  ]));
  ficha.appendChild(el("div", { style: "margin-bottom:10px;" }, [buscador]));

  const grid = el("div", { class: "cuentas-grid" });
  const filas = [];
  CATEGORIAS_GASTO.filter((c) => c.cuenta).forEach((c) => {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.checked = cuentasActuales.has(c.cuenta);
    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) {
        const { error } = await db.from("plantilla_cuentas")
          .insert({ plantilla_id: plantilla.id, cuenta_cod: c.cuenta, cuenta_nombre: c.nombre });
        if (error) { toast("No se pudo asignar: " + error.message); checkbox.checked = false; return; }
        cuentasActuales.add(c.cuenta);
      } else {
        const { data: borrada, error } = await db.from("plantilla_cuentas")
          .delete().eq("plantilla_id", plantilla.id).eq("cuenta_cod", c.cuenta).select();
        if (error) { toast(mensajeErrorAmigable(error)); checkbox.checked = true; return; }
        if (!borrada || !borrada.length) { toast("No tienes permiso para quitar esta cuenta."); checkbox.checked = true; return; }
        cuentasActuales.delete(c.cuenta);
      }
      contador.textContent = `${cuentasActuales.size} seleccionadas`;
      // La celda "Cuentas" de la fila en la tabla de arriba es texto
      // estático pintado una sola vez -- sin esto quedaba mostrando el
      // conteo viejo hasta recargar toda la pantalla de Plantillas.
      if (cuentasCountCell) cuentasCountCell.textContent = String(cuentasActuales.size);
    });
    const label = el("label", { class: "cuenta-check" }, [checkbox, el("span", {}, `${c.cuenta} · ${c.nombre}`)]);
    filas.push({ label, texto: `${c.cuenta} ${c.nombre}`.toLowerCase() });
    grid.appendChild(label);
  });

  buscador.addEventListener("input", () => {
    const q = buscador.value.trim().toLowerCase();
    filas.forEach(({ label, texto }) => label.classList.toggle("oculto", !texto.includes(q)));
  });

  ficha.appendChild(grid);
  panel.appendChild(ficha);
}

// ------------------------------------------------------------
// Nueva rendición
// ------------------------------------------------------------
function wireNuevaRendicion() {
  document.getElementById("btn-add-item").addEventListener("click", () => addItemRow());
  document.getElementById("btn-guardar-rendicion").addEventListener("click", submitRendicion);
  const empresaSelect = document.getElementById("nr-empresa");
  EMPRESAS.forEach((emp) => empresaSelect.appendChild(el("option", { value: emp }, emp)));
  empresaSelect.addEventListener("change", () => {
    actualizarCentroCostoRendicion();
    if (document.getElementById("nr-tipo").value === "FondoPorRendir") cargarSolicitudesDisponibles();
  });
  document.getElementById("nr-tipo").addEventListener("change", () => {
    const esFondo = document.getElementById("nr-tipo").value === "FondoPorRendir";
    document.getElementById("nr-fondo-wrap").style.display = esFondo ? "block" : "none";
    if (esFondo) cargarSolicitudesDisponibles();
  });
  document.getElementById("btn-add-fondo").addEventListener("click", () => agregarFilaFondo().querySelector("select").focus());
  document.getElementById("nr-fondo").addEventListener("change", actualizarFondosFormulario);
  const montoPrimerFondo = document.getElementById("nr-fondo-monto");
  montoPrimerFondo.addEventListener("input", () => { formatearInputMoney(montoPrimerFondo); actualizarFondosFormulario(); });

  // Borrador automático (ver "Borrador de la rendición en curso"): se guarda
  // medio segundo después del último cambio, y al instante si la página se
  // oculta o se cierra (en el celular beforeunload no siempre se dispara).
  const vistaNueva = document.getElementById("view-nueva");
  vistaNueva.addEventListener("input", programarGuardadoBorrador);
  vistaNueva.addEventListener("change", programarGuardadoBorrador);
  new MutationObserver(programarGuardadoBorrador).observe(document.getElementById("items-container"), { childList: true });
  window.addEventListener("pagehide", guardarBorradorRendicion);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") guardarBorradorRendicion(); });
  // Lo escrito se recupera, pero un archivo adjunto no: solo en ese caso el
  // navegador pregunta antes de dejar salir.
  window.addEventListener("beforeunload", (event) => {
    guardarBorradorRendicion();
    if (!enviandoRendicion && vistaNueva.classList.contains("active") && formularioTieneArchivos()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

// Llena el desplegable "Fondo asociado" de Nueva rendición con las
// solicitudes de fondos de ESTE empleado, ya Aprobadas, para la Empresa
// elegida en el encabezado (un fondo entregado para una empresa no debe
// rendirse contra otra). Muestra el saldo disponible de cada una -- ya
// reservado por gastos aprobados y pendientes contra ese mismo fondo --
// aunque esté en $0 (la persona puede seguir rindiendo de más; el
// excedente se contabiliza aparte, ver calcularSplitFondo).
let cargaSolicitudesDisponibles = 0;
async function cargarSolicitudesDisponibles() {
  const generation=++cargaSolicitudesDisponibles,usuarioId=currentUser?.id;
  const sel=document.getElementById("nr-fondo"),empresa=document.getElementById("nr-empresa").value;
  const vigente=()=>generation===cargaSolicitudesDisponibles&&currentUser?.id===usuarioId&&document.getElementById("nr-empresa").value===empresa;
  sel.disabled=true;sel.replaceChildren(el("option",{value:""},"Comprobando fondos y saldos…"));
  try{
    const solicitudes=await consultarTodas(()=>db.from("solicitudes_fondos").select("*",{count:"exact"}).eq("empleado_id",usuarioId).eq("estado","Aprobado").eq("empresa",empresa).order("created_at",{ascending:false}).order("id"));
    if(!vigente())return;
    if(!solicitudes.length){
      const otras=await consultarTodas(()=>db.from("solicitudes_fondos").select("id, empresa",{count:"exact"}).eq("empleado_id",usuarioId).eq("estado","Aprobado").order("id"));
      if(!vigente())return;
      const empresas=[...new Set(otras.map(s=>s.empresa).filter(e=>e&&e!==empresa))];
      sel.replaceChildren(el("option",{value:""},empresas.length?"Sin fondos en esta empresa. Cambia Empresa a: "+empresas.join(", "):"No tienes fondos aprobados"));return;
    }
    const rendidas=await consultarTodas(()=>db.from("rendiciones_por_fondo").select("id, solicitud_fondo_id, monto_total, monto_aprobado, estado",{count:"exact"}).in("solicitud_fondo_id",solicitudes.map(s=>s.id)).order("created_at").order("id").order("solicitud_fondo_id"));
    if(!vigente())return;
    sel.replaceChildren(...solicitudes.map(fund=>{
      const consumption=resumirConsumoFondo(rendidas.filter(r=>r.solicitud_fondo_id===fund.id),fund.monto_solicitado);
      const balance=consumption.saldo<0?"Exceso "+fmtCLP(Math.abs(consumption.saldo)):"Disponible "+fmtCLP(consumption.saldo);
      return el("option",{value:fund.id},"S-"+fund.folio+" · Otorgado "+fmtCLP(fund.monto_solicitado)+" · "+balance+" · En revisión "+fmtCLP(consumption.porRevisar));
    }));
  }catch(error){
    if(vigente())sel.replaceChildren(el("option",{value:""},"No se pudo comprobar el saldo. Cambia el tipo de rendición para reintentar."));
    console.error("Error comprobando fondos disponibles:",error);
  }finally{if(vigente()){sel.disabled=false;refrescarFilasFondo();}}
}

// ------------------------------------------------------------
// Multifondo: una rendición puede rendirse contra varios fondos.
// ------------------------------------------------------------
// La primera fila es el desplegable de siempre (#nr-fondo); "+ Rendir también
// contra otro fondo" agrega filas. Cada fondo menos el último lleva cuánto se
// rinde de él, y el último recibe el resto del total (ver repartirEntreFondos,
// que calcula igual que la base). Con un solo fondo no se pide monto.
function opcionesFondoActuales() {
  return [...document.getElementById("nr-fondo").options].filter((o) => o.value).map((o) => ({ value: o.value, text: o.textContent }));
}

function llenarSelectFondo(sel, valor) {
  const opciones = opcionesFondoActuales();
  sel.replaceChildren(el("option", { value: "" }, "Elige otro fondo"), ...opciones.map((o) => el("option", { value: o.value }, o.text)));
  sel.value = opciones.some((o) => o.value === valor) ? valor : "";
}

function agregarFilaFondo(valor = "", monto = "") {
  const sel = el("select", { class: "nr-fondo-extra", "aria-label": "Otro fondo" });
  llenarSelectFondo(sel, valor);
  const inp = el("input", { class: "nr-fondo-monto", type: "text", inputmode: "numeric", placeholder: "Monto de este fondo", "aria-label": "Monto rendido contra este fondo" });
  inp.value = monto;
  const quitar = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "Quitar este fondo" }, "Quitar");
  const fila = el("div", { class: "nr-fondo-fila" }, [sel, inp, quitar]);
  inp.addEventListener("input", () => { formatearInputMoney(inp); actualizarFondosFormulario(); });
  sel.addEventListener("change", actualizarFondosFormulario);
  quitar.addEventListener("click", () => { fila.remove(); actualizarFondosFormulario(); programarGuardadoBorrador(); });
  document.getElementById("nr-fondos-extra").appendChild(fila);
  actualizarFondosFormulario();
  return fila;
}

function filasFondoFormulario() {
  return [
    { sel: document.getElementById("nr-fondo"), inp: document.getElementById("nr-fondo-monto") },
    ...[...document.querySelectorAll("#nr-fondos-extra .nr-fondo-fila")].map((f) => ({ sel: f.querySelector("select"), inp: f.querySelector("input") })),
  ];
}

function leerFondosFormulario() {
  return filasFondoFormulario().map(({ sel, inp }, i, filas) => ({ id: sel.value, monto: i < filas.length - 1 ? parseMoneyValue(inp.value) : null }));
}

function totalFormulario() {
  return parseMoneyValue(document.getElementById("nr-total")?.textContent || "");
}

function etiquetaFondo(id) {
  const opcion = opcionesFondoActuales().find((o) => o.value === id);
  return opcion ? opcion.text.split(" · ")[0] : "Fondo sin elegir";
}

// Muestra u oculta los montos (el último fondo no lleva: recibe el resto) y el
// reparto resultante, o el error que impediría enviar.
function actualizarFondosFormulario() {
  const filas = filasFondoFormulario(), varios = filas.length > 1;
  filas.forEach(({ inp }, i) => { inp.hidden = !varios || i === filas.length - 1; });
  const resumen = document.getElementById("nr-fondos-resumen");
  if (varios) {
    const fondos = leerFondosFormulario(), total = totalFormulario();
    const error = window.RindeCore.validarFondosRendicion(fondos, total);
    resumen.hidden = false;
    resumen.classList.toggle("error", Boolean(error));
    resumen.textContent = error || "Reparto del total " + fmtCLP(total) + ": " +
      window.RindeCore.repartirEntreFondos(total, fondos).map((f) => etiquetaFondo(f.id) + " " + fmtCLP(f.parte)).join(" · ") + ". El último fondo recibe el resto.";
  } else {
    resumen.hidden = true;
  }
  document.getElementById("btn-add-fondo").hidden = filas.length >= opcionesFondoActuales().length;
  window.RindeUI?.updateFormSummary();
}

// Tras recargar los fondos (otra empresa, otro tipo), las filas extra se
// rellenan con las opciones nuevas; si su fondo ya no está, quedan sin elegir.
function refrescarFilasFondo() {
  document.querySelectorAll("#nr-fondos-extra select").forEach((sel) => llenarSelectFondo(sel, sel.value));
  actualizarFondosFormulario();
}

function limpiarFilasFondo() {
  document.getElementById("nr-fondos-extra").replaceChildren();
  document.getElementById("nr-fondo-monto").value = "";
  actualizarFondosFormulario();
}

// El Centro de Costo se elige UNA vez a nivel de encabezado (igual que la
// Empresa) y se aplica a todos los ítems de la rendición, sean "Documento
// electrónico" o "Boleta" -- toda factura/boleta necesita saber dónde se
// contabiliza, no solo las boletas de gasto directo. Si la persona cambia
// la Empresa, hay que refrescar las opciones (cada empresa tiene sus
// propios Centros de Costo).
function actualizarCentroCostoRendicion() {
  const empresa = document.getElementById("nr-empresa").value;
  const opciones = CENTROS_COSTO_POR_EMPRESA[empresa] || ["Casa Matriz"];
  const sel = document.getElementById("nr-cc");
  const valorActual = sel.value;
  sel.innerHTML = "";
  opciones.forEach((o) => sel.appendChild(el("option", { value: o }, o)));
  sel.value = opciones.includes(valorActual) ? valorActual : opciones[0];

  // Los ítems "Boleta" y "Documento electrónico" ya cargados también se
  // refrescan: si su Centro de Costo actual sigue siendo válido para la
  // nueva empresa se mantiene, si no, se cae al del encabezado (que la
  // persona igual puede volver a cambiar por ítem).
  document.querySelectorAll('.sin-documento select[id$="-cc"], .con-documento select[id$="-cccon"]').forEach((itemSel) => {
    const valorItem = itemSel.value;
    itemSel.innerHTML = "";
    opciones.forEach((o) => itemSel.appendChild(el("option", { value: o }, o)));
    itemSel.value = opciones.includes(valorItem) ? valorItem : sel.value;
  });
}

// ------------------------------------------------------------
// Borradores de rendición
// ------------------------------------------------------------
// Lo que se escribe en "Nueva rendición" se guarda solo, en este navegador y
// separado por usuario, como un borrador: recargar, cerrar la pestaña o un
// corte de conexión no lo pierden, y todos quedan listados en "Borradores".
// Cada uno caduca una semana después de su última edición (ver borradores.js).
// Los archivos adjuntos NO se guardan: un <input type=file> no se puede
// rellenar por código, así que al retomar un borrador hay que volver a
// adjuntarlos (el aviso lo dice).
let restaurandoBorrador = false;
let temporizadorBorrador = null;
let borradorActualId = null;

function almacenBorradores() {
  try { return window.RindeBorradores.crearAlmacen({ storage: window.localStorage }); } catch { return null; }
}

function actualizarContadorBorradores() {
  const almacen = almacenBorradores();
  window.RindeUI?.setBadge("borradores", almacen && currentUser?.id ? almacen.contar(currentUser.id) : 0);
}

// Devuelve null si el formulario está en blanco: los desplegables siempre
// traen un valor por defecto, así que solo cuentan los campos de texto.
function capturarBorradorRendicion() {
  const valor = (id) => document.getElementById(id)?.value ?? "";
  const comentario = valor("nr-comentario");
  let conContenido = !!comentario.trim();
  const items = [...document.querySelectorAll("#items-container .item-card")].map((card) => {
    const campos = {};
    card.querySelectorAll("input, select, textarea").forEach((campo) => {
      if (!campo.id || !campo.id.startsWith(card.id + "-")) return;
      if (campo.type === "file" || campo.type === "hidden" || campo.dataset.paginaPendiente) return;
      campos[campo.id.slice(card.id.length + 1)] = campo.value;
      if (campo.tagName !== "SELECT" && campo.value.trim()) conContenido = true;
    });
    return { tipo: card.querySelector(".toggle-group .active")?.dataset.tipo || "ConDocumento", campos };
  });
  if (!conContenido) return null;
  return {
    fecha: valor("nr-fecha"), tipo: valor("nr-tipo"), fondo: valor("nr-fondo"),
    fondoMonto: valor("nr-fondo-monto"),
    fondosExtra: [...document.querySelectorAll("#nr-fondos-extra .nr-fondo-fila")].map((f) => ({ id: f.querySelector("select").value, monto: f.querySelector("input").value })),
    empresa: valor("nr-empresa"), cc: valor("nr-cc"), comentario, items,
  };
}

// Deja el id del borrador en la URL (#nueva/<id>), para que recargar vuelva a
// este mismo borrador y no a un formulario en blanco.
function fijarBorradorEnUrl() {
  const hash = "#nueva/" + borradorActualId;
  if (location.hash === hash) return;
  history.replaceState({ viewId: "view-nueva", params: { borradorId: borradorActualId }, portalDepth: history.state?.portalDepth || 0 }, "", hash);
}

function guardarBorradorRendicion() {
  clearTimeout(temporizadorBorrador);
  temporizadorBorrador = null;
  const usuarioId = currentUser?.id;
  if (!usuarioId || !borradorActualId || restaurandoBorrador || enviandoRendicion) return;
  if (!document.getElementById("view-nueva")?.classList.contains("active")) return;
  const almacen = almacenBorradores();
  if (!almacen) return;
  const datos = capturarBorradorRendicion();
  if (datos) {
    // Solo una edición de verdad renueva la semana de vigencia: abrir un borrador, o
    // un evento sin cambios (foco, restauración), no debe alargarle la vida.
    const previa = almacen.obtener(usuarioId, borradorActualId);
    if ((previa && JSON.stringify(previa.datos) === JSON.stringify(datos)) || almacen.guardar(usuarioId, borradorActualId, datos)) fijarBorradorEnUrl();
  }
  else almacen.eliminar(usuarioId, borradorActualId);
  actualizarContadorBorradores();
}

function programarGuardadoBorrador() {
  clearTimeout(temporizadorBorrador);
  temporizadorBorrador = setTimeout(guardarBorradorRendicion, 500);
}

// Devuelve la entrada completa (con sus fechas) o null si no existe o caducó.
function leerBorradorRendicion(id) {
  const almacen = almacenBorradores();
  return almacen && currentUser?.id && id ? almacen.obtener(currentUser.id, id) : null;
}

function borrarBorradorRendicion() {
  clearTimeout(temporizadorBorrador);
  temporizadorBorrador = null;
  const almacen = almacenBorradores();
  if (almacen && currentUser?.id && borradorActualId) almacen.eliminar(currentUser.id, borradorActualId);
  // El formulario sigue lleno hasta que se abra otro: sin esto, el guardado al salir de la
  // pantalla (ver show) volvería a crear el borrador que se acaba de enviar o descartar.
  borradorActualId = null;
  actualizarContadorBorradores();
}

function formularioTieneArchivos() {
  return [...document.querySelectorAll('#items-container input[type="file"]')].some((i) => i.files && i.files.length);
}

async function restaurarBorradorRendicion(entrada) {
  const borrador = entrada.datos;
  restaurandoBorrador = true;
  try {
    const poner = (id, valor) => { const campo = document.getElementById(id); if (campo && valor != null && valor !== "") campo.value = valor; };
    poner("nr-fecha", borrador.fecha);
    if (EMPRESAS.includes(borrador.empresa)) poner("nr-empresa", borrador.empresa);
    actualizarCentroCostoRendicion();
    poner("nr-cc", borrador.cc);
    const esFondo = borrador.tipo === "FondoPorRendir";
    poner("nr-tipo", esFondo ? "FondoPorRendir" : "Reembolso");
    document.getElementById("nr-fondo-wrap").style.display = esFondo ? "block" : "none";
    poner("nr-comentario", borrador.comentario);

    document.getElementById("items-container").innerHTML = "";
    itemSeq = 0;
    (borrador.items.length ? borrador.items : [{ tipo: "ConDocumento", campos: {} }]).forEach((guardado) => {
      addItemRow();
      const card = document.getElementById("item-" + itemSeq);
      if (guardado.tipo === "SinDocumento") card.querySelector('[data-tipo="SinDocumento"]').click();
      const entradas = Object.entries(guardado.campos || {});
      // Primero los desplegables: elegir una categoría puede mostrar otros campos.
      for (const sonDesplegables of [true, false]) {
        entradas.forEach(([sufijo, valor]) => {
          const campo = document.getElementById(`${card.id}-${sufijo}`);
          if (!campo || (campo.tagName === "SELECT") !== sonDesplegables) return;
          if (sonDesplegables && ![...campo.options].some((o) => o.value === valor)) return;
          campo.value = valor;
          if (sonDesplegables) campo.dispatchEvent(new Event("change"));
        });
      }
    });
    recalcTotal();
    actualizarAlertasDuplicados();
    mostrarAvisoBorrador(entrada);
    if (esFondo) {
      await cargarSolicitudesDisponibles();
      const selFondo = document.getElementById("nr-fondo");
      if (borrador.fondo && [...selFondo.options].some((o) => o.value === borrador.fondo)) selFondo.value = borrador.fondo;
      document.getElementById("nr-fondo-monto").value = borrador.fondoMonto || "";
      (borrador.fondosExtra || []).forEach((f) => agregarFilaFondo(f.id, f.monto));
      actualizarFondosFormulario();
    }
    window.RindeUI?.updateFormSummary();
  } finally {
    restaurandoBorrador = false;
    programarGuardadoBorrador();
  }
}

function quitarAvisoBorrador() {
  document.getElementById("nr-aviso-borrador")?.remove();
}

function mostrarAvisoBorrador(entrada) {
  quitarAvisoBorrador();
  const cuando = new Date(entrada.actualizado).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
  const descartar = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "Descartar este borrador");
  descartar.addEventListener("click", () => {
    if (!confirm("¿Descartar este borrador y empezar una rendición en blanco?")) return;
    borrarBorradorRendicion();
    openNuevaRendicion(false);
  });
  const aviso = el("div", { class: "card", id: "nr-aviso-borrador", style: "margin-bottom:18px;border:1px solid var(--warn);" }, [
    el("p", { style: "margin:0 0 8px;font-size:0.9rem;" }, `Retomaste un borrador (última edición: ${cuando}). Los comprobantes no se guardan: vuelve a adjuntar el de cada ítem antes de enviar.`),
    descartar,
  ]);
  document.querySelector("#view-nueva .hero-row")?.after(aviso);
}

// Lista de borradores guardados: retomar uno o eliminarlo.
function openBorradores(pushHistory = true) {
  guardarBorradorRendicion();
  renderListaBorradores();
  if (pushHistory) pushView("view-borradores"); else show("view-borradores");
}

function renderListaBorradores() {
  const caja = document.getElementById("borradores-lista");
  const almacen = almacenBorradores();
  const entradas = almacen && currentUser?.id ? almacen.listar(currentUser.id) : [];
  caja.replaceChildren();
  actualizarContadorBorradores();
  if (!entradas.length) {
    caja.append(el("div", { class: "empty-state" }, "No tienes borradores. Lo que empieces a escribir en una nueva rendición se guarda aquí solo."));
    return;
  }
  for (const entrada of entradas) {
    const d = window.RindeBorradores.describir(entrada);
    const caduca = d.diasRestantes <= 1 ? "Caduca en menos de 24 horas" : `Caduca en ${d.diasRestantes} días`;
    const cuando = new Date(d.actualizado).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
    const continuar = el("button", { class: "btn btn-primary btn-sm", type: "button" }, "Continuar");
    continuar.addEventListener("click", () => openNuevaRendicion(true, { borradorId: d.id }));
    const eliminar = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "Eliminar");
    eliminar.addEventListener("click", () => {
      if (!confirm(`¿Eliminar el borrador "${d.titulo}"? No se puede deshacer.`)) return;
      almacen.eliminar(currentUser.id, d.id);
      if (d.id === borradorActualId) borradorActualId = null;
      renderListaBorradores();
      toast("Borrador eliminado.");
    });
    caja.append(el("div", { class: "card borrador-card" }, [
      el("div", { class: "borrador-info" }, [
        el("strong", {}, d.titulo),
        el("span", { class: "borrador-meta" }, `${d.empresa} · ${d.gastos} ${d.gastos === 1 ? "gasto" : "gastos"} · ${fmtCLP(d.total)}`),
        el("small", { class: "borrador-meta" }, `Última edición: ${cuando}`),
      ]),
      el("span", { class: "borrador-caduca" + (d.porVencer ? " por-vencer" : "") }, caduca),
      el("div", { class: "borrador-acciones" }, [continuar, eliminar]),
    ]));
  }
}

function openNuevaRendicion(pushHistory = true, opciones = {}) {
  if(enviandoRendicion){toast("Espera a que termine el envío actual.");return;}
  guardarBorradorRendicion(); // si había un formulario abierto, queda guardado antes de reemplazarlo
  quitarAvisoBorrador();
  // Con "borradorId" (desde la lista o al recargar) se retoma ese borrador; sin él,
  // es una rendición nueva con su propio borrador, que solo se guarda si se escribe algo.
  const entrada = opciones.borradorId ? leerBorradorRendicion(opciones.borradorId) : null;
  if (opciones.borradorId && !entrada) toast("Ese borrador ya no existe o caducó (duran una semana sin cambios).");
  borradorActualId = entrada ? entrada.id : crypto.randomUUID();
  envioRendicionId = crypto.randomUUID();
  adjuntosBorrador.clear();
  document.getElementById("nr-fecha").value = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  document.getElementById("nr-tipo").value = "Reembolso";
  document.getElementById("nr-fondo-wrap").style.display = "none";
  limpiarFilasFondo();
  document.getElementById("nr-comentario").value = "";
  document.getElementById("nr-empresa").value = EMPRESAS[0];
  actualizarCentroCostoRendicion();
  document.getElementById("items-container").innerHTML = "";
  itemSeq = 0;
  // itemSeq vuelve a 0, así que el primer ítem de esta rendición se vuelve a
  // llamar "item-1" igual que el de la rendición anterior. Si estos dos mapas
  // no se limpian, ese id reciclado arrastra el estado del formulario viejo:
  //  - un OCR que quedó en vuelo de la rendición anterior encuentra su "gen"
  //    todavía vigente y los elementos otra vez existentes, y escribe el RUT,
  //    folio, fecha y monto del documento ANTERIOR en este formulario en
  //    blanco -- la persona ve un ítem lleno y lo puede enviar así.
  //  - ocrExitoso.get("item-1") sigue en true, así que estadoReintentoOcr
  //    decide no encolar un ítem cuyo OCR en realidad falló, y el agente en
  //    segundo plano nunca lo toma, sin ninguna señal visible.
  ocrGeneracion.clear();
  ocrExitoso.clear();
  for (const revision of revisionesComprobante.values()) revision.limpiar();
  revisionesComprobante.clear();
  ocrArchivoActual.clear();
  ocrBloqueado.clear();
  ocrConflictos.clear();
  ocrOrigen.clear();
  ocrMonto.clear();
  addItemRow();
  if (pushHistory) pushView("view-nueva", entrada ? { borradorId: entrada.id } : {});
  else {
    show("view-nueva");
    // Si pedía un borrador que ya no existe, la URL no puede seguir apuntando a él.
    if (!entrada && location.hash.startsWith("#nueva/")) history.replaceState({ viewId: "view-nueva", params: {}, portalDepth: history.state?.portalDepth || 0 }, "", "#nueva");
  }
  if (entrada) restaurarBorradorRendicion(entrada).catch((err) => console.error("No se pudo restaurar el borrador:", err));
}

// Después de quitar un ítem, "Ítem 1, Ítem 3" (saltándose el 2) da la
// impresión de que falta algo -- esto vuelve a numerar en pantalla los que
// quedan, de forma correlativa. Los ids internos (item-N) no se tocan, solo
// el texto visible.
function renumerarItems() {
  document.querySelectorAll("#items-container .item-card").forEach((card, i) => {
    const titulo = card.querySelector(".item-head strong");
    if (titulo) titulo.textContent = `Ítem ${i + 1}`;
  });
}

function addItemRow() {
  const id = "item-" + ++itemSeq;
  const wrap = el("div", { class: "item-card", id });

  const titulo = el("strong", {}, `Ítem ${itemSeq}`);
  const head = el("div", { class: "item-head" }, [
    titulo,
    el("div", { style: "display:flex; gap:6px;" }, [
      // Un mismo documento (factura/boleta) puede corresponder a más de un
      // Centro de Costo (ej. una factura de insumos que se reparte entre
      // dos sedes) -- esto arma un segundo ítem con los mismos datos del
      // documento (proveedor, RUT, tipo, N° documento, fecha, categoría, y
      // el mismo comprobante adjunto), para que la persona solo tenga que
      // repartir el monto y elegir el otro Centro de Costo, en vez de
      // tipear todo de nuevo a mano.
      el("button", { class: "btn btn-ghost", type: "button", onclick: () => dividirItem(wrap, id) }, "Dividir ítem"),
      el("button", {
        class: "btn btn-ghost", type: "button",
        onclick: () => {
          // Solo pedimos confirmación si la tarjeta ya tiene algo cargado
          // (monto o comprobante) -- para una tarjeta extra vacía que la
          // persona nunca llegó a usar, preguntar es puro ruido.
          const tieneMonto = [...wrap.querySelectorAll('input[data-money]')].some((i) => i.value.trim());
          const tieneArchivo = [...wrap.querySelectorAll('input[type=file]')].some((i) => i.files.length);
          if ((tieneMonto || tieneArchivo) && !confirm("¿Quitar este ítem? Se pierde el comprobante y los datos cargados, no se puede deshacer.")) return;
          wrap.remove();
          actualizarAlertasDuplicados();
          renumerarItems();
          recalcTotal();
        },
      }, "Quitar"),
    ]),
  ]);

  const toggle = el("div", { class: "toggle-group", role: "tablist" }, [
    el("button", { type: "button", class: "active", "data-tipo": "ConDocumento", "aria-pressed": "true" }, "Documento electrónico"),
    el("button", { type: "button", "data-tipo": "SinDocumento", "aria-pressed": "false" }, "Comprobante/Boleta"),
  ]);

  const bodyConDoc = buildConDocumentoFields(id);
  const bodySinDoc = buildSinDocumentoFields(id);
  bodySinDoc.style.display = "none";

  toggle.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-pressed", "false"); });
      b.classList.add("active");
      b.setAttribute("aria-pressed", "true");
      const isCon = b.dataset.tipo === "ConDocumento";
      bodyConDoc.style.display = isCon ? "block" : "none";
      bodySinDoc.style.display = isCon ? "none" : "block";
      actualizarAlertasDuplicados();
    });
  });

  wrap.appendChild(head);
  wrap.appendChild(toggle);
  wrap.appendChild(bodyConDoc);
  wrap.appendChild(bodySinDoc);
  wrap.appendChild(bodyConDoc.querySelector(`#${id}-dup-status`));
  wrap.appendChild(el("p", { class: "ocr-status", id: id + "-dup-local" }));
  const identidadCampos = /-(rut2?|folio2?|tipodoc2?)$/;
  wrap.addEventListener("input", (event) => {
    if (event.isTrusted) camposEditadosOcr.add(event.target.id);
    if (identidadCampos.test(event.target.id)) actualizarAlertasDuplicados();
  });
  wrap.addEventListener("change", (event) => { if (event.isTrusted) camposEditadosOcr.add(event.target.id); actualizarAlertasDuplicados(); });
  wrap.addEventListener("focusout", (event) => {
    if (identidadCampos.test(event.target.id)) chequearDuplicadoHistorico(id);
  });
  document.getElementById("items-container").appendChild(wrap);
  // itemSeq solo sigue subiendo (nunca vuelve atrás, para que los ids del
  // DOM no se repitan) -- si antes se quitó un ítem, el título inicial de
  // uno nuevo ("Ítem 5") puede no coincidir con su posición real en la
  // lista ("Ítem 3"). renumerarItems() lo corrige apenas se agrega.
  renumerarItems();
}

// Arma un ítem nuevo con los mismos datos del documento del ítem "wrap"
// (proveedor, RUT, tipo, N° documento, fecha, categoría -- y el mismo
// comprobante adjunto), para el caso real de una factura/boleta que
// corresponde a más de un Centro de Costo. A propósito NO reparte el
// monto a la mitad ni adivina nada -- deja el mismo monto en los dos y
// que la persona ajuste cada uno a lo que realmente corresponde a cada
// sede, junto con el Centro de Costo.
function dividirItem(wrap, id) {
  const esCon = wrap.querySelector('[data-tipo="ConDocumento"]').classList.contains("active");
  const v = (sufijo) => document.getElementById(`${id}${sufijo}`)?.value || "";
  const fotoInputOrigen = document.getElementById(esCon ? `${id}-foto` : `${id}-foto2`);
  const datos = esCon
    ? {
        nombreprov: v("-nombreprov"), rut: v("-rut"), tipodoc: v("-tipodoc"),
        folio: v("-folio"), venc: v("-venc"), categoria: v("-categoriacon"), monto: v("-monto"),
      }
    : { nombreprov2: v("-nombreprov2"), rut2: v("-rut2"), tipodoc2: v("-tipodoc2"), folio2: v("-folio2"), fecha2: v("-fecha2"), categoria: v("-categoria"), monto2: v("-monto2") };

  addItemRow();
  const nuevoId = "item-" + itemSeq;
  const nuevoWrap = document.getElementById(nuevoId);
  if (!esCon) nuevoWrap.querySelector('[data-tipo="SinDocumento"]').click();

  if (esCon) {
    document.getElementById(`${nuevoId}-nombreprov`).value = datos.nombreprov;
    document.getElementById(`${nuevoId}-rut`).value = datos.rut;
    if (datos.tipodoc) document.getElementById(`${nuevoId}-tipodoc`).value = datos.tipodoc;
    document.getElementById(`${nuevoId}-folio`).value = datos.folio;
    document.getElementById(`${nuevoId}-venc`).value = datos.venc;
    const catSel = document.getElementById(`${nuevoId}-categoriacon`);
    if (catSel && datos.categoria) catSel.value = datos.categoria;
    document.getElementById(`${nuevoId}-monto`).value = datos.monto;
  } else {
    document.getElementById(`${nuevoId}-nombreprov2`).value = datos.nombreprov2;
    for (const campo of ["rut2", "tipodoc2", "folio2", "fecha2"]) document.getElementById(`${nuevoId}-${campo}`).value = datos[campo];
    const catSel = document.getElementById(`${nuevoId}-categoria`);
    if (catSel && datos.categoria) { catSel.value = datos.categoria; catSel.dispatchEvent(new Event("change")); }
    document.getElementById(`${nuevoId}-monto2`).value = datos.monto2;
  }

  if (fotoInputOrigen?.files?.length) {
    const fotoInputNuevo = document.getElementById(esCon ? `${nuevoId}-foto` : `${nuevoId}-foto2`);
    const dt = new DataTransfer();
    dt.items.add(fotoInputOrigen.files[0]);
    fotoInputNuevo.files = dt.files;
  }

  recalcTotal();
  actualizarAlertasDuplicados();
  toast("Ítem dividido. Ajusta el monto y el Centro de Costo de cada uno para que sumen el total real del documento.");
  document.getElementById(esCon ? `${nuevoId}-cccon` : `${nuevoId}-cc`)?.focus();
}

function buildConDocumentoFields(id) {
  const box = el("div", { class: "con-documento" });
  const row1 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-nombreprov`, "Nombre del proveedor", "text"),
    fieldInput(`${id}-rut`, "RUT del proveedor", "text", "12.345.678-9"),
  ]);
  const row2 = el("div", { class: "field-row" }, [
    fieldSelect(`${id}-tipodoc`, "Tipo de documento", TIPOS_DOCUMENTO),
    fieldInput(`${id}-folio`, "N° de documento", "text"),
  ]);
  const dupStatus = el("p", { class: "ocr-status", id: `${id}-dup-status` });
  const row3 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-venc`, "Fecha del documento", "date"),
    fieldInputMoney(`${id}-monto`, "Monto"),
  ]);
  // Categoría del gasto: NO reemplaza la cuenta contable derivada del tipo
  // de documento (esa sigue siendo 2.01.07.01/03 para cuadrar con Kame,
  // ver CUENTA_POR_TIPO_DOC) -- es una clasificación aparte, la misma idea
  // que ya existía para "Boleta"/Gasto directo, ahora también acá, porque
  // un Documento electrónico (ej. una factura de supermercado) igual es
  // útil poder categorizarlo para Reportes ("Beneficios del Personal",
  // etc.), no solo saber que es una factura.
  //
  // Centro de Costo por ítem: antes un "Documento electrónico" SIEMPRE
  // quedaba con el Centro de Costo del encabezado de la rendición, sin
  // forma de cambiarlo -- una rendición con más de una factura de sedes
  // distintas (ej. una en Chicureo, otra en Mall Sport) no tenía cómo
  // reflejar eso. "Boleta"/Gasto directo ya lo permitía por ítem, esto lo
  // iguala. OJO: el id NO puede ser "${id}-cc" -- ese ya lo usa el campo
  // equivalente de Boleta/SinDocumento, y las dos secciones (Documento
  // electrónico / Boleta) conviven SIEMPRE en el DOM de la misma tarjeta
  // (una queda con display:none, pero sigue ahí) -- reusar el id
  // chocaría con document.getElementById en otro lugar de la tarjeta.
  // NO se manda al comprobante de Kame para este tipo de ítem (ver el
  // comentario en construirFilasCSV) -- es solo para Reportes/Excel.
  const empresaActualCon = document.getElementById("nr-empresa")?.value || EMPRESAS[0];
  const opcionesCCCon = CENTROS_COSTO_POR_EMPRESA[empresaActualCon] || ["Casa Matriz"];
  const ccHeaderActualCon = document.getElementById("nr-cc")?.value;
  // OJO: id "-categoriacon", NO "-categoria" -- ese lo usa el select de
  // categoría de Boleta/SinDocumento más abajo (buildSinDocumentoFields),
  // y las dos secciones conviven en el mismo DOM de la tarjeta (una queda
  // con display:none). Reusar el id hacía que document.getElementById
  // siempre devolviera el de acá (el primero en el DOM), corrompiendo en
  // silencio la categoría guardada de cualquier ítem "Boleta" que no
  // dejara la primera opción del desplegable (bug encontrado en revisión
  // posterior a este mismo cambio) -- mismo motivo que ya se documentó
  // para "-cccon" más arriba.
  const row3b = el("div", { class: "field-row" }, [
    fieldSelectCategoria(`${id}-categoriacon`),
    fieldSelect(`${id}-cccon`, "Centro de Costo (Unidad de Negocio)", opcionesCCCon),
  ]);
  row3b.querySelector("select[id$='-cccon']").value = opcionesCCCon.includes(ccHeaderActualCon) ? ccHeaderActualCon : opcionesCCCon[0];
  const row4 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-desc`, "Descripción", "text"),
  ]);
  const foto = fieldFile(`${id}-foto`, "Comprobante (foto o PDF)");
  const ocrStatus = el("p", { class: "ocr-status", id: `${id}-ocr-status` });
  foto.appendChild(ocrStatus);

  box.appendChild(row1);
  box.appendChild(row2);
  box.appendChild(dupStatus);
  box.appendChild(row3);
  box.appendChild(row3b);
  box.appendChild(row4);
  box.appendChild(foto);
  // La verificación contra contabilidad la hace quien aprueba, no quien carga el gasto
  // (ver openDetalle / verificarDocumentoItem).
  [row1, row2, row3, row4].forEach((r) =>
    r.querySelectorAll("input:not([data-money])").forEach((i) => i.addEventListener("input", recalcTotal))
  );

  const fotoInput = foto.querySelector("input[type=file]");
  fotoInput.addEventListener("change", async () => {
    if (!validarTamanoArchivo(fotoInput)) return;
    nuevaGeneracionOcr(id);
    await prepararArchivoParaLectura(fotoInput,ocrStatus,file => analizarComprobante(id,file,ocrStatus));
  });

  // Si ese RUT ya aparece en la contabilidad, usamos su razón social real
  // en vez de que la persona tenga que escribirla a mano.
  const rutInput = row1.querySelector(`#${id}-rut`);
  const nombreProvInput = row1.querySelector(`#${id}-nombreprov`);
  const rutHint = el("p", { class: "ocr-status", id: `${id}-rut-hint` });
  rutInput.parentElement.appendChild(rutHint);
  const folioInput = row2.querySelector(`#${id}-folio`);

  rutInput.addEventListener("blur", async () => {
    rutInput.value = formatearRut(rutInput.value);
    if (rutInput.value && !validarRut(rutInput.value)) {
      rutHint.textContent = "Ese RUT no parece válido (revisa el dígito verificador).";
      rutHint.className = "ocr-status show err";
    } else {
      rutHint.className = "ocr-status";
    }
    const rutConsultado = rutInput.value;
    const nombre = await buscarNombreProveedorPorRut(rutConsultado);
    if (nombre && rutInput.value === rutConsultado && !camposEditadosOcr.has(nombreProvInput.id)) nombreProvInput.value = nombre;
  });

  return box;
}

function documentoDeTarjeta(card) {
  const con = card.querySelector('[data-tipo="ConDocumento"]').classList.contains("active");
  const v = (campo) => document.getElementById(card.id + campo)?.value || "";
  return { rut_proveedor: v(con ? "-rut" : "-rut2"), tipo_documento: v(con ? "-tipodoc" : "-tipodoc2"), nro_documento: v(con ? "-folio" : "-folio2") };
}

function actualizarAlertasDuplicados() {
  const cards = [...document.querySelectorAll(".item-card")];
  const grupos = documentosDuplicados(cards.map(documentoDeTarjeta));
  cards.forEach((card) => {
    const aviso = document.getElementById(card.id + "-dup-local");
    if (aviso) { aviso.textContent = ""; aviso.className = "ocr-status"; }
  });
  grupos.forEach((indices) => {
    const texto = "⚠ El mismo documento aparece en los ítems " + indices.map((i) => i + 1).join(", ") + ". Si lo repartiste entre centros de costo, verifica que los montos sumen el total de la factura.";
    indices.forEach((indice) => {
      const aviso = document.getElementById(cards[indice].id + "-dup-local");
      if (aviso) { aviso.textContent = texto; aviso.className = "ocr-status show err"; }
    });
  });
  return grupos;
}

async function chequearDuplicadoHistorico(id) {
  const card = document.getElementById(id);
  if (!card) return;
  actualizarAlertasDuplicados();
  const documento = documentoDeTarjeta(card);
  const aviso = document.getElementById(id + "-dup-status");
  const identidad = JSON.stringify(documento);
  aviso.dataset.consulta = identidad;
  aviso.className = "ocr-status";
  if (!documento.rut_proveedor || !documento.nro_documento || !validarRut(documento.rut_proveedor)) return;
  const { data, error } = await db.rpc("buscar_documento_duplicado", {
    p_rut: documento.rut_proveedor, p_nro: documento.nro_documento, p_tipo: documento.tipo_documento,
  });
  if (!document.body.contains(card) || aviso.dataset.consulta !== identidad) return;
  if (error) {
    aviso.textContent = "No se pudo comprobar si el documento ya fue rendido. Revisa antes de enviar.";
    aviso.className = "ocr-status show err";
    return;
  }
  if (data?.length) {
    aviso.textContent = "⚠ Este documento ya está registrado en la rendición N° " + data[0].folio + " de " + data[0].empleado_nombre + ". Revisa que no sea un duplicado.";
    aviso.className = "ocr-status show err";
  }
}

// Lee la foto del comprobante, se la manda a la Edge Function "ocr-recibo"
// (que a su vez consulta a Google Gemini con la API key guardada en el
// servidor) y autocompleta los campos del ítem con lo que logre leer.
// Si algo falla, simplemente no autocompleta nada: el empleado sigue
// pudiendo cargar el gasto a mano.
// Común a "Con documento" y "Gasto directo": lee el archivo, se lo manda a
// la Edge Function ocr-recibo y devuelve los datos extraídos. Cada caller
// mapea el resultado a sus propios campos (son formularios distintos).
// Sin esto, una llamada de red que se cuelga (señal mala en terreno, no un
// error real -- nunca responde ni falla) dejaba el botón pegado en
// "Analizando..."/"Guardando..." indefinidamente, sin ningún mensaje ni
// forma de reintentar salvo recargar la página y perder lo ya tipeado.
function conTimeout(promise, ms, mensaje) {
  let idTimeout;
  const timeout = new Promise((_, reject) => {
    idTimeout = setTimeout(() => reject(new Error(mensaje)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(idTimeout));
}

// ---------------------------------------------------------------------
// Lectura LOCAL de facturas electrónicas en PDF, sin IA.
//
// Una factura electrónica chilena generada digitalmente trae el texto
// adentro del PDF (RUT, folio, total, fecha) -- no hace falta que un modelo
// lo "mire" e interprete: se lee el dato exacto. Es gratis, instantáneo, no
// consume la cuota de Gemini (que el 2026-09-22 se agotó y dejó la app sin
// OCR todo un día) y es MÁS preciso que la IA para este caso, porque no
// interpreta: extrae.
//
// La IA sigue siendo necesaria para fotos y PDF escaneados (imagen sin
// texto), que es donde de verdad aporta. Si acá no se logra sacar lo
// esencial, se cae a la IA como siempre.
// ---------------------------------------------------------------------
// pdf.js 6 (antes 3.11.174, con fallas conocidas). Desde la v4 es un módulo
// (.mjs): se carga con import(). Build "legacy": funciona también en celulares
// con navegadores no tan recientes (cdnjs solo publica la build moderna).
const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/legacy/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/legacy/build/pdf.worker.min.mjs";
let pdfjsCargando = null;

// Se carga recién cuando alguien adjunta o abre un PDF (son ~500KB): no tiene
// sentido que los pague en descarga quien solo sube fotos.
function cargarPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsCargando) return pdfjsCargando;
  pdfjsCargando = new Promise((resolve, reject) => {
    const fallo=()=>{clearTimeout(timer);pdfjsCargando=null;reject(new Error("No se pudo cargar el lector de PDF. Puedes reintentar."));};
    const timer=setTimeout(fallo,30000);
    import(PDFJS_URL).then((pdfjs) => {
      clearTimeout(timer);
      if(!pdfjs?.getDocument || !pdfjs.GlobalWorkerOptions){fallo();return;}
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      window.pdfjsLib = pdfjs;
      resolve(pdfjs);
    }, fallo);
  });
  return pdfjsCargando;
}

// OCR de fotos en el propio navegador, sin API ni cuota. Es la red de
// seguridad para el caso que antes no tenía ninguna: una foto cuando Gemini
// no está disponible no daba absolutamente nada, y el cupo gratuito son ~20
// solicitudes por modelo al día.
//
// Es bastante peor que Gemini leyendo fotos, y por eso NO le compite: solo
// corre cuando la IA ya falló (ver analizarComprobante). Lo que lo hace
// seguro pese a ser ruidoso es que el texto que produce pasa por el MISMO
// parsearTextoFactura que los PDF, y ese parser ya valida lo que extrae: el
// RUT tiene que pasar su dígito verificador y el monto tiene que cuadrar con
// neto + IVA. Si el OCR distorsiona un dígito, esas dos comprobaciones
// fallan y se devuelve null -- que es exactamente lo que se quiere, porque
// un monto equivocado que nadie revisa es peor que un campo vacío.
const TESSERACT_URL = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/7.0.0/tesseract.min.js";
let tesseractCargando = null;

// Pesa varios MB (motor WASM + datos del idioma español), así que se carga
// recién cuando de verdad hace falta: nadie que suba PDF lo descarga, y
// quien sube fotos tampoco mientras la IA esté respondiendo.
function cargarTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractCargando) return tesseractCargando;
  tesseractCargando = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    const timer=setTimeout(()=>{s.remove();reject(new Error("El escáner no terminó de cargar. Intenta nuevamente."));},30000);
    s.onload = () => {
      clearTimeout(timer);
      // Si el script cargó pero no dejó el global, tirar acá adentro dejaría
      // la promesa colgada para siempre y el ítem clavado en "Analizando".
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error("El lector de fotos cargó incompleto."));
    };
    s.onerror = () => {clearTimeout(timer);s.remove();reject(new Error("No se pudo cargar el lector de fotos."));};
    document.head.appendChild(s);
  });
  // Una promesa rechazada quedaba cacheada para siempre: un corte de red
  // momentáneo dejaba el lector inutilizable por el resto de la sesión.
  tesseractCargando.catch(() => { tesseractCargando = null; });
  return tesseractCargando;
}

// Una foto de celular moderna viene en 4000px o más, y pasársela así a
// Tesseract es peor por los dos lados: tarda mucho más y no lee mejor (el
// motor trabaja alrededor de un tamaño de texto, no con el máximo detalle
// posible). Se reescala a un lado máximo razonable y en calidad alta -- alta
// a propósito, distinto de comprimirImagenSiCorresponde, que apunta a que el
// archivo pese poco para subirlo: acá los artefactos de compresión son
// justamente lo que hace que un 8 se lea como 3.
const LADO_MAXIMO_OCR = 2000;
async function prepararImagenParaOcr(file, ampliar = false) {
  try {
    file = await prepararComprobanteIa(file);
    const bitmap = await createImageBitmap(file);
    // Aumentar comprobantes pequeños ayuda al escáner a separar los caracteres.
    const escala = Math.min(ampliar ? 3 : 1, LADO_MAXIMO_OCR / Math.max(bitmap.width, bitmap.height));
    if (escala === 1) { bitmap.close(); return file; }
    const w = Math.round(bitmap.width * escala);
    const h = Math.round(bitmap.height * escala);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return blob ? new File([blob], file.name, { type: "image/png" }) : file;
  } catch (err) {
    console.error("No se pudo preparar la imagen para OCR, se usa la original:", err);
    return file;
  }
}


const lectorLocalPersistente=window.RindeOcrLocal.crearLector(cargarTesseract);
window.addEventListener("pagehide",()=>{lectorLocalPersistente.cerrar();});

async function leerFotoLocal(file) {
  if (!(file.type || "").startsWith("image/")) return null;
  try {
    let preparado=await prepararImagenParaOcr(file);
    const { data } = await lectorLocalPersistente.leer(preparado);
    let texto = data?.text || "";
    let lecturaAlternativa=null;
    // Los comprobantes deslavados o con bloques separados pueden quedar
    // vacíos con la segmentación automática. Prueba bloques dispersos una vez.
    if(texto.replace(/\s/g, "").length < 40){
      preparado=await prepararImagenParaOcr(file,true);
      lecturaAlternativa=await lectorLocalPersistente.leer(preparado,11);
      texto=lecturaAlternativa.data?.text || "";
    }
    if (texto.replace(/\s/g, "").length < 40) return null; // no salió texto legible
    let datos = parsearTextoFactura(texto);
    if(!datos.rut_proveedor && !datos.tipo_documento && !datos.nro_documento && !["aritmetica","etiqueta","palabras+digitos"].includes(datos.monto_origen) && !lecturaAlternativa){
      preparado=await prepararImagenParaOcr(file,true);
      lecturaAlternativa=await lectorLocalPersistente.leer(preparado,11);
      datos=parsearTextoFactura(lecturaAlternativa.data?.text || "");
    }
    // Umbral de utilidad: hace falta AL MENOS un dato con respaldo propio.
    // Vale un RUT (lo valida su dígito verificador) o un monto con
    // procedencia fuerte (aritmética del documento, o pegado a su etiqueta).
    //
    // La condición anterior exigía RUT o aritmética, y por eso descartaba
    // entera la foto del comprobante de transferencia real: no trae RUT del
    // destinatario ni desglose de IVA, pero SÍ decía "Monto $230.000" junto
    // a su etiqueta, que es el dato correcto y el único que importaba. Con
    // el filtro viejo, todo ese tipo de comprobante quedaba fuera por
    // definición, sin importar lo bien que se hubiera leído.
    // También vale un folio o un tipo de documento reconocido. Se agregó tras
    // el comprobante de pago municipal del 2026-09-24: el lector había sacado
    // bien el tipo ("Comprobante de Pago") y el folio (1501346), pero el
    // documento no trae desglose de IVA y su único RUT es el NUESTRO -- somos
    // quienes pagamos la multa --, así que no cumplía ninguna de las dos
    // condiciones y se descartaba entero. La persona terminó escribiendo a
    // mano dos datos que ya estaban leídos.
    const montoConRespaldo = datos.monto && ["aritmetica","etiqueta","palabras+digitos"].includes(datos.monto_origen);
    if (!datos.rut_proveedor && !montoConRespaldo && !datos.nro_documento && !datos.tipo_documento) return null;

    // Desde una foto, el monto solo se acepta si hay EVIDENCIA de que es el
    // total: o la aritmética del documento lo confirma, o venía pegado a una
    // etiqueta ("TOTAL $ 8.990", "Monto transferido: $230.000"). Lo que no
    // se acepta nunca es el paso de último recurso, que elige el mayor
    // importe con $: eso es una conjetura, y sobre una foto sale mal.
    //
    // Medido, no supuesto. En la factura de Supletech fotografiada por
    // WhatsApp, el total real ($350.874) no llegó a leerse EN ABSOLUTO, así
    // que esa conjetura agarró el subtotal de una línea ($273.008) y lo puso
    // en el campo tan campante. Y no sirve filtrar por la confianza del OCR:
    // ese número equivocado salió con confianza 83, mientras que el RUT, que
    // estaba bien, salió con 40. La confianza mide nitidez del trazo, no
    // acierto.
    //
    // La distinción importa sobre todo para boletas, comprobantes de
    // transferencia y vouchers: esos no traen desglose de IVA, así que la
    // verificación aritmética NUNCA les va a aplicar y la etiqueta es la
    // única evidencia fuerte que pueden ofrecer.
    // QUÉ SE COMPLETA DESDE UNA FOTO Y QUÉ NO. El criterio es uno solo: se
    // llena la fuente que MIDE mejor que el azar, y se deja en blanco la que
    // no. Sobre 409 comprobantes reales del archivo de Rindegastos:
    //
    //   monto con evidencia fuerte .... 46 llenados,   0 equivocados
    //   monto rellenando siempre ...... 135 llenados, 58 equivocados (43%)
    //   RUT ........................... 159 leídos,   15 equivocados (9%)
    //   folio pegado al tipo de doc ... acierta ~6 de cada 10
    //   folio suelto en la hoja ....... 109 leídos,   67 equivocados (61%)
    //
    // De ahí sale todo lo de abajo. El MONTO solo se llena con evidencia
    // fuerte: entre los llenados sin ella, era más probable que estuviera
    // mal que bien, y no es un campo donde valga arriesgar -- va a
    // contabilidad, es obligatorio, y la persona lo escribe igual, así que
    // el blanco le cuesta segundos y el error equivocado le cuesta a
    // contabilidad. Los errores tampoco son sutiles: $10.130 leído
    // $310.130, $221.390 leído $4.221.390.
    //
    // El FOLIO se conserva solo cuando venía pegado al tipo de documento
    // ("FACTURA ELECTRONICA N° 7960"); el suelto se descarta porque acierta
    // menos de la mitad de las veces, y un campo que miente más de lo que
    // acierta es peor que vacío: la persona aprende a no mirarlo.
    //
    // El RUT se conserva: 9 de cada 10 salen bien, y además es la llave que
    // destraba proveedor y categoría desde contabilidad.
    //
    // Lo que se conserva pero puede fallar queda listado en confianza_baja,
    // y aplicarRespaldoFoto se lo nombra a la persona uno por uno. Rellenar
    // sin avisar sería lo único peor que dejar en blanco.
    datos.confianza_baja = [];
    let totalCoincidente=false;
    if(datos.monto && datos.monto_origen === "etiqueta"){
      const segunda=lecturaAlternativa ? await lectorLocalPersistente.leer(preparado,3) : await lectorLocalPersistente.leer(preparado,11);
      const otro=parsearTextoFactura(segunda.data?.text || "");
      totalCoincidente=Number(otro.monto)===Number(datos.monto) && ["etiqueta","aritmetica","palabras+digitos"].includes(otro.monto_origen) && !otro.monto_discrepante;
      if(otro.monto && Number(otro.monto)!==Number(datos.monto))datos.monto_discrepante=true;
    }
    // Una discrepancia exige confirmación humana, aunque un valor parezca plausible.
    if (datos.monto_origen === "discrepancia" || datos.monto_discrepante) {
      datos.monto=null;datos.monto_discrepante=true;datos.monto_verificado=false;
    }
    const MONTO_FUERTE = ["palabras+digitos", "aritmetica", "palabras"];
    if (!MONTO_FUERTE.includes(datos.monto_origen) && !totalCoincidente) datos.monto = null;
    if(totalCoincidente){datos.confianza_baja.push("monto");datos.monto_verificado=false;datos.monto_origen="dos_escaneos";}
    // El folio se conserva SIEMPRE, incluso el "suelto" (un número con
    // etiqueta N° en cualquier parte de la hoja), que medido acierta unas 4
    // de cada 10 veces. Antes se descartaba por eso. Se cambió a pedido, con
    // el criterio de que un folio no es plata: uno equivocado no genera un
    // pago mal hecho, se nota al cruzarlo con contabilidad y el aviso pide
    // compararlo. El monto, que sí es plata, mantiene su barra alta.
    if (datos.nro_documento) datos.confianza_baja.push("nro_documento");
    // El tipo de documento también puede venir de una lectura floja.
    if (datos.tipo_documento) datos.confianza_baja.push("tipo_documento");

    // Misma lógica para la fecha: en esa foto el año salió 2025 en vez de
    // 2026, un solo dígito mal que manda el gasto a otro período contable.
    // No hay forma de validarla, así que se descarta la que no sea
    // plausible para una rendición (nada de más de un año atrás ni futuro).
    if (datos.fecha) {
      const f = new Date(datos.fecha + "T00:00:00");
      const hoy = new Date();
      const haceUnAnio = new Date(hoy.getFullYear() - 1, hoy.getMonth(), hoy.getDate());
      const enUnMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate());
      const calendario=/^(\d{4})-(\d{2})-(\d{2})$/.exec(datos.fecha);
      if (isNaN(f) || !calendario || f.getFullYear()!==Number(calendario[1]) || f.getMonth()+1!==Number(calendario[2]) || f.getDate()!==Number(calendario[3]) || f < haceUnAnio || f > enUnMes) datos.fecha = null;
    }
    datos.verificacion_campos={};
    for(const campo of ["nombre_proveedor","rut_proveedor","tipo_documento","nro_documento","fecha","monto"]){
      const valor=datos[campo];
      if(valor && !datos.confianza_baja.includes(campo))datos.confianza_baja.push(campo);
      datos.verificacion_campos[campo]={estado:valor?"por_confirmar":"ilegible",texto:valor?String(valor):"",motivo:valor?"Leído por el escáner local. Compara este dato con el comprobante.":"El escáner local no encontró evidencia suficiente para completar este campo."};
    }
    if(datos.monto && datos.monto_verificado){datos.verificacion_campos.monto.motivo="El importe concuerda con la aritmética o las cifras y palabras leídas. Revisa también el documento.";}
    if(datos.monto_discrepante){datos.verificacion_campos.monto={estado:"por_confirmar",motivo:"Hay montos contradictorios. Confirma el total mirando el comprobante."};}
    return datos;
  } catch (err) {
    console.error("No se pudo leer la foto localmente:", err);
    return null;
  }
}

const MESES_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const RE_RUT_EN_TEXTO = /(\d{1,2}\.?\d{3}\.?\d{3}\s*-\s*[\dkK])/g;

// Los patrones de acá abajo NO son inventados: se ajustaron contra dos
// facturas reales de emisores y maquetados distintos (Supletech/bsale y
// Rindegastos/simpledte), y cada regla existe porque una versión anterior
// se equivocó con una de ellas. Ver los comentarios puntuales.
// El nombre de la contraparte cuando viene rotulado. Pensado sobre todo para
// los comprobantes que NO son DTE: una transferencia dice "Destinatario
// Fulano", un voucher dice el comercio, y ninguno trae RUT. El corte contra
// la siguiente etiqueta conocida es lo que evita arrastrar media pantalla:
// en el comprobante real el texto seguía con "Cuenta Corriente N° ...".
function nombreDesdeEtiqueta(t) {
  const m = /(?:Destinatario|Beneficiario|Comercio|Raz[oó]n\s*Social|Nombre\s*del?\s*(?:comercio|local))\s*:?\s*(.{3,70})/i.exec(t);
  if (!m) return null;
  // Se captura ancho y se corta después, en vez de pedirle al regex que se
  // detenga solo. Un corte perezoso dentro del propio patrón falla en los
  // dos extremos: si la etiqueta siguiente no está en la lista se pasa de
  // largo hasta el tope (el voucher devolvía null), y si el nombre es más
  // corto que el mínimo se lo salta y se come la etiqueta siguiente
  // ("Destinatario: 4 Cuenta Corriente" devolvía "4 Cuenta Corriente").
  const SIGUIENTE_ETIQUETA = /\b(Cuenta|RUT|R\.U\.T|Banco|Motivo|Fecha|Giro|Direcci[oó]n|Monto|C[oó]digo|Total|Autorizaci[oó]n|Tarjeta|Terminal|Folio|N[°º])\b/i;
  const corte = m[1].search(SIGUIENTE_ETIQUETA);
  const nombre = (corte >= 0 ? m[1].slice(0, corte) : m[1])
    .replace(/\s+/g, " ").trim().replace(/[.,;:|\-]+$/, "").trim();
  // Tiene que empezar con letra y traer una palabra de verdad: lo que quede
  // en puros números o símbolos es ruido de OCR, no un nombre.
  if (nombre.length < 3 || !/^[A-Za-zÁÉÍÓÚÑÜáéíóúñü]/.test(nombre) || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}/.test(nombre)) return null;
  return nombre;
}

// Las boletas y facturas chilenas casi siempre imprimen el total EN LETRAS
// ("SON: CIENTO ONCE MIL CIENTO SETENTA"). Eso es oro para una lectura por
// foto, porque es el mismo número codificado de otra forma, y los errores de
// OCR en los dígitos no se correlacionan con los de las palabras: en una
// boleta real el total salió "TOTAL $ 11.179" -- un dígito menos que los
// $111.170 verdaderos -- y estaba pegado a su etiqueta, así que ninguna de
// las defensas que había lo detectó. Las letras decían el número correcto.
//
// Y se autoverifica: una secuencia de palabras o forma un número válido en
// español o no forma nada. Un error de OCR en una palabra rompe el parseo en
// vez de producir un número equivocado, que es exactamente el modo de falla
// que se busca.
const NUM_PALABRAS = {
  cero:0, un:1, uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8, nueve:9,
  diez:10, once:11, doce:12, trece:13, catorce:14, quince:15, dieciseis:16, diecisiete:17,
  dieciocho:18, diecinueve:19, veinte:20, veintiuno:21, veintidos:22, veintitres:23,
  veinticuatro:24, veinticinco:25, veintiseis:26, veintisiete:27, veintiocho:28, veintinueve:29,
  treinta:30, cuarenta:40, cincuenta:50, sesenta:60, setenta:70, ochenta:80, noventa:90,
  cien:100, ciento:100, doscientos:200, trescientos:300, cuatrocientos:400, quinientos:500,
  seiscientos:600, setecientos:700, ochocientos:800, novecientos:900,
};
const SIN_TILDES = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function montoDesdePalabras(texto) {
  // El bloque arranca en "SON" y termina donde deja de haber palabras de
  // número (típicamente "PESOS", o basura del OCR).
  const m = /\bSON\s*:?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ\s]{6,120})/i.exec(texto);
  if (!m) return null;
  const tokens = SIN_TILDES(m[1]).split(/\s+/).filter(Boolean);
  let total = 0, grupo = 0, hubo = false, consumidos = 0;
  for (const tk of tokens) {
    if (tk === "y") continue;                 // "treinta y cinco"
    if (tk === "mil") { grupo = (grupo || 1) * 1000; total += grupo; grupo = 0; hubo = true; consumidos++; continue; }
    if (tk === "millon" || tk === "millones") { total = (total + (grupo || 1)) * 1000000; grupo = 0; hubo = true; consumidos++; continue; }
    const v = NUM_PALABRAS[tk];
    if (v === undefined) break;               // se acabó el número: "PESOS", ruido, etc.
    grupo += v;
    consumidos++;
    hubo = true;
  }
  const valor = total + grupo;
  if (!hubo || valor <= 0) return null;
  // Dos guardas contra un parseo que se cortó a la mitad. "OCHO MXL
  // NOVECIENTOS" (con la palabra "MIL" rota por el OCR) devolvía 8: se
  // consumía un solo token, se frenaba en la palabra ilegible y entregaba
  // ese 8 como si fuera el total -- pisando el monto correcto que los
  // dígitos sí habían leído bien. Un total escrito en letras de verdad usa
  // varias palabras y no baja de mil en una rendición.
  if (consumidos < 2 || valor < 1000) return null;
  return valor;
}

function parsearTextoFactura(texto) {
  const t = texto.replace(/\s+/g, " ");

  // El RUT del EMISOR va antes que el del receptor en los dos formatos
  // probados. Se valida el dígito verificador (validarRut) para descartar
  // números que solo parecen RUT.
  //
  // Antes de eso se descartan los RUT del propio grupo: en toda factura que
  // recibimos aparece el nuestro como RECEPTOR, y en los formatos donde va
  // primero, "el primer RUT del texto" nos ponía a nosotros mismos como
  // proveedor. Eso no solo llena mal el campo: buscarCategoriaEnContabilidad
  // y buscarDatosPreviosPorRut salen a buscar el historial de ese RUT y
  // sugieren una categoría deducida de la entidad equivocada, y como la
  // lectura local igual "funcionó" (hay un RUT válido y un monto), nunca se
  // consulta a la IA para contrastar.
  const rutsPropios = new Set(Object.values(RUT_POR_EMPRESA).map((r) => r.replace(/[.\-]/g, "").toUpperCase()));
  // También se descarta el RUT rotulado como del COMPRADOR. En las boletas
  // de caja es habitual que el cliente dicte su RUT y quede impreso como
  // "RUT SOLICITANTE: 10.247.521-6"; ese RUT es válido (pasa el dígito
  // verificador) y venía antes que el del emisor, así que se tomaba como
  // proveedor. Medido sobre el archivo de Rindegastos: era la causa de
  // varios de los RUT equivocados, y arrastra consigo la categoría sugerida,
  // porque se le busca el historial contable a la entidad equivocada.
  const ETIQUETA_COMPRADOR = /(solicitante|cliente|comprador|receptor|se[nñ]or\(?e?s?\)?|adquirente)\s*:?\s*$/i;
  const ruts = [...t.matchAll(RE_RUT_EN_TEXTO)]
    .filter((m) => !ETIQUETA_COMPRADOR.test(t.slice(Math.max(0, m.index - 30), m.index).replace(/R\.?U\.?T\.?\s*:?\s*$/i, "").trim()))
    .map((m) => m[1].replace(/\s/g, ""))
    .filter((r) => validarRut(r))
    .filter((r) => !rutsPropios.has(r.replace(/[.\-]/g, "").toUpperCase()));

  let tipo_documento = null;
  // Las notas van PRIMERO y no es un detalle de orden: una nota de crédito
  // trae un bloque de referencias ("Referencia: Factura Electrónica N° ..."),
  // así que /FACTURA\s+ELECTR/ matchea igual y la NC entraba como factura.
  // Como "Nota de Crédito" no existe en TIPOS_DOCUMENTO, el select se quedaba
  // en su valor por defecto (Factura Electrónica) y el monto se cargaba
  // POSITIVO a la cuenta por pagar -- una nota que debía REBAJAR el pasivo
  // terminaba aumentándolo, con el signo al revés y sin aviso.
  if (/NOTA\s+DE\s+CR[EÉ]DITO/i.test(t)) tipo_documento = "Nota de Crédito";
  else if (/NOTA\s+DE\s+D[EÉ]BITO/i.test(t)) tipo_documento = "Nota de Débito";
  // "FACTURA NO AFECTA O EXENTA ELECTRÓNICA" es como el SII rotula las
  // exentas, y en la foto de una factura real de Correos el OCR dejó solo
  // "CURA EXENTA ELECTRÓNICA": se perdió la palabra FACTURA entera. Por eso
  // alcanza con que aparezca "EXENTA ELECTR", sin exigir lo de antes.
  else if (/FACTURA\s+EXENTA|EXENTA\s+ELECTR|NO\s+AFECTA\s+O\s+EXENTA|FACTURA\s+NO\s+AFECTA/i.test(t)) tipo_documento = "Factura Exenta Electrónica";
  else if (/FACTURA\s+ELECTR/i.test(t)) tipo_documento = "Factura Electrónica";
  else if (/BOLETA\s+DE\s+HONORARIO/i.test(t)) tipo_documento = "Boleta de Honorario";
  else if (/BOLETA\s+ELECTR/i.test(t)) tipo_documento = "Boleta Electrónica";
  // A partir de acá ya no son documentos tributarios electrónicos, y por eso
  // van al final: si el documento es un DTE, alguna de las reglas de arriba
  // ya ganó. Estos son los que se rinden por la pestaña Comprobante/Boleta y
  // que hasta ahora el lector no reconocía en absoluto, así que ni el tipo
  // ni el folio ni la fecha se sacaban de ellos.
  else if (/BOLETA\s+DE\s+VENTAS?(\s+Y\s+SERVICIOS?)?/i.test(t)) tipo_documento = "Boleta";
  // "Comprobante de Pago" va aparte de la transferencia: son cosas distintas.
  // Un comprobante de pago municipal (una multa, una patente) no tiene
  // proveedor ni RUT emisor impreso -- el único RUT del papel es el NUESTRO,
  // porque somos quienes pagamos. Meterlo en el mismo saco que una
  // transferencia bancaria confundía el tipo en pantalla.
  else if (/COMPROBANTE\s+DE\s+PAGO|TESORER[IÍ]A\s+MUNICIPAL/i.test(t)) tipo_documento = "Comprobante de Pago";
  else if (/COMPROBANTE\s+DE\s+TRANSFERENCIA|TRANSFERENCIA\s+(ELECTR[OÓ]NICA|EXITOSA|REALIZADA)|TRANSFERENCIA\s+A\s+TERCEROS/i.test(t)) tipo_documento = "Comprobante de Transferencia";
  else if (/COMPROBANTE\s+DE\s+DEP[OÓ]SITO/i.test(t)) tipo_documento = "Comprobante de Depósito";
  else if (/\bVOUCHER\b|COMPROBANTE\s+DE\s+VENTA|TRANSBANK|REDCOMPRA/i.test(t)) tipo_documento = "Voucher";
  else if (/\bRECIBO\b/i.test(t)) tipo_documento = "Recibo";
  else if (/\bBOLETA\b/i.test(t)) tipo_documento = "Boleta";
  // Las apps de los bancos no escriben "comprobante de transferencia" en
  // ninguna parte: la pantalla real de una transferencia hecha dice
  // "Operación realizada", "Monto", "Destinatario", "Cuenta Corriente". Se
  // reconoce por esa combinación, que ningún otro tipo de documento tiene.
  else if (/Destinatario/i.test(t) && /Cuenta\s+Corriente|Cuenta\s+Vista|Cuenta\s+RUT/i.test(t)) tipo_documento = "Comprobante de Transferencia";

  // Folio solo si viene con su etiqueta pegada ("N° 136982"). Cuando la
  // etiqueta quedó separada del número en el flujo de texto, se prefiere
  // dejarlo en blanco antes que adivinar: un folio equivocado en
  // contabilidad es peor que un campo vacío.
  //
  // Dos trampas que costaron folios equivocados y que explican por qué esto
  // no es un simple /N°\s*(\d+)/i:
  //  - Con el flag "i", la clase N[°ºo] también matchea la palabra "no".
  //    "Pago no 30 dias" devolvía folio 30. Por eso "No" va aparte y sin
  //    ignorar mayúsculas, y se exige que la N sea mayúscula.
  //  - Se tomaba el PRIMER match de todo el texto, y en el encabezado suelen
  //    venir antes la orden de compra ("Orden de compra No 4500123456") y la
  //    resolución del SII ("Res. Ex. N° 80 de 2014"). Ahora se descartan los
  //    números precedidos por esas etiquetas y se prefiere el que viene
  //    pegado al tipo de documento.
  // La "N" sola (sin ° ni º) está incluida porque el OCR de fotos pierde el
  // símbolo de grado muy seguido ("FACTURA ELECTRONICA N 136982"). Va en
  // mayúscula y sin flag "i" en esa alternativa: con "i" volvería a matchear
  // la palabra "no" y el folio sería cualquier número detrás de un "no".
  // Los documentos que no son DTE numeran con otras palabras: una
  // transferencia trae "N° de operación", un voucher un "código de
  // autorización". Sin estas etiquetas, el número identificador de esos
  // comprobantes no se leía nunca.
  // OJO: esta expresión NO lleva flag "i", y no es un descuido. Con "i", la
  // alternativa "No" matchea la palabra española "no" y cualquier número
  // detrás pasa por folio ("Pago no 30 dias" -> folio 30). Por eso las
  // etiquetas de varias palabras traen sus variantes de mayúscula escritas a
  // mano en vez de resolverse con el flag.
  // El "°" de "N°" es de lo que peor le sale al OCR de una foto: en dos
  // facturas reales salió como "N* 7960" y como "Ne 003191702". Por eso la
  // clase incluye esas confusiones además del símbolo correcto. Siguen
  // dependiendo de una N MAYÚSCULA, que es lo que impide que esto degenere
  // en "cualquier número precedido por la palabra no".
  const RE_FOLIO = /(N[°º*e]\.?|No\.?|N(?=\s+\d)|FOLIO|Folio|[NnPp][°º]?\s*[Dd][Ee]\s*[OoTtCcDd][a-zíóé]+|N[UÚuú]MERO\s+[Dd][Ee]\s+[A-Za-zíóé]+|C[oó]digo\s+[Dd][Ee]\s+[A-Za-zíóé]+)\s*:?\s*(\d{2,12})\b/g;
  const ANTES_NO_ES_FOLIO = /(orden\s+de\s+compra|nota\s+de\s+venta|res(?:oluci[oó]n)?\.?\s*ex\.?|cotizaci[oó]n|gu[ií]a\s+de\s+despacho|contrato|pago)\s*$/i;
  const candidatosFolio = [];
  for (const m of t.matchAll(RE_FOLIO)) {
    const contextoPrevio = t.slice(Math.max(0, m.index - 40), m.index);
    if (ANTES_NO_ES_FOLIO.test(contextoPrevio.trim())) continue;
    // Puros ceros no es un folio, es una casilla vacía del formulario o un
    // relleno que el OCR leyó como número. Salió en la foto de la factura de
    // Correos, que devolvía "00000000" como número de documento.
    if (/^0+$/.test(m[2])) continue;
    candidatosFolio.push({ valor: m[2], pegadoAlTipo: /(factura|boleta|documento)[^.]{0,30}$/i.test(contextoPrevio) });
  }
  const mFolio = candidatosFolio.find((c) => c.pegadoAlTipo) || candidatosFolio[0];

  // Los RUT se sacan del texto ANTES de buscar importes: si no, sus dígitos
  // se leen como pesos (77.574.911-3 daba un "monto" de $77.574.911).
  const sinRuts = t.replace(RE_RUT_EN_TEXTO, " ");
  const aNumero = (s) => Number(String(s).replace(/[.,]/g, ""));
  // Tres formas de escribir un importe. La del medio -- coma como separador
  // de MILES -- se agregó tras un comprobante de pago municipal real que
  // escribía el total "107,582": no matcheaba ninguna de las otras dos
  // ("107" son 3 dígitos, no 4+; y no hay punto), así que el documento
  // entero se descartaba por quedarse sin monto.
  //
  // Es segura en pesos chilenos porque el grupo tiene que ser de EXACTAMENTE
  // tres dígitos: un decimal de verdad ("8,50") no matchea, y el peso no usa
  // centavos en la práctica. El orden también importa: la alternativa con
  // puntos va primera para que "13.650,42" se lea 13650 y no 1365042.
  const RE_MONTO = "(\\d{1,3}(?:\\.\\d{3})+|\\d{1,3}(?:,\\d{3})+|\\d{4,})";

  // 1) La mejor fuente: el total CONFIRMADO por la propia aritmética del
  //    documento (neto + IVA = total, con el IVA al 19%). Cuando ese trío
  //    aparece, el monto deja de ser una heurística -- queda verificado
  //    contra los subtotales de la factura, que es justo lo que hace falta
  //    para un dato que termina en contabilidad.
  //    OJO con el conjunto de candidatos: si se le pasan TODOS los números
  //    del texto, la aritmética encuentra tríos por casualidad. Con los
  //    números de referencia típicos de una factura real
  //    ({136982, 115277, 21705, ...}) se cumple 136982 - 115277 = 21705 y
  //    round(115277 * 0.19) = 21903, que cae dentro de la tolerancia: tres
  //    folios pasan por neto+IVA=total y devuelven $136.982 como monto. Y es
  //    peor que un mal número suelto, porque queda marcado como VERIFICADO:
  //    se le muestra a la persona "monto confirmado" y encima se salta el
  //    contraste con la IA, que era justo la red de seguridad. Por eso solo
  //    entran importes con "$" delante o pegados a una etiqueta de subtotal.
  const RE_IMPORTE_CREIBLE = new RegExp(`(?:\\$\\s*|(?:neto|iva|i\\.v\\.a\\.|afecto|exento|subtotal|total|monto)\\W{0,12})${RE_MONTO}\\b`, "gi");
  const todosLosImportes = [...sinRuts.matchAll(RE_IMPORTE_CREIBLE)]
    .map((m) => aNumero(m[1]))
    .filter((n) => n >= 1000);
  const verificado = totalPorNetoMasIva(todosLosImportes);
  let monto = verificado ? verificado.total : null;
  // De DÓNDE salió el monto, que importa tanto como el monto mismo:
  //   "aritmetica" -> neto + IVA cuadran con el total. Certeza.
  //   "etiqueta"   -> venía pegado a un "TOTAL". Evidencia fuerte.
  //   "maximo"     -> el mayor importe con $. Una CONJETURA, y sobre una
  //                   foto es peligrosa: en la factura fotografiada de
  //                   Supletech el total real ni siquiera se alcanzó a leer,
  //                   así que este paso eligió el subtotal de una línea
  //                   ($273.008 en vez de $350.874) con toda naturalidad.
  // leerFotoLocal usa esto para aceptar solo las dos primeras. En un PDF,
  // donde el texto es exacto, las tres siguen valiendo.
  let monto_origen = verificado ? "aritmetica" : null;

  // 2) Si no cuadra (factura exenta, sin IVA, o subtotales ilegibles), el
  //    importe etiquetado "Total $". El \\$ es obligatorio y "total" va como
  //    palabra propia: sin eso matcheaba "SUBTOTAL 1577" (un SKU) y
  //    "Total 2.40 CLF" (texto de una glosa).
  //    Las etiquetas van más allá de "total" a propósito: una boleta, un
  //    comprobante de transferencia o un recibo no dicen "TOTAL" ni traen
  //    desglose de IVA, y son justamente los documentos donde este paso es
  //    la ÚNICA evidencia fuerte disponible (el paso 1 nunca va a aplicar).
  if (!monto) {
    const ETIQUETAS_TOTAL = String.raw`total(?:\s*a\s*pagar|\s*boleta)?|monto(?:\s*(?:transferido|total|a\s*pagar|de\s*la\s*transferencia))?|valor\s*total|importe(?:\s*total)?|a\s*pagar|neto\s*a\s*pagar|te\s*transfiri[oó]|valores?`;
    const mTotal = new RegExp(`(?:^|[^a-záéíóúñ])(?:${ETIQUETAS_TOTAL})\\s*\\(?\\s*\\$?\\s*\\)?\\s*:?\\s*\\$?\\s*${RE_MONTO}`, "i").exec(sinRuts);
    monto = mTotal ? aNumero(mTotal[1]) : null;
    if (monto) monto_origen = "etiqueta";
  }
  // 3) Último recurso: si la etiqueta quedó lejos de su valor (pasa en el
  //    formato bsale), el mayor importe CON SIGNO $ del documento. El "$" es
  //    clave: sin él ganaba un número de referencia de la sección
  //    "Referencias a otros Documentos", que era más grande que el total.
  //    El ":?" cubre los formatos que escriben "Neto $ : 98.103".
  if (!monto) {
    const candidatos = [...sinRuts.matchAll(new RegExp(`\\$\\s*:?\\s*${RE_MONTO}`, "g"))]
      .map((m) => aNumero(m[1]))
      .filter((n) => n >= 1000);
    monto = candidatos.length ? Math.max(...candidatos) : null;
    if (monto) monto_origen = "maximo";
  }

  // Todo lo anterior da por sentado que los importes están en pesos. Si el
  // documento está en otra moneda, "US$ 1.500" se lee como $1.500 y la
  // diferencia no la nota nadie: el campo queda con un número creíble. Ante
  // una moneda extranjera cerca de un importe se abandona la lectura local
  // (monto = null) y el comprobante cae al camino de la IA, que sí ve el
  // símbolo en la imagen. El chequeo va acá y no antes porque solo importa
  // cuando efectivamente se encontró un monto que reportar.
  // El total en letras le GANA a los dígitos, y no es arbitrario: las letras
  // tienen que formar un número válido en español para parsearse, así que un
  // error de OCR ahí se detecta solo; un dígito mal leído no se detecta de
  // ninguna forma. Si además coinciden, el monto queda confirmado con la
  // misma fuerza que neto + IVA: son dos codificaciones independientes del
  // mismo número dentro del propio documento.
  const enPalabras = montoDesdePalabras(sinRuts);
  if (enPalabras) {
    if (monto === enPalabras) {
      monto_origen = "palabras+digitos";
    } else {
      // Desacuerdo. Las letras SON más confiables (se autoverifican), pero
      // preferirlas en silencio igual significaría elegir por la persona con
      // un documento que se contradice a sí mismo -- y un parseo de letras
      // con una palabra mal leída en el medio puede dar un número plausible
      // y equivocado. Se marca la discrepancia y el filtro de fotos lo
      // rechaza: en una foto el monto queda en blanco y lo escribe la
      // persona. En un PDF el texto es exacto, así que se conserva el valor
      // de los dígitos.
      monto_origen = "discrepancia";
    }
  }

  let montoConfirmado = !!verificado || monto_origen === "palabras+digitos";
  if (monto && /(US\$|USD|EUR|€|\bUF\b|\bCLF\b|\bUTM\b)\W{0,15}\d|\d\W{0,8}(USD|EUR|\bUF\b|\bCLF\b|\bUTM\b)/i.test(sinRuts)) {
    monto = null;
    montoConfirmado = false; // sin monto no hay nada que declarar verificado
  }

  let fecha = null;
  // Prefiere emisión: vencimiento puede aparecer antes y corresponder a otro año.
  const emision=/(?:fecha\s*(?:de\s*)?emisi[oó]n|emitid[ao]\s*(?:el)?)\s*:?\s*(\d{1,2}(?:[/-]\d{1,2}[/-]\d{4}|\s+de\s+[a-záéíóú]+\s+(?:del?\s+)?\d{4}))/i.exec(t);
  const textoFecha=emision?.[1] || t;
  const mNum = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(textoFecha);
  const mTxt = /\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:del?\s+)?(\d{4})\b/i.exec(textoFecha);
  const iso = (a, m, d) => `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (mNum) fecha = iso(mNum[3], mNum[2], mNum[1]);
  else if (mTxt && MESES_ES[mTxt[2].toLowerCase()]) fecha = iso(mTxt[3], MESES_ES[mTxt[2].toLowerCase()], mTxt[1]);

  return {
    // Normalmente se resuelve por RUT contra contabilidad, que es más
    // confiable que leerlo del documento. Pero hay comprobantes que no traen
    // RUT en absoluto -- una transferencia bancaria no identifica
    // tributariamente a quien recibe la plata, solo lo nombra. Para esos, el
    // nombre leído es lo único que hay, y alcanza para buscarle el historial
    // por nombre y sugerir una categoría. En la fusión igual pierde contra
    // la razón social real de contabilidad cuando sí hay RUT.
    nombre_proveedor: nombreDesdeEtiqueta(t),
    rut_proveedor: ruts[0] || null,
    tipo_documento,
    nro_documento: mFolio ? mFolio.valor : null,
    // "tipo" = venía pegado al tipo de documento (evidencia fuerte);
    // "suelto" = un número con etiqueta N° en cualquier parte del papel.
    folio_origen: mFolio ? (mFolio.pegadoAlTipo ? "tipo" : "suelto") : null,
    fecha,
    monto,
    // true solo cuando el monto se confirmó con neto + IVA = total. Se usa
    // para decirle a la persona qué revisar: un monto verificado no necesita
    // segunda mirada, uno deducido sí.
    monto_verificado: montoConfirmado,
    monto_origen,
    // El total leído EN LETRAS, cuando existe. leerFotoLocal lo prefiere
    // ante una discrepancia con los dígitos: es el único que se autoverifica.
    monto_en_palabras: enPalabras || null,
    descripcion: descripcionDesdeDetalle(t),
    categoria_sugerida: null,
  };
}

// Busca el trío neto + IVA = total entre los importes del documento, con el
// IVA al 19% (tolerancia por redondeo). Es la única forma de CONFIRMAR el
// monto en vez de deducirlo: si los tres números cuadran entre sí, no hay
// ambigüedad posible sobre cuál era el total. Devuelve null en facturas
// exentas (sin IVA) o si los subtotales no se pudieron leer, y ahí se cae a
// las heurísticas de siempre.
function totalPorNetoMasIva(importes) {
  const valores = [...new Set(importes)].sort((a, b) => a - b);
  let mejor = null;
  for (const total of valores) {
    for (const neto of valores) {
      if (neto >= total) continue;
      const iva = total - neto;
      if (!valores.includes(iva)) continue;
      const ivaEsperado = Math.round(neto * 0.19);
      // Tolerancia de 2 PESOS, no de un porcentaje. Antes era
      // max(2, ivaEsperado * 0.01): para un IVA de $2.700 eso daba 27 pesos
      // de margen, y ese margen alcanzaba para que un total mal leído
      // encontrara un neto que lo respaldara. Medido sobre el archivo de
      // Rindegastos: un comprobante de $16.940 se leyó $16.960 y pasó como
      // CONFIRMADO por aritmética, que es el peor resultado posible -- el
      // sello de confianza puesto sobre un número equivocado.
      //
      // El IVA chileno es round(neto * 0.19) exacto al peso; la holgura solo
      // existe para absorber cómo redondea cada emisor, y eso nunca son
      // decenas de pesos. Apretarlo no pierde facturas buenas y saca de
      // circulación las coincidencias.
      if (Math.abs(iva - ivaEsperado) > 2) continue;
      if (!mejor || total > mejor.total) mejor = { total, neto, iva };
    }
  }
  return mejor;
}

// ============================================================
// UN LECTOR, DOS FUENTES
// ------------------------------------------------------------
// Antes había DOS caminos paralelos y excluyentes: si la lectura local
// devolvía algo se aplicaba y la IA no se llamaba nunca (salvo para
// contrastar el monto), y si devolvía null todo venía de la IA. El
// resultado era que un PDF que sí se leía local pero al que le faltaba el
// folio, o cuya descripción quedaba en null, dejaba esos campos VACÍOS
// aunque la IA los habría podido leer.
//
// Ahora los dos caminos terminan en la misma función de fusión
// (fusionarLecturas) y la IA es una segunda fuente que solo rellena huecos.
// El tope de UNA llamada por comprobante no es negociable: la cuota gratuita
// de Gemini es de ~20 solicitudes POR MODELO AL DÍA, el usuario decidió no
// pagar, y ya hubo un día entero sin OCR porque la propia maquinaria de
// reintentos se la comió sola. Cuando la lectura local dejó todo lleno y la
// aritmética confirmó el monto, se gastan CERO llamadas.
// ============================================================

// Los campos que conoce la fusión, por formulario. "Documento electrónico"
// los tiene todos; "Gasto directo" solo muestra proveedor, descripción,
// monto y categoría, así que pedirle a la IA lo que ese formulario ni
// siquiera puede mostrar sería gastar cuota para nada.
const CAMPOS_OCR_CON = ["nombre_proveedor", "rut_proveedor", "tipo_documento", "nro_documento", "fecha", "monto", "descripcion", "categoria_sugerida"];
const CAMPOS_OCR_SIN = ["nombre_proveedor", "rut_proveedor", "tipo_documento", "nro_documento", "fecha", "monto", "descripcion", "categoria_sugerida"];

// Solo para el mensaje que se le muestra a la persona: los nombres internos
// ("nro_documento") no significan nada para quien está rindiendo.
const ETIQUETA_CAMPO_OCR = {
  nombre_proveedor: "proveedor",
  rut_proveedor: "RUT",
  tipo_documento: "tipo de documento",
  nro_documento: "folio",
  fecha: "fecha",
  monto: "monto",
  descripcion: "descripción",
  categoria_sugerida: "categoría",
};

// Todo lo que se puede saber de un RUT sin gastar una sola solicitud de
// Gemini: razón social real, categoría con la que contabilidad registró
// antes a este proveedor, y qué se cargó la última vez en la propia app.
// Van juntas y en paralelo porque son independientes entre sí y el
// formulario está esperando.
// La categoría que esta persona usó más veces para un proveedor, buscando
// por NOMBRE. Es más débil que la que sale de contabilidad por RUT (la
// comparación es por texto, y el mismo local puede escribirse de dos formas),
// así que se exige haberlo clasificado al menos dos veces antes de sugerir
// algo: con una sola vez es una coincidencia, no un patrón.
async function categoriaMasUsadaPorNombre(nombre) {
  try {
    const historial = await buscarHistorialCategoriasProveedor(nombre);
    if (!historial || historial.length < 2) return null;
    const conteo = {};
    historial.forEach((h) => { if (h.categoria) conteo[h.categoria] = (conteo[h.categoria] || 0) + 1; });
    const top = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  } catch (err) {
    console.error("No se pudo buscar el historial por nombre:", err);
    return null;
  }
}

async function resolverDatosContables(rut, nombre) {
  const vacio = { rut: null, nombre_proveedor: null, categoria: null, descripcion: null, desdeContabilidad: false };
  // Sin RUT no hay a quién buscarle el historial contable, pero eso no
  // significa que no se pueda sugerir nada: los comprobantes que no son DTE
  // (transferencias, vouchers) no traen RUT NUNCA, y antes quedaban sin
  // proveedor ni categoría por definición, no por no haberse leído bien.
  // Con el nombre alcanza para mirar cómo clasificó esta misma persona
  // compras anteriores al mismo destinatario.
  if (!rut) return nombre ? { ...vacio, nombre_proveedor: nombre, categoria: await categoriaMasUsadaPorNombre(nombre) } : vacio;
  // El RUT se normaliza ANTES de consultar: la lectura local lo saca con
  // puntos ("77.574.911-3") y la IA suele devolverlo pelado ("77574911-3"),
  // pero las dos bases lo guardan en la forma con puntos (es la que escribe
  // aplicarResultadoOcrCon). Sin esto, el mismo proveedor encontraba
  // historial cuando venía del PDF y no cuando venía de una foto.
  const rutFormateado = formatearRut(rut);
  const [razonSocial, categoriaContable, previos] = await Promise.all([
    buscarNombreProveedorPorRut(rutFormateado),
    buscarCategoriaEnContabilidad(rutFormateado),
    buscarDatosPreviosPorRut(rutFormateado),
  ]);
  return {
    rut: rutFormateado,
    // La razón social real de contabilidad le gana al nombre leído del
    // documento; si el RUT no está en contabilidad, queda el leído.
    nombre_proveedor: razonSocial || nombre || null,
    categoria: categoriaContable || previos.categoria,
    descripcion: previos.descripcion,
    // Se distingue la categoría que sale de la CONTABILIDAD REAL (años de
    // asientos) de la que sale del historial de la app, porque el mensaje
    // que ve la persona dice de dónde viene y eso cambia cuánto confiar.
    desdeContabilidad: !!categoriaContable,
  };
}

// Campos que quedaron sin valor después de la lectura local + contabilidad.
function camposFaltantesOcr(datos, campos) {
  return campos.filter((c) => !datos || !datos[c]);
}

// Lo que se le pide a la IA: los campos faltantes, MÁS el monto cuando la
// aritmética del documento no lo pudo confirmar. El monto ahí no está
// técnicamente "faltando" (hay un número), pero es el dato que más caro sale
// equivocado, así que vale la pena que la única llamada que tenemos también
// traiga una segunda lectura suya para contrastar -- que es exactamente lo
// que hacía contrastarMontoConIA antes de integrarse a la fusión. Si la
// aritmética ya lo confirmó no se pide: no hay nada que contrastar.
function camposAPedirOcr(datos, campos) {
  const faltan = camposFaltantesOcr(datos, campos);
  if (campos.includes("monto") && datos && datos.monto && !datos.monto_verificado && !faltan.includes("monto")) faltan.push("monto");
  return faltan;
}

// Qué campos JUSTIFICAN gastar una solicitud de Gemini, que es distinto de
// qué campos se le piden. Los que están acá salen del documento y son caros
// de equivocar o latosos de tipear a mano; los que NO están (nombre del
// proveedor, descripción, categoría) son comodidades que la persona
// completa en segundos y que casi siempre resuelve contabilidad gratis.
//
// La distinción no es un refinamiento: sin ella este cambio AUMENTABA el
// consumo en vez de mantenerlo. Antes se llamaba a la IA solo cuando la
// aritmética no confirmaba el monto; con la fusión, un proveedor nuevo sin
// historial deja vacíos nombre, categoría y descripción, y eso habría
// disparado una llamada en un caso donde antes había cero. Con un techo de
// ~20 solicitudes por modelo al día, esa diferencia se nota el mismo día.
const CAMPOS_QUE_JUSTIFICAN_IA = new Set(["rut_proveedor", "monto", "nro_documento", "fecha", "tipo_documento"]);

// Se le pide TODO lo que falta (los campos extra salen gratis en la misma
// solicitud), pero solo se gasta la solicitud si falta algo sustantivo.
function valeLaPenaLlamarIA(pedidos) {
  return pedidos.some((c) => CAMPOS_QUE_JUSTIFICAN_IA.has(c));
}

// Lo que la lectura local SÍ obtuvo, para mandárselo a ocr-recibo y que no
// tenga que adivinar de nuevo lo que ya sabemos (contrato acordado con el
// lado servidor).
function datosParcialesOcr(datos) {
  const out = {};
  if (!datos) return out;
  CAMPOS_OCR_CON.forEach((c) => { if (datos[c]) out[c] = datos[c]; });
  return out;
}

// LA función de fusión: todo lo que termina en los campos del formulario
// pasa por acá, venga de la lectura local, de contabilidad o de la IA.
//
// La precedencia no es un gusto, sale de cuán determinista es cada fuente:
//  - RUT, tipo, folio y fecha salen del TEXTO del documento, así que lo
//    local gana siempre que exista; la IA (que interpreta una imagen) solo
//    rellena huecos.
//  - Nombre, categoría y descripción no están en el texto, o están peor que
//    en el historial: contabilidad primero, IA después, local al final.
//  - El monto NUNCA se cambia solo. Si las dos fuentes coinciden queda
//    confirmado; si difieren se avisa y se deja el local, porque cuál es el
//    correcto lo decide la persona mirando la factura.
//
// Devuelve tres cosas:
//  - datos: la fusión completa, para aplicar cuando no se aplicó nada aún.
//  - aporteIA: SOLO los campos que puso la IA. Es lo que se aplica en la
//    segunda pasada -- repisar los campos locales 20 segundos después
//    borraría lo que la persona haya corregido a mano mientras esperaba.
//  - avisos: lo que hay que decirle a la persona sobre el monto.
function fusionarLecturas(local, ia, contable) {
  const L = local || {};
  const I = ia || {};
  const C = contable || {};
  const datos = {};
  const aporteIA = {};
  const avisos = [];
  const conflictos = new Set((Array.isArray(I.campos_discrepantes) ? I.campos_discrepantes : []).filter(c => ["rut_proveedor","tipo_documento","nro_documento","fecha","monto"].includes(c)));

  // Determinista primero: lo local manda, la IA solo rellena.
  ["rut_proveedor", "tipo_documento", "nro_documento", "fecha"].forEach((campo) => {
    datos[campo] = L[campo] || I[campo] || null;
    if (!L[campo] && I[campo]) aporteIA[campo] = I[campo];
    const normalizar = v => campo === "rut_proveedor" ? String(v).replace(/[^0-9kK]/g,"").toUpperCase() : campo === "nro_documento" ? String(v).trim().replace(/^0+(?=\d)/,"") : String(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLowerCase();
    const revision=I.verificacion_campos?.[campo];
    if ((L[campo] && I[campo] && normalizar(L[campo])!==normalizar(I[campo])) || (revision?.estado === "por_confirmar" && /discrepan|contradict/i.test(revision.motivo || ""))) {
      conflictos.add(campo);
      avisos.push({ok:false,texto:"Hay lecturas contradictorias del campo "+campo+". Confirma el valor mirando el comprobante."});
    }
  });

  // Contabilidad manda: son datos de personas y de asientos reales, no de
  // un modelo mirando una imagen.
  [["nombre_proveedor", C.nombre_proveedor], ["descripcion", C.descripcion], ["categoria_sugerida", C.categoria]].forEach(([campo, valorContable]) => {
    datos[campo] = valorContable || I[campo] || L[campo] || null;
    if (!valorContable && I[campo] && I[campo] !== L[campo]) aporteIA[campo] = I[campo];
  });

  // El monto pasa por montoValidoCLP a propósito: es el último filtro antes
  // de que un número de afuera aterrice en un campo que va a contabilidad.
  const montoLocal = montoValidoCLP(L.monto);
  const montoIA = montoValidoCLP(I.monto);
  datos.monto = montoLocal || montoIA || null;
  // La IA también puede traer el monto confirmado: ocr-recibo le pide el
  // total EN LETRAS tal como está impreso y lo contrasta contra los dígitos
  // del lado del servidor (ver montoDesdePalabras en _shared/gemini-ocr.ts).
  // Antes ese camino no pasaba por ninguna verificación -- se consumía el
  // JSON del modelo tal cual -- así que era el único sin red.
  datos.monto_verificado = !!L.monto_verificado || (!montoLocal && !!I.monto_verificado);
  if (montoLocal && montoIA) {
    if (montoLocal === montoIA) {
      // Dos lectores independientes que coinciden son mucha más evidencia
      // que uno solo: el monto queda tan confirmado como por aritmética.
      datos.monto_verificado = true;
      avisos.push({ ok: true, texto: `Monto confirmado: la IA leyó el mismo total (${fmtCLP(montoLocal)}).` });
    } else {
      datos.monto = null; datos.monto_verificado = false; datos.monto_discrepante = true;
      avisos.push({ ok: false, texto: `⚠ Ojo con el monto: del texto del PDF se leyó ${fmtCLP(montoLocal)}, pero la IA leyó ${fmtCLP(montoIA)}. Se requiere confirmación del monto mirando la factura antes de enviar.` });
    }
  } else if (!montoLocal && montoIA) {
    aporteIA.monto = montoIA;
  }

  if (L.monto_discrepante || I.monto_discrepante || datos.monto_discrepante) {
    datos.monto=null; datos.monto_verificado=false; datos.monto_discrepante=true;
    aporteIA.monto=null; aporteIA.monto_discrepante=true; aporteIA.monto_verificado=false;
    if (!avisos.some(a => !a.ok)) avisos.push({ok:false,texto:"El comprobante contiene montos contradictorios. Confirma el total mirando el documento antes de enviar."});
  }
  if (datos.monto_discrepante) conflictos.add("monto");
  for(const campo of conflictos){datos[campo]=null;aporteIA[campo]=null;}
  if(conflictos.size){datos.campos_discrepantes=[...conflictos];aporteIA.campos_discrepantes=[...conflictos];}
  if (I.requiere_separacion) {datos.requiere_separacion=true; datos.aviso_documento=I.aviso_documento || "Este archivo requiere separar los comprobantes por gasto."; aporteIA.requiere_separacion=true; aporteIA.aviso_documento=datos.aviso_documento;}
  if (Array.isArray(L.confianza_baja)) datos.confianza_baja=[...L.confianza_baja];
  if (L.verificacion_campos || I.verificacion_campos) datos.verificacion_campos={...(L.verificacion_campos || {}),...(I.verificacion_campos || {})};
  if (I.verificacion_campos) aporteIA.verificacion_campos=I.verificacion_campos;
  if (I.analisis_documento) datos.analisis_documento = I.analisis_documento;
  if (I.proveedor_lectura) datos.proveedor_lectura = I.proveedor_lectura;
  return { datos, aporteIA, avisos };
}

// La ÚNICA llamada a la IA del camino con lectura local, y solo cuando
// quedaron huecos. Corre en segundo plano a propósito: los campos locales ya
// están en pantalla, nadie tiene que mirar un spinner 15-25s para recién ver
// algo. Si falla (cuota agotada, timeout) no se alarma a nadie ni se muestra
// el botón de reintento -- lo local ya sirve para enviar la rendición.
async function completarConIA({ id, file, gen, statusEl, local, contable, datos, campos, aplicar, textoBase }) {
  try {
    const ia = await llamarOcrRecibo(file, camposAPedirOcr(datos, campos), datosParcialesOcr(datos), campos === CAMPOS_OCR_CON ? "ConDocumento" : "SinDocumento");
    // Re-chequeo OBLIGATORIO después de CADA await, y con "return": mientras
    // la IA respondía, la persona pudo adjuntar otro comprobante. Si esto
    // sigue de largo, deja el ítem con datos de dos documentos distintos.
    if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;

    // Si el RUT lo aportó la IA (el PDF tenía texto pero no un RUT legible),
    // recién ahora se le puede preguntar a contabilidad por ese proveedor.
    let contableFinal = contable;
    if (!contableFinal || !contableFinal.rut) {
      if (ia && ia.rut_proveedor) {
        contableFinal = await resolverDatosContables(ia.rut_proveedor, ia.nombre_proveedor || local?.nombre_proveedor);
        if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;
      }
    }

    const { datos: fusion, aporteIA, avisos } = fusionarLecturas(local, ia, contableFinal);
    mostrarVerificacionOcr(id, ia);
    const revisionAplicada = await aplicar(id, aporteIA, gen);
    if (revisionAplicada?.estado === "requiere_separacion" || revisionAplicada?.estado === "obsoleto") return;
    if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;
    // La IA aportó algo: queda registrado como origen mixto. Y el monto pudo
    // pasar a confirmado justo acá, si los dos lectores leyeron el mismo
    // total -- dos fuentes independientes que coinciden valen tanto como la
    // aritmética del documento.
    registrarOrigenOcr(id, local ? "local+ia" : "ia", fusion);
    if(ia.previaId)dispararAgenteYEsperar(id,ia.previaId,gen,(data,g)=>aplicar(id,data,g),statusEl);

    // Una discrepancia de monto se come el mensaje entero: es lo único que
    // hay que mirar antes de enviar, y mezclarlo con "la IA completó el
    // folio" lo esconde.
    const problema = avisos.find((a) => !a.ok);
    if (problema) {
      statusEl.textContent = problema.texto;
      statusEl.className = "ocr-status show err";
      return;
    }
    const llenados = Object.keys(aporteIA).filter((c) => campos.includes(c)).map((c) => ETIQUETA_CAMPO_OCR[c] || c);
    const extra = (llenados.length ? ` La IA completó lo que faltaba: ${llenados.join(", ")}.` : "")
      + avisos.map((a) => ` ${a.texto}`).join("");
    statusEl.textContent = `${textoBase}${extra} ${revisionAplicada?.mensaje || ""}`;
    statusEl.className = "ocr-status show " + (revisionAplicada?.estado === "completo" ? "ok" : "err");
  } catch (err) {
    if (err.noReintentar && esGeneracionVigenteOcr(id,gen)) {ocrBloqueado.add(id);statusEl.textContent=err.message;statusEl.className="ocr-status show err";return;}
    // Que falle la segunda fuente no es un problema: la lectura local ya
    // llenó los campos. Se registra y se sigue, sin alarmar a nadie.
    console.error("No se pudieron completar los campos faltantes con la IA:", err);
  }
}

// Etiquetas que forman la fila de encabezado de la tabla de detalle. Se usan
// para dos cosas: saber dónde empieza el detalle y limpiar los restos que
// queden mezclados con los productos.
// "Impto Adic." y "Desc. Valor" se agregaron después de probar contra una
// factura real guardada (importadora FA DA 9): el resto de la cabecera se
// limpiaba bien, pero esas dos columnas sobrevivían y la descripción salía
// "%Impto Adic.* %Desc. Valor - ARTICULOS VARIOS" en vez de los productos.
const CABECERA_DETALLE = String.raw`(?:SKU|ITEM|Item|Detalle|Descripci[oó]n|VALOR\s*UNITARIO|P\.?\s*unitario|Precio|CANTIDAD|Cant\.?|%?\s*Desc(?:uento|\.)?(?:\s*Valor)?|%?\s*Impto\.?\s*Adic\.?\*?|SUBTOTAL|Total\s*item)`;

// Descripción sacada del detalle del propio documento (lo que se compró).
// Ojo con el encabezado: hay que consumirlo ENTERO antes de capturar, porque
// si no, el "SUBTOTAL" que forma parte del propio encabezado corta la
// captura antes de llegar a los productos (probado: devolvía "% Descuento").
function descripcionDesdeDetalle(texto) {
  const re = new RegExp(
    // "Forma de Pago" se sumó a los cortes tras probar contra una factura
    // real (importadora FA DA 9): venía después del detalle y antes de los
    // totales, así que la captura seguía de largo y la descripción terminaba
    // en "...Forma de Pago:Crédito".
    String.raw`\b(?:ITEM|Item|Detalle|Descripci[oó]n)\b(?:\s*${CABECERA_DETALLE})*(.{0,500}?)(?:Neto|NETO|Total\s*\$|TOTAL\s*\(|I\.V\.A|IVA\s*\(|Timbre|Son:|Referencias|Forma\s+de\s+Pago)`,
    "is"
  );
  const m = re.exec(texto);
  if (!m) return null;
  let z = m[1]
    // Las etiquetas de cabecera se quitan PRIMERO, antes que los números.
    // Al revés no alcanza: quitar "%Desc." deja pegados dos fragmentos que
    // por separado ya habían pasado el filtro numérico ("20 %Desc. ,33" ->
    // "20 ,33"), y esa cola aparecía en la descripción de una factura real.
    .replace(new RegExp(CABECERA_DETALLE, "gi"), " ")
    .replace(/\$\s*[\d.,]+/g, " ")
    .replace(/\b\d+[.,]\d+\s*%/g, " ")
    // Un importe con miles Y decimales es UN solo token: "1.819,33". Antes
    // se quitaban por separado los miles y los decimales, y sobre una
    // factura real ("- ARTICULOS VARIOS 20 1.819,33 36.387") eso se comía
    // "1.819" y dejaba ",33" suelto pegado a la descripción. La coma
    // decimal tiene que estar en la MISMA alternativa que los puntos de mil.
    .replace(/\b\d{1,3}(?:\.\d{3})+(?:,\d+)?\b|\b\d+,\d+\b/g, " ")
    // Rachas de dos o más números sueltos son columnas de la tabla
    // (cantidad, código del ítem siguiente). Un número solo se respeta:
    // suele ser parte del producto ("1kg", "2 lbs").
    // OJO: acá NO se puede usar lookbehind ((?<=\s)). Los literales de regex
    // se validan al PARSEAR el archivo, así que un lookbehind en un
    // navegador que no lo soporta no rompe esta función: rompe app.js
    // entero, y la app queda muerta (pantalla en blanco) para esa persona.
    // Safari recién lo soporta desde la 16.4 y acá hay gente rindiendo
    // desde iPhones viejos. Se captura el separador y se devuelve.
    .replace(/(^|\s)\d+(?:\s+\d+)+(?=\s|$)/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-·,.|]+|[\s\-·,.|]+$/g, "")
    .replace(/^\d+\s+/, "") // código/SKU suelto al principio
    // ...y la cantidad suelta al final, que es lo que queda de la fila una
    // vez quitados los importes ("ARTICULOS VARIOS 20"). Un producto que
    // termina de verdad en un número es raro; una columna sobrante, no.
    .replace(/[\s,.]*\b\d+\s*$/, "")
    .trim();
  if (z.length < 8) return null;
  if (z.length > 110) z = z.slice(0, 110).replace(/\s+\S*$/, "") + "…"; // cortar en palabra entera, no a la mitad
  return z;
}

// Sugerencias SIN IA sacadas del historial real de ESTE MISMO RUT: qué
// categoría y qué descripción se usaron antes para facturas del mismo
// proveedor. Para un proveedor recurrente esto es más confiable que lo que
// pueda deducir un modelo mirando el documento, y la categoría además
// alimenta la sugerencia de cuenta contable que ve el aprobador (ver
// actualizarSugerenciaCuenta en iniciarEdicionItem).
async function buscarDatosPreviosPorRut(rutProveedor) {
  if (!rutProveedor) return { categoria: null, descripcion: null };
  const { data, error } = await db
    .from("rendicion_items")
    .select("categoria, descripcion")
    .eq("rut_proveedor", rutProveedor)
    .order("id", { ascending: false })
    .limit(20);
  if (error || !data?.length) return { categoria: null, descripcion: null };

  // Categoría: la más usada (si hay empate gana la más reciente, por el
  // orden de la consulta). Puede venir toda en null -- los ítems "Documento
  // electrónico" no tenían este campo hasta hace poco, así que para
  // proveedores cargados antes de eso simplemente todavía no hay qué sugerir.
  const conteo = {};
  data.forEach((d) => { if (d.categoria) conteo[d.categoria] = (conteo[d.categoria] || 0) + 1; });
  const categoria = Object.keys(conteo).length
    ? Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  // Descripción: la del ítem más reciente, no la más repetida -- si a este
  // proveedor se le compran cosas distintas, la última es la referencia más
  // útil para editarla encima.
  const descripcion = data.find((d) => d.descripcion && d.descripcion.trim())?.descripcion || null;

  return { categoria, descripcion };
}

// Categoría deducida de la CONTABILIDAD REAL: con qué cuenta de gasto se
// contabilizó históricamente a este proveedor. Es la mejor fuente que hay --
// son años de asientos hechos por el área contable, contra los pocos ítems
// que pueda tener la app.
//
// El detalle importante: filtrar movimientos por el RUT del proveedor NO
// devuelve la cuenta de gasto. Por partida doble, la compra genera dos
// líneas -- el gasto (4.01.03.xx) y el pasivo (2.01.07.01 Proveedores
// Nacionales) -- y solo esta última lleva la ficha del proveedor. Hay que
// saltar del proveedor a su comprobante, y del comprobante a la línea de
// gasto del mismo asiento. Además el número de comprobante se repite entre
// empresas, así que hay que cruzar por empresa también o se mezclan asientos
// ajenos (probado: sin ese filtro aparecían "Banco Santander" y "Comisión
// Transbank" de otras empresas).
const cacheCategoriaContable = new Map();

async function buscarCategoriaEnContabilidad(rut) {
  if (!rut || !dbContabilidad) return null;
  if (cacheCategoriaContable.has(rut)) return cacheCategoriaContable.get(rut);
  try {
    const { data: lineasProveedor } = await dbContabilidad
      .from("movimientos")
      .select(`${MOVIMIENTOS_COLS.comprobante}, ${MOVIMIENTOS_COLS.empresa}`)
      .eq(MOVIMIENTOS_COLS.rutFicha, rut)
      .not(MOVIMIENTOS_COLS.comprobante, "is", null)
      .limit(25);
    if (!lineasProveedor?.length) { cacheCategoriaContable.set(rut, null); return null; }

    const comprobantesPorEmpresa = {};
    lineasProveedor.forEach((l) => {
      const empresa = l[MOVIMIENTOS_COLS.empresa];
      (comprobantesPorEmpresa[empresa] ||= new Set()).add(l[MOVIMIENTOS_COLS.comprobante]);
    });

    // En paralelo, no en serie: un proveedor puede aparecer en varias de las
    // ~10 empresas del grupo, y encadenar una consulta por cada una hace que
    // el formulario espere de más justo cuando se cargan varias facturas.
    const resultados = await Promise.all(
      Object.entries(comprobantesPorEmpresa).map(([empresa, comprobantes]) =>
        dbContabilidad
          .from("movimientos")
          .select(MOVIMIENTOS_COLS.cuentaCod)
          .eq(MOVIMIENTOS_COLS.empresa, empresa)
          .in(MOVIMIENTOS_COLS.comprobante, [...comprobantes].slice(0, 15))
          .limit(200)
      )
    );

    const conteo = {};
    resultados.forEach(({ data }) => {
      (data || []).forEach((m) => {
        const cod = m[MOVIMIENTOS_COLS.cuentaCod];
        if (String(cod || "").startsWith("4.01.03")) conteo[cod] = (conteo[cod] || 0) + 1;
      });
    });

    const codGanador = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0]?.[0];
    const categoria = codGanador ? (CATEGORIAS_GASTO.find((c) => c.cuenta === codGanador)?.nombre || null) : null;
    cacheCategoriaContable.set(rut, categoria);
    return categoria;
  } catch {
    return null;
  }
}

// El folio a veces no se puede sacar del texto del PDF porque su etiqueta
// ("Nº") queda separada del número en el flujo. Pero los sistemas de
// facturación suelen ponerlo en el NOMBRE del archivo ("Factura N9893
// FoodTech.pdf", "GW_2026_09_FACTURA_136982_RINDEGASTOS SPA.pdf"), así que
// sirve como segunda fuente. Se exige que venga acompañado de "factura",
// "boleta", "N" o "F" para no confundirlo con una fecha o un correlativo
// interno cualquiera del nombre.
function folioDesdeNombreArchivo(nombre) {
  if (!nombre) return null;
  const sinExtension = nombre.replace(/\.[a-z0-9]+$/i, "");
  // Sin el flag "i" esto no matcheaba justamente el caso para el que se
  // escribió ("..._FACTURA_136982_..." en mayúsculas), y en cambio sí caía en
  // los que debía ignorar: "boleta-2026-09-15.pdf" devolvía 2026 como folio y
  // "factura_20260915.pdf" devolvía la fecha completa. Un año o una fecha
  // metidos en nro_documento son peores que un campo vacío: alimentan el
  // control de duplicados y el cruce con contabilidad del aprobador.
  const m = /(?:factura|boleta|dte|n|f)[ _\-°º]*(\d{3,10})(?![\d])/i.exec(sinExtension);
  if (!m) return null;
  const candidato = m[1];
  if (/^(19|20)\d{2}$/.test(candidato)) return null;            // un año suelto
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(candidato)) return null; // AAAAMMDD
  return candidato;
}

// Devuelve los datos si el PDF traía texto suficiente, o null para que siga
// el camino normal con IA (PDF escaneado, protegido, o sin los datos clave).
function clasificarPaginaComprobante(texto) {
  const t = String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/gasto\s+\d+\s*\/\s*\d+|campos adicionales:|monto original|resumen de rendicion|total informe|detalle de gastos incluidos/.test(t)) return "Ficha de rendición";
  if (/factura/.test(t)) return "Factura";
  if (/boleta/.test(t)) return "Boleta";
  if (/transbank|redcompra|comprobante de venta|tarjeta de credito/.test(t)) return "Voucher";
  if (/transferencia/.test(t)) return "Transferencia";
  return t.trim().length < 40 ? "Comprobante en imagen" : "Documento";
}

const preparacionesArchivo = new WeakMap();
async function prepararArchivoParaLectura(input, status, analizar) {
  const original = input.files?.[0];
  preparacionesArchivo.get(input)?.limpiar?.();
  input.dataset.paginaPendiente = original?.type === "application/pdf" ? "true" : "false";
  const token = {}; preparacionesArchivo.set(input, token);
  const vigente = () => preparacionesArchivo.get(input) === token && input.isConnected;
  input.parentElement.querySelector(".selector-pagina-ocr")?.remove();
  if (!original) return;
  nuevaGeneracionOcr(input.id.replace(/-foto2?$/, ""));
  try {
    if (original.type !== "application/pdf") {
      // La copia optimizada solo se usa para leer. El adjunto guardado conserva la foto original.
      if (vigente()) await analizar(original);
      return;
    }
    status.className = "ocr-status show"; status.textContent = "Revisando las páginas del PDF…";
    const pdfjs = await cargarPdfJs();
    const pdf = await window.RindeData.abrirPdfSeguro(pdfjs,await original.arrayBuffer()).promise;
    if (!vigente()) {await window.RindeData.cerrarPdf(pdf); return;}
    if (pdf.numPages === 1) {input.dataset.paginaPendiente="false";await window.RindeData.cerrarPdf(pdf); await analizar(original); return;}
    const panel = el("div", {class:"selector-pagina-ocr"});
    panel.appendChild(el("p", {}, "Este PDF contiene " + pdf.numPages + " páginas. Elige el comprobante de este gasto; las fichas de rendición no son el documento original."));
    const select = el("select", {"aria-label":"Página del comprobante"});
    let sugerida = null;
    for (let n=1;n<=pdf.numPages;n++) {
      const page = await pdf.getPage(n);
      const contenido = await page.getTextContent();
      if (!vigente()) {await window.RindeData.cerrarPdf(pdf);return;}
      const tipo = clasificarPaginaComprobante(contenido.items.map(i=>i.str).join(" "));
      select.appendChild(el("option", {value:String(n)}, "Página " + n + " · " + tipo));
      if (sugerida === null && tipo !== "Ficha de rendición" && tipo !== "Documento") sugerida=n;
      status.textContent="Identificando páginas: " + n + " de " + pdf.numPages;
      page.cleanup();
    }
    if (sugerida !== null) select.value=String(sugerida);
    panel.appendChild(select);
    const vista = el("img", {alt:"Vista previa de la página seleccionada"}); panel.appendChild(vista);
    const usar = el("button", {type:"button",class:"btn btn-primary",disabled:true}, "Leer este comprobante"); panel.appendChild(usar);
    input.parentElement.appendChild(panel);
    let renderToken=0, archivoPagina=null, url=null;
    token.limpiar = () => {if(url)URL.revokeObjectURL(url);window.RindeData.cerrarPdf(pdf);};
    async function mostrarPagina() {
      const lectura=++renderToken; usar.disabled=true; archivoPagina=null; input.dataset.paginaPendiente="true";
      try {
        const pagina=await pdf.getPage(Number(select.value));
        const contenido=await pagina.getTextContent();
        const tipo=clasificarPaginaComprobante(contenido.items.map(i=>i.str).join(" "));
        const viewport=pagina.getViewport({scale:1});
        const escala=Math.min(3,2400/Math.max(viewport.width,viewport.height));
        const v=pagina.getViewport({scale:escala});
        const canvas=document.createElement("canvas");canvas.width=Math.ceil(v.width);canvas.height=Math.ceil(v.height);
        await pagina.render({canvasContext:canvas.getContext("2d"),viewport:v}).promise;
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.94));
        if (!vigente() || lectura!==renderToken || !blob) return;
        if (url) URL.revokeObjectURL(url);
        url=URL.createObjectURL(blob);vista.src=url;
        panel.querySelector(".pagina-clasificacion")?.remove();
        panel.insertBefore(el("p", {class:"pagina-clasificacion"}, "Página " + select.value + " · " + tipo),vista);
        archivoPagina=new File([blob],original.name.replace(/\.pdf$/i,"")+"-pagina-"+select.value+".jpg",{type:"image/jpeg"});
        usar.disabled=tipo==="Ficha de rendición";
        status.textContent=tipo==="Ficha de rendición" ? "Esta página es una ficha. Selecciona la página con la boleta, factura o voucher original." : "Confirma la página antes de leerla. Se adjuntará solo este comprobante al gasto.";
      } catch (error) {if(vigente()){status.textContent="No se pudo preparar esta página. Elige otra o adjunta una foto del comprobante.";status.className="ocr-status show err";}}
    }
    select.addEventListener("change",()=>{const id=input.id.replace(/-foto2?$/,"");nuevaGeneracionOcr(id);mostrarPagina();});
    usar.addEventListener("click",async()=>{
      if(!vigente() || !archivoPagina || usar.disabled)return;
      usar.disabled=true;
      const dt=new DataTransfer();dt.items.add(archivoPagina);input.files=dt.files;input.dataset.paginaPendiente="false";
      await analizar(archivoPagina);
      if(vigente())usar.disabled=false;
    });
    await mostrarPagina();
  } catch(error) {
    if(vigente()){status.className="ocr-status show err";status.textContent="No se pudo abrir el archivo. Prueba con una foto o un PDF del comprobante original.";}
  }
}

async function leerPdfLocal(file) {
  if ((file.type || "") !== "application/pdf") return null;
  try {
    const pdfjs = await cargarPdfJs();
    const pdf = await window.RindeData.abrirPdfSeguro(pdfjs,await file.arrayBuffer()).promise;
    let texto = "";
    if (pdf.numPages !== 1) {await window.RindeData.cerrarPdf(pdf); return null;}
    // Tope de páginas: una factura tiene 1-2; leer un PDF enorme entero solo
    // para buscar un RUT no aporta y traba el navegador.
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const contenido = await (await pdf.getPage(p)).getTextContent();
      texto += contenido.items.map((i) => i.str).join(" ") + "\n";
    }
    if (clasificarPaginaComprobante(texto) === "Ficha de rendición") {await window.RindeData.cerrarPdf(pdf); return null;}
    await window.RindeData.cerrarPdf(pdf);
    if (texto.trim().length < 50) return null; // PDF escaneado: es una imagen, no hay texto que leer
    const datos = parsearTextoFactura(texto);
    // El piso para considerarlo bueno: RUT válido + monto. Sin esos dos no
    // vale la pena saltarse la IA.
    return datos.rut_proveedor && datos.monto ? datos : null;
  } catch (err) {
    console.error("No se pudo leer el PDF localmente, se usará la IA:", err);
    return null;
  }
}

// "camposFaltantes" y "datosParciales" son opcionales y van en el body para
// que ocr-recibo lea SOLO lo que la lectura local no pudo sacar, en vez de
// releer el documento entero. No cambian el costo de la llamada (sigue
// siendo una sola solicitud a Gemini), pero sí lo que se le pide. Si el
// servidor todavía no los soporta simplemente los ignora y responde como
// siempre, así que mandarlos es inofensivo.
const fotosPreparadas = new WeakMap();
const opcionesFotos = new WeakMap();
async function prepararComprobanteIa(file) {
  if (!fotosPreparadas.has(file)) fotosPreparadas.set(file, (async () => {
    let imagen = file;
    if (file.type === "application/pdf") {
      const pdfjs = await cargarPdfJs();
      const pdf = await window.RindeData.abrirPdfSeguro(pdfjs,await file.arrayBuffer()).promise;
      try {
        if (pdf.numPages !== 1) return file;
        const pagina = await pdf.getPage(1),base = pagina.getViewport({scale:1});
        const viewport = pagina.getViewport({scale:Math.min(3,2000/Math.max(base.width,base.height))});
        const canvas = document.createElement("canvas");canvas.width = Math.ceil(viewport.width);canvas.height = Math.ceil(viewport.height);
        await pagina.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
        const blob = await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
        if (!blob) throw new Error("No se pudo preparar la página del comprobante.");
        imagen = new File([blob],"pagina-comprobante.png",{type:"image/png"});
      } finally {await window.RindeData.cerrarPdf(pdf);}
    }
    if (!imagen.type.startsWith("image/")) return imagen;
    const resultado = await window.RindeFoto.preparar(imagen,{recortar:file.type!=="application/pdf",...opcionesFotos.get(file)});
    return resultado.file;
  })().catch(error=>{fotosPreparadas.delete(file);throw error;}));
  return fotosPreparadas.get(file);
}
// Cuando una Edge Function responde con un status distinto de 2xx, supabase-js
// arma un error genérico ("Edge Function returned a non-2xx status code") y NO
// lee el cuerpo: el mensaje real que armó la función queda en error.context
// (el Response), así que hay que leerlo a mano para no perderlo.
async function cuerpoErrorFuncion(error) {
  try { return await error.context?.json(); } catch { return null; }
}

async function mensajeErrorFuncion(error) {
  return (await cuerpoErrorFuncion(error))?.error || error.message;
}

async function llamarOcrRecibo(file, camposFaltantes, datosParciales, tipoItem) {
  // Ambos proveedores ven la misma copia; la cola de nube recibe también esa imagen.
  file = await prepararComprobanteIa(file);
  const imageBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const body = { imageBase64, mimeType: file.type || "image/jpeg" };
  if (camposFaltantes && camposFaltantes.length) body.camposFaltantes = camposFaltantes;
  if (datosParciales && Object.keys(datosParciales).length) body.datosParciales = datosParciales;
  // De qu� pesta�a viene el �tem. El modelo no puede deducirlo del papel, y
  // de eso depende si para dar la lectura por completa se exigen RUT, tipo y
  // folio: sin esto, una factura fotografiada con el encabezado ilegible se
  // daba por le�da con solo proveedor, fecha y monto.
  if (tipoItem) body.tipoItem = tipoItem;

  const { data, error } = await conTimeout(
    db.functions.invoke("ocr-recibo", { body }),
    // Tiene que ser MAYOR que el presupuesto del servidor (PRESUPUESTO_EN_VIVO
    // en _shared/gemini-ocr.ts, 30s) más el viaje de red -- si no, cortamos
    // acá justo antes de que la respuesta buena llegue. Sí, 45s de spinner es
    // harto, pero leer un documento con visión tarda tranquilamente 15-25s:
    // el timeout corto de antes (30s de acá con 12s por llamada allá)
    // garantizaba fallar aunque Gemini estuviera respondiendo bien. Si igual
    // falla, el agente en segundo plano sigue con el archivo (ver
    // dispararAgenteYEsperar), así que nadie se queda esperando de verdad.
    45000,
    "Se agotó el tiempo de espera leyendo el comprobante (conexión muy lenta o caída). Completa los datos a mano, o inténtalo de nuevo."
  );
  if (error) {
    const cuerpo = await cuerpoErrorFuncion(error);
    const err = new Error(cuerpo?.error || error.message);
    // ocr-recibo sube el comprobante y lo encola en ocr_previos apenas
    // falla en vivo (ver migracion_ocr_previo.sql) -- este id es lo que
    // deja seguirlo (disparar el agente altiro + saber cuándo esté listo)
    // sin esperar a que se envíe la rendición.
    err.previaId = cuerpo?.previaId || null;
    throw err;
  }
  if (data?.error) throw new Error(data.error);
  if (data?.requiere_separacion) {
    const err = new Error(data.aviso_documento || "Selecciona un comprobante por gasto.");
    err.noReintentar = true; throw err;
  }
  return data;
}

// Evita que la respuesta de una llamada de OCR vieja pise a una más nueva
// para el mismo ítem -- puede pasar si la persona reselecciona el archivo
// (o pulsa "reintenta con IA") mientras la llamada anterior todavía está en
// vuelo: antes, cualquiera de las dos que respondiera último ganaba, sin
// importar si correspondía al archivo que en realidad quedó adjunto.
const camposEditadosOcr = new Set();
const SUFIJOS_OCR = {nombre_proveedor:["nombreprov","nombreprov2"],rut_proveedor:["rut","rut2"],tipo_documento:["tipodoc","tipodoc2"],nro_documento:["folio","folio2"],fecha:["venc","fecha2"],monto:["monto","monto2"],descripcion:["desc","desc2"],categoria_sugerida:["categoriacon","categoria"]};
function protegerEdicionOcr(id, data) {
  const copia = {...data};
  for (const [campo,sufijos] of Object.entries(SUFIJOS_OCR)) {
    if (sufijos.some(s => camposEditadosOcr.has(id+"-"+s))) delete copia[campo];
  }
  return copia;
}
function mostrarVerificacionOcr(id, data) {
  const card = document.getElementById(id);
  const file = ocrArchivoActual.get(id);
  if (!card || !file) return;
  revisionesComprobante.get(id)?.limpiar();
  const campo = nombre => SUFIJOS_OCR[nombre]?.map(s=>document.getElementById(id+"-"+s)).find(n=>n&&n.offsetParent!==null);
  const revisiones = Object.fromEntries(Object.keys(SUFIJOS_OCR).filter(c=>c!=="descripcion"&&c!=="categoria_sugerida").map(c=>[c,data.verificacion_campos?.[c]||{estado:"ilegible",motivo:"Revisa este campo en el adjunto."}]));
  revisionesComprobante.set(id,window.RindeRevision.montar({contenedor:card,datos:{...data,verificacion_campos:revisiones},original:file,fuente:()=>prepararComprobanteIa(file),campo,manual:nombre=>SUFIJOS_OCR[nombre]?.some(s=>camposEditadosOcr.has(id+"-"+s)),ajustar:async opcion=>{
    if (ocrArchivoActual.get(id)!==file) return;
    const opciones = {...opcionesFotos.get(file)};
    if(opcion==="giro")opciones.giro=(opciones.giro||0)+1;
    if(opcion==="contraste")opciones.contraste=!opciones.contraste;
    if(opcion==="completo")opciones.recortar=false;
    opcionesFotos.set(file,opciones);fotosPreparadas.delete(file);
    const estado = card.querySelector(".ocr-status");
    if(document.getElementById(id+"-monto2")?.offsetParent!==null)await analizarComprobanteGastoDirecto(id,file,estado);
    else await analizarComprobante(id,file,estado);
  }}));
}

const revisionesComprobante = new Map();
const ocrGeneracion = new Map();
const ocrArchivoActual = new Map();
function nuevaGeneracionOcr(id, conservarEdiciones = false) {
  if (!conservarEdiciones) for (const campo of camposEditadosOcr) if (campo.startsWith(id+"-")) camposEditadosOcr.delete(campo);
  revisionesComprobante.get(id)?.limpiar();revisionesComprobante.delete(id);
  const gen = (ocrGeneracion.get(id) || 0) + 1;
  ocrGeneracion.set(id, gen);
  if(!conservarEdiciones){ocrBloqueado.delete(id);ocrConflictos.delete(id);}
  return gen;
}
function esGeneracionVigenteOcr(id, gen) {
  return ocrGeneracion.get(id) === gen;
}

// Si el OCR en vivo nunca tuvo éxito para este ítem (ConDocumento), al
// enviar la rendición se encola para reintento en segundo plano (ver
// ocr_reintento_estado en submitRendicion) -- un "agente" en Supabase
// (Edge Function ocr-reintento-pendientes + pg_cron, ver
// migracion_ocr_reintento.sql) lo sigue intentando cada 5 minutos aunque la
// persona ya haya cerrado el navegador.
const ocrExitoso = new Map();
const ocrBloqueado = new Set();
const ocrConflictos = new Map();

// Encolar tiene un costo real: cada reintento del agente gasta solicitudes de
// la cuota gratuita de Gemini, que es de ~20 por modelo AL DÍA. Antes se
// encolaba TODO ítem cuyo OCR en vivo no hubiera salido bien, incluso cuando
// la persona ya había escrito los datos a mano -- el agente reintentaba
// durante horas para "sugerir" exactamente lo que ya estaba en pantalla, y
// esa cuota le faltaba después a un comprobante que sí la necesitaba. Solo
// vale la pena encolar si queda algún hueco que el agente pueda llenar.
function aplicarConflictosOcr(id,data) {
  const conflictos=new Set(ocrConflictos.get(id) || []);
  for(const campo of [...(data.campos_discrepantes || []),...(data.monto_discrepante ? ["monto"] : [])]) {
    if(!SUFIJOS_OCR[campo])continue;
    conflictos.add(campo);
    for(const sufijo of SUFIJOS_OCR[campo]){
      const entrada=document.getElementById(id+"-"+sufijo);
      if(entrada && !camposEditadosOcr.has(id+"-"+sufijo))entrada.value="";
    }
  }
  ocrConflictos.set(id,[...conflictos]);
}
function conflictosSinConfirmar(id) {
  return (ocrConflictos.get(id)||[]).filter(c => !SUFIJOS_OCR[c]?.some(s => camposEditadosOcr.has(id+"-"+s)));
}
function estadoLecturaFormulario(id, directo, data) {
  const campos=directo ? ["nombreprov2","fecha2","monto2","desc2"] : ["nombreprov","rut","tipodoc","folio","venc","monto","desc"];
  const etiquetas={nombreprov:"Proveedor",nombreprov2:"Proveedor",rut:"RUT",tipodoc:"Documento",folio:"Folio",venc:"Fecha",fecha2:"Fecha",monto:"Monto",monto2:"Monto",desc:"Descripción",desc2:"Descripción"};
  const faltantes=campos.filter(s => !document.getElementById(id+"-"+s)?.value?.trim());
  const pendientesConflicto=conflictosSinConfirmar(id);
  const conflicto=pendientesConflicto.length>0 || (data.monto_discrepante && !["monto","monto2"].some(s => camposEditadosOcr.has(id+"-"+s)));
  const completo=!faltantes.length && !conflicto;
  ocrExitoso.set(id,completo);
  return {estado:conflicto ? "conflicto" : completo ? "completo" : "parcial",mensaje:conflicto ? "Datos contradictorios: confirma "+(pendientesConflicto.join(", ") || "monto")+" mirando el comprobante." : completo ? "Lectura completa. Revisa los datos y su evidencia; se conservaron tus correcciones." : "Lectura parcial. Falta revisar: "+faltantes.map(s => etiquetas[s]).join(", ")+". El agente puede reintentar los campos pendientes."};
}

function estadoReintentoOcr(id, huecos) {
  // Una respuesta parcial no cancela la cola de campos pendientes.
  if (ocrBloqueado.has(id)) return null;
  return huecos.some((v) => !v) ? "pendiente" : null;
}

// De dónde salieron los datos de cada ítem ("local", "ia", "local+ia") y si
// el monto quedó confirmado por la aritmética del documento. Se guardan con
// el ítem al enviar la rendición, y sirven para dos cosas distintas:
//  - Quien aprueba puede distinguir un total CONFIRMADO contra los
//    subtotales de la factura de uno deducido por heurística.
//  - Permite notar que el parser local se degradó. Si un proveedor cambia el
//    formato de su factura, lo único que se vería sin esto es que la cuota
//    de Gemini se acaba antes, sin ninguna explicación; con esto se puede
//    consultar cuántos ítems vienen de cada origen y cuándo cambió.
// Va acá, en un dato que ya se guarda igual, y no en una llamada de red
// aparte: no cuesta ninguna solicitud extra.
const ocrOrigen = new Map();
// id -> { verificado: boolean, monto: number } con el monto que dejó el OCR.
// Se guarda el monto además del flag porque si la persona lo corrige a mano
// después, "verificado" dejaría de ser cierto: se compara al enviar.
const ocrMonto = new Map();

function registrarOrigenOcr(id, origen, datos) {
  ocrOrigen.set(id, origen);
  ocrMonto.set(id, { verificado: !!datos.monto_verificado, monto: datos.monto || null });
}

// "Verificado" describe el monto que leyó el OCR, no el que finalmente se
// envía. Si la persona lo corrigió a mano, ese respaldo aritmético ya no
// aplica al número que va a contabilidad, y marcarlo igual sería peor que no
// marcar nada: quien aprueba confiaría en una confirmación que no existe.
function montoSigueVerificado(id, montoEnviado) {
  const reg = ocrMonto.get(id);
  return !!(reg && reg.verificado && reg.monto === montoEnviado);
}

// El comprobante ya quedó adjunto en el <input type=file> antes de llamar a
// esto (fotoInput/fotoInput2 lo retienen aunque el OCR falle -- ver
// addItemRow / buildSinDocumentoFields), así que reintentar no requiere que
// la persona vuelva a elegir el archivo: basta con volver a llamar al mismo
// analizador con el mismo File. Común a "Con documento" y "Gasto directo"
// para no duplicar el armado del botón en los dos catch.
function mostrarErrorOcr(statusEl, err, reintentar) {
  statusEl.textContent = "";
  statusEl.className = "ocr-status show err";
  statusEl.appendChild(document.createTextNode(
    // No es obligatorio completar todo a mano acá: alcanza con el monto para
    // poder enviar la rendición (lo único que de verdad exige el formulario
    // -- ver submitRendicion). Si se envía igual, el ítem queda en cola y el
    // agente de reintento en segundo plano (ocr-reintento-pendientes, cada
    // 5 min) se encarga de leer el resto solo, sin que nadie tenga que
    // volver a intentarlo a mano.
    `No se pudo leer el comprobante automáticamente (${err.message || "error desconocido"}). No hace falta completar todo a mano: con el monto alcanza para enviar la rendición igual, y la IA sigue intentando leer el resto sola en segundo plano. O reintenta ahora mismo:`
  ));
  // .btn-sm real (no un link de texto disfrazado de botón) -- en su propia
  // línea, para que quede claro que es una acción y no parte de la oración.
  statusEl.appendChild(el("div", { style: "margin-top:8px;" }, [
    el("button", {
      type: "button",
      class: "btn btn-sm",
      onclick: reintentar,
    }, "🔄 Reintentar con IA"),
  ]));
}

// Último filtro antes de que un monto venga de afuera (IA o cola
// ocr_previos) y aterrice en el campo. El servidor ya normaliza
// (normalizarMonto en _shared/gemini-ocr.ts), pero el cliente es el último
// salto antes de contabilidad y repetía exactamente el bug que se acababa
// de sacar allá: "Number.isFinite(Number(x))" deja pasar "15.000" como 15
// (formato chileno leído como decimal, error de 1000x hacia abajo), y un
// decimal como 13650.42 se renderizaba "13.650,42", que parseMoneyValue
// -- que borra todo lo que no sea dígito -- convierte en 1.365.042 al
// enviar, un error de 100x hacia arriba. Además, las filas de ocr_previos
// guardadas ANTES del arreglo del servidor se aplican por acá.
//
// OJO con la tentación de resolverlo con Number.isInteger: Number("15.000")
// es 15, que ES un entero positivo, así que el chequeo pasa y el error de
// 1000x sigue vivo. Hay que mirar el FORMATO del string, no solo el número
// que resulta. Es el mismo criterio que normalizarMonto del servidor: si el
// formato es ambiguo (ej. "15.00": ¿centavos o miles mal escritos?) se
// devuelve null y el campo queda vacío, que es preferible a un monto
// equivocado que nadie revisa.
function montoValidoCLP(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number") return Number.isFinite(valor) && valor > 0 ? Math.round(valor) : null;
  if (typeof valor !== "string") return null;
  const s = valor.trim().replace(/^\$\s*/, "");
  // "1.234.567" o "1.234.567,89": puntos de miles al estilo chileno.
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Math.round(Number(s.replace(/\./g, "").replace(",", "."))) || null;
  if (/^\d+$/.test(s)) return Number(s) || null;
  if (/^\d+,\d+$/.test(s)) return Math.round(Number(s.replace(",", "."))) || null;
  return null;
}

// Aplica el resultado de la IA a los campos de un ítem "Documento
// electrónico" -- lo usa tanto el éxito en vivo (más abajo) como la cola
// PRE-envío (ocr_previos) cuando el agente en segundo plano lo resuelve
// mientras el formulario sigue abierto (ver dispararAgenteYEsperar). "gen"
// evita pisar datos más nuevos si la persona ya seleccionó otro archivo
// mientras tanto.
async function aplicarResultadoOcrCon(id, data, gen) {
  if (!esGeneracionVigenteOcr(id, gen)) return {estado:"obsoleto"};
  if (data.requiere_separacion) {const estado=document.querySelector(`#${id} .ocr-status`);if(estado){estado.textContent=data.aviso_documento;estado.className="ocr-status show err";}ocrBloqueado.add(id);return {estado:"requiere_separacion",mensaje:data.aviso_documento};}
  if (!esGeneracionVigenteOcr(id, gen)) return;
  mostrarVerificacionOcr(id, data);
  data = protegerEdicionOcr(id, data);
  aplicarConflictosOcr(id,data);
  ocrExitoso.set(id, true);
  if (data.nombre_proveedor) document.getElementById(`${id}-nombreprov`).value = data.nombre_proveedor;
  if (data.rut_proveedor) {
    const rutFormateado = formatearRut(data.rut_proveedor);
    document.getElementById(`${id}-rut`).value = rutFormateado;
    // Si ese RUT ya está en la contabilidad, su razón social real le gana
    // a lo que la IA haya alcanzado a leer de la imagen. Se salta cuando el
    // nombre ya vino resuelto: los caminos que pasan por fusionarLecturas ya
    // consultaron contabilidad (resolverDatosContables), y repetir la
    // consulta acá no solo es una query de más, es un await de más en el que
    // la persona puede adjuntar otro comprobante.
    const nombreReal = data.nombre_proveedor ? null : await buscarNombreProveedorPorRut(rutFormateado);
    // Re-chequeo OBLIGATORIO después del await, y con "return", no con un
    // "&&" que solo cubra esta línea: mientras la consulta a contabilidad
    // estaba en vuelo, la persona pudo adjuntar OTRO comprobante. Esa
    // segunda corrida ya limpió y llenó los campos; si esta sigue de largo,
    // pisa folio, fecha, descripción y MONTO con los del documento anterior
    // y deja un ítem con datos de dos comprobantes distintos -- justo lo
    // que la limpieza de campos venía a evitar.
    if (!esGeneracionVigenteOcr(id, gen)) return;
    if (nombreReal && !camposEditadosOcr.has(`${id}-nombreprov`)) document.getElementById(`${id}-nombreprov`).value = nombreReal;
  }
  if (data.tipo_documento) {
    if (TIPOS_DOCUMENTO.includes(data.tipo_documento)) {
      document.getElementById(`${id}-tipodoc`).value = data.tipo_documento;
    } else {
      // El desplegable no tiene esta opción (típico: una nota de crédito o
      // de débito). Antes esto se descartaba en silencio y el select se
      // quedaba con "Factura Electrónica", así que una NC entraba como
      // factura, con monto positivo y a la cuenta por pagar -- con el signo
      // al revés y sin que nadie se enterara. Avisar es lo mínimo.
      toast(`El comprobante parece ser "${data.tipo_documento}", que no se puede rendir por acá. Revísalo antes de enviar.`);
    }
  }
  if (data.nro_documento) document.getElementById(`${id}-folio`).value = data.nro_documento;
  if (data.fecha) document.getElementById(`${id}-venc`).value = data.fecha;
  if (data.descripcion) document.getElementById(`${id}-desc`).value = data.descripcion;
  const montoIA = montoValidoCLP(data.monto);
  if (montoIA) document.getElementById(`${id}-monto`).value = montoIA.toLocaleString("es-CL");
  // Igual que en "Gasto directo": solo se aplica si existe tal cual en
  // el desplegable, el campo queda visible y editable para confirmarla.
  if (data.categoria_sugerida) {
    const catSelect = document.getElementById(`${id}-categoriacon`);
    if (catSelect && [...catSelect.options].some((o) => o.value === data.categoria_sugerida)) {
      catSelect.value = data.categoria_sugerida;
    }
  }
  if (esGeneracionVigenteOcr(id, gen)) { recalcTotal(); chequearDuplicadoHistorico(id); }
  return estadoLecturaFormulario(id,false,data);
}

// Dispara el agente de reintento en segundo plano AHORA MISMO (en vez de
// esperar hasta 5 minutos al próximo tick del cron -- ver
// ocr-reintento-pendientes) y sondea el resultado mientras el ítem siga en
// el formulario. Si el agente termina antes de que se envíe la rendición,
// el resultado se aplica directo a los campos vía "aplicar" (como una
// lectura en vivo exitosa: acá todavía no se guardó ni decidió nada). Si la
// persona ya envió la rendición o cambió de archivo antes de que termine,
// esta fila de ocr_previos simplemente queda sin aplicar -- no rompe nada,
// el ítem ya guardado tiene su propia cola aparte (submitRendicion).
function dispararAgenteYEsperar(id, previaId, gen, aplicar, statusEl) {
  if (!previaId) return;
  notificarAsync("ocr-reintento-pendientes", {}, "No se pudo disparar el reintento inmediato de OCR:");

  const INTERVALO_MS = 5000;
  const MAX_SONDEOS = 24; // ~90s de sondeo -- pasado eso, se deja que el cron lo siga intentando solo, sin seguir consultando desde un formulario que quizás ni sigue abierto
  let intento = 0, ultimaLectura = null;
  const sondear = async () => {
    intento++;
    // Se corta en silencio (no es un error, es solo dejar de esperar) si:
    // ya hay una llamada más nueva para este ítem, el ítem se quitó del
    // formulario, o se acabaron los sondeos.
    if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;
    const { data, error } = await db.from("ocr_previos").select("estado, resultado").eq("id", previaId).maybeSingle();
    if (error || !data) return;
    const huella = data.resultado ? JSON.stringify(data.resultado) : null;
    if (data.resultado && huella !== ultimaLectura) {
      ultimaLectura = huella;
      const resultado = await aplicar(data.resultado, gen);
      if (esGeneracionVigenteOcr(id, gen) && resultado?.estado !== "obsoleto") {
        statusEl.textContent = resultado?.mensaje || "Lectura parcial: revisa los campos pendientes y su evidencia.";
        statusEl.className = "ocr-status show " + (resultado?.estado === "completo" ? "ok" : "err");
      }
      if (data.estado === "listo" || data.estado === "agotado") return;
    }
    if (data.estado === "agotado" || intento >= MAX_SONDEOS) return;
    setTimeout(sondear, INTERVALO_MS);
  };
  setTimeout(sondear, INTERVALO_MS);
}

// Al adjuntar un comprobante NUEVO hay que borrar lo que había cargado el
// anterior: si la lectura nueva no logra sacar algún dato, ese campo se
// quedaba con el valor del archivo viejo. Pasa de verdad cuando alguien
// adjunta el PDF equivocado, se da cuenta y elige el correcto -- y quedaba
// mezclando el folio/RUT/descripción de una factura con el monto de otra.
// Son campos que describen al documento adjunto: conservar el valor de otro
// documento nunca es lo correcto.
// Los <select> necesitan trato aparte: ponerles value="" cuando no existe
// una opción con ese valor los deja en selectedIndex = -1 (sin nada
// seleccionado), y submitRendicion leería "" -- que para tipodoc significa
// CUENTA_POR_TIPO_DOC[""] = undefined, es decir un ítem sin cuenta contable.
// Volver al índice 0 los deja en su estado inicial de verdad.
function limpiarCamposDeComprobante(ids) {
  ids.forEach((campoId) => {
    const campo = document.getElementById(campoId);
    if (!campo) return;
    if (campo.tagName === "SELECT") campo.selectedIndex = 0;
    else campo.value = "";
  });
}

async function analizarComprobante(id, file, statusEl) {
  const esReintento=ocrArchivoActual.get(id)===file;
  const gen = nuevaGeneracionOcr(id,esReintento);
  ocrArchivoActual.set(id,file);
  mostrarVerificacionOcr(id,{});
  if(!esReintento)limpiarCamposDeComprobante([`${id}-nombreprov`, `${id}-rut`, `${id}-folio`, `${id}-venc`, `${id}-monto`, `${id}-desc`, `${id}-tipodoc`, `${id}-categoriacon`]);
  statusEl.textContent = "🪄 Analizando comprobante...";
  statusEl.className = "ocr-status show";
  try {
    // Primero se intenta leer el PDF localmente: si es una factura
    // electrónica con texto, sale al instante, gratis y sin gastar cuota de
    // Gemini. Solo si eso no alcanza (foto, PDF escaneado) se llama a la IA.
    const datosLocales = await leerPdfLocal(file);
    // Freno duro para notas de crédito/débito, ANTES de tocar ningún campo.
    // Una NC rebaja el pasivo con el proveedor; rendirla como si fuera una
    // factura lo AUMENTA por el mismo monto, y el error viaja hasta el
    // asiento contable. El desplegable de tipo de documento no tiene esa
    // opción, así que no hay forma de cargarla bien por acá. El aviso va en
    // statusEl y no en un toast a propósito: el toast se desvanece y esto
    // tiene que quedar a la vista mientras la persona decide qué hacer.
    if (datosLocales && /^Nota de (Cr[eé]dito|D[eé]bito)$/i.test(datosLocales.tipo_documento || "")) {
      statusEl.textContent = `⛔ Este documento es una ${datosLocales.tipo_documento}, no una factura o boleta: no se puede rendir por acá porque rebaja lo que se le debe al proveedor en vez de sumarlo. Envíalo a contabilidad directamente y quita este ítem.`;
      statusEl.className = "ocr-status show err";
      return;
    }
    if (datosLocales) {
      // El folio, cuando no se pudo leer del texto, suele venir en el nombre
      // del archivo.
      if (!datosLocales.nro_documento) datosLocales.nro_documento = folioDesdeNombreArchivo(file.name);
      // Categoría, descripción y razón social no salen del PDF: salen de la
      // CONTABILIDAD (con qué cuenta de gasto se registró antes a este
      // proveedor: años de asientos reales) y del historial de la propia
      // app. Es información que no cuesta ni una solicitud de Gemini.
      const contable = await resolverDatosContables(datosLocales.rut_proveedor, datosLocales.nombre_proveedor);
      if (!esGeneracionVigenteOcr(id, gen)) return;

      const { datos } = fusionarLecturas(datosLocales, null, contable);
      registrarOrigenOcr(id, "local", datos);
      const revisionLocal=await aplicarResultadoOcrCon(id, datos, gen);
      if (!esGeneracionVigenteOcr(id, gen)) return;
      // Se dice explícitamente si el monto quedó CONFIRMADO por la
      // aritmética del documento: sirve para dirigir la revisión al dato que
      // de verdad la necesita, en vez de pedir que se revise todo por igual.
      const montoOk = datos.monto_verificado ? " Monto confirmado (neto + IVA cuadran con el total)." : "";
      // También de dónde salió la categoría: si viene de contabilidad,
      // conviene decirlo -- es un dato más fuerte que el historial de la app
      // y ayuda a que la persona decida si confiar en él o cambiarlo.
      let textoBase;
      if (contable.desdeContabilidad) {
        textoBase = `✔ Datos leídos del PDF.${montoOk} Categoría sugerida: "${contable.categoria}", que es la cuenta con la que contabilidad registró antes a este proveedor. Revísalo antes de enviar.`;
      } else if (contable.categoria || contable.descripcion) {
        textoBase = `✔ Datos leídos del PDF, más categoría y descripción según cómo cargaste antes a este proveedor.${montoOk} Revísalos antes de enviar.`;
      } else {
        textoBase = `✔ Datos leídos del PDF de la factura.${montoOk} Revísalos antes de enviar.`;
      }
      statusEl.textContent = textoBase+" "+(revisionLocal?.mensaje || "");
      statusEl.className = "ocr-status show " + (revisionLocal?.estado === "completo" ? "ok" : "err");

      // Acá está el ahorro: la IA se llama SOLO si después de lo local y de
      // contabilidad todavía quedaron huecos (o el monto no lo confirmó la
      // aritmética). Cuando la factura se leyó completa, son cero llamadas.
      // No se espera el resultado a propósito: los campos ya están en
      // pantalla y la IA completa después, sin que nadie mire un spinner.
      if (valeLaPenaLlamarIA(camposAPedirOcr(datos, CAMPOS_OCR_CON))) {
        completarConIA({ id, file, gen, statusEl, local: datosLocales, contable, datos,
          campos: CAMPOS_OCR_CON, aplicar: aplicarResultadoOcrCon, textoBase });
      }
      return;
    }

    // Sin lectura local (foto, PDF escaneado o protegido): la IA es la única
    // fuente. Igual pasa por la MISMA fusión, para que exista un solo camino
    // por el que los datos llegan a los campos -- antes eran dos, y lo que se
    // arreglaba en uno seguía roto en el otro.
    const ia = await llamarOcrRecibo(file, CAMPOS_OCR_CON, {}, "ConDocumento");
    if (!esGeneracionVigenteOcr(id, gen)) return; // ya hay una llamada más nueva para este ítem en curso
    const contableIA = await resolverDatosContables(ia?.rut_proveedor, ia?.nombre_proveedor);
    if (!esGeneracionVigenteOcr(id, gen)) return;
    const { datos: datosIA } = fusionarLecturas(null, ia, contableIA);
    registrarOrigenOcr(id, "ia", datosIA);
    const revision = await aplicarResultadoOcrCon(id, datosIA, gen);
    if(ia.previaId)dispararAgenteYEsperar(id,ia.previaId,gen,(data,g)=>aplicarResultadoOcrCon(id,data,g),statusEl);
    if (!esGeneracionVigenteOcr(id, gen)) return;

    statusEl.textContent = revision?.mensaje || "Revisa los campos pendientes.";
    statusEl.className = "ocr-status show " + (revision?.estado === "completo" ? "ok" : "err");
  } catch (err) {
    if (err.noReintentar) {if (esGeneracionVigenteOcr(id,gen)) {ocrBloqueado.add(id);statusEl.textContent=err.message;statusEl.className="ocr-status show err";} return;}
    if (!esGeneracionVigenteOcr(id, gen)) return; // idem: una llamada más nueva ya se hizo cargo de este ítem
    console.error("Error en OCR:", err);

    // Último recurso para las FOTOS: hasta acá, una foto con Gemini caído o
    // sin cuota no dejaba absolutamente nada y la persona tenía que tipear
    // todo. El OCR local es peor que la IA, pero entre algo verificado y
    // nada, gana algo. Solo se aplica si pasó los controles de
    // leerFotoLocal (RUT con dígito verificador válido, o monto que cuadra
    // con neto + IVA).
    if (await aplicarRespaldoFoto(id, file, gen, statusEl, aplicarResultadoOcrCon, CAMPOS_OCR_CON)) {
      dispararAgenteYEsperar(id, err.previaId, gen, (data, g) => aplicarResultadoOcrCon(id, data, g), statusEl);
      return;
    }

    // Antes se mostraba siempre el mismo mensaje genérico, así que un PDF
    // que fallaba por una razón concreta y diagnosticable (ver ocr-recibo)
    // se veía exactamente igual que cualquier otro problema.
    mostrarErrorOcr(statusEl, err, () => analizarComprobante(id, file, statusEl));
    dispararAgenteYEsperar(id, err.previaId, gen, (data, g) => aplicarResultadoOcrCon(id, data, g), statusEl);
  }
}

// Intenta rescatar una foto leyéndola en el navegador cuando la IA ya falló.
// Devuelve true si logró llenar algo (y entonces el llamador no muestra el
// error), false si no hubo nada rescatable y hay que seguir con el camino
// de error de siempre.
async function leerEscaneadoLocal(file){
  if((file.type || "").startsWith("image/"))return leerFotoLocal(file);
  if(file.type!=="application/pdf")return null;
  let pdf;
  try{
    const pdfjs=await cargarPdfJs();
    pdf=await window.RindeData.abrirPdfSeguro(pdfjs,await file.arrayBuffer()).promise;
    if(pdf.numPages!==1)return null;
    const pagina=await pdf.getPage(1),base=pagina.getViewport({scale:1});
    const escala=Math.min(2.5,LADO_MAXIMO_OCR/Math.max(base.width,base.height));
    const viewport=pagina.getViewport({scale:escala});
    const canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    await pagina.render({canvasContext:canvas.getContext("2d"),viewport,background:"rgb(255,255,255)"}).promise;
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
    return blob?await leerFotoLocal(new File([blob],"comprobante.png",{type:"image/png"})):null;
  }catch(error){console.error("El respaldo local no pudo leer el PDF:",error);return null;}
  finally{if(pdf)await window.RindeData.cerrarPdf(pdf);}
}

async function aplicarRespaldoFoto(id, file, gen, statusEl, aplicar, campos) {
  if (!(file.type || "").startsWith("image/") && file.type!=="application/pdf") return false;
  statusEl.textContent = "La IA no está disponible. El bot está escaneando el comprobante en este navegador...";
  statusEl.className = "ocr-status show";
  const local = await leerEscaneadoLocal(file);
  if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return true;
  if (!local) return false;

  const contable = await resolverDatosContables(local.rut_proveedor, local.nombre_proveedor);
  if (!esGeneracionVigenteOcr(id, gen)) return true;
  const { datos } = fusionarLecturas(local, null, contable);
  registrarOrigenOcr(id, "local", datos);
  await aplicar(id, datos, gen);
  if (!esGeneracionVigenteOcr(id, gen)) return true;

  // El mensaje dice explícitamente que esto NO lo leyó la IA y qué hay que
  // mirar. Una lectura de foto hecha acá es bastante menos confiable que la
  // de un PDF, y presentarla con el mismo "✔ Datos leídos" de siempre sería
  // esconder esa diferencia justo donde importa.
  // camposFaltantesOcr y no camposAPedirOcr: son preguntas distintas. A la
  // IA se le pide también el monto cuando está lleno pero sin confirmar,
  // para contrastarlo; a la PERSONA hay que nombrarle solo lo que quedó
  // vacío de verdad. Con el otro, el aviso del comprobante de transferencia
  // decía "completa a mano: ... monto" con el monto correcto ya en el campo.
  const faltan = camposFaltantesOcr(datos, campos).map((c) => ETIQUETA_CAMPO_OCR[c] || c);
  // El folio y el RUT se nombran aparte, y no por cortesía: medidos contra
  // 188 comprobantes reales, leyendo de una foto el folio sale mal 1 de
  // cada 3 veces y el RUT 1 de cada 10, casi siempre por un solo dígito.
  // Son errores que no se notan de reojo justamente porque el número se ve
  // bien formado, así que hay que pedir que se contrasten contra el papel.
  // Los campos que se llenaron con lectura débil se nombran uno por uno.
  // Todos vienen completos, así que lo único que separa a la persona de un
  // dato equivocado es que sepa CUÁL mirar: "revisa todo" no funciona, se
  // lee como una fórmula. El RUT va siempre en la lista porque, aunque lo
  // valide su dígito verificador, medido sale mal 1 de cada 10 veces.
  const dudosos = [
    ...(datos.confianza_baja || []).map((c) => ETIQUETA_CAMPO_OCR[c] || c),
    datos.rut_proveedor && "RUT",
  ].filter(Boolean);
  // El monto se nombra aparte del resto de los faltantes: es obligatorio, y
  // cuando queda vacío no es que "no se pudo leer" sino que se leyó algo
  // que no era lo bastante confiable como para ponerlo. Decirlo así evita
  // que la persona crea que el lector no vio nada y busque el problema.
  const faltaMonto = !datos.monto;
  const otrosFaltantes = faltan.filter((f) => f !== ETIQUETA_CAMPO_OCR.monto);
  statusEl.textContent = `El bot recuperó datos con el escáner local. Compara los campos con el comprobante.`
    + (datos.monto_verificado ? " El monto sí quedó confirmado contra el propio documento." : "")
    + (faltaMonto ? " El monto necesita confirmación: no se encontró evidencia suficiente. Escríbelo mirando el comprobante." : "")
    + (otrosFaltantes.length ? ` Completa a mano: ${otrosFaltantes.join(", ")}.` : "")
    + (dudosos.length
      ? ` Revisa: ${[...new Set(dudosos)].join(", ")}.`
      : "");
  statusEl.className = "ocr-status show";
  return true;
}

// Misma IA que en "Con documento", pero para "Gasto directo" (boletas
// comunes que van directo al gasto): solo autocompleta monto y descripción,
// que es lo único que ese formulario tiene y lo único que se puede leer con
// certeza de una boleta (la categoría/CC las define la persona).
// Busca en QUÉ categorías esta misma persona clasificó antes compras al
// mismo proveedor (comparación por nombre, sin distinguir mayúsculas --
// "Gasto directo" no siempre tiene RUT del proveedor, solo el nombre que
// se tipeó o que leyó el OCR). Solo mira las rendiciones del propio
// usuario (RLS igual lo exigiría del lado del servidor).
async function buscarHistorialCategoriasProveedor(nombreProveedor) {
  if (!nombreProveedor || !nombreProveedor.trim()) return [];
  const { data, error } = await db
    .from("rendicion_items")
    .select("categoria, rendiciones!inner(empleado_id)")
    .eq("tipo_item", "SinDocumento")
    .eq("rendiciones.empleado_id", currentUser.id)
    .ilike("nombre_proveedor", nombreProveedor.trim())
    .not("categoria", "is", null);
  if (error) { console.error("Error buscando historial de proveedor:", error); return []; }
  return data || [];
}

// Muestra el aviso de historial -- NO cambia el <select> de categoría ni
// nada más, es puramente informativo. Con 0 o 1 antecedente no hay ningún
// patrón real que mostrar, así que no se dice nada (evita ruido).
async function mostrarHistorialProveedor(id, nombreProveedor) {
  const hint = document.getElementById(`${id}-historial-hint`);
  if (!hint) return;
  hint.className = "ocr-status";
  hint.textContent = "";
  const historial = await buscarHistorialCategoriasProveedor(nombreProveedor);
  if (historial.length < 2) return;
  const conteo = {};
  historial.forEach((h) => { conteo[h.categoria] = (conteo[h.categoria] || 0) + 1; });
  const resumen = Object.entries(conteo).sort((a, b) => b[1] - a[1]).map(([cat, n]) => `${cat} (${n})`).join(", ");
  hint.textContent = `📋 Antes clasificaste compras de "${nombreProveedor}" como: ${resumen}. Elige la que corresponda esta vez, no siempre es la misma.`;
  hint.className = "ocr-status show";
}

// Par de aplicarResultadoOcrCon, para "Boleta" (Gasto directo) -- ver el
// comentario de aquella.
async function aplicarResultadoOcrSin(id, data, gen) {
  if (!esGeneracionVigenteOcr(id, gen)) return {estado:"obsoleto"};
  if (data.requiere_separacion) {const estado=document.querySelector(`#${id} .ocr-status`);if(estado){estado.textContent=data.aviso_documento;estado.className="ocr-status show err";}ocrBloqueado.add(id);return {estado:"requiere_separacion",mensaje:data.aviso_documento};}
  if (!esGeneracionVigenteOcr(id, gen)) return;
  mostrarVerificacionOcr(id, data);
  data = protegerEdicionOcr(id, data);
  aplicarConflictosOcr(id,data);
  ocrExitoso.set(id, true);
  if (data.nombre_proveedor) {
    document.getElementById(`${id}-nombreprov2`).value = data.nombre_proveedor;
    mostrarHistorialProveedor(id, data.nombre_proveedor);
  }
  if (data.descripcion) document.getElementById(`${id}-desc2`).value = data.descripcion;
  const montoIA2 = montoValidoCLP(data.monto);
  // En dólares, el monto en pesos se calcula: lo leído es el monto en USD y
  // la persona lo confirma en su campo (un "$9.00" no son 900 pesos).
  if (montoIA2 && document.getElementById(`${id}-moneda`)?.value !== "USD") document.getElementById(`${id}-monto2`).value = montoIA2.toLocaleString("es-CL");
  // Datos del documento, informativos. A diferencia de "Documento
  // electrónico", acá el tipo es texto libre: por esta pestaña entra
  // cualquier cosa (boleta, voucher, comprobante de transferencia, recibo)
  // y encajonarlo en una lista cerrada obligaría a descartar lo que no
  // calce, que es justo lo que hacía que no se leyera nada de ellos.
  if (data.tipo_documento) document.getElementById(`${id}-tipodoc2`).value = data.tipo_documento;
  if (data.nro_documento) document.getElementById(`${id}-folio2`).value = data.nro_documento;
  if (data.rut_proveedor) document.getElementById(`${id}-rut2`).value = formatearRut(data.rut_proveedor);
  if (data.fecha) document.getElementById(`${id}-fecha2`).value = data.fecha;
  // La categoría sugerida solo se aplica si existe tal cual en el
  // desplegable (puede estar filtrado por las cuentas permitidas del
  // usuario) -- el campo queda igual visible y editable para que la
  // persona la confirme o la cambie, nunca se oculta.
  if (data.categoria_sugerida) {
    const catSelect = document.getElementById(`${id}-categoria`);
    if (catSelect && [...catSelect.options].some((o) => o.value === data.categoria_sugerida)) {
      catSelect.value = data.categoria_sugerida;
      catSelect.dispatchEvent(new Event("change"));
    }
  }
  if (esGeneracionVigenteOcr(id, gen)) { recalcTotal(); chequearDuplicadoHistorico(id); }
  return estadoLecturaFormulario(id,true,data);
}

async function analizarComprobanteGastoDirecto(id, file, statusEl) {
  const esReintento=ocrArchivoActual.get(id)===file;
  const gen = nuevaGeneracionOcr(id,esReintento);
  ocrArchivoActual.set(id,file);
  mostrarVerificacionOcr(id,{});
  if(!esReintento)limpiarCamposDeComprobante([`${id}-nombreprov2`, `${id}-desc2`, `${id}-monto2`, `${id}-categoria`, `${id}-cuenta`, `${id}-tipodoc2`, `${id}-folio2`, `${id}-rut2`, `${id}-fecha2`]);
  statusEl.textContent = "🪄 Analizando comprobante...";
  statusEl.className = "ocr-status show";
  try {
    // Igual que en "Documento electrónico": si es un PDF con texto, se lee
    // local (gratis, al instante, sin gastar cuota de Gemini). Este
    // formulario no tiene campos de RUT/folio/tipo, pero el RUT leído
    // igual sirve para resolver proveedor, categoría y descripción.
    const datosLocales = await leerPdfLocal(file);
    if (datosLocales) {
      const contable = await resolverDatosContables(datosLocales.rut_proveedor, datosLocales.nombre_proveedor);
      if (!esGeneracionVigenteOcr(id, gen)) return;
      const { datos } = fusionarLecturas(datosLocales, null, contable);
      registrarOrigenOcr(id, "local", datos);
      const revisionLocal=await aplicarResultadoOcrSin(id, datos, gen);
      if (!esGeneracionVigenteOcr(id, gen)) return;

      // Si el PDF resultó ser una factura/boleta de honorarios, lo más
      // probable es que corresponda la otra pestaña: esos documentos se
      // contabilizan distinto (ver CUENTA_POR_TIPO_DOC y la exportación a
      // Kame), así que conviene avisar antes de que se envíe mal.
      const esDocumentoTributario = datos.tipo_documento && /Factura|Honorario/i.test(datos.tipo_documento);
      const textoBase = esDocumentoTributario
        ? `✔ Datos leídos del PDF. Ojo: parece ser un(a) ${datos.tipo_documento}, que normalmente va en la pestaña "Documento electrónico". Revísalo antes de enviar.`
        : "✔ Datos leídos del PDF. Revísalos antes de enviar.";
      statusEl.textContent = textoBase+" "+(revisionLocal?.mensaje || "");
      statusEl.className = "ocr-status show " + (revisionLocal?.estado === "completo" ? "ok" : "err");

      // Se pide a la IA solo lo que ESTE formulario puede mostrar: pedirle
      // folio o tipo de documento acá sería gastar cuota en campos que no
      // existen en pantalla.
      if (valeLaPenaLlamarIA(camposAPedirOcr(datos, CAMPOS_OCR_SIN))) {
        completarConIA({ id, file, gen, statusEl, local: datosLocales, contable, datos,
          campos: CAMPOS_OCR_SIN, aplicar: aplicarResultadoOcrSin, textoBase });
      }
      return;
    }

    const ia = await llamarOcrRecibo(file, CAMPOS_OCR_SIN, {}, "SinDocumento");
    if (!esGeneracionVigenteOcr(id, gen)) return; // ya hay una llamada más nueva para este ítem en curso
    const contableIA = await resolverDatosContables(ia?.rut_proveedor, ia?.nombre_proveedor);
    if (!esGeneracionVigenteOcr(id, gen)) return;
    const { datos: datosIA } = fusionarLecturas(null, ia, contableIA);
    registrarOrigenOcr(id, "ia", datosIA);
    const revision = await aplicarResultadoOcrSin(id, datosIA, gen);
    if(ia.previaId)dispararAgenteYEsperar(id,ia.previaId,gen,(data,g)=>aplicarResultadoOcrSin(id,data,g),statusEl);
    if (!esGeneracionVigenteOcr(id, gen)) return;

    statusEl.textContent = revision?.mensaje || "Revisa los campos pendientes.";
    statusEl.className = "ocr-status show " + (revision?.estado === "completo" ? "ok" : "err");
  } catch (err) {
    if (err.noReintentar) {if (esGeneracionVigenteOcr(id,gen)) {ocrBloqueado.add(id);statusEl.textContent=err.message;statusEl.className="ocr-status show err";} return;}
    if (!esGeneracionVigenteOcr(id, gen)) return; // idem: una llamada más nueva ya se hizo cargo de este ítem
    console.error("Error en OCR:", err);
    // Mismo respaldo que en "Documento electrónico": una foto sin IA
    // disponible se lee acá antes de darse por vencido.
    if (await aplicarRespaldoFoto(id, file, gen, statusEl, aplicarResultadoOcrSin, CAMPOS_OCR_SIN)) {
      dispararAgenteYEsperar(id, err.previaId, gen, (data, g) => aplicarResultadoOcrSin(id, data, g), statusEl);
      return;
    }
    mostrarErrorOcr(statusEl, err, () => analizarComprobanteGastoDirecto(id, file, statusEl));
    dispararAgenteYEsperar(id, err.previaId, gen, (data, g) => aplicarResultadoOcrSin(id, data, g), statusEl);
  }
}

// Pone en "Cuenta contable" la cuenta de gasto que corresponde a la
// categoría elegida. Se llama tanto cuando la persona cambia el desplegable
// como cuando lo completa el OCR: asignar select.value por código NO dispara
// el evento "change", así que sin la llamada explícita una categoría
// sugerida por la IA dejaba la cuenta vacía.
function sincronizarCuentaDesdeCategoria(id) {
  const categoria = document.getElementById(`${id}-categoria`)?.value;
  const campoCuenta = document.getElementById(`${id}-cuenta`);
  if (!campoCuenta) return;
  const match = CATEGORIAS_GASTO.find((c) => c.nombre === categoria);
  // Si se vuelve a "— elegir —" se limpia: dejar la cuenta de la categoría
  // anterior sería peor que dejarla vacía, porque ya no se corresponde con
  // nada de lo que hay en pantalla.
  campoCuenta.value = match ? match.cuenta : "";
}

// ------------------------------------------------------------
// Gastos en dólares. El dólar observado del Banco Central lo guarda la base
// dos veces al día (tabla tipos_cambio, ver 20261113120000_rendir_en_dolares.sql);
// para un fin de semana o feriado se usa el último publicado antes.
// ------------------------------------------------------------
const dolarObservadoCache = new Map();
async function dolarObservadoPara(fechaISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO || "")) return null;
  if (!dolarObservadoCache.has(fechaISO)) {
    const { data, error } = await db.rpc("dolar_observado", { p_fecha: fechaISO });
    if (error) throw error;
    dolarObservadoCache.set(fechaISO, data || null);
  }
  return dolarObservadoCache.get(fechaISO);
}
const fmtUsd = (n) => Number(n).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTipoCambio = (n) => "$" + Number(n).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Con "Dólares": el monto en pesos queda calculado (USD x tipo de cambio) y no
// se escribe a mano. El tipo de cambio se propone solo con el dólar observado
// de la fecha del documento (o de la rendición) y se puede corregir si la
// cartola muestra otro cargo; corregido a mano, ya no se reemplaza.
function conectarMonedaGasto({ selMoneda, inpUsd, inpTc, rowUsd, tcHint, inpMonto, inpFecha }) {
  const core = window.RindeCore;
  const fechaReferencia = () => inpFecha?.value || document.getElementById("nr-fecha")?.value || new Date().toISOString().slice(0, 10);
  const recalcular = () => {
    if (selMoneda.value !== "USD") return;
    const usd = core.parseDecimal(inpUsd.value), tc = core.parseDecimal(inpTc.value);
    const clp = usd > 0 && tc >= 100 && tc <= 5000 ? core.pesosDesdeDolares(usd, tc) : null;
    inpMonto.value = clp ? clp.toLocaleString("es-CL") : "";
    const base = inpTc.dataset.texto || "";
    tcHint.textContent = (clp ? `USD ${fmtUsd(usd)} × ${fmtTipoCambio(tc)} = ${fmtCLP(clp)}. ` : "") + base;
    recalcTotal();
  };
  const proponer = async () => {
    if (selMoneda.value !== "USD") return;
    const fecha = fechaReferencia();
    inpTc.dataset.fecha = fecha;
    if (inpTc.value && inpTc.dataset.auto !== "1") { inpTc.dataset.texto = "Tipo de cambio escrito a mano."; recalcular(); return; }
    try {
      const d = await dolarObservadoPara(fecha);
      if (selMoneda.value !== "USD" || (inpTc.value && inpTc.dataset.auto !== "1")) return;
      if (d) {
        inpTc.value = Number(d.valor).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        inpTc.dataset.auto = "1"; inpTc.dataset.fecha = d.fecha;
        inpTc.dataset.texto = `Dólar observado del ${fmtDate(d.fecha)} (Banco Central). Si tu cartola muestra otro cargo, corrige el tipo de cambio.`;
      } else {
        inpTc.value = ""; delete inpTc.dataset.auto;
        inpTc.dataset.texto = `No hay dólar observado guardado para el ${fmtDate(fecha)}: escribe el tipo de cambio de tu cartola o del Banco Central.`;
      }
    } catch (error) {
      inpTc.dataset.texto = "No se pudo traer el dólar observado: escribe el tipo de cambio. " + (error?.message || "");
    }
    recalcular();
  };
  const aplicar = () => {
    const usd = selMoneda.value === "USD";
    rowUsd.hidden = !usd; tcHint.hidden = !usd;
    inpMonto.readOnly = usd;
    inpMonto.title = usd ? "Se calcula: monto en dólares × tipo de cambio" : "";
    if (usd) proponer();
    else { delete inpTc.dataset.auto; recalcTotal(); }
  };
  selMoneda.addEventListener("change", aplicar);
  inpUsd.addEventListener("input", recalcular);
  inpTc.addEventListener("input", () => { delete inpTc.dataset.auto; inpTc.dataset.texto = "Tipo de cambio escrito a mano."; recalcular(); });
  inpFecha?.addEventListener("change", proponer);
  document.getElementById("nr-fecha")?.addEventListener("change", proponer);
}

// Datos de moneda de un gasto "Comprobante/Boleta" para enviarlo, o un error.
function leerMonedaGasto(id, montoPesos) {
  if (document.getElementById(`${id}-moneda`)?.value !== "USD") return { datos: { moneda: "CLP" } };
  const usd = window.RindeCore.parseDecimal(document.getElementById(`${id}-usd`).value);
  const inpTc = document.getElementById(`${id}-tc`), tc = window.RindeCore.parseDecimal(inpTc.value);
  if (!(usd > 0)) return { error: "Falta el monto en dólares" };
  if (!(tc >= 100 && tc <= 5000)) return { error: "Revisa el tipo de cambio" };
  if (window.RindeCore.pesosDesdeDolares(usd, tc) !== montoPesos) return { error: "El monto en pesos no calza con dólares × tipo de cambio" };
  const fecha = inpTc.dataset.fecha || document.getElementById(`${id}-fecha2`)?.value || document.getElementById("nr-fecha")?.value;
  return { datos: { moneda: "USD", monto_original: usd, tipo_cambio: tc, fecha_tipo_cambio: fecha } };
}

function buildSinDocumentoFields(id) {
  const box = el("div", { class: "sin-documento" });
  const rowProv = el("div", { class: "field-row" }, [
    fieldInput(`${id}-nombreprov2`, "Proveedor / Local", "text"),
  ]);
  rowProv.querySelector("input").addEventListener("blur", (e) => mostrarHistorialProveedor(id, e.target.value));
  const row1 = el("div", { class: "field-row" }, [
    fieldSelectCategoria(`${id}-categoria`),
    fieldInput(`${id}-cuenta`, "Cuenta contable", "text", "4.01.03.xx"),
  ]);
  // La cuenta sale de la categoría, siempre: CATEGORIAS_GASTO ya trae el par
  // ("Electricidad" -> 4.01.03.06). Aun así este campo era texto libre y
  // había que tipear el código a mano, teniendo la app el dato exacto -- una
  // invitación a equivocarse en un número que después tiene que calzar en la
  // exportación a Kame. Queda editable igual, para el caso raro que no
  // corresponda a la categoría elegida.
  row1.querySelector("select").addEventListener("change", () => sincronizarCuentaDesdeCategoria(id));
  // Aviso informativo (no una regla automática): un mismo proveedor puede
  // ser para cosas distintas cada vez (ej. una ferretería: a veces
  // materiales, a veces mantención), así que en vez de forzar la
  // categoría más repetida, se muestra el historial real de ESTA persona
  // con ESTE proveedor y la persona decide con ese contexto de más.
  const historialHint = el("p", { class: "ocr-status", id: `${id}-historial-hint` });
  // El Centro de Costo por defecto es el que se eligió en el encabezado de
  // la rendición (campo "nr-cc"), pero queda editable por ítem: una misma
  // empresa puede tener boletas de sedes distintas dentro de una misma
  // rendición (ej. bencina en Chicureo y materiales en Mall Sport).
  const empresaActual = document.getElementById("nr-empresa")?.value || EMPRESAS[0];
  const opcionesCC = CENTROS_COSTO_POR_EMPRESA[empresaActual] || ["Casa Matriz"];
  const ccHeaderActual = document.getElementById("nr-cc")?.value;
  const row2 = el("div", { class: "field-row" }, [
    fieldSelect(`${id}-cc`, "Centro de Costo (Unidad de Negocio)", opcionesCC),
    fieldInputMoney(`${id}-monto2`, "Monto"),
  ]);
  row2.querySelector("select").value = opcionesCC.includes(ccHeaderActual) ? ccHeaderActual : opcionesCC[0];
  // Gasto en dólares (comprobantes extranjeros: Netlify, software, viajes). El
  // monto en pesos se calcula: USD x dólar observado del día (ver conectarMonedaGasto).
  const selMoneda = el("select", { id: `${id}-moneda` }, [el("option", { value: "CLP" }, "Pesos (CLP)"), el("option", { value: "USD" }, "Dólares (USD)")]);
  const inpUsd = el("input", { id: `${id}-usd`, type: "text", inputmode: "decimal", placeholder: "9,00" });
  const inpTc = el("input", { id: `${id}-tc`, type: "text", inputmode: "decimal", placeholder: "979,88" });
  const rowMoneda = el("div", { class: "field-row" }, [el("div", { class: "field" }, [el("label", { for: selMoneda.id }, "Moneda del comprobante"), selMoneda])]);
  const rowUsd = el("div", { class: "field-row moneda-usd", hidden: "" }, [
    el("div", { class: "field" }, [el("label", { for: inpUsd.id }, "Monto en dólares (USD)"), inpUsd]),
    el("div", { class: "field" }, [el("label", { for: inpTc.id }, "Tipo de cambio ($ por USD)"), inpTc]),
  ]);
  const tcHint = el("p", { class: "ocr-status show", id: `${id}-tc-hint`, hidden: "" });
  const row3 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-desc2`, "Descripción", "text"),
  ]);
  // Datos del documento, TODOS opcionales y puramente informativos: sirven
  // para que quien aprueba pueda contrastar el ítem contra el comprobante
  // adjunto sin abrirlo, y el RUT además destraba la sugerencia de categoría
  // desde el historial contable, que hasta ahora solo funcionaba para
  // facturas porque esta pestaña no capturaba ningún RUT.
  //
  // Lo que NO cambian es la contabilidad: una boleta, un comprobante de
  // transferencia o un voucher siguen yendo DIRECTO A LA CUENTA DE GASTO
  // (4.01.03.xx, el campo "Cuenta contable" de más arriba). No generan
  // cuenta por pagar ni ficha de proveedor, que es lo que distingue a esta
  // pestaña de "Documento electrónico" (ver CUENTA_POR_TIPO_DOC). Tener el
  // RUT acá no convierte al comprobante en un documento tributario.
  const row4 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-tipodoc2`, "Tipo de documento (opcional)", "text"),
    fieldInput(`${id}-folio2`, "N° de documento (opcional)", "text"),
  ]);
  const row5 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-rut2`, "RUT del proveedor (opcional)", "text"),
    fieldInput(`${id}-fecha2`, "Fecha del documento (opcional)", "date"),
  ]);
  const foto = fieldFile(`${id}-foto2`, "Comprobante (foto o PDF)");
  const ocrStatus = el("p", { class: "ocr-status", id: `${id}-ocr-status2` });
  foto.appendChild(ocrStatus);

  box.appendChild(rowProv);
  box.appendChild(row1);
  box.appendChild(historialHint);
  box.appendChild(row2);
  box.appendChild(rowMoneda);
  box.appendChild(rowUsd);
  box.appendChild(tcHint);
  box.appendChild(row3);
  box.appendChild(row4);
  box.appendChild(row5);
  box.appendChild(foto);
  conectarMonedaGasto({ selMoneda, inpUsd, inpTc, rowUsd, tcHint, inpMonto: row2.querySelector("input"), inpFecha: row5.querySelector('input[type="date"]') });

  const fotoInput2 = foto.querySelector("input[type=file]");
  fotoInput2.addEventListener("change", async () => {
    if (!validarTamanoArchivo(fotoInput2)) return;
    nuevaGeneracionOcr(id);
    await prepararArchivoParaLectura(fotoInput2,ocrStatus,file => analizarComprobanteGastoDirecto(id,file,ocrStatus));
  });

  const catSelect = row1.querySelector("select");
  const cuentaInput = row1.querySelector("input");
  // La cuenta contable se deriva de la categoría elegida: el empleado no la
  // escribe a mano (así la restricción de cuentas del admin no se puede saltar
  // tipeando cualquier código). Solo se habilita si elige "Otro" explícitamente.
  const actualizarCuenta = () => {
    const found = CATEGORIAS_GASTO.find((c) => c.nombre === catSelect.value);
    const esManual = !!found && found.cuenta === "";
    cuentaInput.readOnly = !esManual;
    cuentaInput.value = esManual ? "" : (found ? found.cuenta : "");
  };
  catSelect.addEventListener("change", actualizarCuenta);
  actualizarCuenta();

  [row1, row2, row3].forEach((r) =>
    r.querySelectorAll("input:not([data-money])").forEach((i) => i.addEventListener("input", recalcTotal))
  );
  return box;
}

function fieldInput(id, label, type, placeholder = "") {
  return el("div", { class: "field" }, [
    el("label", { for: id }, label),
    el("input", { id, type, placeholder }),
  ]);
}
// Formatea en vivo un <input> de plata con puntos de miles ("1.234.567"),
// conservando solo los dígitos escritos -- usado por fieldInputMoney y por
// cualquier otro campo de monto suelto (ej. "sf-monto" en Solicitar
// fondos) que antes reimplementaba esta misma lógica de forma idéntica.
function formatearInputMoney(input) {
  const raw = input.value.replace(/\D/g, "");
  input.value = raw ? Number(raw).toLocaleString("es-CL") : "";
}
function fieldInputMoney(id, label) {
  const input = el("input", { id, type: "text", inputmode: "numeric", placeholder: "0", "data-money": "true" });
  input.addEventListener("input", () => {
    formatearInputMoney(input);
    recalcTotal();
  });
  return el("div", { class: "field" }, [el("label", { for: id }, label), input]);
}
// Mismo límite que el bucket "comprobantes" en Supabase Storage (ver
// migracion_mejoras_v2.sql) -- avisar acá, ANTES de intentar subir o
// mandarlo a OCR, da un mensaje claro en vez de que la persona espere un
// buen rato en una conexión de campo (celular, terreno) para recién
// enterarse por un error crudo de la API que el archivo era muy pesado.
// Reescala/recomprime una foto ANTES de usarla para OCR y para subirla a
// Storage -- se comprime una sola vez y el mismo archivo comprimido sirve
// para las dos cosas (antes se mandaba la foto completa dos veces por la
// red del usuario: una en base64 al OCR, otra al subir el original a
// Storage -- el doble de datos móviles por el mismo comprobante). Los PDF
// no se tocan (no se pueden procesar con canvas). Si algo falla (formato
// raro, navegador sin soporte), se usa el archivo original tal cual --
// nunca bloquea el flujo de carga por esto.
async function comprimirImagenSiCorresponde(file) {
  if (!file.type || !file.type.startsWith("image/") || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const LADO_MAXIMO = 2600;
    const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * escala);
    const h = Math.round(bitmap.height * escala);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const contexto = canvas.getContext("2d");
    contexto.fillStyle = "#fff"; contexto.fillRect(0,0,w,h);
    contexto.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    if (!blob || blob.size >= file.size) return file; // no vale la pena si no achica
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (err) {
    console.error("No se pudo comprimir la imagen, se usa el archivo original:", err);
    return file;
  }
}

// Reemplaza el archivo de un <input type=file> por uno ya comprimido, para
// que tanto el OCR como submitRendicion() (que lee fotoInput.files[0] más
// tarde) usen la misma versión liviana. DataTransfer es la única forma
// estándar de reescribir la FileList de un input desde JS.
function evaluarCalidadFoto(ancho,alto,contraste) {
  const avisos=[];
  if(Math.min(ancho,alto)<600) avisos.push("La resolución es baja: usa una foto más cercana, con el documento completo.");
  if(contraste<12) avisos.push("La imagen tiene muy poco contraste: mejora la luz y comprueba que se lean los números.");
  return avisos;
}
async function mostrarCalidadFoto(input,file) {
  input.parentElement.querySelector(".calidad-foto")?.remove();
  if(!file.type?.startsWith("image/")) return;
  let bitmap;
  try {
    bitmap=await createImageBitmap(file);
    const canvas=document.createElement("canvas"),escala=Math.min(1,256/Math.max(bitmap.width,bitmap.height));
    canvas.width=Math.max(1,Math.round(bitmap.width*escala));canvas.height=Math.max(1,Math.round(bitmap.height*escala));
    const contexto=canvas.getContext("2d");contexto.fillStyle="#fff";contexto.fillRect(0,0,canvas.width,canvas.height);contexto.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const rgba=contexto.getImageData(0,0,canvas.width,canvas.height).data;let suma=0,cuadrados=0;
    for(let i=0;i<rgba.length;i+=4){const gris=0.299*rgba[i]+0.587*rgba[i+1]+0.114*rgba[i+2];suma+=gris;cuadrados+=gris*gris;}
    const n=rgba.length/4,contraste=Math.sqrt(Math.max(0,cuadrados/n-(suma/n)**2));
    const avisos=evaluarCalidadFoto(bitmap.width,bitmap.height,contraste);
    if(input.files?.[0]!==file)return;
    input.parentElement.querySelector(".calidad-foto")?.remove();
    if(avisos.length)input.parentElement.appendChild(el("p",{class:"calidad-foto ocr-status show err"},avisos.join(" ")+" Evita sombras y reflejos; vuelve a adjuntar una foto mejor si el texto no es legible."));
  } catch(error){console.warn("No se pudo revisar la calidad de la foto",error);}
  finally {bitmap?.close();}
}

async function reemplazarConVersionComprimida(input) {
  const original = input.files && input.files[0];
  if (!original) return;
  await mostrarCalidadFoto(input,original);
  const comprimido = await comprimirImagenSiCorresponde(original);
  if (input.files?.[0] !== original) return;
  if (comprimido === original) return;
  const dt = new DataTransfer();
  dt.items.add(comprimido);
  input.files = dt.files;
}

const TAMANO_MAXIMO_ARCHIVO = 15 * 1024 * 1024;
function validarTamanoArchivo(input) {
  const file = input.files && input.files[0];
  if (file && file.size > TAMANO_MAXIMO_ARCHIVO) {
    toast(`El archivo "${file.name}" pesa ${(file.size / 1024 / 1024).toFixed(1)}MB (máx. 15MB). Comprímelo o saca una foto de menor resolución.`);
    input.value = "";
    return false;
  }
  return true;
}
function fieldFile(id, label) {
  return el("div", { class: "field" }, [
    el("label", { for: id }, label),
    // capture="environment": en el celular, abre la cámara trasera directo
    // en vez del selector genérico (Cámara / Galería / Archivos) -- un
    // empleado parado frente al comprobante ahorra un tap cada vez que
    // carga un gasto. Si elige un PDF (no se puede "capturar" con cámara),
    // los navegadores igual dejan volver al selector normal de archivos.
    el("input", { id, type: "file", accept: "image/*,application/pdf", capture: "environment" }),
  ]);
}
function fieldSelect(id, label, options) {
  const select = el("select", { id }, options.map((o) => el("option", { value: o }, o)));
  return el("div", { class: "field" }, [el("label", { for: id }, label), select]);
}
function fieldSelectCategoria(id) {
  const filtradas = cuentasPermitidas
    ? CATEGORIAS_GASTO.filter((c) => cuentasPermitidas.has(c.cuenta))
    : CATEGORIAS_GASTO;
  const opciones = filtradas.length ? filtradas : CATEGORIAS_GASTO;
  // Primera opción en blanco, a propósito. Sin ella el desplegable arranca
  // preseleccionado en la primera categoría de la lista y submitRendicion la
  // guarda tal cual, así que todo ítem que nadie tocó se iba con esa
  // categoría. Peor: buscarDatosPreviosPorRut cuenta esas filas para sugerir
  // "la categoría más usada" del proveedor, con lo cual la sugerencia
  // terminaba convergiendo al valor por defecto y confirmándose sola.
  const select = el("select", { id }, [
    el("option", { value: "" }, "— elegir —"),
    ...opciones.map((c) => el("option", { value: c.nombre }, c.nombre)),
  ]);
  return el("div", { class: "field" }, [el("label", { for: id }, "Categoría del gasto"), select]);
}

// Nombres de columna reales de la tabla "movimientos" (proyecto de contabilidad, solo lectura).
const MOVIMIENTOS_COLS = {
  rutFicha: "ficha",
  razonSocial: "razon_social",
  folioDoc: "documento",
  cuentaCod: "cuenta_cod",
  cuentaNom: "cuenta_nom",
  concepto: "concepto",
  comprobante: "comprobante",
  empresa: "empresa",
  rutEmpresa: "rut",
};

// Busca el nombre del proveedor en la contabilidad (solo lectura, en vivo,
// nunca se copia nada a la base propia). Si ese RUT ya apareció antes en
// algún movimiento contable, usamos su razón social real en vez de confiar
// solo en lo que la IA alcanzó a leer de la foto.
async function buscarNombreProveedorPorRut(rut) {
  if (!rut || !dbContabilidad) return null;
  try {
    const { data, error } = await dbContabilidad
      .from("movimientos")
      .select(MOVIMIENTOS_COLS.razonSocial)
      .eq(MOVIMIENTOS_COLS.rutFicha, rut)
      .not(MOVIMIENTOS_COLS.razonSocial, "is", null)
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0][MOVIMIENTOS_COLS.razonSocial] || null;
  } catch {
    return null;
  }
}

// Verificación contra contabilidad: la hace quien aprueba, desde la pantalla de detalle
// (ver openDetalle). Actualiza el ítem en la base para dejar registrada la cuenta real.
function compararMontoContable(item, movimientos) {
  const cuentaProveedor = CUENTA_POR_TIPO_DOC[item.tipo_documento];
  const lineas = movimientos.filter(m => m.cuenta_cod === cuentaProveedor);
  const grupos = new Map();
  for (const m of lineas) {
    if (m.debe == null || m.haber == null || !Number.isFinite(Number(m.debe)) || !Number.isFinite(Number(m.haber))) return {estado:"sin_monto"};
    const clave = m.comprobante || "fila:"+m.id;
    grupos.set(clave,(grupos.get(clave)||0)+Number(m.haber)-Number(m.debe));
  }
  // Solo cuentan los comprobantes que dejan saldo ACREEDOR, es decir los que
  // registran la factura. Un asiento posterior que la cancela -- el pago, o
  // la propia rendición -- deja saldo deudor y no dice nada sobre cuánto
  // valía el documento.
  //
  // Antes se tomaban todos los comprobantes por igual y bastaba que hubiera
  // dos para devolver "ambiguo". Eso no es un caso raro: es el estado normal
  // de toda factura ya rendida. La #80559421 tiene el comprobante 859 con la
  // factura (haber 13.980) y el 866 con "RENDICION N° 23" cancelándola (debe
  // 13.980), así que la verificación fallaba justo en las que completaron el
  // proceso. Descartando los deudores queda un único origen y el monto se
  // puede confirmar.
  //
  // Se conserva la detección de ambigüedad donde sí importa: si DOS
  // comprobantes distintos abonan el mismo documento, está contabilizado dos
  // veces y eso hay que mirarlo a mano.
  const acreedores = [...grupos.values()].filter((saldo) => saldo > 0);
  if (!acreedores.length) return {estado:"sin_monto"};
  if (acreedores.length !== 1) return {estado:"ambiguo",cantidad:acreedores.length};
  const contable = acreedores[0];
  const rendido = Number(item.monto);
  if (!Number.isFinite(rendido) || !Number.isInteger(contable) || contable <= 0) return {estado:"sin_monto"};
  return {estado:contable===rendido ? "coincide" : "diferente",contable,rendido,diferencia:rendido-contable};
}

function detalleMontoVerificado(v) {
  return v.miembros?.length > 1
    ? "Total documento revisado: " + fmtCLP(v.monto_documento_rendido) + " en " + v.miembros.length + " gastos · Este gasto: " + fmtCLP(v.monto_rendido)
    : "Monto revisado: " + fmtCLP(v.monto_rendido);
}

// Texto exacto que contabilidad guarda en "documento" (ej. "Factura Electrónica
// #37896"). Un mismo proveedor puede repetir el número de folio con otro tipo
// (una factura exenta #1 y una afecta #1), así que buscar solo "%#folio"
// mezclaba documentos distintos. El folio va sin ceros a la izquierda (el SII
// los numera como entero y contabilidad guarda "#3191702" aunque el papel diga
// "003191702") y sin comodines de LIKE.
function patronDocumentoContable(tipoDocumento, nroDocumento) {
  const folio = String(nroDocumento ?? "").trim().replace(/^0+(?=\d)/, "").replace(/[\\%_]/g, "\\$&");
  return `${tipoDocumento} #${folio}`;
}

function textoNotasCredito(ncs) {
  return "⚠ El proveedor tiene " + (ncs.length > 1 ? ncs.length + " notas de crédito" : "una nota de crédito") + " por un monto casi igual: "
    + ncs.map((nc) => "NC #" + nc.folio + " por " + fmtCLP(nc.monto) + (nc.fecha ? " (" + fmtDate(nc.fecha) + ")" : "")).join(", ")
    + ". Revisa si anula esta factura antes de aprobar.";
}

async function verificarDocumentoItem(item, box, empresaRendicion, itemsRendicion = [item]) {
  box.className = "verify-box show";
  box.textContent = "Consultando...";

  if (!dbContabilidad) {
    box.className = "verify-box show err";
    box.textContent = "Falta conectar el Supabase de contabilidad (solo lectura).";
    return;
  }

  try {
    // SOLO LECTURA: un simple select, nunca se escribe en el proyecto de contabilidad.
    // El folio NO alcanza por sí solo: cada proveedor lleva su propia
    // numeración, así que dos proveedores distintos pueden compartir el
    // mismo número de folio. Para estar 100% seguros de que es EL documento
    // correcto exigimos las tres cosas juntas: RUT empresa + RUT proveedor +
    // Folio. Además "documento" guarda el texto completo del documento
    // (ej. "Factura Electrónica #115277"), así que se busca ese texto exacto
    // (ver patronDocumentoContable): "277" no debe matchear "#115277" ni una
    // factura exenta con el mismo número.
    const rutEmpresa = RUT_POR_EMPRESA[empresaRendicion];
    if (!rutEmpresa) throw new Error("Falta identificar el RUT de la empresa de la rendición");
    // El nombre comercial puede diferir de la razón social: NEO SPA y
    // Neo Gym Chile SpA tienen el mismo RUT. No ampliar a otras empresas.
    const consultar = async (rut) => {
      let query = dbContabilidad.from("movimientos").select("*",{count:"exact"})
        .eq(MOVIMIENTOS_COLS.rutFicha, item.rut_proveedor)
        .ilike(MOVIMIENTOS_COLS.folioDoc, patronDocumentoContable(item.tipo_documento, item.nro_documento));
      if (rut) query = query.eq(MOVIMIENTOS_COLS.rutEmpresa, rut);
      const {data,error,count} = await query.limit(500);
      if (error) throw error;
      if (count != null && count > (data || []).length) throw new Error("Resultado contable incompleto");
      return data || [];
    };
    const data = await consultar(rutEmpresa);
    // Conservar el diagnóstico de documentos registrados en otra empresa,
    // sin usar esos asientos para validar el monto de esta rendición.
    const otrasEmpresas = !data.length ? [...new Set((await consultar(null)).map(m => m.empresa || "Empresa sin nombre"))] : [];

    const match = data && data[0];
    const grupo = window.RindeCore.grupoDocumentoContable(item,itemsRendicion);
    const comparacionMonto = match ? compararMontoContable({...item,monto:grupo.monto},data) : null;
    const lineaProveedor = data?.find(m => m.cuenta_cod === CUENTA_POR_TIPO_DOC[item.tipo_documento]);
    const cuenta = CUENTA_POR_TIPO_DOC[item.tipo_documento];
    const nombreCuentaVerificada = lineaProveedor?.[MOVIMIENTOS_COLS.cuentaNom] || nombreCuenta(cuenta) || "Nombre no disponible";
    const comprobante = lineaProveedor?.[MOVIMIENTOS_COLS.comprobante] || null;
    // Una factura puede venir anulada por una nota de crédito (N° 68): la NC
    // no dice qué factura anula, así que se buscan las del mismo proveedor y
    // empresa por un monto casi igual y cerca en fecha (notasCreditoCercanas).
    // Si la consulta falla, la verificación sigue igual, sin aviso de NC.
    let notasCredito = [];
    if (match) {
      try {
        // El concepto siempre trae el documento ("Nota de Crédito Electrónica #59532, ficha ...").
        const {data:ncs,error:errorNc} = await dbContabilidad.from("movimientos")
          .select("fecha, documento, concepto, debe, haber, comprobante")
          .eq(MOVIMIENTOS_COLS.rutFicha, item.rut_proveedor).eq(MOVIMIENTOS_COLS.rutEmpresa, rutEmpresa)
          .ilike(MOVIMIENTOS_COLS.concepto, "%Nota de Cr%").limit(200);
        if (errorNc) throw errorNc;
        notasCredito = window.RindeCore.notasCreditoCercanas(ncs, { monto: comparacionMonto?.contable ?? grupo.monto, fecha: match.fecha || item.fecha_vencimiento });
      } catch (errorNc) { notasCredito = []; console.error("No se pudieron revisar notas de crédito:", errorNc?.message || errorNc); }
    }

    // Escribir primero, mostrar el resultado recién si de verdad quedó
    // guardado -- antes se pintaba el ✔ aunque el update no hubiera tocado
    // ninguna fila (RLS bloqueándolo en silencio), y al recargar la página
    // el ítem volvía a aparecer sin verificar sin ninguna explicación.
    const res = await updateChecked("rendicion_items", item.id, {
      existe_en_contabilidad: !!match,
      cuenta_contable: cuenta,
      comprobante_contable_encontrado: comprobante,
      verificacion_contable: {empresa_revisada:empresaRendicion || null,rut_empresa:rutEmpresa,empresa_contable:lineaProveedor?.empresa || null,otras_empresas:otrasEmpresas,estado:comparacionMonto?.estado || (otrasEmpresas.length ? "empresa_distinta" : "no_encontrado"),monto_rendido:Number(item.monto),monto_documento_rendido:grupo.monto,miembros:grupo.miembros,monto_contable:comparacionMonto?.contable ?? null,diferencia:comparacionMonto?.diferencia ?? null,cuenta,nombre_cuenta:nombreCuentaVerificada,comprobante,notas_credito:notasCredito,rut_proveedor:item.rut_proveedor,tipo_documento:item.tipo_documento,nro_documento:item.nro_documento},
    });
    if (!res.ok) {
      box.className = "verify-box show err";
      box.textContent = res.mensaje;
      return;
    }
    item.existe_en_contabilidad = !!match;
    item.cuenta_contable = cuenta;
    item.verificacion_contable = res.data?.[0]?.verificacion_contable || null;

    box.className = "verify-box show " + (!match ? "no" : comparacionMonto.estado === "coincide" && !notasCredito.length ? "ok" : "err");
    box.textContent = !match ? (otrasEmpresas.length ? "⚠ Documento registrado en otra empresa: "+otrasEmpresas.join(", ")+". No se confirmó el monto para "+empresaRendicion+"." : "✘ Todavía no aparece registrada en contabilidad. El monto no se pudo comprobar.")
      : comparacionMonto.estado === "coincide" ? "✔ Documento encontrado · " + (grupo.miembros.length>1 ? "Suma de "+grupo.miembros.length+" gastos coincide: " : "Monto coincide: ") + fmtCLP(comparacionMonto.contable) + (grupo.miembros.length>1 ? " · Este gasto: "+fmtCLP(item.monto) : "") + " · Cuenta " + cuenta + " · " + nombreCuentaVerificada
      : comparacionMonto.estado === "diferente" ? "⚠ Documento encontrado, pero el monto difiere. Rendido: " + fmtCLP(comparacionMonto.rendido) + ". Contabilidad: " + fmtCLP(comparacionMonto.contable) + ". Diferencia: " + fmtCLP(comparacionMonto.diferencia) + ". Si distribuiste la factura entre varios gastos, revisa la suma de esas partes."
      : comparacionMonto.estado === "ambiguo" ? "⚠ Documento encontrado en varios comprobantes contables. No se puede confirmar un único monto; revisa los registros."
      : "⚠ Documento encontrado, pero no hay un monto contable del proveedor que pueda confirmarse. Revisa el comprobante.";
    if (notasCredito.length) box.textContent += " " + textoNotasCredito(notasCredito);
  } catch (err) {
    console.error("verificarDocumentoItem:", err);
    box.className = "verify-box show err";
    box.textContent = "No se pudo verificar el documento ni el monto" + (err?.message ? ` (${err.message})` : "") + ". Intenta nuevamente o revisa el registro en contabilidad.";
  }
}

function recalcTotal() {
  let total = 0;
  document.querySelectorAll(".item-card").forEach((card) => {
    const id = card.id;
    const isCon = card.querySelector(`[data-tipo="ConDocumento"]`).classList.contains("active");
    const val = isCon
      ? document.getElementById(`${id}-monto`)?.value
      : document.getElementById(`${id}-monto2`)?.value;
    total += parseMoneyValue(val);
  });
  document.getElementById("nr-total").textContent = fmtCLP(total);
  actualizarFondosFormulario();
}

async function submitRendicion() {
  if(enviandoRendicion) return;
  if (document.querySelector('#items-container input[data-pagina-pendiente="true"]')) {toast("Selecciona y confirma el comprobante de cada PDF antes de enviar la rendición.");return;}
  const cards = Array.from(document.querySelectorAll(".item-card"));
  if (!cards.length) { toast("Agrega al menos un ítem."); return; }

  const fecha = document.getElementById("nr-fecha").value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)){toast("Selecciona la fecha de la rendición.");return;}
  const tipoRendicion = document.getElementById("nr-tipo").value;
  const comentario = document.getElementById("nr-comentario").value.trim();
  const empresaRendicion = document.getElementById("nr-empresa").value;
  const centroCostoRendicion = document.getElementById("nr-cc").value;

  const items = [];
  for (const [idx, card] of cards.entries()) {
    const id = card.id;
    if (ocrBloqueado.has(id)) {toast(`El Ítem ${idx+1} requiere separar o cambiar el comprobante antes de enviar.`);return;}
    if (conflictosSinConfirmar(id).length) {toast(`Confirma los campos contradictorios del Ítem ${idx+1} mirando el comprobante y escribiendo su valor.`);return;}
    const isCon = card.querySelector(`[data-tipo="ConDocumento"]`).classList.contains("active");
    if (isCon) {
      const monto = parseMoneyValue(document.getElementById(`${id}-monto`).value);
      const tipoDoc = document.getElementById(`${id}-tipodoc`).value;
      const fotoInput = document.getElementById(`${id}-foto`);
      if (!monto) {
        // Una tarjeta de ítem completamente vacía (sin monto ni comprobante)
        // se ignora en silencio -- es solo un ítem extra que la persona no
        // llegó a usar. Pero si ya adjuntó el comprobante y dejó el monto en
        // blanco, avisamos en vez de descartar el ítem sin que se entere.
        if (fotoInput.files.length) { toast(`Falta el monto del Ítem ${idx + 1}.`); return; }
        continue;
      }
      if (!fotoInput.files.length) {
        toast(`Falta adjuntar el comprobante del Ítem ${idx + 1}.`);
        return;
      }
      const rutProveedor = document.getElementById(`${id}-rut`).value.trim();
      if (rutProveedor && !validarRut(rutProveedor)) {
        toast(`El RUT del proveedor del Ítem ${idx + 1} no es válido.`);
        return;
      }
      if (!window.RindeCore.folioDocumentoValido(document.getElementById(`${id}-folio`).value)) {
        toast(MENSAJE_FOLIO_INVALIDO(idx + 1));
        document.getElementById(`${id}-folio`).focus();
        return;
      }
      items.push({
        tipo_item: "ConDocumento",
        nombre_proveedor: document.getElementById(`${id}-nombreprov`).value.trim(),
        rut_proveedor: rutProveedor,
        tipo_documento: tipoDoc,
        nro_documento: document.getElementById(`${id}-folio`).value.trim(),
        fecha_vencimiento: document.getElementById(`${id}-venc`).value || null,
        // La verificación real contra contabilidad la hace el aprobador (ver openDetalle);
        // acá solo dejamos la cuenta por defecto según el tipo de documento.
        cuenta_contable: CUENTA_POR_TIPO_DOC[tipoDoc],
        comprobante_contable_encontrado: null,
        existe_en_contabilidad: null,
        empresa: empresaRendicion,
        centro_costo: document.getElementById(`${id}-cccon`)?.value?.trim() || centroCostoRendicion,
        categoria: document.getElementById(`${id}-categoriacon`)?.value || null,
        monto,
        descripcion: document.getElementById(`${id}-desc`).value.trim(),
        // Si el OCR en vivo nunca completó este ítem con éxito Y todavía
        // falta algún dato que el agente pueda aportar, queda en cola para
        // que ocr-reintento-pendientes lo siga intentando en segundo plano
        // (ver estadoReintentoOcr más arriba).
        ocr_reintento_estado: estadoReintentoOcr(id, [
          document.getElementById(`${id}-nombreprov`).value.trim(),
          rutProveedor,
          document.getElementById(`${id}-folio`).value.trim(),
          document.getElementById(`${id}-desc`).value.trim(),
        ]),
        ocr_origen: ocrOrigen.get(id) || null,
        monto_verificado: montoSigueVerificado(id, monto),
        _fotoInput: fotoInput,
      });
    } else {
      const monto = parseMoneyValue(document.getElementById(`${id}-monto2`).value);
      const fotoInput2 = document.getElementById(`${id}-foto2`);
      if (!monto) {
        if (fotoInput2.files.length) { toast(`Falta el monto del Ítem ${idx + 1}.`); return; }
        continue;
      }
      if (!fotoInput2.files.length) {
        toast(`Falta adjuntar el comprobante del Ítem ${idx + 1}.`);
        return;
      }
      // El RUT es opcional acá, pero si se escribió (o lo leyó el OCR de una
      // foto, que se puede equivocar) tiene que ser válido: guardar un RUT
      // mal formado es peor que no guardarlo, porque después se cruza contra
      // contabilidad y no calza con nada sin que se sepa por qué.
      const rutSinDoc = document.getElementById(`${id}-rut2`).value.trim();
      if (rutSinDoc && !validarRut(rutSinDoc)) {
        toast(`El RUT del proveedor del Ítem ${idx + 1} no es válido.`);
        return;
      }
      const monedaGasto = leerMonedaGasto(id, monto);
      if (monedaGasto.error) { toast(`${monedaGasto.error} del Ítem ${idx + 1}.`); return; }
      items.push({
        tipo_item: "SinDocumento",
        ...monedaGasto.datos,
        nombre_proveedor: document.getElementById(`${id}-nombreprov2`).value.trim() || null,
        // Informativos: quien aprueba los contrasta contra el adjunto sin
        // abrirlo. NO cambian el asiento -- cuenta_contable sigue siendo la
        // cuenta de GASTO que eligió la persona, nunca la cuenta por pagar,
        // aunque el comprobante traiga RUT. Es la diferencia de fondo entre
        // esta pestaña y "Documento electrónico".
        rut_proveedor: rutSinDoc || null,
        tipo_documento: document.getElementById(`${id}-tipodoc2`).value.trim() || null,
        nro_documento: document.getElementById(`${id}-folio2`).value.trim() || null,
        fecha_vencimiento: document.getElementById(`${id}-fecha2`).value || null,
        cuenta_contable: document.getElementById(`${id}-cuenta`).value.trim(),
        empresa: empresaRendicion,
        centro_costo: document.getElementById(`${id}-cc`).value.trim() || centroCostoRendicion,
        categoria: document.getElementById(`${id}-categoria`).value,
        monto,
        descripcion: document.getElementById(`${id}-desc2`).value.trim(),
        // Igual que en ConDocumento. Ahora esta pestaña sí tiene folio, RUT
        // y tipo, así que el agente tiene más huecos reales que llenar que
        // solo la descripción.
        ocr_reintento_estado: estadoReintentoOcr(id, [
          document.getElementById(`${id}-desc2`).value.trim(),
          document.getElementById(`${id}-nombreprov2`).value.trim(),
          rutSinDoc,
          document.getElementById(`${id}-folio2`).value.trim(),
        ]),
        ocr_origen: ocrOrigen.get(id) || null,
        monto_verificado: montoSigueVerificado(id, monto),
        _fotoInput: fotoInput2,
      });
    }
  }

  if (!items.length) { toast("Ingresa el monto de al menos un ítem."); return; }
  const duplicados = documentosDuplicados(items);
  if (duplicados.length) {
    actualizarAlertasDuplicados();
    const resumen = duplicados.map((grupo) => grupo.map((i) => i + 1).join(", ")).join("; ");
    if (!confirm("El mismo documento aparece más de una vez (ítems " + resumen + "). ¿Confirmas que es una distribución entre centros de costo y que los montos suman el total real de cada documento?")) return;
  }
  const hayItemsPendientesOcr = items.some((it) => it.ocr_reintento_estado === "pendiente");

  let solicitudFondoId = null, fondosRendicion = null;
  if (tipoRendicion === "FondoPorRendir") {
    const fondos = leerFondosFormulario();
    const errorFondos = window.RindeCore.validarFondosRendicion(fondos, items.reduce((s, it) => s + Number(it.monto || 0), 0));
    if (errorFondos) { toast(errorFondos); return; }
    solicitudFondoId = fondos[0].id;
    if (fondos.length > 1) fondosRendicion = fondos;
  }

  const btn = document.getElementById("btn-guardar-rendicion");
  enviandoRendicion = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Guardando...';

  try {
    const vistos = new Set();
    for (const item of items) {
      const clave = window.RindeCore.claveDocumento(item);
      if (!clave || vistos.has(clave)) continue;
      vistos.add(clave);
      const { data, error } = await db.rpc("buscar_documento_duplicado", { p_rut: item.rut_proveedor, p_nro: item.nro_documento, p_tipo: item.tipo_documento });
      if (error) throw new Error("No se pudo comprobar documentos duplicados. Vuelve a intentar antes de enviar.");
      if (data?.length && !confirm("El documento " + item.nro_documento + " ya aparece en la rendición N° " + data[0].folio + ". ¿Confirmas que corresponde enviarlo nuevamente?")) return;
    }
    // Varias rendiciones de un gasto cada una contra el mismo fondo (N° 69 a 74,
    // 2026-11) se revisan y se exportan por separado. Se avisa, sin bloquear.
    if (solicitudFondoId) {
      let q = db.from("rendiciones").select("folio").eq("empleado_id", currentUser.id).eq("estado", "Pendiente").eq("solicitud_fondo_id", solicitudFondoId);
      if (envioRendicionId) q = q.neq("id", envioRendicionId);
      const { data: pendientesFondo } = await q;
      if (pendientesFondo?.length && !confirm("Ya tienes " + (pendientesFondo.length > 1 ? pendientesFondo.length + " rendiciones pendientes" : "la rendición N° " + pendientesFondo[0].folio + " pendiente") + " contra este mismo fondo"
        + (pendientesFondo.length > 1 ? " (" + pendientesFondo.map((p) => "N° " + p.folio).join(", ") + ")" : "") + ".\n\nSi son gastos del mismo evento, conviene enviarlos juntos en una sola rendición. ¿Enviar esta como una rendición nueva igual?")) return;
    }
    const usuarioEnvio = currentUser.id;
    const rendicionId = envioRendicionId || (envioRendicionId = crypto.randomUUID());
    const preparados = await window.RindeData.prepararAdjuntos(db,items,usuarioEnvio,rendicionId,adjuntosBorrador,conTimeout);
    if(currentUser?.id!==usuarioEnvio) throw new Error("La sesión cambió durante el envío. Ingresa nuevamente.");
    const resultado = await conTimeout(window.RindeData.guardarRendicionCompleta(db,{
      id:rendicionId,tipo_rendicion:tipoRendicion,empresa:empresaRendicion,
      comentario,solicitud_fondo_id:solicitudFondoId,fecha_rendicion:fecha,
      ...(fondosRendicion?{fondos:fondosRendicion}:{}),
    },preparados),45000,"No se pudo confirmar el envío. Tu formulario se conserva; reintenta para comprobar si ya fue recibido.");
    if(currentUser?.id!==usuarioEnvio) return;
    const rendicion = resultado.rendicion;
    if(!resultado.reutilizada) notificarAsync("notificar-aprobador", { rendicion_id: rendicion.id }, "No se pudo notificar al aprobador:");

    // Si algún ítem quedó con el comprobante sin leer, no hace falta
    // esperar hasta 5 minutos al próximo tick del cron (ver
    // migracion_ocr_reintento.sql) -- se dispara altiro un intento
    // inmediato, con sesión propia (el agente scopea a los ítems de este
    // mismo usuario, ver ocr-reintento-pendientes). Fire-and-forget: si
    // falla, el cron de todos modos lo agarra más tarde.
    if (hayItemsPendientesOcr) {
      notificarAsync("ocr-reintento-pendientes", {}, "No se pudo disparar el reintento inmediato de OCR:");
    }

    toast(resultado.reutilizada ? "El envío anterior ya fue recibido. No se creó otra rendición." : "Rendición enviada completa a aprobación.");
    adjuntosBorrador.clear();
    borrarBorradorRendicion();
    replaceView("view-dashboard");
    loadDashboard();
  } catch (err) {
    toast(mensajeErrorAmigable(err));
  } finally {
    enviandoRendicion = false;
    btn.disabled = false;
    btn.textContent = "Enviar a aprobación";
  }
}

// ------------------------------------------------------------
// Solicitudes de fondos por rendir
// ------------------------------------------------------------
// Paso previo a una rendición tipo "FondoPorRendir": el empleado pide que
// se le entregue un monto (la entrega la hace Finanzas fuera de la app);
// un aprobador/admin la aprueba o rechaza igual que una rendición. Una vez
// Aprobada, aparece en el desplegable "Fondo asociado" de Nueva rendición
// (ver cargarSolicitudesDisponibles) para que el empleado la vincule al
// justificar en qué gastó ese fondo.
function wireNuevaSolicitud() {
  document.getElementById("btn-guardar-solicitud").addEventListener("click", submitSolicitud);
  const empresaSelect = document.getElementById("sf-empresa");
  EMPRESAS.forEach((emp) => empresaSelect.appendChild(el("option", { value: emp }, emp)));
  empresaSelect.addEventListener("change", actualizarCentroCostoSolicitud);
  const montoInput = document.getElementById("sf-monto");
  montoInput.addEventListener("input", () => formatearInputMoney(montoInput));
}

function actualizarCentroCostoSolicitud() {
  const empresa = document.getElementById("sf-empresa").value;
  const opciones = CENTROS_COSTO_POR_EMPRESA[empresa] || ["Casa Matriz"];
  const sel = document.getElementById("sf-cc");
  sel.innerHTML = "";
  opciones.forEach((o) => sel.appendChild(el("option", { value: o }, o)));
}

function openNuevaSolicitud(pushHistory = true) {
  document.getElementById("sf-empresa").value = EMPRESAS[0];
  actualizarCentroCostoSolicitud();
  document.getElementById("sf-monto").value = "";
  document.getElementById("sf-fecha").value = "";
  document.getElementById("sf-motivo").value = "";
  if (pushHistory) pushView("view-nueva-solicitud"); else show("view-nueva-solicitud");
}

async function submitSolicitud() {
  const empresa = document.getElementById("sf-empresa").value;
  const centroCosto = document.getElementById("sf-cc").value;
  const monto = parseMoneyValue(document.getElementById("sf-monto").value);
  const fechaNecesaria = document.getElementById("sf-fecha").value || null;
  const motivo = document.getElementById("sf-motivo").value.trim();

  if (!monto) { toast("Ingresa el monto solicitado."); return; }
  if (!motivo) { toast("Explica para qué es el fondo."); return; }

  const btn = document.getElementById("btn-guardar-solicitud");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Enviando...';
  try {
    const { data: solicitud, error } = await db
      .from("solicitudes_fondos")
      .insert({
        empleado_id: currentUser.id,
        empleado_nombre: currentProfile?.nombre || currentUser.email,
        rut_empleado: currentProfile?.rut || null,
        empresa,
        centro_costo: centroCosto,
        monto_solicitado: monto,
        motivo,
        fecha_necesaria: fechaNecesaria,
        estado: "Pendiente",
      })
      .select()
      .single();
    if (error) throw error;

    // Mismo correo/plantilla que una rendición nueva, pero con tipo
    // "solicitud" para que el asunto y el cuerpo hablen de un fondo.
    notificarAsync("notificar-aprobador", { tipo: "solicitud", rendicion_id: solicitud.id }, "No se pudo notificar al aprobador:");

    toast("Solicitud de fondos enviada.");
    replaceView("view-dashboard");
    loadDashboard();
  } catch (err) {
    toast(mensajeErrorAmigable(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar solicitud";
  }
}

async function prepararComprobanteEntregaFondo(id, opciones) {
  if (!esAprobadorEfectivo(currentProfile)) throw new Error("Solo administradores y aprobadores pueden preparar este comprobante.");
  const {data:s,error} = await db.from("solicitudes_fondos").select("*").eq("id",id).maybeSingle();
  if (error || !s) throw new Error("No se pudo actualizar el fondo. Intenta nuevamente.");
  const {data:perfil,error:errorPerfil} = await db.from("profiles").select("nombre, rut").eq("id",s.empleado_id).maybeSingle();
  if (errorPerfil) throw new Error("No se pudo comprobar el RUT del empleado. Intenta nuevamente.");
  const fondo = {...s,empleado_nombre:perfil?.nombre || s.empleado_nombre,rut_empleado:perfil?.rut || s.rut_empleado};
  const comprobante = window.RindeCore.comprobanteEntregaFondo(fondo,opciones);
  return {...comprobante,empresa:s.empresa,content:[CSV_HEADER,...comprobante.filas.map(row=>row.map(campoCSVSeguro).join(";"))].join("\r\n")};
}

function panelContabilizarFondo(solicitud) {
  const panel = el("section",{class:"fondo-kame-panel","aria-label":"Contabilización de entrega de fondo"});
  const form = el("form",{class:"fondo-kame-form",id:`fondo-kame-${solicitud.id}`,hidden:""});
  const abrir = el("button",{class:"btn btn-primary",type:"button","aria-expanded":"false","aria-controls":form.id},"Contabilizar en Kame");
  const fecha=el("input",{type:"date",required:"",id:"fk-fecha"});
  const cuenta=el("input",{type:"text",required:"",id:"fk-cuenta",placeholder:"Código de la cuenta en Kame",autocomplete:"off"});
  const banco=el("input",{type:"text",required:"",id:"fk-banco",placeholder:"Nombre del banco o cuenta de salida",maxlength:"100"});
  const referencia=el("input",{type:"text",id:"fk-referencia",placeholder:"Número de transferencia (opcional)",maxlength:"100"});
  const confirmado=el("input",{type:"checkbox",required:"",id:"fk-confirmado"});
  const campos=el("div",{class:"fondo-kame-fields"});
  [["Fecha efectiva de entrega",fecha],["Cuenta bancaria de salida · código",cuenta],["Nombre de la cuenta bancaria",banco],["Referencia de la entrega",referencia]].forEach(([label,input])=>campos.appendChild(el("div",{class:"field"},[el("label",{for:input.id},label),input])));
  const resultado=el("div",{class:"fondo-kame-preview","aria-live":"polite"});
  const revisar=el("button",{class:"btn btn-secondary",type:"submit"},"Revisar comprobante");
  const descargar=el("button",{class:"btn btn-primary",type:"button",disabled:""},"Descargar archivo para Kame");
  const estado=el("p",{class:"portal-muted",role:"status"});
  const opciones=()=>({fecha:fecha.value,cuentaBanco:cuenta.value,nombreBanco:banco.value,referencia:referencia.value,entregaConfirmada:confirmado.checked});
  let previo=null,ocupado=false,revision=0;
  form.addEventListener("input",()=>{revision++;previo=null;descargar.disabled=true;resultado.replaceChildren();estado.textContent="Revisa nuevamente el comprobante después de cambiar los datos.";});
  abrir.addEventListener("click",()=>{form.hidden=!form.hidden;abrir.setAttribute("aria-expanded",String(!form.hidden));if(!form.hidden)fecha.focus();});
  form.append(el("h3",{},`Entrega del fondo S-${solicitud.folio}`),el("p",{class:"portal-muted"},`Prepara un egreso por ${fmtCLP(solicitud.monto_solicitado)} para importar en ${solicitud.empresa}. Usa la cuenta bancaria de esa empresa desde la que se entregó el dinero.`),campos,
    el("label",{class:"fondo-kame-confirmacion",for:confirmado.id},[confirmado,"La entrega ya se realizó y revisé que no esté contabilizada en Kame."]),
    el("p",{class:"portal-muted"},"La aprobación del fondo no confirma su pago. Esta descarga no registra automáticamente el asiento en Kame ni modifica el saldo del fondo."),
    el("div",{class:"fondo-kame-actions"},[revisar,descargar]),estado,resultado);
  const mostrar=(c)=>{
    const tabla=el("table",{class:"items-table"});
    tabla.appendChild(el("thead",{},el("tr",{},["Cuenta contable","Debe","Haber"].map((t,i)=>el("th",{class:i?"right":""},t)))));
    const cuerpo=el("tbody");
    [["1.01.11.05 · Fondo por Rendir",c.monto,0],[`${c.cuentaBanco} · ${c.nombreBanco}`,0,c.monto],["Total",c.monto,c.monto]].forEach(row=>cuerpo.appendChild(el("tr",{},row.map((v,i)=>el("td",{class:i?"monto":""},i?fmtCLP(v):v)))));
    tabla.appendChild(cuerpo);
    resultado.replaceChildren(el("p",{},`Empresa: ${c.empresa} · Egreso · ${fmtDate(c.fecha)}`),el("p",{class:"portal-muted"},c.glosa),el("div",{class:"table-scroll"},tabla));
  };
  form.addEventListener("submit",async event=>{
    event.preventDefault();if(ocupado)return;
    ocupado=true;revisar.disabled=true;descargar.disabled=true;previo=null;
    const revisionInicial=revision;
    estado.textContent="Comprobando fondo y datos del empleado…";
    try {
      const c=await prepararComprobanteEntregaFondo(solicitud.id,opciones());
      if(revision!==revisionInicial)return;
      previo=c;mostrar(c);descargar.disabled=false;estado.textContent="El comprobante está cuadrado. Revisa la cuenta bancaria antes de descargar.";
    }catch(error){estado.textContent=error.message;resultado.replaceChildren();}
    finally{ocupado=false;revisar.disabled=false;}
  });
  descargar.addEventListener("click",async()=>{
    if(ocupado||!previo)return;
    ocupado=true;revisar.disabled=true;descargar.disabled=true;
    const esperado=previo.content,revisionInicial=revision;
    try {
      const c=await prepararComprobanteEntregaFondo(solicitud.id,opciones());
      if(revision!==revisionInicial)return;
      if(c.content!==esperado){previo=null;mostrar(c);estado.textContent="Los datos del fondo cambiaron. Revisa nuevamente el comprobante antes de descargar.";return;}
      const url=URL.createObjectURL(new Blob(["\uFEFF"+c.content],{type:"text/csv;charset=utf-8"}));
      const link=el("a",{href:url,download:c.fileName});document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      previo=null;confirmado.checked=false;
      estado.textContent="Archivo descargado. Impórtalo una sola vez en Kame, en la empresa indicada. Descargarlo no confirma su contabilización.";
    }catch(error){previo=null;estado.textContent=error.message;}
    finally{ocupado=false;revisar.disabled=false;}
  });
  panel.append(abrir,form);return panel;
}

// ------------------------------------------------------------
// Liquidación de fondos (solo admin). Cierra uno o varios fondos de la misma
// persona y empresa: los excesos se cruzan con los restantes y la diferencia
// se devuelve o se paga por banco. La base hace el cálculo y el cierre
// (preparar_liquidacion_fondos / liquidar_fondos); aquí se arma el asiento.
// ------------------------------------------------------------
const RESULTADO_LIQUIDACION = { Devolucion: "Devolución del empleado", Pago: "Pago al empleado", Compensado: "Compensado sin mover dinero" };

function textoNetoLiquidacion(neto, nombre) {
  if (neto > 0) return `${nombre} debe devolver ${fmtCLP(neto)} a la empresa.`;
  if (neto < 0) return `La empresa debe pagar ${fmtCLP(-neto)} a ${nombre}.`;
  return "Los excesos y los restantes se compensan: no hay que mover dinero.";
}

function tablaLiquidacion(detalle, destacar = null) {
  const cols = ["Fondo", "Otorgado", "Aprobado", "Restante", "Exceso"];
  const tabla = el("table", { class: "items-table" });
  tabla.appendChild(el("thead", {}, el("tr", {}, cols.map((c, i) => el("th", { class: i ? "right" : "" }, c)))));
  const cuerpo = el("tbody");
  const suma = (k) => detalle.reduce((s, d) => s + Number(d[k] || 0), 0);
  [...detalle].sort((a, b) => Number(a.folio_fondo) - Number(b.folio_fondo)).forEach((d) => {
    const excesos = (d.excesos || []).map((e) => "N° " + e.folio).join(", ");
    const celdas = [el("td", {}, [el("strong", {}, "S-" + d.folio_fondo + (d.solicitud_fondo_id === destacar ? " (este)" : "")), excesos ? el("small", { style: "display:block;color:var(--ink-soft)" }, "Exceso en " + excesos) : null]),
      ...["otorgado", "aprobado", "restante", "exceso"].map((k) => el("td", { class: "monto" }, fmtCLP(d[k])))];
    celdas.forEach((td, i) => td.setAttribute("data-label", cols[i]));
    cuerpo.appendChild(el("tr", {}, celdas));
  });
  cuerpo.appendChild(el("tr", { class: "liquidacion-total" }, [el("td", {}, "Total"), ...["otorgado", "aprobado", "restante", "exceso"].map((k) => el("td", { class: "monto" }, fmtCLP(suma(k))))]));
  tabla.appendChild(cuerpo);
  return el("div", { class: "table-scroll" }, tabla);
}

function tablaAsiento(filas) {
  const tabla = el("table", { class: "items-table" });
  tabla.appendChild(el("thead", {}, el("tr", {}, ["Cuenta", "Detalle", "Debe", "Haber"].map((t, i) => el("th", { class: i > 1 ? "right" : "" }, t)))));
  const cuerpo = el("tbody");
  filas.forEach((f) => cuerpo.appendChild(el("tr", {}, [el("td", {}, f[5] + (nombreCuenta(f[5]) ? " · " + nombreCuenta(f[5]) : "")), el("td", {}, f[8]), el("td", { class: "monto" }, f[6] ? fmtCLP(f[6]) : ""), el("td", { class: "monto" }, f[7] ? fmtCLP(f[7]) : "")])));
  const debe = filas.reduce((s, f) => s + f[6], 0), haber = filas.reduce((s, f) => s + f[7], 0);
  cuerpo.appendChild(el("tr", { class: "liquidacion-total" }, [el("td", {}, "Total"), el("td", {}, ""), el("td", { class: "monto" }, fmtCLP(debe)), el("td", { class: "monto" }, fmtCLP(haber))]));
  tabla.appendChild(cuerpo);
  return el("div", { class: "table-scroll" }, tabla);
}

// Lo que la liquidación deja abierto en Kame, documento por documento.
function avisoPendientesLiquidacion(c, neto, nombre) {
  if (!neto || !c.pendientes.length) return el("p", { class: "portal-muted" }, "Los fondos quedan saldados: no hay nada que pagar ni devolver.");
  const docs = c.pendientes.map((p) => (p.cuenta === "2.01.07.29" ? "rendición N° " : "fondo S-") + p.folio + " (" + fmtCLP(p.monto) + ")").join(", ");
  return el("p", { class: "liquidacion-pendiente" }, neto < 0
    ? `Queda por pagar a ${nombre} ${fmtCLP(-neto)} en 2.01.07.29 Rendiciones por Pagar: ${docs}. Finanzas lo paga en Kame como cualquier reembolso.`
    : `${nombre} debe devolver ${fmtCLP(neto)}, que sigue en 1.01.11.05 Fondo por Rendir: ${docs}. Regístralo en Kame cuando deposite.`);
}

async function leerLiquidacion(id) {
  const [{ data: l, error: e1 }, { data: detalle, error: e2 }] = await Promise.all([
    db.from("liquidaciones_fondos").select("*").eq("id", id).maybeSingle(),
    db.from("liquidacion_fondos_detalle").select("*").eq("liquidacion_id", id).order("folio_fondo"),
  ]);
  if (e1 || e2 || !l) throw new Error("No se pudo leer la liquidación. Intenta nuevamente.");
  return { l, detalle: detalle || [] };
}

// Descarga el CSV para Kame de una liquidación ya registrada y anota la descarga.
async function descargarCsvLiquidacion(id) {
  const { l, detalle } = await leerLiquidacion(id);
  const { data: perfil } = await db.from("profiles").select("nombre, rut").eq("id", l.empleado_id).maybeSingle();
  const c = window.RindeCore.comprobanteLiquidacionFondos({ ...l, empleado_nombre: perfil?.nombre || l.empleado_nombre, rut_empleado: perfil?.rut || l.rut_empleado }, detalle);
  if (!c.filas.length) return { sinAsiento: true };
  const content = [CSV_HEADER, ...c.filas.map((row) => row.map(campoCSVSeguro).join(";"))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" }));
  const link = el("a", { href: url, download: c.fileName }); document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  const { error } = await db.rpc("marcar_liquidacion_exportada_kame", { p_liquidacion: id });
  if (error) console.warn("No se pudo registrar la descarga del CSV de la liquidación:", error);
  return { fileName: c.fileName };
}

function panelLiquidarFondo(fondo) {
  const panel = el("section", { class: "fondo-kame-panel", "aria-label": "Liquidación del fondo" });
  const form = el("form", { class: "fondo-kame-form", id: `liquidar-${fondo.id}`, hidden: "" });
  const abrir = el("button", { class: "btn btn-secondary", type: "button", "aria-expanded": "false", "aria-controls": form.id }, "Liquidar fondo");
  let cargado = false;
  abrir.addEventListener("click", async () => {
    form.hidden = !form.hidden; abrir.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden && !cargado) { cargado = true; await armarFormularioLiquidacion(fondo, form); }
  });
  panel.append(abrir, form);
  return panel;
}

async function armarFormularioLiquidacion(fondo, form) {
  const nombre = fondo.empleado_nombre || "La persona";
  form.replaceChildren(el("p", { class: "portal-muted" }, "Cargando los fondos abiertos de " + nombre + "…"));
  let abiertos, consumo;
  try {
    abiertos = await consultarTodas(() => db.from("solicitudes_fondos").select("*", { count: "exact" }).eq("empleado_id", fondo.empleado_id).eq("empresa", fondo.empresa).eq("estado", "Aprobado").order("folio").order("id"));
    consumo = await cargarConsumoFondos(abiertos);
  } catch (error) { form.replaceChildren(el("p", { class: "ocr-status show err" }, "No se pudieron cargar los fondos. " + mensajeErrorAmigable(error))); return; }

  const checks = new Map(), lista = el("div", { class: "liquidacion-fondos" });
  abiertos.forEach((s) => {
    const filas = consumo.get(s.id), c = filas ? resumirConsumoFondo(filas, s.monto_solicitado) : null;
    const enRevision = !filas || filas.some((r) => r.estado !== "Aprobado" && r.estado !== "Rechazado");
    const cb = el("input", { type: "checkbox", value: s.id, id: `liq-${fondo.id}-${s.id}` });
    cb.checked = s.id === fondo.id && !enRevision; cb.disabled = enRevision;
    const saldo = !c ? "Consumo no disponible" : c.saldo < 0 ? "Exceso " + fmtCLP(-c.saldo) : c.saldo > 0 ? "Restante " + fmtCLP(c.saldo) : "Sin saldo";
    lista.appendChild(el("label", { class: "liquidacion-fondo" + (enRevision ? " bloqueado" : ""), for: cb.id }, [cb,
      el("span", {}, [el("strong", {}, "S-" + s.folio + (s.id === fondo.id ? " (este)" : "")), " · " + (s.motivo || "Sin motivo"),
        el("small", {}, "Otorgado " + fmtCLP(s.monto_solicitado) + (c ? " · Aprobado " + fmtCLP(c.aprobado) : "") + " · " + saldo),
        enRevision ? el("small", { class: "liquidacion-aviso" }, "Tiene rendiciones en revisión: termina de revisarlas antes de liquidarlo.") : null])]));
    checks.set(s.id, cb);
  });

  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const fecha = el("input", { type: "date", required: "", id: `liq-fecha-${fondo.id}`, max: hoy }); fecha.value = hoy;
  const observacion = el("textarea", { id: `liq-obs-${fondo.id}`, rows: "2", maxlength: "500", placeholder: "Opcional: acuerdos, quién autorizó, etc." });
  const confirmado = el("input", { type: "checkbox", id: `liq-ok-${fondo.id}` });
  const textoConfirmacion = el("span", {});
  const campos = el("div", { class: "fondo-kame-fields" }, [el("div", { class: "field" }, [el("label", { for: fecha.id }, "Fecha de la liquidación"), fecha]), el("div", { class: "field" }, [el("label", { for: observacion.id }, "Observación"), observacion])]);
  const resumen = el("div", { class: "fondo-kame-preview", "aria-live": "polite" });
  const estado = el("p", { class: "portal-muted", role: "status" });
  const calcular = el("button", { class: "btn btn-secondary", type: "button" }, "Calcular liquidación");
  const liquidar = el("button", { class: "btn btn-primary", type: "submit", disabled: "" }, "Liquidar y descargar CSV");

  let previa = null, ocupado = false;
  const elegidos = () => [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
  const asiento = () => {
    if (!previa) return null;
    const neto = Number(previa.neto);
    return window.RindeCore.comprobanteLiquidacionFondos({ folio: "nuevo", empresa: previa.empresa, empleado_nombre: previa.empleado_nombre, rut_empleado: previa.rut_empleado,
      fecha: fecha.value, resultado: neto > 0 ? "Devolucion" : neto < 0 ? "Pago" : "Compensado", total_restante: previa.total_restante, total_exceso: previa.total_exceso,
      monto_neto: Math.abs(neto) }, previa.detalle);
  };
  const refrescar = () => {
    liquidar.disabled = true;
    if (!previa) return;
    const neto = Number(previa.neto);
    textoConfirmacion.textContent = "Revisé los montos y esta liquidación no está registrada en Kame.";
    const partes = [el("p", { class: "liquidacion-neto " + (neto < 0 ? "portal-negative" : "") }, el("strong", {}, textoNetoLiquidacion(neto, previa.empleado_nombre || nombre))), tablaLiquidacion(previa.detalle, fondo.id)];
    try {
      const c = asiento();
      partes.push(el("p", { style: "margin-top:16px;font-weight:600" }, c.filas.length ? `Asiento para Kame (TRASPASO) en ${previa.empresa}: compensa ${fmtCLP(c.compensado)}` : "No requiere asiento: no hay excesos que cruzar con restantes."));
      if (c.filas.length) partes.push(tablaAsiento(c.filas));
      partes.push(avisoPendientesLiquidacion(c, neto, previa.empleado_nombre || nombre));
      liquidar.disabled = !confirmado.checked || ocupado;
      estado.textContent = confirmado.checked ? "" : "Marca la confirmación para liquidar.";
    } catch (error) { estado.textContent = error.message; }
    resumen.replaceChildren(...partes);
  };
  const invalidar = () => { previa = null; liquidar.disabled = true; resumen.replaceChildren(); estado.textContent = "Calcula la liquidación para ver el resultado."; };
  checks.forEach((cb) => cb.addEventListener("change", invalidar));
  [fecha, confirmado].forEach((i) => i.addEventListener("input", refrescar));
  confirmado.addEventListener("change", refrescar);

  calcular.addEventListener("click", async () => {
    if (ocupado) return;
    const ids = elegidos();
    if (!ids.length) { estado.textContent = "Elige al menos un fondo."; return; }
    ocupado = true; calcular.disabled = true; estado.textContent = "Calculando…";
    try {
      const { data, error } = await db.rpc("preparar_liquidacion_fondos", { p_fondos: ids });
      if (error) throw error;
      previa = { ...data, ids }; estado.textContent = "";
    } catch (error) { previa = null; resumen.replaceChildren(); estado.textContent = mensajeErrorAmigable(error); }
    finally { ocupado = false; calcular.disabled = false; refrescar(); }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ocupado || !previa || !confirmado.checked) return;
    let c; try { c = asiento(); } catch (error) { estado.textContent = error.message; return; }
    const folios = previa.detalle.map((d) => "S-" + d.folio_fondo).join(", ");
    if (!confirm(`Se cerrarán ${folios}. ${textoNetoLiquidacion(Number(previa.neto), previa.empleado_nombre || nombre)}\n\nLos fondos dejarán de aceptar rendiciones. Si te equivocas, puedes anular la liquidación desde el fondo.`)) return;
    ocupado = true; liquidar.disabled = true; calcular.disabled = true; estado.textContent = "Liquidando…";
    try {
      const { data, error } = await db.rpc("liquidar_fondos", { p_fondos: previa.ids, p_fecha: fecha.value, p_neto_esperado: Number(previa.neto),
        p_observacion: observacion.value || null });
      if (error) throw error;
      let aviso = `Liquidación L-${data.folio} registrada.`;
      if (c.filas.length) {
        try { await descargarCsvLiquidacion(data.id); aviso += " CSV para Kame descargado: impórtalo una sola vez."; }
        catch (error) { aviso += " No se pudo descargar el CSV: bájalo desde el fondo. " + error.message; }
      }
      toast(aviso);
      loadDashboard();
      openDetalleSolicitud(fondo.id, false);
    } catch (error) { estado.textContent = mensajeErrorAmigable(error); ocupado = false; calcular.disabled = false; refrescar(); }
  });

  const algunoBloqueado = !checks.get(fondo.id) || checks.get(fondo.id).disabled;
  form.replaceChildren(...[
    el("h3", {}, "Liquidar fondos de " + nombre),
    el("p", { class: "portal-muted" }, `Elige los fondos abiertos de ${fondo.empresa} que se cierran juntos. Los excesos se cruzan con los restantes; la diferencia queda en Kame en su documento y se paga o se devuelve como hoy. Para cerrar un fondo por separado, deja solo ese marcado.`),
    algunoBloqueado ? el("p", { class: "ocr-status show err" }, "Este fondo todavía tiene rendiciones en revisión.") : null,
    lista, el("div", { class: "fondo-kame-actions" }, [calcular]), resumen, campos,
    el("label", { class: "fondo-kame-confirmacion", for: confirmado.id }, [confirmado, textoConfirmacion]),
    el("p", { class: "portal-muted" }, "Supone que la entrega de cada fondo y los CSV de sus rendiciones ya están importados en Kame."),
    el("div", { class: "fondo-kame-actions" }, [liquidar]), estado].filter(Boolean));
  textoConfirmacion.textContent = "Calcula la liquidación para confirmar.";
}

// Resumen de la liquidación en el detalle de un fondo cerrado. El admin puede
// volver a bajar el CSV o anularla (reabre los fondos).
async function bloqueLiquidacion(s, esAdmin) {
  const caja = el("section", { class: "liquidacion-resumen" });
  if (!s.liquidacion_id) { caja.appendChild(el("p", {}, "Fondo cerrado.")); return caja; }
  let datos;
  try { datos = await leerLiquidacion(s.liquidacion_id); }
  catch (error) { caja.appendChild(el("p", { class: "ocr-status show err" }, "Fondo cerrado. " + error.message)); return caja; }
  const { l, detalle } = datos;
  caja.append(
    el("h3", {}, `Liquidado en L-${l.folio}`),
    el("p", {}, `${fmtDate(l.fecha)} · ${RESULTADO_LIQUIDACION[l.resultado] || l.resultado}${Number(l.monto_neto) ? " por " + fmtCLP(l.monto_neto) : ""} · registrado por ${l.creado_por_nombre || "-"}`),
    tablaLiquidacion(detalle, s.id));
  try {
    const c = window.RindeCore.comprobanteLiquidacionFondos(l, detalle);
    caja.appendChild(avisoPendientesLiquidacion(c, l.resultado === "Devolucion" ? Number(l.monto_neto) : -Number(l.monto_neto), l.empleado_nombre || "La persona"));
  } catch (error) { caja.appendChild(el("p", { class: "ocr-status show err" }, error.message)); }
  if (l.observacion) caja.appendChild(el("p", { class: "portal-muted" }, "Observación: " + l.observacion));
  if (!esAdmin) return caja;

  const estadoKame = el("p", { class: "portal-muted" }, l.kame_exportado_en ? `CSV para Kame descargado el ${fmtDate(l.kame_exportado_en)}` + (l.kame_exportaciones > 1 ? ` (${l.kame_exportaciones} veces)` : "") : "CSV para Kame sin descargar.");
  const descargar = el("button", { class: "btn btn-secondary", type: "button" }, "Descargar CSV para Kame");
  descargar.addEventListener("click", async () => {
    if (l.kame_exportado_en && !confirm("Este CSV ya se descargó. Importarlo dos veces en Kame duplica el asiento. ¿Descargar de nuevo?")) return;
    descargar.disabled = true;
    try { const r = await descargarCsvLiquidacion(l.id); toast(r.sinAsiento ? "Esta liquidación no requiere asiento." : "CSV descargado: impórtalo una sola vez en Kame."); openDetalleSolicitud(s.id, false); }
    catch (error) { toast(error.message); descargar.disabled = false; }
  });
  const motivo = el("textarea", { rows: "2", maxlength: "500", placeholder: "Motivo de la anulación" });
  const confirmarAnular = el("button", { class: "btn btn-danger", type: "button" }, "Confirmar anulación");
  const cajaAnular = el("div", { class: "liquidacion-anular", hidden: "" }, [
    el("p", {}, `Se reabrirán ${detalle.map((d) => "S-" + d.folio_fondo).join(", ")}.` + (l.kame_exportado_en ? " El CSV ya se descargó: si se importó, reversa el asiento en Kame." : "")),
    motivo, el("div", { class: "fondo-kame-actions" }, confirmarAnular)]);
  const anular = el("button", { class: "btn btn-ghost", type: "button" }, "Anular liquidación");
  anular.addEventListener("click", () => { cajaAnular.hidden = !cajaAnular.hidden; if (!cajaAnular.hidden) motivo.focus(); });
  confirmarAnular.addEventListener("click", async () => {
    if (!motivo.value.trim()) { toast("Explica por qué se anula."); motivo.focus(); return; }
    confirmarAnular.disabled = true;
    const { error } = await db.rpc("anular_liquidacion_fondos", { p_liquidacion: l.id, p_motivo: motivo.value });
    if (error) { toast(mensajeErrorAmigable(error)); confirmarAnular.disabled = false; return; }
    toast(`Liquidación L-${l.folio} anulada; los fondos volvieron a quedar abiertos.`);
    loadDashboard(); openDetalleSolicitud(s.id, false);
  });
  caja.append(estadoKame, el("div", { class: "fondo-kame-actions" }, [descargar, anular]), cajaAnular);
  return caja;
}

async function openDetalleSolicitud(id, pushHistory = true) {
  const box0 = document.getElementById("detalle-solicitud-card");
  box0.innerHTML = "<p style='color:var(--ink-soft)'>Cargando...</p>";

  const { data: s, error: errS } = await db.from("solicitudes_fondos").select("*").eq("id", id).maybeSingle();
  if (errS || !s) {
    toast("No se pudo abrir esa solicitud (puede que ya no exista o no tengas permiso).");
    replaceView("view-dashboard");
    return;
  }
  const esAprobadorViewer = esAprobadorEfectivo(currentProfile);
  const esPropia = s.empleado_id === currentUser.id;
  const puedeAprobar = esAprobadorViewer && s.estado === "Pendiente" && !esPropia;

  const box = document.getElementById("detalle-solicitud-card");
  box.innerHTML = "";

  box.appendChild(el("div", { class: "detail-header" }, [
    el("div", {}, [
      el("h2", { style: "margin:0 0 4px" }, `S-${s.folio ?? "-"} · ${s.empresa || "-"}`),
      el("p", { style: "margin:0;color:var(--ink-soft);font-size:0.88rem" }, `${s.empleado_nombre} · ${fmtDate(s.created_at)}`),
    ]),
    el("span", { class: "pill " + s.estado, style: "font-size:0.8rem" }, s.estado),
  ]));

  [
    ["Centro de Costo", s.centro_costo || "-"],
    ["Motivo", s.motivo || "-"],
    ["Fecha en que se necesita", s.fecha_necesaria ? fmtDate(s.fecha_necesaria) : "-"],
  ].forEach(([label, valor]) => {
    box.appendChild(el("p", { style: "margin:4px 0;font-size:0.9rem" }, [
      el("strong", {}, `${label}: `),
      valor,
    ]));
  });

  box.appendChild(el("div", { class: "totals-bar" }, [
    el("span", {}, "Monto solicitado"),
    el("span", { class: "amount" }, fmtCLP(s.monto_solicitado)),
  ]));

  if (s.estado === "Aprobado" || s.estado === "Cerrado") {
    const abierto = s.estado === "Aprobado";
    box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:10px" },
      `Aprobado por ${s.aprobador_nombre || "-"} el ${fmtDate(s.fecha_aprobacion)}`));
    if (esAprobadorViewer && abierto) box.appendChild(panelContabilizarFondo(s));
    if (!abierto) box.appendChild(await bloqueLiquidacion(s, currentProfile?.rol === "admin"));

    // Saldo: cuánto de este fondo ya se rindió (rendiciones Aprobadas
    // vinculadas a esta solicitud) y cuánto queda disponible. Si el saldo
    // es negativo, la persona gastó más de lo que se le entregó -- ese
    // exceso se contabilizó como Rendiciones por Pagar (ver
    // calcularSplitFondo), no como parte de este fondo.
    let rendidas = [], errorConsumo = null;
    try { rendidas = await consultarTodas(() => db.from("rendiciones_por_fondo").select("id, folio, monto_total, monto_aprobado, estado, monto_total_rendicion",{count:"exact"}).eq("solicitud_fondo_id",s.id).order("created_at").order("id")); }
    catch (error) {errorConsumo=error; box.appendChild(el("p",{class:"ocr-status show err"},"No se pudo comprobar el consumo del fondo. Vuelve a abrir el detalle para reintentar."));}
    const aprobadas = (rendidas || []).filter((r) => r.estado === "Aprobado");
    const rendido = errorConsumo ? null : resumirConsumoFondo(rendidas,s.monto_solicitado).consumido;
    const saldo = rendido === null ? null : Number(s.monto_solicitado) - rendido;

    const consumption=errorConsumo?null:resumirConsumoFondo(rendidas,s.monto_solicitado),ui=window.RindeUI;
    box.appendChild(el("div",{class:"portal-metrics"},[
      ui.metric("Consumo aprobado",consumption?fmtCLP(consumption.aprobado):"No disponible","Gastos aceptados","positive"),
      ui.metric("En revisión",consumption?fmtCLP(consumption.porRevisar):"No disponible","Reservado hasta su revisión","warning"),
      ui.metric(saldo!==null&&saldo<0?"Exceso rendido":"Disponible para rendir",saldo===null?"No disponible":fmtCLP(Math.abs(saldo)),"Se excluyen gastos rechazados",saldo!==null&&saldo<0?"negative":"")
    ]));
    if(consumption&&Number(s.monto_solicitado)>0){
      box.appendChild(el("progress",{class:"portal-fund-progress",max:"100",value:String(Math.min(100,100*consumption.consumido/Number(s.monto_solicitado))),"aria-label":"Porcentaje del fondo rendido"}));
      box.appendChild(el("p",{class:"portal-muted"},"El saldo reserva tanto los gastos aprobados como los que siguen en revisión."));
    }
    if (abierto && currentProfile?.rol === "admin" && !esPropia) box.appendChild(panelLiquidarFondo(s));
    if(esPropia&&abierto)box.appendChild(el("button",{class:"btn btn-primary",type:"button",onclick:async()=>{
      if(enviandoRendicion){toast("Espera a que termine el envío actual.");return;}
      openNuevaRendicion();document.getElementById("nr-empresa").value=s.empresa;actualizarCentroCostoRendicion();
      document.getElementById("nr-tipo").value="FondoPorRendir";document.getElementById("nr-fondo-wrap").style.display="block";
      await cargarSolicitudesDisponibles();document.getElementById("nr-fondo").value=s.id;window.RindeUI.updateFormSummary();
    }},"Rendir este fondo"));

    if (rendidas && rendidas.length) {
      box.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.9rem" }, "Rendiciones contra este fondo"));
      const tabla = el("table", { class: "items-table" });
      const cols = ["Rendición", "Monto", "Estado"];
      tabla.appendChild(el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { class: c === "Monto" ? "right" : "" }, c)))]));
      const tbody = el("tbody");
      rendidas.forEach((r) => {
        const celdas = [
          el("td", {}, `N° ${r.folio ?? "-"}`),
          el("td", { class: "monto" }, Number(r.monto_total_rendicion) !== Number(r.monto_total) ? [fmtCLP(r.monto_total), el("small", { style: "display:block;color:var(--ink-soft)" }, "de " + fmtCLP(r.monto_total_rendicion) + " (multifondo)")] : fmtCLP(r.monto_total)),
          el("td", {}, el("span", { class: "pill " + r.estado }, r.estado)),
        ];
        celdas.forEach((td, i) => td.setAttribute("data-label", cols[i]));
        tbody.appendChild(filaClickable(() => openDetalle(r.id), celdas));
      });
      tabla.appendChild(tbody);
      box.appendChild(el("div", { class: "table-scroll" }, [tabla]));
    }
  }

  if (s.estado === "Rechazado") {
    box.appendChild(el("div", {
      style: "margin-top:10px; padding:12px 14px; border-radius:8px; background:var(--danger-bg); color:var(--danger);",
    }, [
      el("p", { style: "margin:0 0 4px; font-weight:600;" }, `Rechazado por ${s.aprobador_nombre || "-"} el ${fmtDate(s.fecha_aprobacion)}`),
      el("p", { style: "margin:0;" }, s.motivo_rechazo || "No se dejó un motivo."),
    ]));
  }

  if (esAprobadorViewer && esPropia && s.estado === "Pendiente") {
    box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:16px" },
      "Es tu propia solicitud -- otro aprobador o admin debe revisarla, no puedes aprobarla o rechazarla tú mismo."));
  }

  if (puedeAprobar) {
    const rechazoBox = el("div", { style: "display:none; margin-top:14px;" });
    const rechazoInput = el("textarea", {
      rows: "2", placeholder: "Explica brevemente por qué se rechaza (se le avisa por correo al empleado)...",
      style: "width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font-family:inherit; font-size:0.9rem; resize:vertical;",
    });
    rechazoBox.appendChild(rechazoInput);
    const btnConfirmarRechazo = el("button", { class: "btn btn-danger", type: "button" }, "Confirmar rechazo");
    btnConfirmarRechazo.addEventListener("click", async () => {
      const motivo = rechazoInput.value.trim();
      if (!motivo) { toast("Escribe el motivo del rechazo."); return; }
      btnConfirmarRechazo.disabled = true;
      btnConfirmarRechazo.textContent = "Rechazando...";
      await aprobarSolicitud(s, "Rechazado", motivo);
      btnConfirmarRechazo.disabled = false;
      btnConfirmarRechazo.textContent = "Confirmar rechazo";
    });
    rechazoBox.appendChild(el("div", { style: "display:flex; gap:10px; margin-top:8px;" }, [
      btnConfirmarRechazo,
      el("button", { class: "btn btn-ghost", type: "button", onclick: () => { rechazoBox.style.display = "none"; } }, "Cancelar"),
    ]));

    const btnAprobar = el("button", { class: "btn btn-success" }, "Aprobar");
    btnAprobar.addEventListener("click", async () => {
      // Desactivado mientras se consultan sus fondos abiertos: un doble clic no abre dos confirmaciones.
      if (btnAprobar.disabled) return;
      btnAprobar.disabled = true;
      const abiertos = await avisoFondosAbiertos(s.empleado_id, s.empleado_nombre, s.id);
      if (!confirm((abiertos ? abiertos + "\n\n" : "") + `¿Aprobar la solicitud de fondos de ${s.empleado_nombre} por ${fmtCLP(s.monto_solicitado)}? Esta acción no se puede deshacer.`)) { btnAprobar.disabled = false; return; }
      btnAprobar.textContent = "Aprobando...";
      await aprobarSolicitud(s, "Aprobado");
      btnAprobar.disabled = false;
      btnAprobar.textContent = "Aprobar";
    });
    const actions = el("div", { style: "display:flex;gap:10px;margin-top:16px" }, [
      btnAprobar,
      el("button", { class: "btn btn-danger", onclick: () => { rechazoBox.style.display = "block"; } }, "Rechazar"),
    ]);
    box.appendChild(actions);
    box.appendChild(rechazoBox);
  }

  if (pushHistory) pushView("view-detalle-solicitud", { id }); else show("view-detalle-solicitud");
}

// ------------------------------------------------------------
// Avisos de fondos: una sola fuente, estado_fondos_abiertos() (la misma que
// usa el correo diario de recordatorios-pendientes).
// ------------------------------------------------------------
async function leerEstadoFondos() {
  const { data, error } = await db.rpc("estado_fondos_abiertos");
  if (error) throw error;
  return data || [];
}

// Texto para el confirm de aprobar/registrar un fondo; "" si la persona no
// tiene otros abiertos o si no se pudo consultar (el aviso no bloquea).
async function avisoFondosAbiertos(empleadoId, nombre, excluirId = null) {
  try {
    const filas = (await leerEstadoFondos()).filter((f) => f.empleado_id === empleadoId && f.id !== excluirId);
    return window.RindeCore.textoFondosAbiertos(filas, nombre || "La persona");
  } catch (error) {
    console.warn("No se pudo revisar los fondos abiertos:", error);
    return "";
  }
}

// Tarjeta "Fondos por cerrar" en Inicio (aprobadores y admin): personas con
// fondos listos para liquidar y fondos quietos sin rendir.
async function mostrarFondosPorCerrar(gen) {
  let filas;
  try { filas = await leerEstadoFondos(); }
  catch (error) { console.warn("No se pudo cargar Fondos por cerrar:", error); return; }
  if (gen !== dashboardCarga) return;
  const home = document.getElementById("portal-home-content");
  if (!home) return;
  document.getElementById("portal-fondos-por-cerrar")?.remove();
  const { porRendir, porLiquidar } = window.RindeCore.clasificarFondos(filas);
  if (!porRendir.length && !porLiquidar.length) return;
  const abrir = (f) => (e) => { e.preventDefault(); openDetalleSolicitud(f.id); };
  const masAntiguo = (fondos) => fondos.reduce((a, f) => (Number(f.dias_abierto) > Number(a.dias_abierto) ? f : a), fondos[0]);
  const resultado = (n) => (n > 0 ? "Devuelve " + fmtCLP(n) : n < 0 ? "Se le paga " + fmtCLP(-n) : "Compensado");
  const filasHtml = [
    ...porLiquidar.slice(0, 5).map((g) => el("a", { class: "portal-attention", href: "#detalle-solicitud/" + masAntiguo(g.fondos).id, onclick: abrir(masAntiguo(g.fondos)) }, [
      el("div", {}, [el("strong", {}, g.empleado_nombre || "Fondo"), el("span", {}, g.empresa + " · " + g.fondos.map((f) => "S-" + f.folio).join(", ")), el("small", {}, "Lista para liquidar · abierto hace " + g.dias + " días")]),
      el("b", {}, resultado(g.neto)),
    ])),
    ...porRendir.filter((g) => !porLiquidar.some((l) => l.empleado_id === g.empleado_id)).slice(0, 5).map((g) => el("a", { class: "portal-attention", href: "#detalle-solicitud/" + masAntiguo(g.fondos).id, onclick: abrir(masAntiguo(g.fondos)) }, [
      el("div", {}, [el("strong", {}, g.empleado_nombre || "Fondo"), el("span", {}, g.fondos.map((f) => "S-" + f.folio).join(", ")), el("small", {}, "Sin movimiento hace " + Math.max(...g.fondos.map((f) => Number(f.dias_sin_movimiento) || 0)) + " días · se le recuerda por correo")]),
      el("b", {}, fmtCLP(g.sin_rendir) + " sin rendir"),
    ])),
  ];
  const tarjeta = el("section", { class: "card", id: "portal-fondos-por-cerrar", style: "margin-bottom:24px;" }, [
    el("div", { class: "portal-section-heading" }, [
      el("div", {}, [el("h2", {}, "Fondos por cerrar"), el("small", {}, "Sin rendiciones en revisión. Se liquidan por persona y empresa desde el detalle del fondo.")]),
      el("a", { href: "#fondos", class: "btn btn-secondary", onclick: (e) => { e.preventDefault(); navegarPortal("fondos"); } }, "Ver fondos"),
    ]),
    ...filasHtml,
  ]);
  const columnas = home.querySelector(".portal-two-columns");
  home.insertBefore(tarjeta, columnas ? columnas.nextSibling : null);
}

async function aprobarSolicitud(solicitud, estado, motivoRechazo = null) {
  const cambios = {
    estado,
    aprobador_id: currentUser.id,
    aprobador_nombre: currentProfile?.nombre || currentUser.email,
    fecha_aprobacion: new Date().toISOString(),
  };
  if (estado === "Rechazado") cambios.motivo_rechazo = motivoRechazo;

  const res = await updateChecked("solicitudes_fondos", solicitud.id, cambios);
  if (!res.ok) {
    toast(res.mensaje);
    if (/ya fue procesad/i.test(res.mensaje)) openDetalleSolicitud(solicitud.id, false);
    return;
  }

  toast(estado === "Aprobado" ? "Solicitud aprobada." : "Solicitud rechazada.");
  Object.assign(solicitud, cambios);

  // Igual que con las rendiciones: se le avisa por correo a quien pidió el
  // fondo cómo quedó, con el motivo si fue rechazada.
  notificarAsync("notificar-estado-rendicion", { tipo: "solicitud", rendicion_id: solicitud.id }, "No se pudo notificar al empleado:");

  replaceView("view-dashboard");
  loadDashboard();
}

// ------------------------------------------------------------
// Detalle / aprobación
// ------------------------------------------------------------
function crearResumenRendicion(items) {
  const s=resumenRendicion(items), ui=window.RindeUI;
  return el("section",{class:"resumen-gastos","aria-label":"Resumen de montos de la rendición"},[
    ui.metric("Monto rendido",fmtCLP(s.rendido),s.total+(s.total===1?" gasto":" gastos")),
    ui.metric("Monto aprobado",fmtCLP(s.aprobado),s.aprobados+(s.aprobados===1?" gasto":" gastos"),"positive"),
    ui.metric("Monto rechazado",fmtCLP(s.rechazado),s.rechazados+(s.rechazados===1?" gasto":" gastos"),"negative"),
    ui.metric("Pendiente de revisión",fmtCLP(s.pendiente),s.pendientes+(s.pendientes===1?" gasto":" gastos"),"warning")
  ]);
}

// Fondos de una rendición en orden, con la parte del total que le toca a cada uno.
async function cargarFondosDeRendicion(rendicionId) {
  const { data, error } = await db.from("rendiciones_por_fondo").select("solicitud_fondo_id, orden, tope, monto_total, monto_total_rendicion").eq("id", rendicionId).order("orden");
  if (error) throw error;
  const ids = (data || []).map((f) => f.solicitud_fondo_id);
  const { data: solicitudes, error: errorSolicitudes } = ids.length
    ? await db.from("solicitudes_fondos").select("id, folio, motivo, monto_solicitado").in("id", ids)
    : { data: [], error: null };
  if (errorSolicitudes) throw errorSolicitudes;
  return (data || []).map((f) => ({ ...f, solicitud: (solicitudes || []).find((s) => s.id === f.solicitud_fondo_id) }));
}

async function bloqueFondosRendicion(r, editable, totalVigente) {
  const caja = el("div", { class: "fondos-rendicion" });
  let fondos = [];
  try { if (r.tipo_rendicion === "FondoPorRendir") fondos = await cargarFondosDeRendicion(r.id); }
  catch (error) {
    console.error("No se pudo consultar el fondo asociado:", error);
    caja.appendChild(el("p", { class: "ocr-status show err" }, "No se pudo consultar el fondo asociado. Vuelve a abrir el detalle para reintentar."));
    return caja;
  }
  const enlace = (f) => el("a", {
    href: "#", style: "color:var(--blue);font-weight:600;",
    onclick: (e) => { e.preventDefault(); openDetalleSolicitud(f.solicitud_fondo_id); },
  }, "S-" + (f.solicitud?.folio ?? "—"));
  if (fondos.length === 1) caja.appendChild(el("p", { style: "margin:0" }, ["Fondo asociado: ", enlace(fondos[0])]));
  else if (fondos.length > 1) {
    caja.appendChild(el("p", { style: "margin:0" }, "Rendida contra " + fondos.length + " fondos:"));
    caja.appendChild(el("ul", {}, fondos.map((f) => el("li", {}, [
      enlace(f), " · " + (f.solicitud?.motivo || "Sin motivo") + " · " + fmtCLP(f.monto_total) + (f.tope == null ? " (el resto)" : ""),
    ]))));
  } else caja.appendChild(el("p", { style: "margin:0;color:var(--ink-soft)" }, "Reembolso: no está asociada a ningún fondo."));
  if (editable) {
    const boton = el("button", { class: "btn btn-secondary btn-sm", type: "button", style: "margin-top:8px" }, fondos.length ? "Cambiar fondos" : "Asociar a fondos");
    boton.addEventListener("click", async () => {
      boton.disabled = true;
      try { caja.appendChild(await editorFondosRendicion(r, fondos, totalVigente)); boton.remove(); }
      catch (error) { toast(mensajeErrorAmigable(error)); boton.disabled = false; }
    });
    caja.appendChild(boton);
  }
  return caja;
}

// Editor de los fondos de una rendición Pendiente (dueño o aprobador). Mismas
// reglas que el formulario; sin filas, la rendición vuelve a ser Reembolso.
async function editorFondosRendicion(r, actuales, total) {
  const disponibles = await consultarTodas(() => db.from("solicitudes_fondos").select("id, folio, motivo, monto_solicitado", { count: "exact" })
    .eq("empleado_id", r.empleado_id).eq("estado", "Aprobado").eq("empresa", r.empresa).order("created_at", { ascending: false }).order("id"));
  const editor = el("div", { class: "editor-fondos" });
  const cerrar = () => openDetalle(r.id, false);
  if (!disponibles.length) {
    const volver = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Cerrar");
    volver.addEventListener("click", cerrar);
    editor.append(el("p", { style: "margin:0 0 8px" }, (r.empleado_nombre || "Esta persona") + " no tiene fondos aprobados en " + (r.empresa || "esta empresa") + "."), volver);
    return editor;
  }
  const folio = (id) => "S-" + (disponibles.find((s) => s.id === id)?.folio ?? "—");
  const filas = el("div");
  const resumen = el("p", { class: "nr-fondos-resumen" });
  const agregar = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "+ Agregar fondo");
  const leer = () => [...filas.children].map((f, i, lista) => ({ id: f.querySelector("select").value, monto: i < lista.length - 1 ? parseMoneyValue(f.querySelector("input").value) : null }));
  const actualizar = () => {
    const lista = [...filas.children];
    lista.forEach((f, i) => { f.querySelector("input").hidden = lista.length < 2 || i === lista.length - 1; });
    const fondos = leer();
    const error = fondos.length ? window.RindeCore.validarFondosRendicion(fondos, total) : null;
    resumen.classList.toggle("error", Boolean(error));
    resumen.textContent = error || (!fondos.length ? "Sin fondos: la rendición queda como Reembolso."
      : fondos.length === 1 ? "Todo el total (" + fmtCLP(total) + ") contra " + folio(fondos[0].id) + "."
      : "Reparto del total " + fmtCLP(total) + ": " + window.RindeCore.repartirEntreFondos(total, fondos).map((f) => folio(f.id) + " " + fmtCLP(f.parte)).join(" · ") + ". El último fondo recibe el resto.");
    agregar.hidden = lista.length >= disponibles.length;
  };
  const agregarFila = (id = "", monto = null) => {
    const sel = el("select", { "aria-label": "Fondo" }, [el("option", { value: "" }, "Elige un fondo"),
      ...disponibles.map((s) => el("option", { value: s.id }, "S-" + s.folio + " · " + (s.motivo || "Sin motivo") + " · " + fmtCLP(s.monto_solicitado)))]);
    sel.value = disponibles.some((s) => s.id === id) ? id : "";
    const inp = el("input", { class: "nr-fondo-monto", type: "text", inputmode: "numeric", placeholder: "Monto de este fondo", "aria-label": "Monto rendido contra este fondo" });
    if (monto != null) { inp.value = String(Math.round(Number(monto))); formatearInputMoney(inp); }
    const quitar = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "Quitar este fondo" }, "Quitar");
    const fila = el("div", { class: "nr-fondo-fila" }, [sel, inp, quitar]);
    sel.addEventListener("change", actualizar);
    inp.addEventListener("input", () => { formatearInputMoney(inp); actualizar(); });
    quitar.addEventListener("click", () => { fila.remove(); actualizar(); });
    filas.appendChild(fila);
  };
  agregar.addEventListener("click", () => { agregarFila(); actualizar(); });
  actuales.forEach((f) => agregarFila(f.solicitud_fondo_id, f.tope));
  if (!actuales.length) agregarFila();
  const guardar = el("button", { class: "btn btn-primary btn-sm", type: "button" }, "Guardar fondos");
  const cancelar = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Cancelar");
  cancelar.addEventListener("click", cerrar);
  guardar.addEventListener("click", async () => {
    const fondos = leer();
    const error = fondos.length ? window.RindeCore.validarFondosRendicion(fondos, total) : null;
    if (error) { toast(error); return; }
    if (!fondos.length && !confirm("¿Dejar esta rendición como Reembolso, sin fondo asociado?")) return;
    guardar.disabled = true;
    const { error: errorGuardar } = await db.rpc("asignar_fondos_rendicion", { p_rendicion: r.id, p_fondos: fondos });
    guardar.disabled = false;
    if (errorGuardar) { toast(mensajeErrorAmigable(errorGuardar)); return; }
    toast(fondos.length ? "Fondos de la rendición actualizados." : "La rendición quedó como Reembolso.");
    cerrar();
    loadDashboard();
  });
  editor.append(
    el("strong", {}, "Fondos de esta rendición"),
    el("p", { class: "portal-muted", style: "margin:4px 0 10px" }, "Cada fondo menos el último lleva cuánto se rinde de él; el último recibe el resto."),
    filas, resumen, el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" }, [agregar, guardar, cancelar]));
  actualizar();
  return editor;
}

async function openDetalle(id, pushHistory = true) {
  const box0 = document.getElementById("detalle-card");
  box0.innerHTML = "<p style='color:var(--ink-soft)'>Cargando...</p>";

  const { data: r, error: errR } = await db.from("rendiciones").select("*").eq("id", id).maybeSingle();
  if (errR || !r) {
    toast("No se pudo abrir esa rendición (puede que ya no exista o no tengas permiso).");
    replaceView("view-dashboard");
    return;
  }
  // Las dos consultas solo dependen de "id", no una de la otra -- se piden
  // en paralelo en vez de esperar la primera para recién pedir la segunda.
  // historialCount es solo para saber si hay algo que mostrar -- el botón de
  // historial ni aparece si la rendición nunca tuvo un cambio registrado.
  const [{ data: items, error: errorItems, count: cantidadItems }, { count: historialCount }, { data: montosEditados }] = await Promise.all([
    db.from("rendicion_items").select("*", {count:"exact"}).eq("rendicion_id", id),
    db.from("rendicion_items_historial").select("id", { count: "exact", head: true }).eq("rendicion_id", id),
    // Qué ítems tuvieron su monto editado a mano después de cargarse (por
    // OCR o a mano) -- una señal de confianza simple para quien aprueba,
    // usando datos que el historial ya guardaba pero que antes no se
    // resumían en ningún lado de la vista de detalle.
    db.from("rendicion_items_historial").select("item_id").eq("rendicion_id", id).eq("campo", "monto"),
  ]);
  if (errorItems || !items || cantidadItems !== items.length) {
    box0.textContent = "No se pudo cargar el detalle completo. Vuelve a abrir la rendición."; return;
  }
  window.RindeCore.ordenarItemsRendicion(items);
  const itemsConMontoEditado = new Set((montosEditados || []).map((h) => h.item_id));

  const esAprobadorViewer = esAprobadorEfectivo(currentProfile);
  const esPropia = r.empleado_id === currentUser.id;
  const puedeAprobar = esAprobadorViewer && r.estado === "Pendiente" && !esPropia;

  const box = document.getElementById("detalle-card");
  box.innerHTML = "";

  box.appendChild(el("div", { class: "detail-header" }, [
    el("div", {}, [
      el("h2", { style: "margin:0 0 4px" }, `N° ${r.folio ?? "-"} · ${r.comentario || `${r.empresa || "Sin empresa"} / ${r.tipo_rendicion}`}`),
      el("p", { style: "margin:0;color:var(--ink-soft);font-size:0.88rem" }, `${r.empleado_nombre} · ${fmtDate(r.fecha_rendicion || r.created_at)}`),
    ]),
    el("span", { class: "pill " + r.estado, style: "font-size:0.8rem" }, r.estado),
  ]));

  box.appendChild(crearResumenRendicion(items));
  const gruposDuplicados = documentosDuplicados(items.filter((it) => it.estado !== "Rechazado"));
  if (gruposDuplicados.length) box.appendChild(el("p", { class: "ocr-status show err" }, "⚠ Hay documentos repetidos en esta rendición. Comprueba que correspondan a una distribución del gasto y que no se esté rindiendo dos veces la factura."));

  // Fondos que justifica esta rendición (uno o varios, con la parte de cada
  // uno; folio real, no el uuid) y, mientras está Pendiente, el editor para
  // asociarla a fondos o cambiarlos -- p. ej. si se envió como Reembolso.
  const puedeCambiarFondos = r.estado === "Pendiente" && (esAprobadorViewer || r.empleado_id === currentUser.id);
  if ((r.tipo_rendicion === "FondoPorRendir" && r.solicitud_fondo_id) || puedeCambiarFondos) {
    const totalVigente = items.filter((it) => it.estado !== "Rechazado").reduce((s, it) => s + Number(it.monto || 0), 0);
    box.appendChild(await bloqueFondosRendicion(r, puedeCambiarFondos, totalVigente));
  }

  const puedeEditarItems = r.estado === "Pendiente" && (esAprobadorViewer || r.empleado_id === currentUser.id);

  const columnas = ["Tipo", "Proveedor / Categoría", "RUT", "Documento", "Fecha Venc."];
  if (esAprobadorViewer) columnas.push("Cuenta Contable");
  columnas.push("Centro de Costo", "Descripción", "Monto", "Estado");

  const tabla = el("table", { class: "items-table revision-gastos" });
  const thead = el("thead", {}, [el("tr", {}, columnas.map((c) => el("th", { class: c === "Monto" ? "right" : "" }, c)))]);
  tabla.appendChild(thead);

  const visor=window.RindeUI.createPreview(items,tabla,iterarImagenesAdjunto,nombreCuenta,verComprobante,esAprobadorViewer);
  (items || []).forEach((it) => {
    const tbody = el("tbody", { class: "revision-gasto" });
    tbody.dataset.estado = it.estado || "Pendiente";
    tbody.dataset.busqueda = [it.nombre_proveedor,it.categoria,it.rut_proveedor,it.nro_documento,it.descripcion,it.centro_costo].filter(Boolean).join(" ").toLocaleLowerCase("es");
    tabla.appendChild(tbody);
    const esCon = it.tipo_item === "ConDocumento";

    const celdas = [
      el("td", {}, tipoItemLabel(it.tipo_item)),
      el("td", { class: "wrap" }, [it.categoria, it.nombre_proveedor].filter(Boolean).join(" · ") || "-"),
      el("td", {}, esCon ? (it.rut_proveedor || "-") : "-"),
      el("td", {}, esCon ? `${it.tipo_documento || "-"}${it.nro_documento ? " #" + it.nro_documento : ""}` : "-"),
      el("td", {}, esCon && it.fecha_vencimiento ? fmtDate(it.fecha_vencimiento) : "-"),
    ];
    if (esAprobadorViewer) {
      let cuentaTxt = it.cuenta_contable ? `${it.cuenta_contable} · ${nombreCuenta(it.cuenta_contable) || "-"}` : "-";
      if (it.existe_en_contabilidad === true) cuentaTxt += " ✔";
      else if (it.existe_en_contabilidad === false) cuentaTxt += " ✘";
      celdas.push(el("td", { class: "wrap" }, cuentaTxt));
    }
    celdas.push(el("td", { class: "wrap" }, it.centro_costo || "-"));
    celdas.push(el("td", { class: "wrap" }, it.descripcion || "-"));
    const montoCellContenido = [fmtCLP(it.monto)];
    if (it.moneda === "USD") montoCellContenido.push(el("small", { class: "monto-usd", style: "display:block;color:var(--ink-soft)" },
      `USD ${fmtUsd(it.monto_original)} × ${fmtTipoCambio(it.tipo_cambio)} (${fmtDate(it.fecha_tipo_cambio)})`));
    if (itemsConMontoEditado.has(it.id)) {
      montoCellContenido.push(el("span", {
        title: "El monto de este ítem fue editado manualmente después de cargarse.",
        style: "margin-left:4px;cursor:help;",
      }, "✏️"));
    }
    celdas.push(el("td", { class: "monto" }, montoCellContenido));
    // Si el ítem quedó Rechazado dentro de una rendición que en general
    // terminó Aprobada, el pill rojo por sí solo no dice nada -- antes el
    // motivo (que sí se guarda) no se mostraba en ningún lado de la UI, así
    // que el empleado no tenía forma de saber por qué justo ESE ítem quedó
    // afuera del monto y del comprobante.
    const estadoCellContenido = [el("span", { class: "pill " + (it.estado || "Pendiente"), style: "font-size:0.72rem" }, it.estado || "Pendiente")];
    if (it.estado === "Rechazado" && it.motivo_rechazo) {
      estadoCellContenido.push(el("p", { style: "margin:4px 0 0;font-size:0.72rem;color:var(--danger);" }, it.motivo_rechazo));
    }
    celdas.push(el("td", { class: "center" }, estadoCellContenido));
    // En celular la tabla se apila como tarjetas (ver CSS) -- cada celda
    // necesita saber el nombre de su columna para mostrarlo como etiqueta.
    celdas.forEach((td, i) => td.setAttribute("data-label", columnas[i]));

    const filaExtra = el("tr", { class: "item-extra-row", style: "display:none;" });
    const extraCell = el("td", { colspan: String(columnas.length) });
    filaExtra.appendChild(extraCell);

    // OJO: el flex va en un <div> ADENTRO del <td>, no en el <td> mismo --
    // ponerle display:flex directo a una celda con colspan hace que algunos
    // navegadores dejen de sumarle el ancho de las columnas que abarca (se
    // achica a el ancho de una sola columna en vez de todas).
    const accionesCell = el("div", { class: "acciones-cell" });
    if (it.adjunto_url) {
      accionesCell.appendChild(el("button", { class: "btn btn-sm", type: "button", onclick: () => visor.select(it,tbody,true) }, "Ver comprobante"));
    }
    if (puedeEditarItems) {
      accionesCell.appendChild(el("button", {
        class: "btn btn-sm", type: "button",
        onclick: () => {
          filaExtra.style.display = ""; // deja que el CSS decida (ver comentario en openAdminUsuarios)
          iniciarEdicionItem(it, extraCell, r, esAprobadorViewer);
        },
      }, "Editar"));
    }
    // Las boletas (electrónicas o de honorarios) nunca llegan por el SII a
    // contabilidad, así que verificarlas contra "movimientos" no tiene
    // sentido: van directo como gasto aprobado. Solo las facturas
    // electrónicas se pueden verificar.
    if (esAprobadorViewer && esCon && (it.tipo_documento === "Factura Electrónica" || it.tipo_documento === "Factura Exenta Electrónica")) {
      accionesCell.appendChild(el("button", {
        class: "btn btn-sm", type: "button",
        onclick: () => {
          filaExtra.style.display = ""; // deja que el CSS decida (ver comentario en openAdminUsuarios)
          const verifyBox = el("div", { class: "verify-box show" }, "Consultando...");
          extraCell.innerHTML = "";
          extraCell.appendChild(verifyBox);
          verificarDocumentoItem(it, verifyBox, r.empresa, items);
        },
      }, "Verificar"));
    }
    // Aprobación por ítem: mientras la rendición siga Pendiente, el
    // aprobador puede aceptar o rechazar cada gasto por separado (y
    // cambiar de opinión las veces que quiera antes de "Finalizar
    // aprobación"). Un ítem Rechazado necesita un motivo, igual que el
    // rechazo general de la rendición.
    if (puedeAprobar) {
      const btnAprobarItem = el("button", { class: "btn btn-success btn-sm", type: "button" }, "Aprobar ítem");
      btnAprobarItem.addEventListener("click", async () => {
        // Si aprobarItem() tiene éxito vuelve a pintar todo el detalle (este
        // botón incluido), así que no hace falta reactivarlo a mano en ese
        // caso -- pero mientras esté en vuelo, sin esto un doble clic podía
        // disparar dos aprobaciones seguidas antes de que la primera volviera.
        btnAprobarItem.disabled = true;
        btnAprobarItem.textContent = "Aprobando...";
        await aprobarItem(it, r, "Aprobado");
        btnAprobarItem.disabled = false;
        btnAprobarItem.textContent = "Aprobar ítem";
      });
      accionesCell.appendChild(btnAprobarItem);
      accionesCell.appendChild(el("button", {
        class: "btn btn-danger btn-sm", type: "button",
        onclick: () => {
          filaExtra.style.display = ""; // deja que el CSS decida (ver comentario en openAdminUsuarios)
          extraCell.innerHTML = "";
          const motivoInput = el("textarea", {
            rows: "2", placeholder: "Motivo del rechazo de este ítem (se le avisa por correo al empleado)...",
            style: "width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font-family:inherit; font-size:0.85rem; resize:vertical;",
          });
          extraCell.appendChild(motivoInput);
          const btnConfirmarRechazo = el("button", { class: "btn btn-danger btn-sm", type: "button" }, "Confirmar rechazo del ítem");
          btnConfirmarRechazo.addEventListener("click", async () => {
            const motivo = motivoInput.value.trim();
            if (!motivo) { toast("Escribe el motivo del rechazo."); return; }
            btnConfirmarRechazo.disabled = true;
            btnConfirmarRechazo.textContent = "Rechazando...";
            await aprobarItem(it, r, "Rechazado", motivo);
            btnConfirmarRechazo.disabled = false;
            btnConfirmarRechazo.textContent = "Confirmar rechazo del ítem";
          });
          extraCell.appendChild(el("div", { style: "display:flex; gap:8px; margin-top:8px;" }, [
            btnConfirmarRechazo,
            el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { filaExtra.style.display = "none"; } }, "Cancelar"),
          ]));
        },
      }, "Rechazar ítem"));
    }
    tbody.appendChild(el("tr", { class: "revision-datos" }, celdas));
    tbody.appendChild(el("tr", { class: "acciones-row" }, [el("td", { colspan: String(columnas.length) }, [accionesCell])]));
    tbody.appendChild(filaExtra);

    // Resultado del "agente" que reintenta el OCR en segundo plano (ver
    // migracion_ocr_reintento.sql): nunca pisa lo ya guardado, es solo una
    // sugerencia para que quien revisa el ítem decida si vale la pena
    // aplicarla a mano (vía "Editar"). Los tres estados se muestran, incluido
    // "agotado": antes ese caso no renderizaba nada, así que el aviso
    // "🔄 la IA sigue intentando" simplemente desaparecía de la pantalla y
    // quien revisaba quedaba sin desenlace -- sin saber si había terminado
    // bien, si seguía corriendo o si el ítem se había caído de la cola.
    // OJO: el display:block de .ocr-status va en un <div> ADENTRO del <td>,
    // no en el <td> mismo -- mismo motivo que acciones-cell más arriba:
    // ponerle un display distinto de table-cell directo a una celda con
    // colspan hace que algunos navegadores dejen de sumarle el ancho de las
    // columnas que abarca (ya nos mordió con el panel "Editar perfil" de
    // Usuarios, mismo patrón).
    if (it.verificacion_contable) {
      const v=it.verificacion_contable;
      const caducada=v.empresa_revisada!==r.empresa || (v.miembros && JSON.stringify(v.miembros)!==JSON.stringify(window.RindeCore.grupoDocumentoContable(it,items).miembros));
      tbody.appendChild(el("tr",{},[el("td",{colspan:String(columnas.length)},[el("div",{class:"verify-box show "+(v.estado==="coincide" && !caducada?"ok":"err")},"Verificación: "+(caducada?"caducada; cambió la distribución del documento":v.estado)+" · "+detalleMontoVerificado(v)+" · Cuenta "+(v.cuenta||"-")+" · "+(v.nombre_cuenta||"-")+" · "+(v.verificado_en?fmtDate(v.verificado_en):""))])]));
    }
    if (it.ocr_reintento_estado === "pendiente") {
      tbody.appendChild(el("tr", {}, [
        el("td", { colspan: String(columnas.length) }, [
          el("div", { class: "ocr-status show" },
            "La IA reintentará los campos pendientes de este comprobante. Tus datos guardados se conservan."),
        ]),
      ]));
    }
    if (it.ocr_reintento_resultado) {
      const s = it.ocr_reintento_resultado;
      const partes = [
        s.nombre_proveedor && `Proveedor: ${s.nombre_proveedor}`,
        s.rut_proveedor && `RUT: ${s.rut_proveedor}`,
        s.nro_documento && `N° documento: ${s.nro_documento}`,
        s.monto && `Monto: ${fmtCLP(s.monto)}`,
      ].filter(Boolean).join(" · ");
      tbody.appendChild(el("tr", {}, [
        el("td", { colspan: String(columnas.length) }, [
          el("div", { class: "ocr-status show " + (s.revision_estado === "completo" ? "ok" : "err") },
            s.requiere_separacion ? s.aviso_documento : `Lectura ${s.revision_estado || "por revisar"}: ${partes || "sin datos nuevos"}. ${s.campos_pendientes?.length ? "Pendiente: "+s.campos_pendientes.join(", ")+". " : ""}Revisa la evidencia y aplica las correcciones con "Editar".`),
        ]),
      ]));
    } else if (it.ocr_reintento_estado === "agotado") {
      tbody.appendChild(el("tr", {}, [
        el("td", { colspan: String(columnas.length) }, [
          el("div", { class: "ocr-status show" },
            "La IA no pudo leer este comprobante ni siquiera reintentando en segundo plano. Los datos del ítem son los que cargó la persona a mano: revísalos contra el comprobante adjunto."),
        ]),
      ]));
    }
  });

  const filtrosRevision = el("div", { class: "revision-filtros" });
  const estadosRevision = el("div", { class: "revision-estados", role: "group", "aria-label": "Filtrar gastos por estado" });
  const buscarRevision = el("input", { type: "search", placeholder: "Buscar proveedor, folio o descripción…", "aria-label": "Buscar gastos", class: "revision-buscar" });
  const resultadoRevision = el("span", { class: "revision-resultado", role: "status", "aria-live": "polite" });
  let estadoRevision = "Todos";
  const botonesRevision = [];
  function filtrarRevision() {
    const texto = buscarRevision.value.trim().toLocaleLowerCase("es");
    let visibles = 0;
    Array.from(tabla.tBodies).forEach(grupo => {
      const mostrar = (estadoRevision === "Todos" || grupo.dataset.estado === estadoRevision) && grupo.dataset.busqueda.includes(texto);
      grupo.hidden = !mostrar;
      if (mostrar) visibles++;
    });
    botonesRevision.forEach(({boton,estado}) => boton.setAttribute("aria-pressed", String(estado === estadoRevision)));
    resultadoRevision.textContent = visibles + " de " + items.length + " gastos";
  }
  ["Todos","Pendiente","Aprobado","Rechazado"].forEach(estado => {
    const cantidad = estado === "Todos" ? items.length : items.filter(it => (it.estado || "Pendiente") === estado).length;
    const boton = el("button", { type: "button", class: "btn btn-sm", "aria-pressed": String(estado === "Todos"), onclick: () => {estadoRevision = estado; filtrarRevision();} }, estado + " · " + cantidad);
    botonesRevision.push({boton,estado});
    estadosRevision.appendChild(boton);
  });
  buscarRevision.addEventListener("input", filtrarRevision);
  filtrosRevision.append(estadosRevision,buscarRevision,resultadoRevision);
  box.appendChild(el("div",{class:"portal-review-workspace"},[el("div",{},[filtrosRevision,el("div", { class: "revision-contenedor" }, [tabla])]),visor.element]));
  visor.first();
  filtrarRevision();



  if (r.estado === "Aprobado") {
    box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:10px" },
      `Aprobado por ${r.aprobador_nombre || "-"} el ${fmtDate(r.fecha_aprobacion)}`));
  }

  if (r.estado === "Rechazado") {
    box.appendChild(el("div", {
      style: "margin-top:10px; padding:12px 14px; border-radius:8px; background:var(--danger-bg); color:var(--danger);",
    }, [
      el("p", { style: "margin:0 0 4px; font-weight:600;" }, `Rechazado por ${r.aprobador_nombre || "-"} el ${fmtDate(r.fecha_aprobacion)}`),
      el("p", { style: "margin:0;" }, r.motivo_rechazo || "No se dejó un motivo."),
    ]));
  }

  if (esAprobadorViewer && esPropia && r.estado === "Pendiente") {
    box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:16px" },
      "Es tu propia rendición -- otro aprobador o admin debe revisarla, no puedes aprobarla o rechazarla tú mismo."));
  }

  if (puedeAprobar) {
    const pendientes = (items || []).filter((it) => (it.estado || "Pendiente") === "Pendiente").length;
    if (pendientes > 0) {
      box.appendChild(el("p", { style: "color:var(--warn);font-size:0.85rem;margin-top:16px" },
        `Faltan ${pendientes} ítem(s) por revisar (Aprobar ítem / Rechazar ítem, en la tabla de arriba) antes de poder finalizar la aprobación.`));
      if (pendientes > 1) {
        // Aprobar uno por uno tiene sentido cuando hay que revisar cada
        // ítem con cuidado, pero para una rendición larga con varios ítems
        // obviamente correctos, forzar el clic individual en cada uno es
        // pura fricción -- este botón aprueba de un golpe todos los que
        // sigan Pendientes (no toca los que ya se marcaron Aprobado o
        // Rechazado a mano).
        const btnAprobarTodos = el("button", { class: "btn btn-success", style: "margin-top:8px;" }, `Aprobar los ${pendientes} ítems pendientes`);
        btnAprobarTodos.addEventListener("click", async () => {
          if (!confirm(`¿Aprobar de una vez los ${pendientes} ítem(s) que siguen Pendientes de esta rendición?`)) return;
          btnAprobarTodos.disabled = true;
          btnAprobarTodos.textContent = "Aprobando...";
          await aprobarTodosPendientes(r, items);
        });
        box.appendChild(btnAprobarTodos);
      }
    } else {
      const aprobados = (items || []).filter((it) => it.estado === "Aprobado").length;
      const rechazados = (items || []).filter((it) => it.estado === "Rechazado").length;
      box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:16px" },
        `${aprobados} ítem(s) aprobado(s), ${rechazados} rechazado(s). Al finalizar, los rechazados quedan fuera del monto y del comprobante.`));
      const btnFinalizar = el("button", { class: "btn btn-primary", style: "margin-top:8px;" }, "Finalizar aprobación");
      btnFinalizar.addEventListener("click", async () => {
        const totalAprobado = aprobados > 0 ? fmtCLP(items.filter((it) => it.estado === "Aprobado").reduce((s, it) => s + Number(it.monto || 0), 0)) : "$0";
        if (!confirm(`¿Finalizar la aprobación de esta rendición? Quedará ${aprobados > 0 ? "Aprobada por " + totalAprobado : "Rechazada"}. Esta acción no se puede deshacer.`)) return;
        btnFinalizar.disabled = true;
        btnFinalizar.textContent = "Finalizando...";
        await finalizarAprobacionRendicion(r, items);
        btnFinalizar.disabled = false;
        btnFinalizar.textContent = "Finalizar aprobación";
      });
      box.appendChild(btnFinalizar);
    }
  }

  // Todas las acciones secundarias (descargas, reenviar aviso, historial)
  // van juntas en una sola fila que se ajusta sola (flex-wrap) -- antes cada
  // botón se agregaba suelto con su propio margin-top distinto, así que en
  // pantallas angostas quedaban amontonados con alturas y separaciones
  // inconsistentes en vez de una fila prolija.
  const acciones = el("div", { style: "display:flex; flex-wrap:wrap; gap:8px; margin-top:16px;" });
  if (r.estado === "Aprobado") {
    const avisoKame = el("p", { class: "portal-muted", style: "flex-basis:100%;margin:0;font-size:0.85rem" }, textoExportacionKame(r) || "El CSV para Kame todavía no se ha descargado.");
    acciones.appendChild(el("button", {
      class: "btn btn-secondary btn-sm", type: "button",
      onclick: async () => { await descargarCSV(r, items); avisoKame.textContent = textoExportacionKame(r) || avisoKame.textContent; },
    }, "Descargar comprobante para Kame"));
    if (esAprobadorViewer) acciones.appendChild(avisoKame);
  }
  // El aviso por correo al empleado se manda una sola vez, al momento de
  // aprobar/rechazar (ver finalizarAprobacionRendicion) -- si falló ahí
  // (ej. Resend mal configurado, o la sesión de quien aprobó estaba
  // desactualizada) no hay reintento automático. Este botón repite
  // exactamente esa misma llamada, a mano, sin tener que recurrir a la
  // consola del navegador.
  if (esAprobadorViewer && (r.estado === "Aprobado" || r.estado === "Rechazado")) {
    const btnReenviar = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "Reenviar notificación por correo");
    btnReenviar.addEventListener("click", async () => {
      btnReenviar.disabled = true;
      btnReenviar.textContent = "Enviando...";
      const { data, error } = await db.functions.invoke("notificar-estado-rendicion", { body: { rendicion_id: r.id } });
      if (error || !data?.ok) {
        const mensaje = error ? await mensajeErrorFuncion(error) : data?.error;
        toast("No se pudo enviar: " + (mensaje || "revisa los logs de la función en Supabase."));
      } else {
        toast("Notificación reenviada.");
      }
      btnReenviar.disabled = false;
      btnReenviar.textContent = "Reenviar notificación por correo";
    });
    acciones.appendChild(btnReenviar);
  }
  acciones.appendChild(el("button", {
    class: "btn btn-secondary btn-sm", type: "button",
    onclick: () => generarInformePDF(r, items),
  }, "Descargar informe PDF"));
  // Quién cambió qué y cuándo, para todos los ítems de esta rendición (no
  // solo el más reciente) -- es información de auditoría, no algo que se
  // consulte en el flujo normal de aprobar/editar. Ni el botón aparece si
  // la rendición nunca tuvo un cambio registrado.
  const historialBox = el("div", { style: "width:100%; margin-top:8px;" });
  if (historialCount && historialCount > 0) {
    acciones.appendChild(el("button", {
      class: "btn btn-secondary btn-sm", type: "button",
      onclick: () => mostrarHistorialRendicion(r.id, historialBox),
    }, "Ver historial de cambios"));
  }
  box.appendChild(acciones);
  box.appendChild(historialBox);
  if (currentProfile?.rol === "admin") {
    try { const panel = await panelCorreccionesAdmin(r, items); if (panel) box.appendChild(panel); }
    catch (error) { console.warn("No se pudo armar el panel de correcciones:", error); }
  }

  if (pushHistory) pushView("view-detalle", { id }); else show("view-detalle");
}

// ------------------------------------------------------------
// Correcciones de administrador (detalle de una rendición). Cada acción llama
// a una función de la base que valida, aplica, deja historial y un evento en
// una sola transacción (ver 20261112120000_correcciones_admin.sql). Aquí solo
// se ofrecen las acciones que tienen sentido para el estado de la rendición.
// ------------------------------------------------------------
function descargarTextoCsv(fileName, content) {
  const url = URL.createObjectURL(new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" }));
  const link = el("a", { href: url, download: fileName });
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Reverso para Kame de una rendición aprobada cuyo CSV ya se descargó: las
// mismas líneas con Debe y Haber invertidos, fechadas hoy. Se arma ANTES de
// anular, porque después los gastos quedan rechazados y ya no hay asiento.
async function prepararReversoKame(r, items) {
  const rend = await conDatosActualesDeEmpleado(r);
  let split = null;
  if (rend.tipo_rendicion === "FondoPorRendir" && rend.solicitud_fondo_id) {
    split = (await calcularSplitFondo([rend])).get(rend.id) || null;
  }
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
  const filas = construirFilasCSV(rend, items, 1, split, { reverso: { fecha: `${d}/${m}/${y}` } });
  return { fileName: `reverso_rendicion_${r.folio ?? r.id.slice(0, 8)}.csv`, content: [CSV_HEADER, ...filas].join("\r\n") };
}

function formularioCorreccion({ titulo, descripcion, campos = [], textoBoton, ejecutar }) {
  const motivo = el("textarea", { rows: "2", maxlength: "500", placeholder: "Motivo (queda en el historial)" });
  const estado = el("p", { class: "portal-muted", role: "status", style: "margin:8px 0 0" });
  const boton = el("button", { class: "btn btn-primary btn-sm", type: "button" }, textoBoton);
  const caja = el("div", { class: "correccion-accion", hidden: "" }, [
    el("p", { style: "margin:0 0 8px;font-size:0.88rem" }, descripcion),
    ...campos,
    el("div", { class: "field" }, [el("label", {}, "Motivo"), motivo]),
    boton, estado,
  ]);
  const abrir = el("button", { class: "btn btn-secondary btn-sm", type: "button", "aria-expanded": "false" }, titulo);
  abrir.addEventListener("click", () => { caja.hidden = !caja.hidden; abrir.setAttribute("aria-expanded", String(!caja.hidden)); });
  boton.addEventListener("click", async () => {
    const texto = motivo.value.trim();
    if (texto.length < 3) { estado.textContent = "Explica el motivo de la corrección."; motivo.focus(); return; }
    boton.disabled = true; estado.textContent = "Aplicando…";
    try { await ejecutar(texto, estado); }
    catch (error) { estado.textContent = mensajeErrorAmigable(error); }
    finally { boton.disabled = false; }
  });
  return { abrir, caja };
}

async function panelCorreccionesAdmin(r, items) {
  const panel = el("section", { class: "card correcciones-admin", "aria-label": "Correcciones de administrador" });
  const botones = el("div", { style: "display:flex;flex-wrap:wrap;gap:8px" });
  const cajas = el("div", {});
  const agregar = (f) => { botones.appendChild(f.abrir); cajas.appendChild(f.caja); };
  const rpc = async (nombre, args) => { const { data, error } = await db.rpc(nombre, args); if (error) throw error; return data; };
  const pendienteLibre = r.estado === "Pendiente" && !r.kame_exportado_en;
  const sinFondo = r.tipo_rendicion === "Reembolso" && !r.solicitud_fondo_id;

  if (pendienteLibre && sinFondo) {
    const selEmpresa = el("select", {}, EMPRESAS.filter((e) => e !== r.empresa).map((e) => el("option", { value: e }, e)));
    agregar(formularioCorreccion({
      titulo: "Cambiar empresa",
      descripcion: `Hoy es de ${r.empresa}. Cambia la rendición y sus ${items.length} gastos; la verificación contable de cada gasto se vuelve a hacer.`,
      campos: [el("div", { class: "field" }, [el("label", {}, "Empresa nueva"), selEmpresa])],
      textoBoton: "Cambiar empresa",
      ejecutar: async (motivo) => {
        if (!confirm(`¿Pasar la rendición N° ${r.folio} de ${r.empresa} a ${selEmpresa.value}?`)) return;
        await rpc("admin_cambiar_empresa_rendicion", { p_rendicion: r.id, p_empresa: selEmpresa.value, p_motivo: motivo });
        toast(`Rendición N° ${r.folio} ahora es de ${selEmpresa.value}.`); loadDashboard(); openDetalle(r.id, false);
      },
    }));

    const { data: perfiles } = await db.from("profiles").select("id, nombre, activo").eq("activo", true).order("nombre");
    const candidatos = (perfiles || []).filter((p) => p.id !== r.empleado_id && p.id !== currentUser.id);
    if (candidatos.length) {
      const selEmpleado = el("select", {}, candidatos.map((p) => el("option", { value: p.id }, p.nombre)));
      agregar(formularioCorreccion({
        titulo: "Traspasar a otro empleado",
        descripcion: `Hoy es de ${r.empleado_nombre}. Úsalo cuando alguien cargó la rendición por otra persona. Las boletas quedan donde están y el nuevo dueño las puede ver.`,
        campos: [el("div", { class: "field" }, [el("label", {}, "Nuevo dueño"), selEmpleado])],
        textoBoton: "Traspasar",
        ejecutar: async (motivo) => {
          const nombre = selEmpleado.selectedOptions[0]?.textContent;
          if (!confirm(`¿Traspasar la rendición N° ${r.folio} de ${r.empleado_nombre} a ${nombre}?`)) return;
          await rpc("admin_cambiar_empleado_rendicion", { p_rendicion: r.id, p_empleado: selEmpleado.value, p_motivo: motivo });
          toast(`Rendición N° ${r.folio} traspasada a ${nombre}.`); loadDashboard(); openDetalle(r.id, false);
        },
      }));
    }
  }

  if (pendienteLibre) {
    let q = db.from("rendiciones").select("id, folio, comentario, monto_total, created_at").eq("estado", "Pendiente")
      .eq("empleado_id", r.empleado_id).eq("empresa", r.empresa).eq("tipo_rendicion", r.tipo_rendicion)
      .is("kame_exportado_en", null).neq("id", r.id).order("folio");
    q = r.solicitud_fondo_id ? q.eq("solicitud_fondo_id", r.solicitud_fondo_id) : q.is("solicitud_fondo_id", null);
    const { data: hermanas } = await q;
    if (hermanas?.length) {
      const checks = hermanas.map((h) => {
        const cb = el("input", { type: "checkbox", value: h.id, id: "unir-" + h.id });
        return { cb, h, fila: el("label", { for: cb.id, style: "display:flex;gap:8px;align-items:center;margin:4px 0" }, [cb, `N° ${h.folio} · ${h.comentario || "Sin comentario"} · ${fmtCLP(h.monto_total)}`]) };
      });
      agregar(formularioCorreccion({
        titulo: "Unir con otras rendiciones",
        descripcion: `Rendiciones pendientes de ${r.empleado_nombre} con la misma empresa, tipo y fondo. Sus gastos pasan a la N° ${r.folio}, al final y en el orden en que se enviaron; las elegidas desaparecen.`,
        campos: checks.map((c) => c.fila),
        textoBoton: `Unir en la N° ${r.folio}`,
        ejecutar: async (motivo, estado) => {
          const elegidas = checks.filter((c) => c.cb.checked);
          if (!elegidas.length) { estado.textContent = "Marca al menos una rendición."; return; }
          if (!confirm(`¿Unir ${elegidas.map((c) => "N° " + c.h.folio).join(", ")} en la N° ${r.folio}? Las elegidas dejan de existir.`)) return;
          const res = await rpc("admin_unir_rendiciones", { p_destino: r.id, p_origenes: elegidas.map((c) => c.h.id), p_motivo: motivo });
          toast(`${res.unidas} unidas en la N° ${r.folio}: ${res.gastos_movidos} gastos, total ${fmtCLP(res.total)}.`); loadDashboard(); openDetalle(r.id, false);
        },
      }));
    }
  }

  if (r.estado === "Aprobado" && r.empleado_id !== currentUser.id) {
    const exportada = !!r.kame_exportado_en;
    agregar(formularioCorreccion({
      titulo: "Anular aprobación",
      descripcion: "Pasa la rendición a Rechazada con este motivo y le avisa a " + r.empleado_nombre + " por correo."
        + (exportada ? " Su CSV ya se descargó para Kame: se descarga también el REVERSO, que hay que importar en Kame para cancelar el asiento." : " Su CSV todavía no se ha descargado para Kame."),
      textoBoton: "Anular aprobación",
      ejecutar: async (motivo, estado) => {
        let reverso = null;
        if (exportada) {
          estado.textContent = "Preparando el reverso para Kame…";
          reverso = await prepararReversoKame(r, items);
        }
        if (!confirm(`¿Anular la aprobación de la rendición N° ${r.folio} (${fmtCLP(r.monto_total)})?` + (exportada ? "\n\nSe descargará el reverso para Kame." : ""))) { estado.textContent = ""; return; }
        await rpc("admin_anular_aprobacion", { p_rendicion: r.id, p_motivo: motivo });
        if (reverso) descargarTextoCsv(reverso.fileName, reverso.content);
        notificarAsync("notificar-estado-rendicion", { rendicion_id: r.id }, "No se pudo notificar al empleado:");
        toast(`Aprobación de la N° ${r.folio} anulada.` + (reverso ? " Importa el reverso en Kame una sola vez." : "")); loadDashboard(); openDetalle(r.id, false);
      },
    }));
  }

  if (!botones.children.length) return null;
  panel.append(
    el("h3", { style: "margin:0 0 4px;font-size:1rem" }, "Correcciones de administrador"),
    el("p", { class: "portal-muted", style: "margin:0 0 10px;font-size:0.85rem" }, "Cada corrección pide un motivo y queda en el historial y en el registro de eventos."),
    botones, cajas);
  return panel;
}

// Marca un ítem individual Aprobado/Rechazado (el aprobador puede cambiar
// de opinión las veces que quiera mientras la rendición siga Pendiente) y
// vuelve a pintar el detalle para que se actualice el pill de estado y la
// disponibilidad del botón "Finalizar aprobación".
// .select() es necesario para detectar el caso en que RLS bloquea la fila
// silenciosamente (sin llegar a disparar un trigger que devolvería un error
// real): sin él, Postgrest devuelve error:null aunque hayan sido 0 las filas
// modificadas, y un toast de éxito miente mientras el dato se queda pegado en
// su valor anterior. Usar esto en vez de un .update() directo en cualquier
// lugar donde un falso "funcionó" sería grave (cambios de estado/aprobación).
async function updateChecked(table, id, cambios) {
  const { data, error } = await db.from(table).update(cambios).eq("id", id).select();
  if (error) return { ok: false, mensaje: mensajeErrorAmigable(error) };
  if (!data || data.length === 0) return { ok: false, mensaje: "No tienes permiso para hacer este cambio, o ya no existe." };
  return { ok: true, data };
}

// Dispara una Edge Function de notificación sin bloquear la UI ni el flujo
// principal -- si el correo falla (Resend caído, secret sin configurar), la
// rendición/solicitud ya quedó guardada de todas formas, que es lo que
// importa. db.functions.invoke() NO rechaza la promesa cuando la función
// responde con un error propio (ej. { error: "..." } en el body) -- resuelve
// igual, así que hace falta revisar "error" en el .then() ADEMÁS del
// .catch(): con solo este último, ese caso pasaba completamente
// desapercibido, sin ni un console.error que lo delatara.
function notificarAsync(fn, body, contexto) {
  db.functions.invoke(fn, { body }).then(async ({ error }) => {
    if (error) console.error(contexto, await mensajeErrorFuncion(error), error);
  }).catch((err) => console.error(contexto, err));
}

async function aprobarItem(item, rendicion, estado, motivo = null) {
  const cambios = { estado, motivo_rechazo: estado === "Rechazado" ? motivo : null };
  const res = await updateChecked("rendicion_items", item.id, cambios);
  if (!res.ok) { toast(res.mensaje); return; }
  Object.assign(item, cambios);
  toast(estado === "Aprobado" ? "Ítem aprobado." : "Ítem rechazado.");
  openDetalle(rendicion.id, false);
}

// Aprueba de un golpe todos los ítems que sigan Pendientes de una rendición
// (botón "Aprobar los N ítems pendientes" en openDetalle) -- para una
// rendición larga donde cada ítem es obviamente correcto, aprobar uno por
// uno es pura fricción. No toca los que el aprobador ya haya marcado a
// mano como Aprobado o Rechazado.
async function aprobarTodosPendientes(rendicion, items) {
  const pendientes = items.filter((it) => (it.estado || "Pendiente") === "Pendiente");
  let ok = 0;
  const errores = [];
  for (const it of pendientes) {
    const res = await updateChecked("rendicion_items", it.id, { estado: "Aprobado", motivo_rechazo: null });
    if (res.ok) { it.estado = "Aprobado"; it.motivo_rechazo = null; ok++; }
    else errores.push(res.mensaje);
  }
  toast(errores.length
    ? `Se aprobaron ${ok} de ${pendientes.length} ítems. ${errores[0]}`
    : `${ok} ítem(s) aprobado(s).`);
  openDetalle(rendicion.id, false);
}

// "Aprobación general": solo se puede llamar cuando ningún ítem quedó
// Pendiente. Los ítems Rechazados se excluyen del monto_total y del
// comprobante Kame; si quedó al menos un ítem Aprobado, la rendición pasa
// a Aprobado (con el monto recalculado); si todos fueron rechazados, pasa
// a Rechazado.
async function finalizarAprobacionRendicion(rendicion, items) {
  const duplicados = documentosDuplicados(items.filter((it) => it.estado !== "Rechazado"));
  if (duplicados.length && !confirm("Hay documentos repetidos dentro de esta rendición. Verifica la distribución de montos antes de aprobar. ¿Continuar?")) return;
  const conNc = items.filter((it) => it.estado === "Aprobado" && it.verificacion_contable?.notas_credito?.length);
  if (conNc.length && !confirm("Ojo: " + conNc.map((it) => (it.tipo_documento || "Documento") + " " + (it.nro_documento || "") + ": " + textoNotasCredito(it.verificacion_contable.notas_credito)).join("\n\n") + "\n\n¿Aprobar igual?")) return;
  const { data, error } = await db.rpc("finalizar_rendicion", { p_id: rendicion.id });
  if (error || !data) { toast(mensajeErrorAmigable(error || new Error("No se pudo finalizar."))); await openDetalle(rendicion.id, false); return; }
  Object.assign(rendicion, data.rendicion);
  toast(rendicion.estado === "Aprobado" ? "Rendición aprobada." : "Rendición rechazada.");
  notificarAsync("notificar-estado-rendicion", { rendicion_id: rendicion.id }, "No se pudo notificar al empleado:");
  if (rendicion.estado === "Aprobado") await descargarCSV(rendicion, data.items);
  replaceView("view-dashboard");
  loadDashboard();
}

// El bucket "comprobantes" es privado: para ver la foto/PDF hay que pedir una
// URL firmada de corta duración en vez de un link directo.
async function verComprobante(it) {
  const { data, error } = await db.storage.from("comprobantes").createSignedUrl(it.adjunto_url, 120);
  if (error || !data?.signedUrl) { toast("No se pudo abrir el comprobante: " + (error?.message || "")); return; }
  window.open(data.signedUrl, "_blank");
}

// Deja registro en rendicion_items_historial de quién cambió qué y desde
// qué valor a cuál. Importante sobre todo para la cuenta contable (Centro
// de Costo) y el monto, que son los campos que afectan la contabilidad.

// Nombres de campo legibles para el historial (ver mostrarHistorialRendicion).
const NOMBRE_CAMPO_HISTORIAL = {
  tipo_item: "Tipo",
  estado: "Estado",
  monto: "Monto",
  descripcion: "Descripción",
  nombre_proveedor: "Proveedor / Local",
  rut_proveedor: "RUT proveedor",
  categoria: "Categoría",
  cuenta_contable: "Cuenta contable",
  centro_costo: "Centro de Costo",
  tipo_documento: "Tipo de documento",
  nro_documento: "N° de documento",
  fecha_vencimiento: "Fecha del documento",
  existe_en_contabilidad: "Existe en contabilidad",
  comprobante_contable_encontrado: "Comprobante contable encontrado",
  motivo_rechazo: "Motivo de rechazo",
};

// Algunos valores guardados son códigos internos (tipo_item, monto) que
// conviene mostrar en el mismo formato que ve la persona en el resto de la
// app, no el valor crudo de la base.
function valorLegibleHistorial(campo, valor) {
  if (valor === null || valor === undefined || valor === "") return "(vacío)";
  if (campo === "tipo_item") return tipoItemLabel(valor);
  if (campo === "monto") return fmtCLP(Number(valor));
  if (campo === "cuenta_contable") {
    const nombre = nombreCuenta(valor);
    return `${valor}${nombre ? " · " + nombre : ""}`;
  }
  if (campo === "existe_en_contabilidad" || campo === "comprobante_contable_encontrado") {
    return valor === "true" ? "Sí" : valor === "false" ? "No" : valor;
  }
  return valor;
}

// Muestra, para TODA la rendición (todos sus ítems, no uno solo), quién
// cambió qué y cuándo (tabla rendicion_items_historial, alimentada por
// registrarCambio() y por el trigger de auditoría de cambio de estado).
// Va al final del detalle, detrás de un botón -- es información de
// auditoría, no algo que se consulte en el flujo normal de aprobar/editar.
// Cualquiera que pueda ver la rendición puede ver su historial (misma regla
// de visibilidad -- RLS -- que para los ítems mismos).
async function mostrarHistorialRendicion(rendicionId, box) {
  if (box.dataset.open === "true") { box.innerHTML = ""; box.dataset.open = "false"; return; }
  box.dataset.open = "true";

  box.innerHTML = "";
  box.appendChild(el("p", { class: "ocr-status show" }, "Cargando historial..."));

  const { data: historial, error } = await db
    .from("rendicion_items_historial")
    .select("*, rendicion_items(descripcion, nombre_proveedor)")
    .eq("rendicion_id", rendicionId)
    .order("created_at", { ascending: false });

  // Si en el tiempo que tardó la consulta la persona volvió a hacer clic y
  // cerró el panel, no lo pisamos -- sin este chequeo el contenido
  // reaparecía solo después de haberlo cerrado.
  if (box.dataset.open !== "true") return;

  box.innerHTML = "";
  if (error) {
    box.appendChild(el("p", { class: "ocr-status show err" }, mensajeErrorAmigable(error)));
    return;
  }
  if (!historial || !historial.length) {
    box.appendChild(el("p", { style: "margin:0;color:var(--ink-soft);font-size:0.85rem" }, "Esta rendición no tiene cambios registrados."));
    return;
  }
  box.appendChild(el("div", { style: "display:flex; flex-direction:column; gap:10px;" },
    historial.map((h) => {
      const item = h.rendicion_items;
      const itemLabel = item ? (item.descripcion || item.nombre_proveedor || "Ítem sin descripción") : "Ítem eliminado";
      return el("div", {
        style: "border-left:3px solid var(--line); padding-left:10px; font-size:0.82rem; line-height:1.5;",
      }, [
        el("p", { style: "margin:0 0 2px; font-weight:600;" }, itemLabel),
        el("p", { style: "margin:0;" }, [
          `${NOMBRE_CAMPO_HISTORIAL[h.campo] || h.campo}: `,
          el("span", { style: "color:var(--ink-soft);" }, valorLegibleHistorial(h.campo, h.valor_anterior)),
          " → ",
          valorLegibleHistorial(h.campo, h.valor_nuevo),
        ]),
        el("p", { style: "margin:2px 0 0;color:var(--ink-soft);font-size:0.78rem;" },
          `${h.usuario_nombre || "-"} · ${new Date(h.created_at).toLocaleString("es-CL")}`),
      ]);
    })
  ));
}

// Cuenta de un documento editado. El aprobador la escribe (null si quien edita
// es el empleado, que no la ve). Vacía, o igual a la del tipo anterior cuando
// cambió el tipo sin que el empleado pudiera tocarla, pasa a la del tipo nuevo.
function cuentaDocumentoEditado(it, tipoNuevo, cuentaEscrita) {
  const porDefecto = CUENTA_POR_TIPO_DOC[tipoNuevo] || "";
  if (cuentaEscrita !== null) return cuentaEscrita || porDefecto;
  const actual = it.tipo_item === "ConDocumento" ? (it.cuenta_contable || "") : "";
  const delTipoAnterior = it.tipo_item === "ConDocumento" && actual === CUENTA_POR_TIPO_DOC[it.tipo_documento];
  return !actual || (delTipoAnterior && tipoNuevo !== it.tipo_documento) ? porDefecto : actual;
}

function iniciarEdicionItem(it, lineWrap, rendicion, esAprobadorViewer) {
  lineWrap.innerHTML = "";
  // Prefijado con el id del ítem: sin esto, editar dos ítems de la misma
  // rendición al mismo tiempo dejaba dos elementos con el mismo id en el DOM.
  const pfx = `edit-${it.id}-`;
  // El tipo se puede cambiar mientras se edita (ej. se cargó por error como
  // "Documento electrónico" y en realidad es una "Boleta"): el toggle de
  // abajo reconstruye los campos de tipo-específico cada vez que cambia,
  // sin tocar monto/descripción que son comunes a ambos tipos.
  let tipoEditado = it.tipo_item;
  // Cambiar el tipo (Documento electrónico <-> Boleta) es una corrección de
  // clasificación contable, no algo que un empleado deba poder hacer sobre
  // su propio gasto -- solo aprobador/admin ven el selector.
  const puedeCambiarTipo = esAprobadorViewer;

  // Un borrador por tipo, sembrado desde el ítem original: así, si alguien
  // alterna entre pestañas varias veces antes de guardar, lo que haya
  // tecleado en una no se pierde al mirar la otra y volver (antes se releía
  // siempre desde el ítem original, tirando a la basura cualquier edición
  // sin guardar). Documento electrónico también guarda ahora tipo/N°/fecha
  // de documento -- antes "Editar" nunca los mostraba, así que al volver de
  // "Boleta" a "Documento electrónico" quedaban perdidos para siempre (el
  // ítem quedaba con tipo_documento null sin ninguna forma de corregirlo).
  const draftCon = {
    nombreProveedor: it.tipo_item === "ConDocumento" ? (it.nombre_proveedor || "") : "",
    rutProveedor: it.tipo_item === "ConDocumento" ? (it.rut_proveedor || "") : "",
    cuentaContable: it.tipo_item === "ConDocumento" ? (it.cuenta_contable || "") : "",
    tipoDocumento: it.tipo_item === "ConDocumento" && it.tipo_documento ? it.tipo_documento : TIPOS_DOCUMENTO[0],
    nroDocumento: it.tipo_item === "ConDocumento" ? (it.nro_documento || "") : "",
    fechaVencimiento: it.tipo_item === "ConDocumento" ? (it.fecha_vencimiento || "") : "",
    // Categoría propia de Documento electrónico (ver buildConDocumentoFields
    // -- no reemplaza cuentaContable, es una clasificación aparte).
    categoria: it.tipo_item === "ConDocumento" ? it.categoria : null,
  };
  const draftSin = {
    nombreProveedor: it.tipo_item === "SinDocumento" ? (it.nombre_proveedor || "") : "",
    categoria: it.tipo_item === "SinDocumento" ? it.categoria : null,
    cuentaContable: it.tipo_item === "SinDocumento" ? (it.cuenta_contable || "") : "",
  };
  // El Centro de Costo es la misma unidad de negocio física sea cual sea el
  // tipo, así que se comparte en vez de duplicarse por borrador.
  let centroCostoDraft = it.centro_costo || "";

  const toggle = puedeCambiarTipo
    ? el("div", { class: "toggle-group", role: "tablist" }, [
        el("button", { type: "button", "data-tipo": "ConDocumento", "aria-pressed": "false" }, "Documento electrónico"),
        el("button", { type: "button", "data-tipo": "SinDocumento", "aria-pressed": "false" }, "Comprobante/Boleta"),
      ])
    : null;
  const camposTipo = el("div");

  // Vuelca lo que haya en pantalla al borrador del tipo que se está dejando,
  // antes de reconstruir los campos con el otro tipo.
  function guardarDraftActual() {
    const ccInput = lineWrap.querySelector(`#${pfx}cc`);
    if (ccInput) centroCostoDraft = ccInput.value;
    if (tipoEditado === "ConDocumento") {
      const v = (sel) => lineWrap.querySelector(sel)?.value;
      draftCon.nombreProveedor = v(`#${pfx}nombreprov`)?.trim() ?? draftCon.nombreProveedor;
      draftCon.rutProveedor = v(`#${pfx}rut`)?.trim() ?? draftCon.rutProveedor;
      if (esAprobadorViewer) draftCon.cuentaContable = v(`#${pfx}cuenta`)?.trim() ?? draftCon.cuentaContable;
      draftCon.tipoDocumento = v(`#${pfx}tipodoc`) ?? draftCon.tipoDocumento;
      draftCon.nroDocumento = v(`#${pfx}nrodoc`)?.trim() ?? draftCon.nroDocumento;
      draftCon.fechaVencimiento = v(`#${pfx}venc`) ?? draftCon.fechaVencimiento;
      draftCon.categoria = v(`#${pfx}categoria`) ?? draftCon.categoria;
    } else {
      const v = (sel) => lineWrap.querySelector(sel)?.value;
      draftSin.nombreProveedor = v(`#${pfx}nombreprov2`)?.trim() ?? draftSin.nombreProveedor;
      draftSin.categoria = v(`#${pfx}categoria`) ?? draftSin.categoria;
      draftSin.cuentaContable = v(`#${pfx}cuenta`)?.trim() ?? draftSin.cuentaContable;
    }
  }

  function renderCamposTipo() {
    camposTipo.innerHTML = "";
    if (toggle) toggle.querySelectorAll("button").forEach((b) => {
      const activo = b.dataset.tipo === tipoEditado;
      b.classList.toggle("active", activo);
      b.setAttribute("aria-pressed", String(activo));
    });

    const opcionesCC = CENTROS_COSTO_POR_EMPRESA[it.empresa] || ["Casa Matriz"];
    if (centroCostoDraft && !opcionesCC.includes(centroCostoDraft)) opcionesCC.unshift(centroCostoDraft);

    if (tipoEditado === "ConDocumento") {
      const nombreProv = fieldInput(`${pfx}nombreprov`, "Nombre del proveedor", "text");
      nombreProv.querySelector("input").value = draftCon.nombreProveedor;
      const rutProv = fieldInput(`${pfx}rut`, "RUT del proveedor", "text");
      rutProv.querySelector("input").value = draftCon.rutProveedor;
      camposTipo.appendChild(el("div", { class: "field-row" }, [nombreProv, rutProv]));

      const tipoDoc = fieldSelect(`${pfx}tipodoc`, "Tipo de documento", TIPOS_DOCUMENTO);
      const tipoDocSel = tipoDoc.querySelector("select");
      tipoDocSel.value = draftCon.tipoDocumento;
      // Un documento sin cuenta (p. ej. venía de "Boleta") parte con la del tipo.
      if (!draftCon.cuentaContable) draftCon.cuentaContable = CUENTA_POR_TIPO_DOC[tipoDocSel.value] || "";
      const nroDoc = fieldInput(`${pfx}nrodoc`, "N° de documento", "text");
      nroDoc.querySelector("input").value = draftCon.nroDocumento;
      camposTipo.appendChild(el("div", { class: "field-row" }, [tipoDoc, nroDoc]));

      const venc = fieldInput(`${pfx}venc`, "Fecha del documento", "date");
      venc.querySelector("input").value = draftCon.fechaVencimiento || "";

      const catDoc = fieldSelectCategoria(`${pfx}categoria`);
      const catDocSel = catDoc.querySelector("select");
      if (draftCon.categoria && [...catDocSel.options].some((o) => o.value === draftCon.categoria)) {
        catDocSel.value = draftCon.categoria;
      }
      camposTipo.appendChild(el("div", { class: "field-row" }, [catDoc]));

      if (esAprobadorViewer) {
        const cuenta = fieldInput(`${pfx}cuenta`, "Cuenta contable", "text");
        const cuentaInput = cuenta.querySelector("input");
        cuentaInput.value = draftCon.cuentaContable;
        const nombreHint = el("p", { class: "ocr-status show", id: `${pfx}cuenta-nombre` }, nombreCuenta(cuentaInput.value));
        cuentaInput.addEventListener("input", () => { nombreHint.textContent = nombreCuenta(cuentaInput.value) || "Cuenta no reconocida"; });
        cuenta.appendChild(nombreHint);
        // La cuenta de un documento es la de su pasivo (Proveedores u Honorarios
        // por Pagar): si cambia el tipo y la cuenta era la del tipo anterior, se
        // cambia con él. Antes quedaba la de Proveedores en boletas de honorarios.
        let tipoDocAnterior = tipoDocSel.value;
        tipoDocSel.addEventListener("change", () => {
          const actual = cuentaInput.value.trim();
          if (!actual || actual === CUENTA_POR_TIPO_DOC[tipoDocAnterior]) {
            cuentaInput.value = CUENTA_POR_TIPO_DOC[tipoDocSel.value] || actual;
            nombreHint.textContent = nombreCuenta(cuentaInput.value) || "Cuenta no reconocida";
          }
          tipoDocAnterior = tipoDocSel.value;
        });
        // Sugerencia de cuenta de GASTO según la categoría elegida (no
        // reemplaza la cuenta de arriba, que sigue siendo la de pasivo
        // -- Proveedores/Honorarios por Pagar -- fija según el tipo de
        // documento, para no descuadrar el comprobante de Kame). Es solo
        // una ayuda para quien aprueba y registra la factura, ya que es
        // quien decide con qué cuenta real contabilizarla -- por eso NO
        // se auto-aplica a ningún campo, solo se muestra como texto.
        const sugerenciaCuenta = el("p", { class: "ocr-status show", id: `${pfx}cuenta-sugerida` });
        const actualizarSugerenciaCuenta = () => {
          const cat = CATEGORIAS_GASTO.find((c) => c.nombre === catDocSel.value);
          sugerenciaCuenta.textContent = cat && cat.cuenta
            ? `💡 Sugerencia según la categoría: ${cat.cuenta} · ${cat.nombre} (la cuenta de arriba es la de Proveedores/Honorarios por Pagar por defecto).`
            : "";
        };
        catDocSel.addEventListener("change", actualizarSugerenciaCuenta);
        actualizarSugerenciaCuenta();
        cuenta.appendChild(sugerenciaCuenta);
        camposTipo.appendChild(el("div", { class: "field-row" }, [venc, cuenta]));
      } else {
        camposTipo.appendChild(el("div", { class: "field-row" }, [venc]));
      }
      const ccDoc = fieldSelect(`${pfx}cc`, "Centro de Costo (Unidad de Negocio)", opcionesCC);
      ccDoc.querySelector("select").value = centroCostoDraft || opcionesCC[0];
      camposTipo.appendChild(el("div", { class: "field-row" }, [ccDoc]));
    } else {
      const nombreProv2 = fieldInput(`${pfx}nombreprov2`, "Proveedor / Local", "text");
      nombreProv2.querySelector("input").value = draftSin.nombreProveedor;
      camposTipo.appendChild(el("div", { class: "field-row" }, [nombreProv2]));

      const catSelect = fieldSelectCategoria(`${pfx}categoria`);
      const sel = catSelect.querySelector("select");
      const cuenta = fieldInput(`${pfx}cuenta`, "Cuenta contable", "text");
      const cuentaInput = cuenta.querySelector("input");
      // Mismo criterio que actualizarCuenta() en buildSinDocumentoFields (el
      // formulario de creación): la cuenta solo se puede tipear a mano
      // cuando la categoría es "Otro" -- antes acá quedaba SIEMPRE
      // readOnly, así que un ítem cargado con categoría "Otro" y una cuenta
      // manual no se podía corregir, y encima si se tocaba el desplegable
      // de categoría y se volvía a "Otro" la cuenta quedaba en blanco sin
      // forma de volver a tipearla (bug encontrado en revisión posterior).
      const actualizarCuentaEdit = (preservarValorGuardado) => {
        const found = CATEGORIAS_GASTO.find((c) => c.nombre === sel.value);
        const esManual = !!found && found.cuenta === "";
        cuentaInput.readOnly = !esManual;
        if (esManual) cuentaInput.value = preservarValorGuardado ? (draftSin.cuentaContable || "") : "";
        else cuentaInput.value = found ? found.cuenta : "";
      };
      if (draftSin.categoria && [...sel.options].some((o) => o.value === draftSin.categoria)) {
        sel.value = draftSin.categoria;
      }
      actualizarCuentaEdit(true);
      sel.addEventListener("change", () => actualizarCuentaEdit(false));
      camposTipo.appendChild(el("div", { class: "field-row" }, [catSelect, cuenta]));
      const cc = fieldSelect(`${pfx}cc`, "Centro de Costo (Unidad de Negocio)", opcionesCC);
      cc.querySelector("select").value = centroCostoDraft || opcionesCC[0];
      camposTipo.appendChild(el("div", { class: "field-row" }, [cc]));
    }
  }

  if (toggle) {
    toggle.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.dataset.tipo === tipoEditado) return;
        guardarDraftActual();
        tipoEditado = b.dataset.tipo;
        renderCamposTipo();
      });
    });
  }
  renderCamposTipo();

  const monto = fieldInputMoney(`${pfx}monto`, "Monto");
  monto.querySelector("input").value = Number(it.monto || 0).toLocaleString("es-CL");
  // Un gasto en dólares tiene los pesos calculados (USD x tipo de cambio); la
  // base rechaza un monto que no calce, así que aquí no se edita.
  if (it.moneda === "USD") {
    monto.querySelector("input").readOnly = true;
    monto.appendChild(el("small", { class: "portal-muted" }, `USD ${fmtUsd(it.monto_original)} × ${fmtTipoCambio(it.tipo_cambio)}. Para cambiarlo, rechaza el gasto y pide que lo corrijan.`));
  }
  const desc = fieldInput(`${pfx}desc`, "Descripción", "text");
  desc.querySelector("input").value = it.descripcion || "";

  if (toggle) lineWrap.appendChild(toggle);
  lineWrap.appendChild(camposTipo);
  lineWrap.appendChild(el("div", { class: "field-row" }, [monto, desc]));

  const acciones = el("div", { style: "display:flex; gap:8px;" }, [
    el("button", {
      class: "btn btn-primary", type: "button",
      onclick: async () => {
        const cambios = {
          tipo_item: tipoEditado,
          monto: parseMoneyValue(lineWrap.querySelector(`#${pfx}monto`).value),
          descripcion: lineWrap.querySelector(`#${pfx}desc`).value.trim(),
          centro_costo: lineWrap.querySelector(`#${pfx}cc`).value.trim(),
        };
        if (!(cambios.monto > 0)) { toast("El monto debe ser mayor a $0."); return; }
        if (tipoEditado === "ConDocumento") {
          const rutEditado = formatearRut(lineWrap.querySelector(`#${pfx}rut`).value.trim());
          if (rutEditado && !validarRut(rutEditado)) { toast("Ese RUT de proveedor no es válido."); return; }
          cambios.nombre_proveedor = lineWrap.querySelector(`#${pfx}nombreprov`).value.trim();
          cambios.rut_proveedor = rutEditado;
          cambios.tipo_documento = lineWrap.querySelector(`#${pfx}tipodoc`).value;
          cambios.nro_documento = lineWrap.querySelector(`#${pfx}nrodoc`).value.trim();
          if (!window.RindeCore.folioDocumentoValido(cambios.nro_documento)) { toast(MENSAJE_FOLIO_INVALIDO()); return; }
          cambios.fecha_vencimiento = lineWrap.querySelector(`#${pfx}venc`).value || null;
          cambios.cuenta_contable = cuentaDocumentoEditado(it, cambios.tipo_documento,
            esAprobadorViewer ? lineWrap.querySelector(`#${pfx}cuenta`).value.trim() : null);
          if (!cambios.cuenta_contable) { toast("Falta la cuenta contable del documento."); return; }
          cambios.categoria = lineWrap.querySelector(`#${pfx}categoria`)?.value || null;
        } else {
          cambios.nombre_proveedor = lineWrap.querySelector(`#${pfx}nombreprov2`).value.trim();
          cambios.categoria = lineWrap.querySelector(`#${pfx}categoria`).value;
          cambios.cuenta_contable = lineWrap.querySelector(`#${pfx}cuenta`).value.trim();
          // RUT, folio y fecha siguen identificando el comprobante original.
          // Cambiar categoría o tratamiento contable no elimina esa evidencia.
          cambios.existe_en_contabilidad = null;
          cambios.comprobante_contable_encontrado = null;
        }

        const res = await updateChecked("rendicion_items", it.id, cambios);
        if (!res.ok) { toast(res.mensaje); return; }



        toast("Ítem actualizado.");
        openDetalle(rendicion.id, false);
      },
    }, "Guardar cambios"),
    el("button", {
      class: "btn btn-ghost", type: "button",
      onclick: () => openDetalle(rendicion.id, false),
    }, "Cancelar"),
  ]);
  lineWrap.appendChild(acciones);
}

// ------------------------------------------------------------
// Generación de comprobante contable (formato importador Kame)
// ------------------------------------------------------------
const CSV_HEADER = [
  "TipoComprobante", "FolioAuto", "Folio", "Fecha", "Comentario", "Cuenta", "Debe", "Haber",
  "Comentario Linea", "Rut Ficha", "Rzn Social Ficha", "Nombre Doc", "Folio Doc", "Fecha Venc",
  "Unidad Negocio", "Tipo Movimiento", "Numero Movimiento",
].join(";");

function csvRow(fields) {
  return fields.map(campoCSV).join(";");
}

// Arma las filas (sin encabezado) de UNA rendición: una línea por ítem más
// su línea de contrapartida. La reutilizan tanto el comprobante individual
// como el comprobante combinado por rango de fechas.
// folioTransaccion es el correlativo de LA TRANSACCIÓN dentro del archivo
// (columna "Folio" de Kame): se repite en todas las líneas de una misma
// rendición, y sube de 1 en 1 por cada rendición nueva dentro del mismo
// comprobante combinado. Para un comprobante de una sola rendición, es
// simplemente 1.
// split (opcional): { dentroDelFondo, excedente } -- solo aplica a
// rendiciones tipo FondoPorRendir vinculadas a una solicitud (ver
// calcularSplitFondo). Cuando viene presente, la línea de contrapartida
// única se reemplaza por hasta dos líneas: lo que cae dentro del saldo del
// fondo entregado (cuenta "Fondo por Rendir") y, si la persona gastó más
// de lo que se le había entregado, el excedente aparte contra "Rendiciones
// por Pagar" -- como si esa parte fuera un reembolso normal de bolsillo.
// opciones.reverso = { fecha: "dd/mm/aaaa" }: mismas líneas con Debe y Haber
// invertidos, para anular en Kame un comprobante ya importado (ver
// anularAprobacionAdmin). Mismos folios de documento y fichas, así Kame
// cancela exactamente lo que se importó.
function construirFilasCSV(rendicion, items, folioTransaccion = 1, split = null, opciones = {}) {
  const fila = (campos) => csvRow(opciones.reverso ? window.RindeCore.invertirFilaKame(campos, opciones.reverso.fecha) : campos);
  const fecha = fmtDateSlash(rendicion.fecha_rendicion || rendicion.created_at) || rendicion.created_at;
  const fondoFolio = split?.fondoFolio ?? rendicion.solicitudes_fondos?.folio;
  const referenciaFondo = rendicion.tipo_rendicion === "FondoPorRendir" && rendicion.solicitud_fondo_id && fondoFolio != null ? " · FONDO S-" + fondoFolio : "";
  const glosa = (`RENDICION N° ${rendicion.folio ?? ""} ${rendicion.empleado_nombre}` + referenciaFondo).replace(/\s+/g, " ").trim();
  if (rendicion.tipo_rendicion === "FondoPorRendir" && rendicion.solicitud_fondo_id && !split) throw new Error("Falta comprobar la distribución del fondo; no se generó el CSV.");
  const aprobados = (items || []).filter(it => it.estado === "Aprobado");
  const debe = aprobados.reduce((s,it)=>s+Number(it.monto || 0),0);
  const haber = split ? Number(split.dentroDelFondo)+Number(split.excedente) : Number(rendicion.monto_total);
  if(!Number.isFinite(debe) || !Number.isFinite(haber) || debe !== haber) throw new Error("Los gastos aprobados y la contrapartida no coinciden. Actualiza la rendición antes de generar el CSV.");
  const rows = [];

  // "Comentario Linea" va con el mismo texto en todas las líneas de la
  // rendición (así aparece en los comprobantes reales de Kame que revisamos:
  // el mismo glosa se repite en cada línea de una misma transacción).
  //
  // Filtrado acá adentro, no confiado a quien llama: la contrapartida de
  // abajo siempre usa rendicion.monto_total, que excluye los ítems
  // Rechazados (ver finalizarAprobacionRendicion) -- si algún llamador
  // pasara la lista sin filtrar (como pasaba antes con el botón "Descargar
  // comprobante para Kame" y con el export por rango de fechas), las líneas
  // Debe sumaban más que el Haber y el comprobante quedaba descuadrado.
  (items || []).filter((it) => it.estado === "Aprobado").forEach((it) => {
    if (it.tipo_item === "ConDocumento") {
      // El Centro de Costo de un "Documento electrónico" es solo para uso
      // interno de la app (reportes, Excel) -- no se manda en el
      // comprobante de Kame para este tipo de ítem.
      rows.push(fila([
        "TRASPASO", "S", folioTransaccion, fecha, glosa, it.cuenta_contable, it.monto, 0,
        glosa, it.rut_proveedor, it.nombre_proveedor || "", it.tipo_documento, it.nro_documento,
        it.fecha_vencimiento ? fmtDateSlash(it.fecha_vencimiento) : "",
        "", "", "",
      ]));
    } else {
      // Sin proveedor, pero igual va con Ficha: la del empleado que hizo el
      // gasto, para poder trazar de quién es cada línea.
      // Un gasto en dólares deja en el comentario de su línea de dónde salen los pesos.
      const comentarioLinea = it.moneda === "USD" && it.monto_original && it.tipo_cambio
        ? `${glosa} · USD ${fmtUsd(it.monto_original)} TC ${Number(it.tipo_cambio).toLocaleString("es-CL", { minimumFractionDigits: 2 })}` : glosa;
      rows.push(fila([
        "TRASPASO", "S", folioTransaccion, fecha, glosa, it.cuenta_contable, it.monto, 0,
        comentarioLinea, rendicion.rut_empleado || "", rendicion.empleado_nombre, "", "", "",
        it.centro_costo || it.empresa || "", "", "",
      ]));
    }
  });

  const folioDoc = rendicion.folio ?? rendicion.id.slice(0, 8);
  const filaContrapartida = (cuenta, monto) => fila([
    "TRASPASO", "S", folioTransaccion, fecha, glosa, cuenta, 0, monto,
    glosa, rendicion.rut_empleado || "", rendicion.empleado_nombre, "Otros", folioDoc,
    fecha, "", "", "",
  ]);

  if (rendicion.tipo_rendicion === "FondoPorRendir" && rendicion.solicitud_fondo_id && !split) throw new Error("Falta comprobar la distribución del fondo; no se generó el CSV.");
  if (rendicion.tipo_rendicion === "FondoPorRendir" && rendicion.solicitud_fondo_id && split) {
    if (split.dentroDelFondo > 0) rows.push(filaContrapartida(CUENTA_CONTRAPARTIDA.FondoPorRendir.cuenta, split.dentroDelFondo));
    if (split.excedente > 0) rows.push(filaContrapartida(CUENTA_CONTRAPARTIDA.Reembolso.cuenta, split.excedente));
  } else {
    const contra = CUENTA_CONTRAPARTIDA[rendicion.tipo_rendicion] || CUENTA_CONTRAPARTIDA.Reembolso;
    rows.push(filaContrapartida(contra.cuenta, rendicion.monto_total));
  }

  return rows;
}

// Para rendiciones FondoPorRendir vinculadas a una solicitud, calcula
// cuánto de cada una cae dentro del saldo del fondo entregado y cuánto
// excede ese saldo (la persona gastó más de lo que se le había dado). El
// saldo se consume en el orden real en que las rendiciones contra ese
// fondo se fueron aprobando -- por eso se recalcula sobre TODO el
// historial de rendiciones Aprobadas de la(s) solicitud(es) involucradas,
// no solo sobre las que se están procesando en este momento.
async function calcularSplitFondo(rendicionesFondo) {
  return window.RindeData.distribuirFondosCsv(db,rendicionesFondo);
}

function construirCSV(rendicion, items, split = null) {
  const rows = [CSV_HEADER, ...construirFilasCSV(rendicion, items, 1, split)];
  return {
    fileName: `comprobante_rendicion_${rendicion.folio ?? rendicion.id.slice(0, 8)}.csv`,
    content: rows.join("\r\n"),
  };
}

// La rendición guarda el RUT/nombre del empleado tal como estaban al
// momento de crearla. Si esa persona no tenía el RUT cargado en su perfil
// en ese momento (y lo completó después), la rendición vieja se queda con
// ese dato vacío para siempre a menos que lo busquemos de nuevo acá, contra
// el perfil ACTUAL, cada vez que se genera un comprobante.
async function conDatosActualesDeEmpleado(rendicion) {
  const { data: perfil } = await db.from("profiles").select("nombre, rut").eq("id", rendicion.empleado_id).maybeSingle();
  let fondo = rendicion.solicitudes_fondos;
  if (rendicion.tipo_rendicion === "FondoPorRendir" && rendicion.solicitud_fondo_id && fondo?.folio == null) {
    const {data,error} = await db.from("solicitudes_fondos").select("folio").eq("id",rendicion.solicitud_fondo_id).maybeSingle();
    if (error || !data || data.folio == null) throw new Error("No se pudo identificar el fondo del comprobante. Intenta nuevamente.");
    fondo=data;
  }
  if (!perfil) return {...rendicion,solicitudes_fondos:fondo};
  return {
    ...rendicion,
    solicitudes_fondos:fondo,
    rut_empleado: perfil.rut || rendicion.rut_empleado,
    empleado_nombre: perfil.nombre || rendicion.empleado_nombre,
  };
}

// Registro de qué rendiciones ya tienen su CSV para Kame descargado: importar
// dos veces el mismo comprobante lo duplica en contabilidad. Si el registro
// falla (p. ej. sin conexión) el CSV ya se descargó: solo se avisa en consola.
function textoExportacionKame(r) {
  if (!r?.kame_exportado_en) return "";
  const veces = Number(r.kame_exportaciones || 1);
  return "CSV para Kame descargado el " + fmtDate(r.kame_exportado_en) + (r.kame_exportado_por_nombre ? " por " + r.kame_exportado_por_nombre : "")
    + (veces > 1 ? " (" + veces + " veces)" : "");
}

async function registrarExportacionKame(rendiciones) {
  const ids = rendiciones.map((r) => r.id);
  for (let inicio = 0; inicio < ids.length; inicio += 500) {
    const { error } = await db.rpc("marcar_exportado_kame", { p_rendiciones: ids.slice(inicio, inicio + 500) });
    if (error) { console.warn("No se pudo registrar la descarga del CSV para Kame:", error); return; }
  }
  const ahora = new Date().toISOString();
  rendiciones.forEach((r) => {
    r.kame_exportado_en = r.kame_exportado_en || ahora;
    r.kame_exportado_por_nombre = r.kame_exportado_por_nombre || currentProfile?.nombre || null;
    r.kame_exportaciones = Number(r.kame_exportaciones || 0) + 1;
  });
}

async function descargarCSV(rendicion, items) {
  if (rendicion.kame_exportado_en && !confirm(textoExportacionKame(rendicion) + ".\n\nSi ya lo importaste en Kame, importarlo de nuevo duplica el comprobante. ¿Descargarlo igual?")) return;
  const rendicionActualizada = await conDatosActualesDeEmpleado(rendicion);
  let split = null;
  if (rendicionActualizada.tipo_rendicion === "FondoPorRendir" && rendicionActualizada.solicitud_fondo_id) {
    const splits = await calcularSplitFondo([rendicionActualizada]);
    split = splits.get(rendicionActualizada.id) || null;
  }
  const { fileName, content } = construirCSV(rendicionActualizada, items, split);
  // El BOM al inicio le indica a Excel que el archivo es UTF-8; sin esto,
  // Excel lo abre asumiendo ANSI/Windows-1252 y las tildes y el "°" salen
  // como caracteres extraños (ej. "NÂ°" en vez de "N°").
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  await registrarExportacionKame([rendicion]);
}

// ------------------------------------------------------------
// Informe PDF de una rendición (con los comprobantes adjuntos)
// ------------------------------------------------------------
// Descarga el archivo del bucket privado (vía URL firmada, igual que
// "Ver") y lo devuelve como imagen lista para insertar en el PDF. Si el
// adjunto original es una foto (jpg/png) se usa tal cual; si es un PDF, se
// renderiza su primera página con pdf.js y esa imagen es la que se
// incrusta -- jsPDF no sabe insertar páginas de OTRO pdf directamente.
// Tamaño máximo (lado más largo, en px) al que se reescala cualquier
// comprobante antes de meterlo al PDF. Las fotos de celular vienen a
// resolución completa de cámara (3000x4000 o más, varios MB cada una) --
// para un informe que se ve en pantalla o se imprime esa resolución sobra,
// y sin reescalar el PDF de una rendición con un par de fotos pesaba
// varios MB (uno de prueba real llegó a 7+ MB con solo 2 fotos).
const PDF_IMG_MAX_DIM = 2200;
const PDF_IMG_CALIDAD = 0.9;

function canvasAJpegRedimensionado(canvasOrigen) {
  let { width, height } = canvasOrigen;
  if (width <= PDF_IMG_MAX_DIM && height <= PDF_IMG_MAX_DIM) {
    return canvasOrigen.toDataURL("image/jpeg", PDF_IMG_CALIDAD);
  }
  const factor = PDF_IMG_MAX_DIM / Math.max(width, height);
  const chico = document.createElement("canvas");
  chico.width = Math.round(width * factor);
  chico.height = Math.round(height * factor);
  chico.getContext("2d").drawImage(canvasOrigen, 0, 0, chico.width, chico.height);
  return chico.toDataURL("image/jpeg", PDF_IMG_CALIDAD);
}

async function* iterarImagenesAdjunto(path) {
  const {data:signed,error}=await db.storage.from("comprobantes").createSignedUrl(path,120);
  if(error || !signed?.signedUrl)throw new Error("No se pudo acceder al adjunto");
  const resp=await fetch(signed.signedUrl);if(!resp.ok)throw new Error("No se pudo descargar el adjunto");
  const blob=await resp.blob();
  if(blob.type === "application/pdf" || path.toLowerCase().endsWith(".pdf")){
    const pdfjs=await cargarPdfJs();const pdf=await window.RindeData.abrirPdfSeguro(pdfjs,await blob.arrayBuffer()).promise;
    try{
      for(let n=1;n<=pdf.numPages;n++){
        const page=await pdf.getPage(n);const viewport=page.getViewport({scale:1});
        const v=page.getViewport({scale:Math.min(3,2200/Math.max(viewport.width,viewport.height))});
        const canvas=document.createElement("canvas");canvas.width=Math.ceil(v.width);canvas.height=Math.ceil(v.height);
        await page.render({canvasContext:canvas.getContext("2d"),viewport:v}).promise;
        yield {imagen:canvasAJpegRedimensionado(canvas),pagina:n,total:pdf.numPages};
        page.cleanup();canvas.width=canvas.height=0;
      }
    }finally{await window.RindeData.cerrarPdf(pdf);}
  }else{
    const bitmap=await createImageBitmap(blob);
    try{
      const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);
      yield {imagen:canvasAJpegRedimensionado(canvas),pagina:1,total:1};
    }finally{bitmap.close();}
  }
}

// Informe completo de una rendición: encabezado, tabla de ítems, y una
// página por cada comprobante adjunto (para que quede todo -- rendición y
// respaldos -- en un solo archivo). Sirve para cualquier estado
// (Pendiente/Aprobado/Rechazado), no solo para las ya aprobadas.
async function generarInformePDF(rendicion, items) {
  toast("Generando PDF...");
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setProperties({title:"Informe de rendición N° "+(rendicion.folio ?? "-"),author:"RindeWellness",subject:"Rendición y comprobantes adjuntos"});
    const corteInforme=new Intl.DateTimeFormat("es-CL",{timeZone:"America/Santiago",dateStyle:"medium",timeStyle:"short"}).format(new Date());

    const ancho = doc.internal.pageSize.getWidth();
    const margen = 14, util = ancho - margen*2;
    const tinta = [33,54,66], tenue = [117,135,145], verde = [22,127,118];
    doc.setFont("helvetica","bold");doc.setFontSize(19);doc.setTextColor(...verde);
    doc.text("GW",margen,18);doc.setTextColor(...tinta);doc.setFontSize(14);doc.text("RindeWellness",30,18);
    doc.setFontSize(20);doc.text("Informe de rendición N° " + (rendicion.folio ?? "-"),margen,33);
    doc.setDrawColor(226,233,237);doc.line(margen,41,ancho-margen,41);
    let y = 51;
    const linea = (texto,negrita=false) => {
      doc.setFont("helvetica",negrita?"bold":"normal");doc.setFontSize(negrita?11:9);doc.setTextColor(...(negrita?tinta:tenue));
      const partes=doc.splitTextToSize(String(texto || "-"),util);
      if(y+partes.length*5>230){doc.addPage();y=20;}
      doc.text(partes,margen,y);y+=partes.length*5+3;
    };
    linea(rendicion.empleado_nombre,true);
    linea("RUT: " + (rendicion.rut_empleado || "-") + " · " + (rendicion.empresa || "-"));
    linea("Fecha: " + fmtDate(rendicion.fecha_rendicion || rendicion.created_at) + " · " + (rendicion.tipo_rendicion === "FondoPorRendir" ? "Fondo por rendir" : "Reembolso") + " · Estado: " + rendicion.estado);
    if(rendicion.comentario)linea("Motivo: " + rendicion.comentario);
    if(rendicion.estado === "Aprobado")linea("Aprobado por " + (rendicion.aprobador_nombre || "-") + " · " + fmtDate(rendicion.fecha_aprobacion));
    if(rendicion.estado === "Rechazado")linea("Rechazado por " + (rendicion.aprobador_nombre || "-") + ". " + (rendicion.motivo_rechazo || "Sin motivo registrado"));
    const resumen = resumenRendicion(items || []);
    if(y+36>245){doc.addPage();y=20;}
    const anchoMetrica=(util-9)/4;
    const metricas=[["RENDIDO",resumen.rendido,resumen.total,tinta],["APROBADO",resumen.aprobado,resumen.aprobados,verde],["RECHAZADO",resumen.rechazado,resumen.rechazados,[195,93,74]],["PENDIENTE",resumen.pendiente,resumen.pendientes,[165,121,41]]];
    metricas.forEach(([titulo,monto,cantidad,color],i)=>{
      const x=margen+i*(anchoMetrica+3);doc.setFillColor(243,247,248);doc.roundedRect(x,y,anchoMetrica,29,3,3,"F");
      doc.setFont("helvetica","bold");doc.setFontSize(7);doc.setTextColor(...tenue);doc.text(titulo,x+4,y+7);
      const importe=fmtCLP(monto);doc.setFontSize(importe.length>12?11:14);doc.setTextColor(...color);doc.text(importe,x+4,y+17);
      doc.setFont("helvetica","normal");doc.setFontSize(7);doc.setTextColor(...tenue);doc.text(cantidad+(cantidad===1?" gasto":" gastos"),x+4,y+24);
    });
    y+=38;
    linea("Corte del informe: "+corteInforme);
    const cantidadAdjuntos=(items || []).filter(it=>it.adjunto_url).length;
    linea("Respaldos: "+cantidadAdjuntos+" de "+resumen.total+" gastos con archivo adjunto."+(cantidadAdjuntos<resumen.total?" Hay gastos sin adjunto.":""));
    if(resumen.rechazados)linea("Los gastos rechazados se conservan en este informe y no forman parte del monto aprobado ni del consumo del fondo.");
    if(rendicion.tipo_rendicion === "FondoPorRendir" && rendicion.solicitud_fondo_id){
      let fondosRendicion=null;
      try{fondosRendicion=await cargarFondosDeRendicion(rendicion.id);}catch(error){console.error("No se pudo consultar los fondos:",error);}
      if(!fondosRendicion||!fondosRendicion.length||fondosRendicion.some(f=>!f.solicitud))linea("Fondo asociado: no se pudo consultar su referencia y saldo.");
      else{
      const consumo=await cargarConsumoFondos(fondosRendicion.map(f=>({id:f.solicitud_fondo_id})));
      for(const f of fondosRendicion){
        const fondo={...f.solicitud,id:f.solicitud_fondo_id};
        const filas=consumo.get(fondo.id);
        const saldo=filas?resumirConsumoFondo(filas,fondo.monto_solicitado):null;
        if(y+45>245){doc.addPage();y=20;}
        doc.setFillColor(237,245,241);doc.roundedRect(margen,y,util,39,3,3,"F");
        doc.setFont("helvetica","bold");doc.setFontSize(9);doc.setTextColor(...verde);
        doc.text("FONDO S-"+fondo.folio+" · Monto del fondo: "+fmtCLP(fondo.monto_solicitado)+(fondosRendicion.length>1?" · Esta rendición: "+fmtCLP(f.monto_total):""),margen+5,y+9);
        doc.setTextColor(...tinta);doc.text(saldo?"Consumido total: "+fmtCLP(saldo.consumido)+" · "+(saldo.saldo<0?"Exceso: "+fmtCLP(-saldo.saldo):"Disponible: "+fmtCLP(saldo.saldo)):"Consumo y saldo no disponibles",margen+5,y+18);
        doc.setFont("helvetica","normal");doc.setFontSize(8);
        if(saldo)doc.text("Aprobado: "+fmtCLP(saldo.aprobado)+" · Por revisar: "+fmtCLP(saldo.porRevisar),margen+5,y+25);
        doc.setFontSize(6.5);doc.text("Consumo: aprobados y pendientes de todas las rendiciones del fondo; excluye rechazados.",margen+5,y+33);y+=47;
      }
      }
    }
    doc.setFont("helvetica","bold");doc.setFontSize(12);doc.setTextColor(...tinta);doc.text("Detalle de gastos",margen,y);y+=6;
    // jspdf-autotable 5 ya no se engancha a jsPDF: es la función global autoTable(doc, opciones).
    const autoTable = window.autoTable || ((d, o) => d.autoTable(o));
    autoTable(doc, {
      startY:y,margin:{left:margen,right:margen,top:18,bottom:19},
      head:[["Gasto / proveedor","Documento","Descripción / centro de costo / cuenta","Monto","Estado"]],
      body:(items || []).map((it,i)=>[
        (i+1)+". "+(it.nombre_proveedor || it.categoria || "Sin proveedor")+"\n"+[it.categoria,it.rut_proveedor,tipoItemLabel(it.tipo_item)].filter(Boolean).join(" · "),
        (it.tipo_documento || "Comprobante")+(it.nro_documento?" #"+it.nro_documento:"")+(it.fecha_vencimiento?"\n"+fmtDate(it.fecha_vencimiento):""),
        [it.centro_costo,it.descripcion,it.cuenta_contable ? it.cuenta_contable+" · "+(nombreCuenta(it.cuenta_contable)||"Nombre de cuenta no disponible") : null].filter(Boolean).join("\n") || "-",
        fmtCLP(it.monto),(it.estado || "Pendiente")+(it.motivo_rechazo?"\n"+it.motivo_rechazo:"")
      ]),
      theme:"striped",styles:{font:"helvetica",fontSize:8,cellPadding:3,textColor:tinta,lineColor:[226,233,237]},
      headStyles:{fillColor:verde,textColor:[255,255,255],fontSize:7.5,fontStyle:"bold"},
      alternateRowStyles:{fillColor:[244,247,248]},rowPageBreak:"avoid",
      columnStyles:{0:{cellWidth:53},1:{cellWidth:37},2:{cellWidth:45},3:{cellWidth:23,halign:"right",fontStyle:"bold"},4:{cellWidth:24}},
      didParseCell:datos=>{if(datos.section==="body" && datos.column.index===4 && String(datos.cell.raw).startsWith("Rechazado"))datos.cell.styles.textColor=[195,93,74];}
    });

    // Una página por cada comprobante adjunto, para que el informe quede
    // completo (rendición + respaldos) en un solo PDF descargable. Las
    // imágenes se piden todas en paralelo (antes era una por una, una
    // rendición con varios ítems tardaba varios segundos de más); las
    // páginas igual se agregan en orden al PDF.
    const itemsConAdjunto = (items || [])
      .map((it, indiceOriginal) => ({ it, indiceOriginal }))
      .filter(({ it }) => it.adjunto_url);
    const itemsSinAdjunto=(items || []).map((it,i)=>({it,i})).filter(({it})=>!it.adjunto_url);
    if(itemsSinAdjunto.length){doc.addPage();doc.setFont('helvetica','bold');doc.setFontSize(16);doc.setTextColor(...tinta);doc.text('Gastos sin comprobante adjunto',margen,23);doc.setFont('helvetica','normal');doc.setFontSize(9);doc.text('Este informe contiene gastos sin respaldo documental adjunto.',margen,32);autoTable(doc,{startY:40,margin:{left:margen,right:margen,top:18,bottom:19},head:[['Gasto','Proveedor / descripción','Monto CLP','Estado']],body:itemsSinAdjunto.map(({it,i})=>[i+1,[it.nombre_proveedor,it.descripcion].filter(Boolean).join('\n')||'-',fmtCLP(it.monto),it.estado||'Pendiente']),styles:{fontSize:9,cellPadding:3,textColor:tinta},headStyles:{fillColor:verde},columnStyles:{0:{cellWidth:20},1:{cellWidth:97},2:{cellWidth:30,halign:'right'},3:{cellWidth:35}}});}
    let adjuntosFallidos=0;
    const adjuntosPorRuta=new Map();
    for(const dato of itemsConAdjunto){if(!adjuntosPorRuta.has(dato.it.adjunto_url))adjuntosPorRuta.set(dato.it.adjunto_url,[]);adjuntosPorRuta.get(dato.it.adjunto_url).push(dato);}
    if(itemsConAdjunto.length){doc.addPage();doc.setFont("helvetica","bold");doc.setFontSize(16);doc.setTextColor(...tinta);doc.text("Anexo de comprobantes",margen,23);doc.setFont("helvetica","normal");doc.setFontSize(9);doc.text("Imágenes originales y todas las páginas de cada PDF, en orden de gasto.",margen,32);autoTable(doc,{startY:40,margin:{left:margen,right:margen,top:18,bottom:19},head:[["Gasto(s)","Proveedor / documento","Monto CLP","Estado"]],body:[...adjuntosPorRuta.values()].map(grupo=>[grupo.map(x=>x.indiceOriginal+1).join(", "),(grupo[0].it.nombre_proveedor || "Comprobante")+"\n"+(grupo[0].it.tipo_documento || "")+(grupo[0].it.nro_documento?" #"+grupo[0].it.nro_documento:""),fmtCLP(grupo.reduce((s,x)=>s+Number(x.it.monto||0),0)),[...new Set(grupo.map(x=>x.it.estado || "Pendiente"))].join(" / ")]),theme:"striped",styles:{fontSize:9,cellPadding:3,textColor:tinta},headStyles:{fillColor:verde},columnStyles:{0:{cellWidth:20},1:{cellWidth:97},2:{cellWidth:30,halign:"right"},3:{cellWidth:35}}});}
    for(const grupoAdjunto of adjuntosPorRuta.values()){
      const {it,indiceOriginal}=grupoAdjunto[0];
      const numeroGastos=grupoAdjunto.map(x=>x.indiceOriginal+1).join(", ");
      try{
        for await (const {imagen,pagina,total} of iterarImagenesAdjunto(it.adjunto_url)){
          doc.addPage();doc.setFont("helvetica","bold");doc.setFontSize(11);doc.setTextColor(33,54,66);
          const titulo="Comprobante · Gasto(s) "+numeroGastos+" · Página "+pagina+" de "+total;
          doc.text(titulo,14,16);doc.setFont("helvetica","normal");doc.setFontSize(8);
          const subtitulo=doc.splitTextToSize((it.nombre_proveedor || it.categoria || "")+" · "+fmtCLP(it.monto)+" · "+(it.estado || "Pendiente"),182).slice(0,2); doc.text(subtitulo,14,22);
          const inicioImagen=27+subtitulo.length*3;
          const propiedades=doc.getImageProperties(imagen);
          const limiteW=doc.internal.pageSize.getWidth()-28,limiteH=doc.internal.pageSize.getHeight()-inicioImagen-18;
          const escala=Math.min(limiteW/propiedades.width,limiteH/propiedades.height);
          const w=propiedades.width*escala,h=propiedades.height*escala;
          doc.addImage(imagen,"JPEG",(ancho-w)/2,inicioImagen,w,h);
        }
      }catch(error){
        adjuntosFallidos++;doc.addPage();doc.setTextColor(195,93,74);doc.setFontSize(12);
        doc.text("Adjunto no disponible · Gasto "+(indiceOriginal+1),14,22);doc.setTextColor(33,54,66);doc.setFontSize(10);
        doc.text(doc.splitTextToSize("No se pudo incorporar el comprobante de "+(it.nombre_proveedor || it.categoria || "este gasto")+". Este informe tiene respaldo incompleto; vuelve a generarlo cuando el archivo esté disponible.",182),14,34);
      }
    }

    for(let pagina=1;pagina<=doc.getNumberOfPages();pagina++){doc.setPage(pagina);doc.setFont("helvetica","normal");doc.setFontSize(7);doc.setTextColor(117,135,145);doc.text("Grupo Wellness · Montos en CLP",14,doc.internal.pageSize.getHeight()-9);doc.text("Página "+pagina+" de "+doc.getNumberOfPages(),ancho-14,doc.internal.pageSize.getHeight()-9,{align:"right"});}

    // Nombre de archivo con quién rinde, para poder identificarlo de un
    // vistazo entre varios PDFs descargados (ej. "informe_rendicion_1_nataly_alvarez.pdf").
    const nombreArchivo = (rendicion.empleado_nombre || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // saca tildes
      .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    doc.save(`informe_rendicion_${rendicion.folio ?? rendicion.id.slice(0, 8)}${nombreArchivo ? "_" + nombreArchivo : ""}.pdf`);
    const sinAdjunto=resumen.total-cantidadAdjuntos;
    toast(adjuntosFallidos || sinAdjunto ? "PDF generado: "+adjuntosFallidos+" archivo(s) no disponibles y "+sinAdjunto+" gasto(s) sin adjunto. Revisa las advertencias del informe." : "PDF generado con todos los comprobantes adjuntos.");
  } catch (err) {
    console.error("Error generando el PDF:", err);
    toast("No se pudo generar el PDF: " + (err.message || ""));
  }
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function formatearRangoFechas(desde, hasta) {
  const d1 = new Date(desde + "T00:00:00");
  const d2 = new Date(hasta + "T00:00:00");
  if (d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth()) {
    return `Rendiciones del ${d1.getDate()} al ${d2.getDate()} de ${MESES[d1.getMonth()]} de ${d1.getFullYear()}`;
  }
  if (d1.getFullYear() === d2.getFullYear()) {
    return `Rendiciones del ${d1.getDate()} de ${MESES[d1.getMonth()]} al ${d2.getDate()} de ${MESES[d2.getMonth()]} de ${d1.getFullYear()}`;
  }
  return `Rendiciones del ${d1.getDate()} de ${MESES[d1.getMonth()]} de ${d1.getFullYear()} al ${d2.getDate()} de ${MESES[d2.getMonth()]} de ${d2.getFullYear()}`;
}

// Comprobante contable combinado para un rango de fechas: junta todas las
// rendiciones Aprobadas cuya fecha de aprobación cae en el rango, arma un
// CSV por empresa (todas sus rendiciones del período en un solo archivo) y
// los empaqueta en un .zip con una carpeta por el rango y subcarpetas por
// empresa -- todo local, se descarga directo al PC de quien lo pide.
async function generarComprobantesPorRango(desde, hasta) {
  const statusEl = document.getElementById("rango-status");
  statusEl.className = "ocr-status show";
  statusEl.textContent = "Generando comprobantes...";
  try {
    let rendiciones = await consultarTodas(() => db.from("rendiciones").select("*",{count:"exact"}).eq("estado","Aprobado").gte("fecha_aprobacion",`${desde}T00:00:00`).lte("fecha_aprobacion",`${hasta}T23:59:59`).order("fecha_aprobacion").order("id"));

    if (!rendiciones || !rendiciones.length) {
      statusEl.textContent = "No hay rendiciones aprobadas en ese rango de fechas.";
      statusEl.className = "ocr-status show err";
      return;
    }
    // Las que ya se bajaron antes (rangos que se cruzan, o la descarga al aprobar).
    const yaExportadas = rendiciones.filter((r) => r.kame_exportado_en);
    if (yaExportadas.length && !confirm(yaExportadas.length + " de las " + rendiciones.length + " rendiciones ya tienen su CSV para Kame descargado (N° "
      + yaExportadas.slice(0, 12).map((r) => r.folio).join(", ") + (yaExportadas.length > 12 ? "…" : "") + ").\n\n"
      + "Aceptar: incluirlas igual (si ya están en Kame, se duplican).\nCancelar: dejarlas fuera.")) {
      rendiciones = rendiciones.filter((r) => !r.kame_exportado_en);
      if (!rendiciones.length) {
        statusEl.textContent = "Todas las rendiciones del rango ya tenían su CSV descargado; no se generó otro.";
        statusEl.className = "ocr-status show";
        return;
      }
    }

    const ids = rendiciones.map((r) => r.id);
    const items=[];
    for(let inicio=0;inicio<ids.length;inicio+=100) items.push(...await consultarTodas(() => db.from("rendicion_items").select("*",{count:"exact"}).in("rendicion_id",ids.slice(inicio,inicio+100)).order("id")));

    // Igual que en el comprobante individual: usamos el RUT/nombre ACTUAL
    // del perfil de cada empleado, no el que haya quedado guardado en la
    // rendición al momento de crearla (puede estar vacío si en ese momento
    // la persona no tenía el RUT cargado).
    const empleadoIds = [...new Set(rendiciones.map((r) => r.empleado_id))];
    const { data: perfiles } = await db.from("profiles").select("id, nombre, rut").in("id", empleadoIds);
    const perfilPorId = new Map((perfiles || []).map((p) => [p.id, p]));
    rendiciones.forEach((r) => {
      const perfil = perfilPorId.get(r.empleado_id);
      if (perfil) {
        r.rut_empleado = perfil.rut || r.rut_empleado;
        r.empleado_nombre = perfil.nombre || r.empleado_nombre;
      }
    });

    const itemsPorRendicion = {};
    (items || []).forEach((it) => {
      if (!itemsPorRendicion[it.rendicion_id]) itemsPorRendicion[it.rendicion_id] = [];
      itemsPorRendicion[it.rendicion_id].push(it);
    });
    // Mismo orden de carga que en el detalle (antes salían en orden de id, al azar).
    Object.values(itemsPorRendicion).forEach((lista) => window.RindeCore.ordenarItemsRendicion(lista));

    const porEmpresa = {};
    rendiciones.forEach((r) => {
      const empresa = r.empresa || "Sin empresa";
      if (!porEmpresa[empresa]) porEmpresa[empresa] = [];
      porEmpresa[empresa].push(r);
    });

    // Split contable de fondos por rendir: se calcula sobre TODO el
    // historial de cada solicitud involucrada (no solo el rango elegido),
    // para que el saldo consumido sea el real aunque rendiciones previas
    // se hayan aprobado antes del rango o en otra empresa.
    const rendicionesFondo = rendiciones.filter((r) => r.tipo_rendicion === "FondoPorRendir" && r.solicitud_fondo_id);
    const splitPorId = await calcularSplitFondo(rendicionesFondo);

    const nombreCarpeta = formatearRangoFechas(desde, hasta);
    const zip = new JSZip();
    const carpetaRaiz = zip.folder(nombreCarpeta);

    Object.entries(porEmpresa).forEach(([empresa, rends]) => {
      const filas = [CSV_HEADER];
      rends.forEach((r, i) => filas.push(...construirFilasCSV(r, itemsPorRendicion[r.id] || [], i + 1, splitPorId.get(r.id) || null)));
      const contenido = "﻿" + filas.join("\r\n");
      const nombreArchivo = `comprobante_${empresa.replace(/[^a-zA-Z0-9]+/g, "_")}.csv`;
      carpetaRaiz.folder(empresa).file(nombreArchivo, contenido);
    });

    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${nombreCarpeta}.zip`;
    a.click();
    await registrarExportacionKame(rendiciones);

    statusEl.textContent = `Listo: ${rendiciones.length} rendición(es) en ${Object.keys(porEmpresa).length} empresa(s).`;
    statusEl.className = "ocr-status show ok";
  } catch (err) {
    console.error("Error generando comprobantes por rango:", err);
    statusEl.textContent = "Error: " + (err.message || "");
    statusEl.className = "ocr-status show err";
  }
}

// Reporte general (no es el comprobante para Kame): un .xlsx con todas las
// rendiciones, en dos hojas -- Resumen (una fila por rendición) y Detalle
// (una fila por ítem) -- que se descarga directo al PC de quien lo pide.
let excelJsCargando = null;
function cargarExcelJs() {
  if(window.ExcelJS)return Promise.resolve(window.ExcelJS);
  if(excelJsCargando)return excelJsCargando;
  excelJsCargando=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='assets/vendor/exceljs-4.4.0.min.js';
    const timer=setTimeout(()=>{script.remove();reject(new Error('El generador de Excel tardó demasiado. Intenta nuevamente.'));},30000);
    script.onload=()=>{clearTimeout(timer);window.ExcelJS?resolve(window.ExcelJS):reject(new Error('No se pudo iniciar el generador de Excel.'));};
    script.onerror=()=>{clearTimeout(timer);script.remove();reject(new Error('No se pudo cargar el generador de Excel.'));};
    document.head.appendChild(script);
  });excelJsCargando.catch(()=>{excelJsCargando=null;});return excelJsCargando;
}
// Período rápido para el panel del Excel, en fechas de Chile (AAAA-MM-DD).
function periodoExcel(tipo) {
  const hoy = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const [a, m] = hoy.split("-").map(Number);
  const dd = (n) => String(n).padStart(2, "0");
  if (tipo === "mes-anterior") {
    const am = m === 1 ? a - 1 : a, mm = m === 1 ? 12 : m - 1;
    return { desde: `${am}-${dd(mm)}-01`, hasta: `${am}-${dd(mm)}-${dd(new Date(Date.UTC(am, mm, 0)).getUTCDate())}` };
  }
  if (tipo === "anio") return { desde: `${a}-01-01`, hasta: hoy };
  if (tipo === "todo") return { desde: "", hasta: "" };
  return { desde: `${a}-${dd(m)}-01`, hasta: hoy };
}

// Excel general con el período, la empresa y el estado elegidos en el panel.
// Antes siempre exportaba TODO el historial, y la hoja de fondos contaba cada
// rendición entera contra su fondo principal (mal con multifondo).
async function exportarExcel(filtro = {}) {
  const status = document.getElementById("excel-status");
  const aviso = (texto, clase = "") => { if (status) { status.className = "ocr-status show " + clase; status.textContent = texto; } };
  if (filtro.desde && filtro.hasta && filtro.desde > filtro.hasta) { aviso("La fecha «Desde» es posterior a «Hasta».", "err"); return; }
  aviso("Generando Excel…");
  try {
    const rendiciones=await consultarTodas(() => db.from('rendiciones').select('*, solicitudes_fondos!rendiciones_solicitud_fondo_id_fkey(folio)',{count:'exact'}).order('folio').order('id'));
    const ids=rendiciones.map(r=>r.id),items=[];
    for(let i=0;i<ids.length;i+=100)items.push(...await consultarTodas(() => db.from('rendicion_items').select('*',{count:'exact'}).in('rendicion_id',ids.slice(i,i+100)).order('rendicion_id').order('id')));
    window.RindeCore.ordenarItemsRendicion(items);
    const solicitudes=await consultarTodas(() => db.from('solicitudes_fondos').select('*',{count:'exact'}).order('folio').order('id'));
    const porFondo=await consultarTodas(() => db.from('rendiciones_por_fondo').select('id,folio,estado,solicitud_fondo_id,orden,monto_total,monto_aprobado',{count:'exact'}).order('id').order('solicitud_fondo_id'));
    const datos=window.RindeReportes.preparar(rendiciones,items,solicitudes,{nombreCuenta,filtro,porFondo});
    if(!datos.rendiciones.length){aviso("No hay rendiciones con esos filtros. Prueba otro período o «Todo el historial».","err");return;}
    const corte=new Date(),ExcelJS=await cargarExcelJs();
    const libro=window.RindeReportes.crearLibro(ExcelJS,datos,corte);
    const buffer=await libro.xlsx.writeBuffer();
    const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const sufijo=filtro.desde||filtro.hasta?(filtro.desde||'inicio')+'_a_'+(filtro.hasta||'hoy'):'historial_'+corte.toISOString().slice(0,10);
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='rendiciones_'+sufijo+'.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    const revisar=datos.cuadratura.filter(c=>c.Estado==='Revisar').length;
    aviso(`Listo: ${datos.rendiciones.length} rendiciones y ${datos.gastos.length} gastos.`+(revisar?` La hoja «Cuadratura» marca ${revisar} control(es) para revisar.`:" Todos los controles de cuadratura están OK."),revisar?"":"ok");
  }catch(err){console.error('Error exportando a Excel:',err);aviso('No se pudo generar el Excel: '+(err.message||''),"err");}
}
