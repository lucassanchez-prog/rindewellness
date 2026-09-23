// ============================================================
// RindeWellness - lógica de la app (vanilla JS + Supabase)
// ============================================================

// formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash y parseMoneyValue
// viven en pure.js (cargado antes que este archivo, ver index.html) -- son
// funciones puras sin DOM ni red, separadas para poder testearlas con Node
// (ver tests/pure.test.js) sin arrastrar el resto de la app.
const { formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash, parseMoneyValue, esAprobadorEfectivo } = window.RindeCore;

const CFG = window.RINDE_WELLNESS_CONFIG || {};
let db = null; // proyecto propio de la app (lectura/escritura)
let dbContabilidad = null; // proyecto de contabilidad (SOLO LECTURA)
let currentUser = null;
let currentProfile = null;
let itemSeq = 0;
// null = sin restricción (ve todas las cuentas de gasto directo);
// Set(...) = solo puede usar esas cuentas. La define el admin en "Usuarios".
let cuentasPermitidas = null;

const EMPRESAS = [
  "Grupo Wellness SpA", "Dmoov SpA", "Dmoov Zona Sur SpA", "Dmoov PT Zona Sur SpA",
  "Tactiq SpA", "Neo Gym Chile SpA", "Neo App SpA", "RFA SpA",
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
  "RFA SpA": "78.210.251-6",
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
  "RFA SpA": ["Casa Matriz"],
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
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
}

// Navegación con historial: para que el botón "Atrás" del navegador
// se mueva dentro de la app en vez de salir de la página.
// El hash de la URL codifica el estado (no solo el pushState en memoria) --
// así, al recargar la página (F5), el navegador vuelve a pedir el mismo
// hash y podemos reabrir exactamente esa pantalla en vez de mandar siempre
// al dashboard.
function hashDeVista(viewId, params) {
  if (viewId === "view-detalle" && params?.id) return `detalle/${params.id}`;
  if (viewId === "view-detalle-solicitud" && params?.id) return `detalle-solicitud/${params.id}`;
  return viewId.replace("view-", "");
}
function estadoDesdeHash() {
  const [base, param] = location.hash.replace(/^#/, "").split("/");
  if (base === "detalle" && param) return { viewId: "view-detalle", params: { id: param } };
  if (base === "detalle-solicitud" && param) return { viewId: "view-detalle-solicitud", params: { id: param } };
  if (base === "admin") return { viewId: "view-admin", params: {} };
  if (base === "plantillas") return { viewId: "view-plantillas", params: {} };
  if (base === "reportes") return { viewId: "view-reportes", params: {} };
  if (base === "nueva") return { viewId: "view-nueva", params: {} };
  if (base === "nueva-solicitud") return { viewId: "view-nueva-solicitud", params: {} };
  return { viewId: "view-dashboard", params: {} };
}
function pushView(viewId, params = {}) {
  show(viewId);
  history.pushState({ viewId, params }, "", "#" + hashDeVista(viewId, params));
}
function replaceView(viewId, params = {}) {
  show(viewId);
  history.replaceState({ viewId, params }, "", "#" + hashDeVista(viewId, params));
}
function renderRoute(state) {
  const resuelto = state || estadoDesdeHash();
  const viewId = resuelto?.viewId || "view-dashboard";
  const params = resuelto?.params || {};
  if (viewId === "view-detalle" && params.id) { openDetalle(params.id, false); return; }
  if (viewId === "view-detalle-solicitud" && params.id) { openDetalleSolicitud(params.id, false); return; }
  if (viewId === "view-admin") { openAdminUsuarios(false); return; }
  if (viewId === "view-plantillas") { openAdminPlantillas(false); return; }
  if (viewId === "view-reportes") { openReportes(false); return; }
  if (viewId === "view-nueva") { openNuevaRendicion(false); return; }
  if (viewId === "view-nueva-solicitud") { openNuevaSolicitud(false); return; }
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

window.addEventListener("DOMContentLoaded", async () => {
  wireTheme();
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    document.getElementById("login-error").textContent =
      "Falta configurar Supabase en config.js (SUPABASE_URL / SUPABASE_ANON_KEY).";
    return;
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

  // Si la persona llegó desde el link de recuperación de contraseña del
  // correo, Supabase arma una sesión temporal y dispara "PASSWORD_RECOVERY"
  // -- hay que registrar este listener ANTES de chequear la sesión manual de
  // abajo, porque supabase-js reproduce ese evento apenas alguien se
  // suscribe. Si no lo interceptamos acá, el chequeo de sesión de abajo la
  // metería directo al dashboard en vez de dejarla definir su clave nueva.
  let esRecuperacionClave = false;
  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      esRecuperacionClave = true;
      show("view-nueva-clave");
    } else if (event === "SIGNED_OUT") {
      currentUser = null;
      currentProfile = null;
      document.getElementById("app-shell").style.display = "none";
      show("view-login");
    }
  });

  const { data } = await db.auth.getSession();
  if (data.session && !esRecuperacionClave) {
    await onLoggedIn(data.session.user);
  }
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
        redirectTo: window.location.origin + window.location.pathname,
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
  if (selError) console.error("Error leyendo perfil:", selError);
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
  currentProfile = profile;

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

  await cargarCuentasPermitidas();

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
  const consultas = [db.from("perfil_cuentas").select("cuenta_cod").eq("profile_id", currentUser.id)];
  if (currentProfile?.plantilla_id) {
    consultas.push(db.from("plantilla_cuentas").select("cuenta_cod").eq("plantilla_id", currentProfile.plantilla_id));
  }
  const resultados = await Promise.all(consultas);
  const codigos = new Set();
  resultados.forEach(({ data, error }) => {
    if (error) { console.error("Error cargando cuentas permitidas:", error); return; }
    (data || []).forEach((d) => codigos.add(d.cuenta_cod));
  });
  cuentasPermitidas = codigos.size ? codigos : null;
}

// ------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------
function wireDashboard() {
  document.getElementById("btn-nueva").addEventListener("click", () => openNuevaRendicion());
  document.getElementById("btn-solicitar-fondos").addEventListener("click", () => openNuevaSolicitud());
  document.getElementById("btn-admin-usuarios").addEventListener("click", () => openAdminUsuarios());
  document.getElementById("btn-reportes").addEventListener("click", () => openReportes());
  const btnExportarExcel = document.getElementById("btn-exportar-excel");
  btnExportarExcel.addEventListener("click", async () => {
    btnExportarExcel.disabled = true;
    const textoOriginal = btnExportarExcel.textContent;
    btnExportarExcel.textContent = "Generando...";
    await exportarExcel();
    btnExportarExcel.disabled = false;
    btnExportarExcel.textContent = textoOriginal;
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
    b.addEventListener("click", () => history.back())
  );

  const empresaSelect = document.getElementById("filtro-empresa");
  EMPRESAS.forEach((emp) => empresaSelect.appendChild(el("option", { value: emp }, emp)));
  ["filtro-estado", "filtro-empresa"].forEach((id) =>
    document.getElementById(id).addEventListener("change", applyDashboardFilters)
  );
  document.getElementById("filtro-texto").addEventListener("input", applyDashboardFilters);
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
      Object.entries(LISTAS_POR_TAB).forEach(([t, listId]) => {
        document.getElementById(listId).style.display = t === tab ? "flex" : "none";
      });
    })
  );
}

// Cache de la última carga, para poder filtrar sin volver a golpear la base.
const dashboardData = { mias: [], aprobaciones: [], solicitudesMias: [], solicitudesAprobacion: [] };

// Tope de seguridad para las listas de "Mis rendiciones"/"Mis solicitudes"
// -- sin esto, el historial de alguien con años de antigüedad crece sin
// límite y cada carga del dashboard se pone más lenta con el tiempo. OJO:
// a propósito NO se le pone límite a la consulta de "aprobaciones" que ve
// el admin más abajo -- Reportes (openReportes/renderReportes) depende de
// que dashboardData.aprobaciones tenga TODO el histórico para calcular
// tendencias, anomalías y presupuestos; limitarla rompería esos cálculos
// en silencio, sin ningún error que lo delate. Si esto llega a pesar
// demasiado, la solución real es una consulta de agregación server-side
// para Reportes (no depender de traer todas las filas al navegador), no
// un límite acá.
const TOPE_LISTA_PROPIA = 300;

async function loadDashboard() {
  const { data: mias } = await db
    .from("rendiciones")
    .select("*")
    .eq("empleado_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(TOPE_LISTA_PROPIA);
  dashboardData.mias = mias || [];

  const { data: solicitudesMias } = await db
    .from("solicitudes_fondos")
    .select("*")
    .eq("empleado_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(TOPE_LISTA_PROPIA);
  dashboardData.solicitudesMias = solicitudesMias || [];

  if (esAprobadorEfectivo(currentProfile)) {
    // El admin (usuario maestro) ve todas las rendiciones de todo el grupo;
    // un aprobador normal (o un delegado temporal) solo ve las pendientes
    // de aprobar.
    let query = db.from("rendiciones").select("*");
    query = currentProfile.rol === "admin"
      ? query.order("created_at", { ascending: false })
      : query.eq("estado", "Pendiente").order("created_at", { ascending: true });
    const { data: pendientes } = await query;
    dashboardData.aprobaciones = pendientes || [];
    document.getElementById("tab-aprobaciones").textContent =
      currentProfile.rol === "admin" ? "Todas las rendiciones" : "Aprobaciones pendientes";

    let querySolicitudes = db.from("solicitudes_fondos").select("*");
    querySolicitudes = currentProfile.rol === "admin"
      ? querySolicitudes.order("created_at", { ascending: false })
      : querySolicitudes.eq("estado", "Pendiente").order("created_at", { ascending: true });
    const { data: solicitudesPendientes } = await querySolicitudes;
    dashboardData.solicitudesAprobacion = solicitudesPendientes || [];
    document.getElementById("tab-solicitudes-aprobacion").textContent =
      currentProfile.rol === "admin" ? "Todas las solicitudes de fondos" : "Solicitudes de fondos pendientes";
  } else {
    dashboardData.aprobaciones = [];
    dashboardData.solicitudesAprobacion = [];
  }

  // El admin ve totales de TODA la empresa (ya tiene los datos: dashboardData.aprobaciones
  // trae cada rendición, sin filtrar por estado, cuando el rol es admin) --
  // antes siempre se mostraban los propios, aunque quien mirara fuera admin
  // y le sirviera más ver el conjunto completo de un vistazo.
  const esAdmin = currentProfile?.rol === "admin";
  const paraStats = esAdmin ? dashboardData.aprobaciones : dashboardData.mias;
  const pendienteStats = paraStats.filter((r) => r.estado === "Pendiente");
  const pendiente = pendienteStats.reduce((s, r) => s + Number(r.monto_total), 0);
  const aprobado = paraStats.filter((r) => r.estado === "Aprobado").reduce((s, r) => s + Number(r.monto_total), 0);
  // Cuántas de las Pendientes llevan más de 7 días esperando -- antes no
  // había ninguna forma de detectar un cuello de botella sin abrir cada
  // rendición a mirar la fecha una por una.
  const haceUnaSemana = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const antiguas = pendienteStats.filter((r) => new Date(r.created_at).getTime() < haceUnaSemana).length;
  renderStats(pendiente, aprobado, paraStats.length, esAdmin, antiguas);

  applyDashboardFilters();
}

function applyDashboardFilters() {
  const estado = document.getElementById("filtro-estado").value;
  const empresa = document.getElementById("filtro-empresa").value;
  const texto = document.getElementById("filtro-texto").value.trim().toLowerCase();

  const pasaFiltro = (r) =>
    (!estado || r.estado === estado) &&
    (!empresa || r.empresa === empresa) &&
    (!texto || `${r.comentario || ""} ${r.empleado_nombre || ""}`.toLowerCase().includes(texto));

  const pasaFiltroSolicitud = (s) =>
    (!estado || s.estado === estado) &&
    (!empresa || s.empresa === empresa) &&
    (!texto || `${s.motivo || ""} ${s.empleado_nombre || ""}`.toLowerCase().includes(texto));

  renderList(document.getElementById("list-mias"), dashboardData.mias.filter(pasaFiltro), false);
  renderList(document.getElementById("list-aprobaciones"), dashboardData.aprobaciones.filter(pasaFiltro), true);
  renderListSolicitudes(document.getElementById("list-solicitudes-mias"), dashboardData.solicitudesMias.filter(pasaFiltroSolicitud), false);
  renderListSolicitudes(document.getElementById("list-solicitudes-aprobacion"), dashboardData.solicitudesAprobacion.filter(pasaFiltroSolicitud), true);
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

function renderList(container, rows, showEmpleado) {
  container.innerHTML = "";
  if (!rows.length) {
    container.appendChild(el("div", { class: "empty-state" }, [
      el("div", { class: "icon" }, "🧾"),
      el("div", {}, "No hay rendiciones para mostrar todavía."),
    ]));
    return;
  }

  const columnas = ["Folio"];
  if (showEmpleado) columnas.push("Empleado");
  columnas.push("Empresa", "Comentario", "Fecha", "Tipo", "Monto", "Estado");

  const columnasCentradas = new Set(["Folio", "Fecha", "Tipo", "Estado"]);
  const tabla = el("table", { class: "items-table" });
  tabla.appendChild(el("thead", {}, [
    el("tr", {}, columnas.map((c) => el("th", { class: columnasCentradas.has(c) ? "center" : (c === "Monto" ? "right" : "") }, c))),
  ]));
  const tbody = el("tbody");
  tabla.appendChild(tbody);

  rows.forEach((r) => {
    const celdas = [el("td", { class: "center" }, `N° ${r.folio ?? "-"}`)];
    if (showEmpleado) celdas.push(el("td", {}, r.empleado_nombre || "-"));
    celdas.push(
      el("td", {}, r.empresa || "-"),
      el("td", { class: "wrap" }, r.comentario || "-"),
      el("td", { class: "center" }, fmtDate(r.created_at)),
      el("td", { class: "center" }, r.tipo_rendicion),
      el("td", { class: "monto" }, fmtCLP(r.monto_total)),
      el("td", { class: "center" }, el("span", { class: "pill " + r.estado }, r.estado)),
    );
    celdas.forEach((td, i) => td.setAttribute("data-label", columnas[i]));
    tbody.appendChild(filaClickable(() => openDetalle(r.id), celdas));
  });

  container.appendChild(el("div", { class: "table-scroll" }, [tabla]));
}

function renderListSolicitudes(container, rows, showEmpleado) {
  container.innerHTML = "";
  if (!rows.length) {
    container.appendChild(el("div", { class: "empty-state" }, [
      el("div", { class: "icon" }, "💰"),
      el("div", {}, "No hay solicitudes de fondos para mostrar todavía."),
    ]));
    return;
  }

  const columnas = ["Folio"];
  if (showEmpleado) columnas.push("Empleado");
  columnas.push("Empresa", "Centro de Costo", "Motivo", "Fecha", "Monto", "Estado");

  const columnasCentradas = new Set(["Folio", "Fecha", "Estado"]);
  const tabla = el("table", { class: "items-table" });
  tabla.appendChild(el("thead", {}, [
    el("tr", {}, columnas.map((c) => el("th", { class: columnasCentradas.has(c) ? "center" : (c === "Monto" ? "right" : "") }, c))),
  ]));
  const tbody = el("tbody");
  tabla.appendChild(tbody);

  rows.forEach((s) => {
    const celdas = [el("td", { class: "center" }, `S-${s.folio ?? "-"}`)];
    if (showEmpleado) celdas.push(el("td", {}, s.empleado_nombre || "-"));
    celdas.push(
      el("td", {}, s.empresa || "-"),
      el("td", {}, s.centro_costo || "-"),
      el("td", { class: "wrap" }, s.motivo || "-"),
      el("td", { class: "center" }, fmtDate(s.created_at)),
      el("td", { class: "monto" }, fmtCLP(s.monto_solicitado)),
      el("td", { class: "center" }, el("span", { class: "pill " + s.estado }, s.estado)),
    );
    celdas.forEach((td, i) => td.setAttribute("data-label", columnas[i]));
    tbody.appendChild(filaClickable(() => openDetalleSolicitud(s.id), celdas));
  });

  container.appendChild(el("div", { class: "table-scroll" }, [tabla]));
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
    desdeInput.value = hace30.toISOString().slice(0, 10);
  }
  if (!hastaInput.value) hastaInput.value = new Date().toISOString().slice(0, 10);

  desdeInput.onchange = renderReportes;
  hastaInput.onchange = renderReportes;

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

async function renderReportes() {
  const cont = document.getElementById("reportes-contenido");
  const desde = document.getElementById("reportes-desde").value;
  const hasta = document.getElementById("reportes-hasta").value;
  const desdeMs = desde ? new Date(desde + "T00:00:00").getTime() : -Infinity;
  const hastaMs = hasta ? new Date(hasta + "T23:59:59").getTime() : Infinity;
  const enRango = (r, dMs, hMs) => {
    const t = new Date(r.created_at).getTime();
    return t >= dMs && t <= hMs;
  };

  const rendicionesEnRango = dashboardData.aprobaciones.filter((r) => r.estado === "Aprobado" && enRango(r, desdeMs, hastaMs));

  const { data: presupuestosData, error: errPresupuestos } = await db.from("presupuestos").select("*");
  if (errPresupuestos) console.error("Error cargando presupuestos:", errPresupuestos);
  const presupuestoPorEmpresa = {};
  (presupuestosData || []).forEach((p) => { presupuestoPorEmpresa[p.empresa] = p.monto_limite_mensual; });

  cont.innerHTML = "";

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
    cont.appendChild(el("div", { class: "empty-state" }, "No hay rendiciones aprobadas en este rango de fechas."));
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
        .filter((r) => r.estado === "Aprobado" && enRango(r, desdeAnteriorMs, hastaAnteriorMs))
        .reduce((s, r) => s + Number(r.monto_total || 0), 0);
      if (totalAnterior > 0) {
        const variacion = ((totalGeneral - totalAnterior) / totalAnterior) * 100;
        deltaTexto = `${variacion >= 0 ? "+" : ""}${variacion.toFixed(0)}% vs. período anterior (${fmtCLP(totalAnterior)})`;
      } else if (totalGeneral > 0) {
        deltaTexto = "Sin gasto aprobado en el período anterior equivalente.";
      }
    }

    cont.appendChild(el("div", { class: "totals-bar", style: "margin-bottom:4px;" }, [
      el("span", {}, `Total aprobado (${rendicionesEnRango.length} rendición(es))`),
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
    const { data: items, error } = await db
      .from("rendicion_items")
      .select("categoria, monto, empresa, tipo_item, estado, cuenta_contable, centro_costo")
      .in("rendicion_id", rendicionesEnRango.map((r) => r.id))
      .eq("estado", "Aprobado");
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
      csvContenido = todasLasFilas.map((fila) => fila.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
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

  // Saldo de Fondos por Rendir: cuánto de lo ya ENTREGADO (solicitudes
  // Aprobadas) sigue sin justificar con una rendición Aprobada -- es un
  // saldo a una fecha (como un pasivo), no algo del rango elegido arriba,
  // así que se muestra siempre, incluso si no hay rendiciones aprobadas
  // en el rango. Misma fórmula que calcularSplitFondo, pero consolidada
  // para todas las personas en vez de una solicitud a la vez.
  const solicitudesAprobadas = dashboardData.solicitudesAprobacion.filter((s) => s.estado === "Aprobado");
  if (solicitudesAprobadas.length) {
    cont.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.95rem" }, "Saldo de Fondos por Rendir"));
    const tablaFondos = el("table", { class: "items-table" });
    tablaFondos.appendChild(el("thead", {}, [el("tr", {}, ["Empleado", "Empresa", "Otorgado", "Rendido", "Saldo"].map((c) => el("th", { class: ["Empleado", "Empresa"].includes(c) ? "" : "right" }, c)))]));
    const tbodyFondos = el("tbody");
    solicitudesAprobadas
      .map((s) => {
        const rendido = dashboardData.aprobaciones
          .filter((r) => r.solicitud_fondo_id === s.id && r.estado === "Aprobado")
          .reduce((sum, r) => sum + Number(r.monto_total || 0), 0);
        return { s, rendido, saldo: Number(s.monto_solicitado) - rendido };
      })
      .filter(({ saldo }) => saldo > 0)
      .sort((a, b) => b.saldo - a.saldo)
      .forEach(({ s, rendido, saldo }) => {
        tbodyFondos.appendChild(el("tr", {}, [
          el("td", { "data-label": "Empleado" }, s.empleado_nombre || "-"),
          el("td", { "data-label": "Empresa" }, s.empresa || "-"),
          el("td", { class: "monto", "data-label": "Otorgado" }, fmtCLP(s.monto_solicitado)),
          el("td", { class: "monto", "data-label": "Rendido" }, fmtCLP(rendido)),
          el("td", { class: "monto", "data-label": "Saldo" }, fmtCLP(saldo)),
        ]));
      });
    tablaFondos.appendChild(tbodyFondos);
    cont.appendChild(el("div", { class: "table-scroll" }, [tablaFondos]));
  }

  // Posibles gastos recurrentes: mismo proveedor apareciendo en 3 o más
  // meses distintos entre los "Gasto directo" -- candidato a pasar a
  // gasto fijo de la empresa en vez de reembolso manual todos los meses.
  // Independiente del rango de fechas elegido arriba (mira TODO el
  // histórico aprobado), porque el patrón solo se ve mirando varios meses
  // a la vez -- por eso es una consulta aparte, no reusa "items" de arriba.
  const { data: itemsHistoricos, error: errHistoricos } = await db
    .from("rendicion_items")
    .select("nombre_proveedor, monto, rendiciones!inner(created_at, estado)")
    .eq("tipo_item", "SinDocumento")
    .eq("estado", "Aprobado")
    .eq("rendiciones.estado", "Aprobado")
    .not("nombre_proveedor", "is", null);
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

  const btnRecordatorios = document.getElementById("btn-recordatorios");
  btnRecordatorios.onclick = async () => {
    btnRecordatorios.disabled = true;
    const textoOriginal = btnRecordatorios.textContent;
    btnRecordatorios.textContent = "Enviando...";
    const { data, error } = await db.functions.invoke("recordatorios-pendientes", {});
    if (error || !data?.ok) {
      toast("No se pudo enviar: " + (error?.message || data?.error || "revisa los logs de la función en Supabase."));
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
      toast("No se pudo limpiar: " + (error?.message || data?.error || "revisa los logs de la función en Supabase."));
    } else {
      toast(data.borrados ? `Se borraron ${data.borrados} archivo(s) huérfano(s).` : (data.nota || "No había archivos huérfanos."));
    }
    btnLimpiarStorage.disabled = false;
    btnLimpiarStorage.textContent = textoOriginal;
  };

  // Salud del sistema: cuántos fallos de OCR/correo dejó registrados
  // system_events en los últimos 7 días -- sin esto, nadie tenía ningún
  // motivo para pensar en ir a mirar esa tabla directamente en Supabase.
  db.from("system_events")
    .select("tipo")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .like("tipo", "%_fail")
    .then(({ data: eventos, error: errEventos }) => {
      if (errEventos || !eventos || !eventos.length) return;
      const conteo = {};
      eventos.forEach((e) => { conteo[e.tipo] = (conteo[e.tipo] || 0) + 1; });
      const resumen = Object.entries(conteo).sort((a, b) => b[1] - a[1]).map(([tipo, n]) => `${tipo} (${n})`).join(" · ");
      list.insertBefore(
        el("div", { class: "card", style: "border:1px solid var(--warn);margin-bottom:16px;" }, [
          el("p", { style: "margin:0;font-size:0.85rem;" }, `⚠ Salud del sistema (últimos 7 días): ${resumen}`),
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
      const select = el("select", { style: "width:auto" }, ROLES.map((r) => el("option", { value: r }, r)));
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
      const selectPlantilla = el("select", { style: "width:auto" }, [
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
  const buscador = el("input", { type: "text", class: "cuentas-buscar", placeholder: "Buscar cuenta..." });
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
}

// Llena el desplegable "Fondo asociado" de Nueva rendición con las
// solicitudes de fondos de ESTE empleado, ya Aprobadas, para la Empresa
// elegida en el encabezado (un fondo entregado para una empresa no debe
// rendirse contra otra). Muestra el saldo disponible de cada una -- ya
// consumido por rendiciones Aprobadas anteriores contra ese mismo fondo --
// aunque esté en $0 (la persona puede seguir rindiendo de más; el
// excedente se contabiliza aparte, ver calcularSplitFondo).
async function cargarSolicitudesDisponibles() {
  const sel = document.getElementById("nr-fondo");
  sel.innerHTML = "";
  const empresa = document.getElementById("nr-empresa").value;
  const { data: solicitudes, error } = await db
    .from("solicitudes_fondos")
    .select("*")
    .eq("empleado_id", currentUser.id)
    .eq("estado", "Aprobado")
    .eq("empresa", empresa)
    .order("created_at", { ascending: false });
  if (error) { console.error("Error cargando solicitudes de fondos:", error); return; }
  if (!solicitudes || !solicitudes.length) {
    sel.appendChild(el("option", { value: "" }, "No tienes fondos aprobados en esta empresa"));
    return;
  }
  const ids = solicitudes.map((s) => s.id);
  const { data: rendidas } = await db.from("rendiciones").select("solicitud_fondo_id, monto_total").in("solicitud_fondo_id", ids).eq("estado", "Aprobado");
  const rendidoPorId = {};
  (rendidas || []).forEach((r) => { rendidoPorId[r.solicitud_fondo_id] = (rendidoPorId[r.solicitud_fondo_id] || 0) + Number(r.monto_total || 0); });

  solicitudes.forEach((s) => {
    const rendido = rendidoPorId[s.id] || 0;
    const saldo = Math.max(0, Number(s.monto_solicitado) - rendido);
    const label = `S-${s.folio} · Otorgado ${fmtCLP(s.monto_solicitado)} · Saldo disponible ${fmtCLP(saldo)}`;
    sel.appendChild(el("option", { value: s.id }, label));
  });
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

function openNuevaRendicion(pushHistory = true) {
  document.getElementById("nr-fecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("nr-tipo").value = "Reembolso";
  document.getElementById("nr-fondo-wrap").style.display = "none";
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
  ocrOrigen.clear();
  ocrMonto.clear();
  addItemRow();
  if (pushHistory) pushView("view-nueva"); else show("view-nueva");
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
    });
  });

  wrap.appendChild(head);
  wrap.appendChild(toggle);
  wrap.appendChild(bodyConDoc);
  wrap.appendChild(bodySinDoc);
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
    : { nombreprov2: v("-nombreprov2"), categoria: v("-categoria"), monto2: v("-monto2") };

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
    await reemplazarConVersionComprimida(fotoInput);
    if (fotoInput.files && fotoInput.files[0]) analizarComprobante(id, fotoInput.files[0], ocrStatus);
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
    const nombre = await buscarNombreProveedorPorRut(rutInput.value);
    if (nombre) nombreProvInput.value = nombre;
    chequearDuplicado();
  });
  folioInput.addEventListener("blur", chequearDuplicado);

  // Detector de comprobantes duplicados: mismo RUT + N° de documento ya
  // cargado antes en OTRA rendición (propia o ajena) que no esté Rechazada.
  // Es solo un aviso, no bloquea -- puede haber compras legítimas repetidas
  // al mismo proveedor con folios que coinciden por error de tipeo, así que
  // la decisión final la sigue tomando la persona (o quien aprueba).
  async function chequearDuplicado() {
    const rut = rutInput.value.trim();
    const folio = folioInput.value.trim();
    dupStatus.className = "ocr-status";
    if (!rut || !folio || !validarRut(rut)) return;
    const { data, error } = await db.rpc("buscar_documento_duplicado", { p_rut: rut, p_nro: folio });
    if (error || !data || !data.length) return;
    const match = data[0];
    dupStatus.textContent = `⚠ Este documento ya está registrado en la rendición N° ${match.folio} de ${match.empleado_nombre} (${match.estado}). Revisa que no sea un duplicado.`;
    dupStatus.className = "ocr-status show err";
  }

  return box;
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
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
let pdfjsCargando = null;

// Se carga recién cuando alguien adjunta un PDF (son ~300KB): no tiene
// sentido que los pague en descarga quien solo sube fotos.
function cargarPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsCargando) return pdfjsCargando;
  pdfjsCargando = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("No se pudo cargar el lector de PDF."));
    document.head.appendChild(s);
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
    s.onload = () => {
      // Si el script cargó pero no dejó el global, tirar acá adentro dejaría
      // la promesa colgada para siempre y el ítem clavado en "Analizando".
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error("El lector de fotos cargó incompleto."));
    };
    s.onerror = () => reject(new Error("No se pudo cargar el lector de fotos."));
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
async function prepararImagenParaOcr(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const escala = Math.min(1, LADO_MAXIMO_OCR / Math.max(bitmap.width, bitmap.height));
    if (escala === 1) return file;
    const w = Math.round(bitmap.width * escala);
    const h = Math.round(bitmap.height * escala);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    return blob ? new File([blob], file.name, { type: "image/jpeg" }) : file;
  } catch (err) {
    console.error("No se pudo preparar la imagen para OCR, se usa la original:", err);
    return file;
  }
}

async function leerFotoLocal(file) {
  if (!(file.type || "").startsWith("image/")) return null;
  try {
    const tess = await cargarTesseract();
    const { data } = await tess.recognize(await prepararImagenParaOcr(file), "spa");
    const texto = data?.text || "";
    if (texto.replace(/\s/g, "").length < 40) return null; // no salió texto legible
    const datos = parsearTextoFactura(texto);
    // Umbral de utilidad: sin un RUT válido ni un monto confirmado por
    // aritmética, lo que haya salido no es lo bastante confiable como para
    // ponerlo en campos que van a contabilidad. Vale más dejarlos vacíos.
    if (!datos.rut_proveedor && !datos.monto_verificado) return null;

    // EL MONTO NO SE RELLENA DESDE UNA FOTO salvo que la aritmética del
    // documento lo confirme. Probado contra una factura real fotografiada
    // por WhatsApp: el RUT, el folio y el tipo salieron perfectos, pero el
    // total se leyó $273.008 cuando eran $350.874. Y tiene sentido que sea
    // así: el RUT se valida con su dígito verificador y el folio tiene que
    // venir pegado a su etiqueta, pero un monto son dígitos sueltos sin nada
    // que los contradiga si el OCR se equivoca. Como el monto es obligatorio
    // igual, la persona lo va a escribir de todos modos: dejarlo en blanco
    // le cuesta diez segundos, y un número equivocado que se cuela le cuesta
    // a contabilidad.
    if (!datos.monto_verificado) datos.monto = null;

    // Misma lógica para la fecha: en esa foto el año salió 2025 en vez de
    // 2026, un solo dígito mal que manda el gasto a otro período contable.
    // No hay forma de validarla, así que se descarta la que no sea
    // plausible para una rendición (nada de más de un año atrás ni futuro).
    if (datos.fecha) {
      const f = new Date(datos.fecha + "T00:00:00");
      const hoy = new Date();
      const haceUnAnio = new Date(hoy.getFullYear() - 1, hoy.getMonth(), hoy.getDate());
      const enUnMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate());
      if (isNaN(f) || f < haceUnAnio || f > enUnMes) datos.fecha = null;
    }
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
  const ruts = [...t.matchAll(RE_RUT_EN_TEXTO)]
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
  else if (/FACTURA\s+EXENTA/i.test(t)) tipo_documento = "Factura Exenta Electrónica";
  else if (/FACTURA\s+ELECTR/i.test(t)) tipo_documento = "Factura Electrónica";
  else if (/BOLETA\s+DE\s+HONORARIO/i.test(t)) tipo_documento = "Boleta de Honorario";
  else if (/BOLETA\s+ELECTR/i.test(t)) tipo_documento = "Boleta Electrónica";

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
  const RE_FOLIO = /(N[°º]\.?|No\.?|N(?=\s+\d)|FOLIO|Folio)\s*:?\s*(\d{2,10})\b/g;
  const ANTES_NO_ES_FOLIO = /(orden\s+de\s+compra|nota\s+de\s+venta|res(?:oluci[oó]n)?\.?\s*ex\.?|cotizaci[oó]n|gu[ií]a\s+de\s+despacho|contrato|pago)\s*$/i;
  const candidatosFolio = [];
  for (const m of t.matchAll(RE_FOLIO)) {
    const contextoPrevio = t.slice(Math.max(0, m.index - 40), m.index);
    if (ANTES_NO_ES_FOLIO.test(contextoPrevio.trim())) continue;
    candidatosFolio.push({ valor: m[2], pegadoAlTipo: /(factura|boleta|documento)[^.]{0,30}$/i.test(contextoPrevio) });
  }
  const mFolio = candidatosFolio.find((c) => c.pegadoAlTipo) || candidatosFolio[0];

  // Los RUT se sacan del texto ANTES de buscar importes: si no, sus dígitos
  // se leen como pesos (77.574.911-3 daba un "monto" de $77.574.911).
  const sinRuts = t.replace(RE_RUT_EN_TEXTO, " ");
  const aNumero = (s) => Number(String(s).replace(/\./g, ""));
  const RE_MONTO = "(\\d{1,3}(?:\\.\\d{3})+|\\d{4,})";

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

  // 2) Si no cuadra (factura exenta, sin IVA, o subtotales ilegibles), el
  //    importe etiquetado "Total $". El \\$ es obligatorio y "total" va como
  //    palabra propia: sin eso matcheaba "SUBTOTAL 1577" (un SKU) y
  //    "Total 2.40 CLF" (texto de una glosa).
  if (!monto) {
    const mTotal = new RegExp(`(?:^|[^a-záéíóúñ])total\\s*\\(?\\s*\\$\\s*\\)?\\s*:?\\s*\\$?\\s*${RE_MONTO}`, "i").exec(sinRuts);
    monto = mTotal ? aNumero(mTotal[1]) : null;
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
  }

  // Todo lo anterior da por sentado que los importes están en pesos. Si el
  // documento está en otra moneda, "US$ 1.500" se lee como $1.500 y la
  // diferencia no la nota nadie: el campo queda con un número creíble. Ante
  // una moneda extranjera cerca de un importe se abandona la lectura local
  // (monto = null) y el comprobante cae al camino de la IA, que sí ve el
  // símbolo en la imagen. El chequeo va acá y no antes porque solo importa
  // cuando efectivamente se encontró un monto que reportar.
  let montoConfirmado = !!verificado;
  if (monto && /(US\$|USD|EUR|€|\bUF\b|\bCLF\b|\bUTM\b)\W{0,15}\d|\d\W{0,8}(USD|EUR|\bUF\b|\bCLF\b|\bUTM\b)/i.test(sinRuts)) {
    monto = null;
    montoConfirmado = false; // sin monto no hay nada que declarar verificado
  }

  let fecha = null;
  const mNum = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(t);
  const mTxt = /\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:del?\s+)?(\d{4})\b/i.exec(t);
  const iso = (a, m, d) => `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (mNum) fecha = iso(mNum[3], mNum[2], mNum[1]);
  else if (mTxt && MESES_ES[mTxt[2].toLowerCase()]) fecha = iso(mTxt[3], MESES_ES[mTxt[2].toLowerCase()], mTxt[1]);

  return {
    nombre_proveedor: null, // se resuelve por RUT contra contabilidad, que es más confiable que leerlo del PDF
    rut_proveedor: ruts[0] || null,
    tipo_documento,
    nro_documento: mFolio ? mFolio.valor : null,
    fecha,
    monto,
    // true solo cuando el monto se confirmó con neto + IVA = total. Se usa
    // para decirle a la persona qué revisar: un monto verificado no necesita
    // segunda mirada, uno deducido sí.
    monto_verificado: montoConfirmado,
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
      // Tolerancia mínima: el IVA se redondea distinto según el emisor.
      if (Math.abs(iva - ivaEsperado) > Math.max(2, ivaEsperado * 0.01)) continue;
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
const CAMPOS_OCR_SIN = ["nombre_proveedor", "monto", "descripcion", "categoria_sugerida"];

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
async function resolverDatosContables(rut) {
  const vacio = { rut: null, nombre_proveedor: null, categoria: null, descripcion: null, desdeContabilidad: false };
  if (!rut) return vacio;
  // El RUT se normaliza ANTES de consultar: la lectura local lo saca con
  // puntos ("77.574.911-3") y la IA suele devolverlo pelado ("77574911-3"),
  // pero las dos bases lo guardan en la forma con puntos (es la que escribe
  // aplicarResultadoOcrCon). Sin esto, el mismo proveedor encontraba
  // historial cuando venía del PDF y no cuando venía de una foto.
  const rutFormateado = formatearRut(rut);
  const [nombre, categoriaContable, previos] = await Promise.all([
    buscarNombreProveedorPorRut(rutFormateado),
    buscarCategoriaEnContabilidad(rutFormateado),
    buscarDatosPreviosPorRut(rutFormateado),
  ]);
  return {
    rut: rutFormateado,
    nombre_proveedor: nombre,
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

  // Determinista primero: lo local manda, la IA solo rellena.
  ["rut_proveedor", "tipo_documento", "nro_documento", "fecha"].forEach((campo) => {
    datos[campo] = L[campo] || I[campo] || null;
    if (!L[campo] && I[campo]) aporteIA[campo] = I[campo];
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
  datos.monto_verificado = !!L.monto_verificado;
  if (montoLocal && montoIA) {
    if (montoLocal === montoIA) {
      // Dos lectores independientes que coinciden son mucha más evidencia
      // que uno solo: el monto queda tan confirmado como por aritmética.
      datos.monto_verificado = true;
      avisos.push({ ok: true, texto: `Monto confirmado: la IA leyó el mismo total (${fmtCLP(montoLocal)}).` });
    } else {
      avisos.push({ ok: false, texto: `⚠ Ojo con el monto: del texto del PDF se leyó ${fmtCLP(montoLocal)}, pero la IA leyó ${fmtCLP(montoIA)}. Se dejó el primero. Confirma cuál corresponde mirando la factura antes de enviar.` });
    }
  } else if (!montoLocal && montoIA) {
    aporteIA.monto = montoIA;
  }

  return { datos, aporteIA, avisos };
}

// La ÚNICA llamada a la IA del camino con lectura local, y solo cuando
// quedaron huecos. Corre en segundo plano a propósito: los campos locales ya
// están en pantalla, nadie tiene que mirar un spinner 15-25s para recién ver
// algo. Si falla (cuota agotada, timeout) no se alarma a nadie ni se muestra
// el botón de reintento -- lo local ya sirve para enviar la rendición.
async function completarConIA({ id, file, gen, statusEl, local, contable, datos, campos, aplicar, textoBase }) {
  try {
    const ia = await llamarOcrRecibo(file, camposAPedirOcr(datos, campos), datosParcialesOcr(datos));
    // Re-chequeo OBLIGATORIO después de CADA await, y con "return": mientras
    // la IA respondía, la persona pudo adjuntar otro comprobante. Si esto
    // sigue de largo, deja el ítem con datos de dos documentos distintos.
    if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;

    // Si el RUT lo aportó la IA (el PDF tenía texto pero no un RUT legible),
    // recién ahora se le puede preguntar a contabilidad por ese proveedor.
    let contableFinal = contable;
    if (!contableFinal || !contableFinal.rut) {
      if (ia && ia.rut_proveedor) {
        contableFinal = await resolverDatosContables(ia.rut_proveedor);
        if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;
      }
    }

    const { datos: fusion, aporteIA, avisos } = fusionarLecturas(local, ia, contableFinal);
    await aplicar(id, aporteIA, gen);
    if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;
    // La IA aportó algo: queda registrado como origen mixto. Y el monto pudo
    // pasar a confirmado justo acá, si los dos lectores leyeron el mismo
    // total -- dos fuentes independientes que coinciden valen tanto como la
    // aritmética del documento.
    registrarOrigenOcr(id, local ? "local+ia" : "ia", fusion);

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
    statusEl.textContent = `${textoBase}${extra}`;
    statusEl.className = "ocr-status show ok";
  } catch (err) {
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
async function leerPdfLocal(file) {
  if ((file.type || "") !== "application/pdf") return null;
  try {
    const pdfjs = await cargarPdfJs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let texto = "";
    // Tope de páginas: una factura tiene 1-2; leer un PDF enorme entero solo
    // para buscar un RUT no aporta y traba el navegador.
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const contenido = await (await pdf.getPage(p)).getTextContent();
      texto += contenido.items.map((i) => i.str).join(" ") + "\n";
    }
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
async function llamarOcrRecibo(file, camposFaltantes, datosParciales) {
  const imageBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const body = { imageBase64, mimeType: file.type || "image/jpeg" };
  if (camposFaltantes && camposFaltantes.length) body.camposFaltantes = camposFaltantes;
  if (datosParciales && Object.keys(datosParciales).length) body.datosParciales = datosParciales;

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
    // Cuando la Edge Function responde con un status distinto de 2xx,
    // supabase-js arma un error genérico ("Edge Function returned a
    // non-2xx status code") y NO lee el cuerpo -- el mensaje real y
    // específico que arma ocr-recibo (ej. "high demand", "MAX_TOKENS",
    // falta de configuración) queda en error.context (el Response),
    // así que hay que leerlo a mano para no perderlo.
    let mensaje = error.message;
    let previaId = null;
    try {
      const cuerpo = await error.context?.json();
      if (cuerpo?.error) mensaje = cuerpo.error;
      // ocr-recibo sube el comprobante y lo encola en ocr_previos apenas
      // falla en vivo (ver migracion_ocr_previo.sql) -- este id es lo que
      // deja seguirlo (disparar el agente altiro + saber cuándo esté listo)
      // sin esperar a que se envíe la rendición.
      if (cuerpo?.previaId) previaId = cuerpo.previaId;
    } catch { /* el cuerpo no era JSON legible, se usa el mensaje genérico */ }
    const err = new Error(mensaje);
    err.previaId = previaId;
    throw err;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// Evita que la respuesta de una llamada de OCR vieja pise a una más nueva
// para el mismo ítem -- puede pasar si la persona reselecciona el archivo
// (o pulsa "reintenta con IA") mientras la llamada anterior todavía está en
// vuelo: antes, cualquiera de las dos que respondiera último ganaba, sin
// importar si correspondía al archivo que en realidad quedó adjunto.
const ocrGeneracion = new Map();
function nuevaGeneracionOcr(id) {
  const gen = (ocrGeneracion.get(id) || 0) + 1;
  ocrGeneracion.set(id, gen);
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

// Encolar tiene un costo real: cada reintento del agente gasta solicitudes de
// la cuota gratuita de Gemini, que es de ~20 por modelo AL DÍA. Antes se
// encolaba TODO ítem cuyo OCR en vivo no hubiera salido bien, incluso cuando
// la persona ya había escrito los datos a mano -- el agente reintentaba
// durante horas para "sugerir" exactamente lo que ya estaba en pantalla, y
// esa cuota le faltaba después a un comprobante que sí la necesitaba. Solo
// vale la pena encolar si queda algún hueco que el agente pueda llenar.
function estadoReintentoOcr(id, huecos) {
  if (ocrExitoso.get(id) === true) return null;
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
  if (!esGeneracionVigenteOcr(id, gen)) return;
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
    if (nombreReal) document.getElementById(`${id}-nombreprov`).value = nombreReal;
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
  if (esGeneracionVigenteOcr(id, gen)) recalcTotal();
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
  const MAX_SONDEOS = 18; // ~90s de sondeo -- pasado eso, se deja que el cron lo siga intentando solo, sin seguir consultando desde un formulario que quizás ni sigue abierto
  let intento = 0;
  const sondear = async () => {
    intento++;
    // Se corta en silencio (no es un error, es solo dejar de esperar) si:
    // ya hay una llamada más nueva para este ítem, el ítem se quitó del
    // formulario, o se acabaron los sondeos.
    if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return;
    const { data, error } = await db.from("ocr_previos").select("estado, resultado").eq("id", previaId).maybeSingle();
    if (error || !data) return;
    if (data.estado === "listo" && data.resultado) {
      await aplicar(data.resultado, gen);
      if (esGeneracionVigenteOcr(id, gen)) {
        statusEl.textContent = "✔ La IA logró leer el comprobante en un reintento automático. Revísalo antes de enviar.";
        statusEl.className = "ocr-status show ok";
      }
      return;
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
  const gen = nuevaGeneracionOcr(id);
  limpiarCamposDeComprobante([`${id}-nombreprov`, `${id}-rut`, `${id}-folio`, `${id}-venc`, `${id}-monto`, `${id}-desc`, `${id}-tipodoc`, `${id}-categoriacon`]);
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
      const contable = await resolverDatosContables(datosLocales.rut_proveedor);
      if (!esGeneracionVigenteOcr(id, gen)) return;

      const { datos } = fusionarLecturas(datosLocales, null, contable);
      registrarOrigenOcr(id, "local", datos);
      await aplicarResultadoOcrCon(id, datos, gen);
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
      statusEl.textContent = textoBase;
      statusEl.className = "ocr-status show ok";

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
    const ia = await llamarOcrRecibo(file, CAMPOS_OCR_CON, {});
    if (!esGeneracionVigenteOcr(id, gen)) return; // ya hay una llamada más nueva para este ítem en curso
    const contableIA = await resolverDatosContables(ia?.rut_proveedor);
    if (!esGeneracionVigenteOcr(id, gen)) return;
    const { datos: datosIA } = fusionarLecturas(null, ia, contableIA);
    registrarOrigenOcr(id, "ia", datosIA);
    await aplicarResultadoOcrCon(id, datosIA, gen);
    if (!esGeneracionVigenteOcr(id, gen)) return;

    statusEl.textContent = contableIA.desdeContabilidad
      ? `✔ Datos completados con IA. Categoría sugerida: "${contableIA.categoria}", que es la cuenta con la que contabilidad registró antes a este proveedor. Revísalos antes de enviar.`
      : "✔ Datos completados con IA. Revísalos antes de enviar.";
    statusEl.className = "ocr-status show ok";
  } catch (err) {
    if (!esGeneracionVigenteOcr(id, gen)) return; // idem: una llamada más nueva ya se hizo cargo de este ítem
    console.error("Error en OCR:", err);

    // Último recurso para las FOTOS: hasta acá, una foto con Gemini caído o
    // sin cuota no dejaba absolutamente nada y la persona tenía que tipear
    // todo. El OCR local es peor que la IA, pero entre algo verificado y
    // nada, gana algo. Solo se aplica si pasó los controles de
    // leerFotoLocal (RUT con dígito verificador válido, o monto que cuadra
    // con neto + IVA).
    if (await aplicarRespaldoFoto(id, file, gen, statusEl, aplicarResultadoOcrCon, CAMPOS_OCR_CON)) return;

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
async function aplicarRespaldoFoto(id, file, gen, statusEl, aplicar, campos) {
  if (!(file.type || "").startsWith("image/")) return false;
  statusEl.textContent = "🪄 La IA no está disponible. Leyendo la foto acá mismo, puede tardar unos segundos...";
  statusEl.className = "ocr-status show";
  const local = await leerFotoLocal(file);
  if (!esGeneracionVigenteOcr(id, gen) || !document.body.contains(statusEl)) return true;
  if (!local) return false;

  const contable = await resolverDatosContables(local.rut_proveedor);
  if (!esGeneracionVigenteOcr(id, gen)) return true;
  const { datos } = fusionarLecturas(local, null, contable);
  registrarOrigenOcr(id, "local", datos);
  await aplicar(id, datos, gen);
  if (!esGeneracionVigenteOcr(id, gen)) return true;

  // El mensaje dice explícitamente que esto NO lo leyó la IA y qué hay que
  // mirar. Una lectura de foto hecha acá es bastante menos confiable que la
  // de un PDF, y presentarla con el mismo "✔ Datos leídos" de siempre sería
  // esconder esa diferencia justo donde importa.
  const faltan = camposAPedirOcr(datos, campos).map((c) => ETIQUETA_CAMPO_OCR[c] || c);
  statusEl.textContent = `⚠ La IA no está disponible, así que la foto se leyó acá mismo, que es menos preciso.`
    + (datos.monto_verificado ? " El monto igual quedó confirmado (neto + IVA cuadran con el total)." : "")
    + (faltan.length ? ` Revisa todo y completa a mano: ${faltan.join(", ")}.` : " Revisa todos los campos antes de enviar.");
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
  if (!esGeneracionVigenteOcr(id, gen)) return;
  ocrExitoso.set(id, true);
  if (data.nombre_proveedor) {
    document.getElementById(`${id}-nombreprov2`).value = data.nombre_proveedor;
    mostrarHistorialProveedor(id, data.nombre_proveedor);
  }
  if (data.descripcion) document.getElementById(`${id}-desc2`).value = data.descripcion;
  const montoIA2 = montoValidoCLP(data.monto);
  if (montoIA2) document.getElementById(`${id}-monto2`).value = montoIA2.toLocaleString("es-CL");
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
  if (esGeneracionVigenteOcr(id, gen)) recalcTotal();
}

async function analizarComprobanteGastoDirecto(id, file, statusEl) {
  const gen = nuevaGeneracionOcr(id);
  limpiarCamposDeComprobante([`${id}-nombreprov2`, `${id}-desc2`, `${id}-monto2`, `${id}-categoria`]);
  statusEl.textContent = "🪄 Analizando comprobante...";
  statusEl.className = "ocr-status show";
  try {
    // Igual que en "Documento electrónico": si es un PDF con texto, se lee
    // local (gratis, al instante, sin gastar cuota de Gemini). Este
    // formulario no tiene campos de RUT/folio/tipo, pero el RUT leído
    // igual sirve para resolver proveedor, categoría y descripción.
    const datosLocales = await leerPdfLocal(file);
    if (datosLocales) {
      const contable = await resolverDatosContables(datosLocales.rut_proveedor);
      if (!esGeneracionVigenteOcr(id, gen)) return;
      const { datos } = fusionarLecturas(datosLocales, null, contable);
      registrarOrigenOcr(id, "local", datos);
      await aplicarResultadoOcrSin(id, datos, gen);
      if (!esGeneracionVigenteOcr(id, gen)) return;

      // Si el PDF resultó ser una factura/boleta de honorarios, lo más
      // probable es que corresponda la otra pestaña: esos documentos se
      // contabilizan distinto (ver CUENTA_POR_TIPO_DOC y la exportación a
      // Kame), así que conviene avisar antes de que se envíe mal.
      const esDocumentoTributario = datos.tipo_documento && /Factura|Honorario/i.test(datos.tipo_documento);
      const textoBase = esDocumentoTributario
        ? `✔ Datos leídos del PDF. Ojo: parece ser un(a) ${datos.tipo_documento}, que normalmente va en la pestaña "Documento electrónico". Revísalo antes de enviar.`
        : "✔ Datos leídos del PDF. Revísalos antes de enviar.";
      statusEl.textContent = textoBase;
      statusEl.className = "ocr-status show ok";

      // Se pide a la IA solo lo que ESTE formulario puede mostrar: pedirle
      // folio o tipo de documento acá sería gastar cuota en campos que no
      // existen en pantalla.
      if (valeLaPenaLlamarIA(camposAPedirOcr(datos, CAMPOS_OCR_SIN))) {
        completarConIA({ id, file, gen, statusEl, local: datosLocales, contable, datos,
          campos: CAMPOS_OCR_SIN, aplicar: aplicarResultadoOcrSin, textoBase });
      }
      return;
    }

    const ia = await llamarOcrRecibo(file, CAMPOS_OCR_SIN, {});
    if (!esGeneracionVigenteOcr(id, gen)) return; // ya hay una llamada más nueva para este ítem en curso
    const contableIA = await resolverDatosContables(ia?.rut_proveedor);
    if (!esGeneracionVigenteOcr(id, gen)) return;
    const { datos: datosIA } = fusionarLecturas(null, ia, contableIA);
    registrarOrigenOcr(id, "ia", datosIA);
    await aplicarResultadoOcrSin(id, datosIA, gen);
    if (!esGeneracionVigenteOcr(id, gen)) return;

    statusEl.textContent = "✔ Datos completados con IA. Revísalos antes de enviar.";
    statusEl.className = "ocr-status show ok";
  } catch (err) {
    if (!esGeneracionVigenteOcr(id, gen)) return; // idem: una llamada más nueva ya se hizo cargo de este ítem
    console.error("Error en OCR:", err);
    // Mismo respaldo que en "Documento electrónico": una foto sin IA
    // disponible se lee acá antes de darse por vencido.
    if (await aplicarRespaldoFoto(id, file, gen, statusEl, aplicarResultadoOcrSin, CAMPOS_OCR_SIN)) return;
    mostrarErrorOcr(statusEl, err, () => analizarComprobanteGastoDirecto(id, file, statusEl));
    dispararAgenteYEsperar(id, err.previaId, gen, (data, g) => aplicarResultadoOcrSin(id, data, g), statusEl);
  }
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
  const row3 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-desc2`, "Descripción", "text"),
  ]);
  const foto = fieldFile(`${id}-foto2`, "Comprobante (foto o PDF)");
  const ocrStatus = el("p", { class: "ocr-status", id: `${id}-ocr-status2` });
  foto.appendChild(ocrStatus);

  box.appendChild(rowProv);
  box.appendChild(row1);
  box.appendChild(historialHint);
  box.appendChild(row2);
  box.appendChild(row3);
  box.appendChild(foto);

  const fotoInput2 = foto.querySelector("input[type=file]");
  fotoInput2.addEventListener("change", async () => {
    if (!validarTamanoArchivo(fotoInput2)) return;
    await reemplazarConVersionComprimida(fotoInput2);
    if (fotoInput2.files && fotoInput2.files[0]) analizarComprobanteGastoDirecto(id, fotoInput2.files[0], ocrStatus);
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
    const LADO_MAXIMO = 1600;
    const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * escala);
    const h = Math.round(bitmap.height * escala);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
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
async function reemplazarConVersionComprimida(input) {
  const original = input.files && input.files[0];
  if (!original) return;
  const comprimido = await comprimirImagenSiCorresponde(original);
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
async function verificarDocumentoItem(item, box, empresaRendicion) {
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
    // correcto exigimos las tres cosas juntas: Empresa + RUT proveedor +
    // Folio. Además "documento" guarda el texto completo del documento
    // (ej. "Factura Electrónica #115277"), así que anclamos el folio al
    // final del texto, justo después de un "#", para no confundir folios
    // que son substring de otros (ej. "277" no debe matchear "#115277").
    let query = dbContabilidad
      .from("movimientos")
      .select("*")
      .eq(MOVIMIENTOS_COLS.rutFicha, item.rut_proveedor)
      .ilike(MOVIMIENTOS_COLS.folioDoc, `%#${item.nro_documento}`);
    if (empresaRendicion) query = query.ilike(MOVIMIENTOS_COLS.empresa, empresaRendicion);
    const { data, error } = await query.limit(1);
    if (error) throw error;

    const match = data && data[0];
    const cuenta = (match && match[MOVIMIENTOS_COLS.cuentaCod]) || CUENTA_POR_TIPO_DOC[item.tipo_documento];
    const comprobante = (match && match[MOVIMIENTOS_COLS.comprobante]) || null;

    // Escribir primero, mostrar el resultado recién si de verdad quedó
    // guardado -- antes se pintaba el ✔ aunque el update no hubiera tocado
    // ninguna fila (RLS bloqueándolo en silencio), y al recargar la página
    // el ítem volvía a aparecer sin verificar sin ninguna explicación.
    const res = await updateChecked("rendicion_items", item.id, {
      existe_en_contabilidad: !!match,
      cuenta_contable: cuenta,
      comprobante_contable_encontrado: comprobante,
    });
    if (!res.ok) {
      box.className = "verify-box show err";
      box.textContent = res.mensaje;
      return;
    }
    item.existe_en_contabilidad = !!match;
    item.cuenta_contable = cuenta;

    box.className = "verify-box show " + (match ? "ok" : "no");
    box.textContent = match
      ? `✔ Registrada en contabilidad · Cuenta ${cuenta}`
      : "✘ Todavía no aparece registrada en contabilidad.";
  } catch (err) {
    box.className = "verify-box show err";
    box.textContent = "No se pudo verificar (revisa los nombres de columnas de 'movimientos').";
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
}

async function submitRendicion() {
  const cards = Array.from(document.querySelectorAll(".item-card"));
  if (!cards.length) { toast("Agrega al menos un ítem."); return; }

  const fecha = document.getElementById("nr-fecha").value;
  const tipoRendicion = document.getElementById("nr-tipo").value;
  const comentario = document.getElementById("nr-comentario").value.trim();
  const empresaRendicion = document.getElementById("nr-empresa").value;
  const centroCostoRendicion = document.getElementById("nr-cc").value;

  const items = [];
  for (const [idx, card] of cards.entries()) {
    const id = card.id;
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
      items.push({
        tipo_item: "SinDocumento",
        nombre_proveedor: document.getElementById(`${id}-nombreprov2`).value.trim() || null,
        rut_proveedor: null,
        tipo_documento: null,
        nro_documento: null,
        fecha_vencimiento: null,
        cuenta_contable: document.getElementById(`${id}-cuenta`).value.trim(),
        empresa: empresaRendicion,
        centro_costo: document.getElementById(`${id}-cc`).value.trim() || centroCostoRendicion,
        categoria: document.getElementById(`${id}-categoria`).value,
        monto,
        descripcion: document.getElementById(`${id}-desc2`).value.trim(),
        // Igual que en ConDocumento. Acá el único hueco que el agente puede
        // llenar es la descripción: el gasto directo no tiene proveedor ni
        // folio que leer.
        ocr_reintento_estado: estadoReintentoOcr(id, [
          document.getElementById(`${id}-desc2`).value.trim(),
        ]),
        ocr_origen: ocrOrigen.get(id) || null,
        monto_verificado: montoSigueVerificado(id, monto),
        _fotoInput: fotoInput2,
      });
    }
  }

  if (!items.length) { toast("Ingresa el monto de al menos un ítem."); return; }
  const hayItemsPendientesOcr = items.some((it) => it.ocr_reintento_estado === "pendiente");

  let solicitudFondoId = null;
  if (tipoRendicion === "FondoPorRendir") {
    solicitudFondoId = document.getElementById("nr-fondo").value || null;
    if (!solicitudFondoId) { toast("Selecciona el fondo (solicitud aprobada) que estás rindiendo."); return; }
  }

  const btn = document.getElementById("btn-guardar-rendicion");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Guardando...';

  try {
    // Subimos los comprobantes ANTES de crear la rendición -- así, si todos
    // fallan (red, un nombre de archivo raro, etc.), nunca se llega a
    // insertar la cabecera y no se quema un folio en el intento. Antes se
    // creaba la cabecera primero: cada reintento fallido dejaba una
    // rendición fantasma en $0 Y el número de folio se perdía para siempre
    // (una secuencia autoincremental de Postgres no reutiliza los números
    // de filas borradas).
    const rendicionId = crypto.randomUUID();
    const itemsConAdjunto = [];
    const erroresItems = [];
    for (const [idx, item] of items.entries()) {
      const file = item._fotoInput?.files?.[0];
      delete item._fotoInput;
      let adjuntoUrl = null;
      if (file) {
        // Un nombre de archivo con "°", tildes u otros caracteres fuera de
        // ASCII rompe la ruta del storage y la subida falla -- ej. "Factura
        // N°9893.pdf". Se sanea antes de armar la ruta, la persona nunca ve
        // este nombre (solo se usa como parte interna del path).
        const nombreSeguro = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        // "idx" (además de Date.now()) evita que dos ítems con el mismo
        // nombre de archivo (ej. dos fotos "foto.jpg" del celular) puedan
        // llegar a compartir la misma ruta si alguna vez coincidiera el
        // milisegundo -- upload() no sobreescribe en silencio (falla con
        // 409), pero total es gratis evitarlo del todo.
        const path = `${currentUser.id}/${rendicionId}-${idx}-${Date.now()}-${nombreSeguro}`;
        // Timeout propio (no solo el de conTimeout) para que un archivo
        // colgado no aborte tratar de subir el resto de los ítems -- se
        // captura acá mismo, no se deja propagar al try/catch general de
        // toda la función, que si no habría cortado en seco el envío
        // completo en vez de seguir con los ítems que sí van bien.
        let upErr = null;
        try {
          const resp = await conTimeout(
            db.storage.from("comprobantes").upload(path, file),
            45000,
            "Se agotó el tiempo de espera subiendo el archivo (conexión muy lenta o caída)."
          );
          upErr = resp.error;
        } catch (timeoutErr) {
          upErr = timeoutErr;
        }
        if (upErr) {
          console.error("Error subiendo comprobante:", upErr);
          erroresItems.push(`Ítem ${idx + 1}: no se pudo subir el comprobante (${upErr.message}).`);
          continue;
        }
        adjuntoUrl = path;
      }
      itemsConAdjunto.push({ item, idx, adjunto_url: adjuntoUrl });
    }

    if (!itemsConAdjunto.length) {
      toast(`No se pudo subir ningún comprobante, así que no se creó la rendición. ${erroresItems.join(" · ")}`);
      return;
    }

    const { data: rendicion, error: errR } = await db
      .from("rendiciones")
      .insert({
        id: rendicionId,
        empleado_id: currentUser.id,
        empleado_nombre: currentProfile?.nombre || currentUser.email,
        rut_empleado: currentProfile?.rut || null,
        tipo_rendicion: tipoRendicion,
        empresa: empresaRendicion,
        monto_total: itemsConAdjunto.reduce((s, x) => s + x.item.monto, 0),
        estado: "Pendiente",
        comentario,
        solicitud_fondo_id: solicitudFondoId,
      })
      .select()
      .single();
    if (errR) throw errR;

    // Se recalcula el total según lo que REALMENTE queda guardado -- si el
    // insert del ítem en sí falla (más raro que la subida, ej. una
    // restricción de la base), ese ítem se descarta y el monto_total no
    // debe incluirlo.
    let montoRealGuardado = 0;
    let itemsGuardados = 0;
    for (const { item, idx, adjunto_url } of itemsConAdjunto) {
      const { error: itemErr } = await db.from("rendicion_items").insert({ ...item, rendicion_id: rendicion.id, adjunto_url });
      if (itemErr) {
        console.error("Error guardando ítem:", itemErr);
        erroresItems.push(`Ítem ${idx + 1}: no se pudo guardar (${itemErr.message}).`);
        continue;
      }
      montoRealGuardado += item.monto;
      itemsGuardados++;
    }

    if (!itemsGuardados) {
      // El o los comprobantes sí se subieron, pero el insert del ítem en sí
      // falló para todos -- igual limpiamos la cabecera para no dejar el
      // folio con una rendición vacía. .select() para confirmar que el
      // borrado realmente afectó la fila (requiere la policy
      // "rendiciones_delete_propia_vacia") y no decirle a la persona que se
      // borró cuando en realidad quedó ahí, bloqueada en silencio por RLS
      // -- el mismo caso que ya nos mordió con aprobarItem antes de que
      // existiera updateChecked().
      const { data: borrada } = await db.from("rendiciones").delete().eq("id", rendicion.id).select();
      const mensajeBase = `No se pudo guardar ningún ítem. ${erroresItems.join(" · ")}`;
      toast(borrada && borrada.length
        ? `${mensajeBase} La rendición no quedó creada.`
        : `${mensajeBase} La rendición quedó guardada vacía -- avisa a un admin para que la revise.`);
      return;
    }

    if (montoRealGuardado !== rendicion.monto_total) {
      await db.from("rendiciones").update({ monto_total: montoRealGuardado }).eq("id", rendicion.id);
    }

    if (erroresItems.length) {
      toast(`Se guardaron ${itemsGuardados} de ${items.length} ítems. Revisa la rendición y vuelve a cargar los que fallaron:\n${erroresItems.join(" · ")}`);
    }

    notificarAsync("notificar-aprobador", { rendicion_id: rendicion.id }, "No se pudo notificar al aprobador:");

    // Si algún ítem quedó con el comprobante sin leer, no hace falta
    // esperar hasta 5 minutos al próximo tick del cron (ver
    // migracion_ocr_reintento.sql) -- se dispara altiro un intento
    // inmediato, con sesión propia (el agente scopea a los ítems de este
    // mismo usuario, ver ocr-reintento-pendientes). Fire-and-forget: si
    // falla, el cron de todos modos lo agarra más tarde.
    if (hayItemsPendientesOcr) {
      notificarAsync("ocr-reintento-pendientes", {}, "No se pudo disparar el reintento inmediato de OCR:");
    }

    toast("Rendición enviada a aprobación.");
    replaceView("view-dashboard");
    loadDashboard();
  } catch (err) {
    toast(mensajeErrorAmigable(err));
  } finally {
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

  if (s.estado === "Aprobado") {
    box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:10px" },
      `Aprobado por ${s.aprobador_nombre || "-"} el ${fmtDate(s.fecha_aprobacion)}`));

    // Saldo: cuánto de este fondo ya se rindió (rendiciones Aprobadas
    // vinculadas a esta solicitud) y cuánto queda disponible. Si el saldo
    // es negativo, la persona gastó más de lo que se le entregó -- ese
    // exceso se contabilizó como Rendiciones por Pagar (ver
    // calcularSplitFondo), no como parte de este fondo.
    const { data: rendidas } = await db
      .from("rendiciones")
      .select("id, folio, monto_total, estado")
      .eq("solicitud_fondo_id", s.id)
      .order("created_at", { ascending: true });
    const aprobadas = (rendidas || []).filter((r) => r.estado === "Aprobado");
    const rendido = aprobadas.reduce((sum, r) => sum + Number(r.monto_total || 0), 0);
    const saldo = Number(s.monto_solicitado) - rendido;

    box.appendChild(el("div", {
      style: "margin-top:14px; padding:12px 14px; border-radius:8px; background:var(--bg-soft, rgba(120,120,120,0.06));",
    }, [
      el("p", { style: "margin:0 0 4px;font-size:0.85rem;color:var(--ink-soft)" }, "Monto ya rendido (aprobado)"),
      el("p", { style: "margin:0 0 10px;font-weight:700" }, fmtCLP(rendido)),
      el("p", { style: "margin:0 0 4px;font-size:0.85rem;color:var(--ink-soft)" },
        saldo >= 0 ? "Saldo disponible" : "Exceso rendido (va a Rendiciones por Pagar)"),
      el("p", { style: `margin:0;font-weight:700;color:${saldo >= 0 ? "var(--success)" : "var(--danger)"}` }, fmtCLP(Math.abs(saldo))),
    ]));

    if (rendidas && rendidas.length) {
      box.appendChild(el("p", { style: "margin:16px 0 8px;font-weight:600;font-size:0.9rem" }, "Rendiciones contra este fondo"));
      const tabla = el("table", { class: "items-table" });
      const cols = ["Rendición", "Monto", "Estado"];
      tabla.appendChild(el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { class: c === "Monto" ? "right" : "" }, c)))]));
      const tbody = el("tbody");
      rendidas.forEach((r) => {
        const celdas = [
          el("td", {}, `N° ${r.folio ?? "-"}`),
          el("td", { class: "monto" }, fmtCLP(r.monto_total)),
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
      if (!confirm(`¿Aprobar la solicitud de fondos de ${s.empleado_nombre} por ${fmtCLP(s.monto_solicitado)}? Esta acción no se puede deshacer.`)) return;
      btnAprobar.disabled = true;
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
  const [{ data: items }, { count: historialCount }, { data: montosEditados }] = await Promise.all([
    db.from("rendicion_items").select("*").eq("rendicion_id", id),
    db.from("rendicion_items_historial").select("id", { count: "exact", head: true }).eq("rendicion_id", id),
    // Qué ítems tuvieron su monto editado a mano después de cargarse (por
    // OCR o a mano) -- una señal de confianza simple para quien aprueba,
    // usando datos que el historial ya guardaba pero que antes no se
    // resumían en ningún lado de la vista de detalle.
    db.from("rendicion_items_historial").select("item_id").eq("rendicion_id", id).eq("campo", "monto"),
  ]);
  const itemsConMontoEditado = new Set((montosEditados || []).map((h) => h.item_id));

  const esAprobadorViewer = esAprobadorEfectivo(currentProfile);
  const esPropia = r.empleado_id === currentUser.id;
  const puedeAprobar = esAprobadorViewer && r.estado === "Pendiente" && !esPropia;

  const box = document.getElementById("detalle-card");
  box.innerHTML = "";

  box.appendChild(el("div", { class: "detail-header" }, [
    el("div", {}, [
      el("h2", { style: "margin:0 0 4px" }, `N° ${r.folio ?? "-"} · ${r.comentario || `${r.empresa || "Sin empresa"} / ${r.tipo_rendicion}`}`),
      el("p", { style: "margin:0;color:var(--ink-soft);font-size:0.88rem" }, `${r.empleado_nombre} · ${fmtDate(r.created_at)}`),
    ]),
    el("span", { class: "pill " + r.estado, style: "font-size:0.8rem" }, r.estado),
  ]));

  // Si esta rendición justifica un fondo entregado por adelantado, se
  // muestra el vínculo con su solicitud (folio real, no el uuid) para
  // poder ir a ver cuánto se otorgó y cuánto queda disponible.
  if (r.tipo_rendicion === "FondoPorRendir" && r.solicitud_fondo_id) {
    const { data: solicitud } = await db.from("solicitudes_fondos").select("folio").eq("id", r.solicitud_fondo_id).maybeSingle();
    if (solicitud) {
      box.appendChild(el("p", { style: "margin:0 0 14px;font-size:0.88rem" }, [
        "Fondo asociado: ",
        el("a", {
          href: "#", style: "color:var(--blue);font-weight:600;",
          onclick: (e) => { e.preventDefault(); openDetalleSolicitud(r.solicitud_fondo_id); },
        }, `S-${solicitud.folio}`),
      ]));
    }
  }

  const puedeEditarItems = r.estado === "Pendiente" && (esAprobadorViewer || r.empleado_id === currentUser.id);

  const columnas = ["Tipo", "Proveedor / Categoría", "RUT", "Documento", "Fecha Venc."];
  if (esAprobadorViewer) columnas.push("Cuenta Contable");
  columnas.push("Centro de Costo", "Descripción", "Monto", "Estado");

  const tabla = el("table", { class: "items-table" });
  const thead = el("thead", {}, [el("tr", {}, columnas.map((c) => el("th", { class: c === "Monto" ? "right" : "" }, c)))]);
  const tbody = el("tbody");
  tabla.appendChild(thead);
  tabla.appendChild(tbody);

  (items || []).forEach((it) => {
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
      accionesCell.appendChild(el("button", { class: "btn btn-sm", type: "button", onclick: () => verComprobante(it) }, "Ver"));
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
          verificarDocumentoItem(it, verifyBox, r.empresa);
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
    tbody.appendChild(el("tr", {}, celdas));
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
    if (it.ocr_reintento_estado === "pendiente") {
      tbody.appendChild(el("tr", {}, [
        el("td", { colspan: String(columnas.length) }, [
          el("div", { class: "ocr-status show" },
            "🔄 La IA sigue intentando leer este comprobante en segundo plano (Gemini estuvo saturado al crear el ítem)."),
        ]),
      ]));
    } else if (it.ocr_reintento_estado === "listo" && it.ocr_reintento_resultado) {
      const s = it.ocr_reintento_resultado;
      const partes = [
        s.nombre_proveedor && `Proveedor: ${s.nombre_proveedor}`,
        s.rut_proveedor && `RUT: ${s.rut_proveedor}`,
        s.nro_documento && `N° documento: ${s.nro_documento}`,
        s.monto && `Monto: ${fmtCLP(s.monto)}`,
      ].filter(Boolean).join(" · ");
      tbody.appendChild(el("tr", {}, [
        el("td", { colspan: String(columnas.length) }, [
          el("div", { class: "ocr-status show ok" },
            `💡 La IA logró leer este comprobante en un reintento en segundo plano: ${partes || "sin datos nuevos"}. Revísalo y aplícalo a mano con "Editar" si corresponde.`),
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

  box.appendChild(el("div", { class: "table-scroll" }, [tabla]));

  box.appendChild(el("div", { class: "totals-bar" }, [
    el("span", {}, "Total"),
    el("span", { class: "amount" }, fmtCLP(r.monto_total)),
  ]));

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
    acciones.appendChild(el("button", {
      class: "btn btn-secondary btn-sm", type: "button",
      onclick: () => descargarCSV(r, items),
    }, "Descargar comprobante para Kame"));
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
        toast("No se pudo enviar: " + (error?.message || "revisa los logs de la función en Supabase."));
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

  if (pushHistory) pushView("view-detalle", { id }); else show("view-detalle");
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
  db.functions.invoke(fn, { body }).then(({ error }) => {
    if (error) console.error(contexto, error);
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
  const aprobados = items.filter((it) => it.estado === "Aprobado");
  const rechazados = items.filter((it) => it.estado === "Rechazado");
  const estado = aprobados.length > 0 ? "Aprobado" : "Rechazado";
  const montoTotal = aprobados.reduce((s, it) => s + Number(it.monto || 0), 0);

  const cambios = {
    estado,
    monto_total: montoTotal,
    aprobador_id: currentUser.id,
    aprobador_nombre: currentProfile?.nombre || currentUser.email,
    fecha_aprobacion: new Date().toISOString(),
  };
  if (estado === "Rechazado") {
    cambios.motivo_rechazo = rechazados.map((it) => it.motivo_rechazo).filter(Boolean).join(" | ") || "Todos los ítems fueron rechazados.";
  }

  const res = await updateChecked("rendiciones", rendicion.id, cambios);
  if (!res.ok) {
    toast(res.mensaje);
    if (/ya fue procesad/i.test(res.mensaje)) openDetalle(rendicion.id, false);
    return;
  }

  toast(estado === "Aprobado" ? "Rendición aprobada." : "Rendición rechazada.");
  Object.assign(rendicion, cambios);

  notificarAsync("notificar-estado-rendicion", { rendicion_id: rendicion.id }, "No se pudo notificar al empleado:");

  if (estado === "Aprobado") {
    await descargarCSV(rendicion, aprobados);
  }
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
async function registrarCambio(item, rendicionId, campo, valorAnterior, valorNuevo) {
  if (String(valorAnterior ?? "") === String(valorNuevo ?? "")) return;
  await db.from("rendicion_items_historial").insert({
    item_id: item.id,
    rendicion_id: rendicionId,
    usuario_id: currentUser.id,
    usuario_nombre: currentProfile?.nombre || currentUser.email,
    campo,
    valor_anterior: valorAnterior === null || valorAnterior === undefined ? null : String(valorAnterior),
    valor_nuevo: valorNuevo === null || valorNuevo === undefined ? null : String(valorNuevo),
  });
}

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
      tipoDoc.querySelector("select").value = draftCon.tipoDocumento;
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
        if (tipoEditado === "ConDocumento") {
          const rutEditado = formatearRut(lineWrap.querySelector(`#${pfx}rut`).value.trim());
          if (rutEditado && !validarRut(rutEditado)) { toast("Ese RUT de proveedor no es válido."); return; }
          cambios.nombre_proveedor = lineWrap.querySelector(`#${pfx}nombreprov`).value.trim();
          cambios.rut_proveedor = rutEditado;
          cambios.tipo_documento = lineWrap.querySelector(`#${pfx}tipodoc`).value;
          cambios.nro_documento = lineWrap.querySelector(`#${pfx}nrodoc`).value.trim();
          cambios.fecha_vencimiento = lineWrap.querySelector(`#${pfx}venc`).value || null;
          if (esAprobadorViewer) cambios.cuenta_contable = lineWrap.querySelector(`#${pfx}cuenta`).value.trim();
          cambios.categoria = lineWrap.querySelector(`#${pfx}categoria`)?.value || null;
        } else {
          cambios.nombre_proveedor = lineWrap.querySelector(`#${pfx}nombreprov2`).value.trim();
          cambios.categoria = lineWrap.querySelector(`#${pfx}categoria`).value;
          cambios.cuenta_contable = lineWrap.querySelector(`#${pfx}cuenta`).value.trim();
          // Sale de "Documento electrónico": estos campos ya no aplican y no
          // deben quedar reflejando un tipo de documento que ya no es este ítem.
          cambios.rut_proveedor = null;
          cambios.tipo_documento = null;
          cambios.nro_documento = null;
          cambios.fecha_vencimiento = null;
          cambios.existe_en_contabilidad = null;
          cambios.comprobante_contable_encontrado = null;
        }

        const res = await updateChecked("rendicion_items", it.id, cambios);
        if (!res.ok) { toast(res.mensaje); return; }

        // Solo se audita lo que realmente formaba parte del formulario editado
        // (p.ej. un empleado no puede tocar cuenta_contable, así que no debe
        // quedar un registro falso de "cambio" en ese campo).
        await Promise.all(
          Object.keys(cambios).map((campo) => registrarCambio(it, rendicion.id, campo, it[campo], cambios[campo]))
        );

        if (cambios.monto !== it.monto) {
          // Excluir Rechazado: un aprobador puede editar el monto de un
          // ítem mientras revisa uno por uno, antes de "Finalizar
          // aprobación" -- si ya rechazó otro ítem de la misma rendición,
          // sumarlo acá infla el Total mostrado (y el stat de Pendientes
          // del dashboard) con plata que nunca va a quedar aprobada.
          const { data: todos } = await db.from("rendicion_items").select("monto, estado").eq("rendicion_id", rendicion.id);
          const nuevoTotal = (todos || []).filter((x) => x.estado !== "Rechazado").reduce((s, x) => s + Number(x.monto), 0);
          await db.from("rendiciones").update({ monto_total: nuevoTotal }).eq("id", rendicion.id);
        }

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
  return fields.map((f) => (f === null || f === undefined ? "" : String(f))).join(";");
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
function construirFilasCSV(rendicion, items, folioTransaccion = 1, split = null) {
  const fecha = fmtDateSlash(rendicion.created_at) || rendicion.created_at;
  const glosa = `RENDICION N° ${rendicion.folio ?? ""} ${rendicion.empleado_nombre}`.replace(/\s+/g, " ").trim();
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
      rows.push(csvRow([
        "TRASPASO", "S", folioTransaccion, fecha, glosa, it.cuenta_contable, it.monto, 0,
        glosa, it.rut_proveedor, it.nombre_proveedor || "", it.tipo_documento, it.nro_documento,
        it.fecha_vencimiento ? fmtDateSlash(it.fecha_vencimiento) : "",
        "", "", "",
      ]));
    } else {
      // Sin proveedor, pero igual va con Ficha: la del empleado que hizo el
      // gasto, para poder trazar de quién es cada línea.
      rows.push(csvRow([
        "TRASPASO", "S", folioTransaccion, fecha, glosa, it.cuenta_contable, it.monto, 0,
        glosa, rendicion.rut_empleado || "", rendicion.empleado_nombre, "", "", "",
        it.centro_costo || it.empresa || "", "", "",
      ]));
    }
  });

  const folioDoc = rendicion.folio ?? rendicion.id.slice(0, 8);
  const filaContrapartida = (cuenta, monto) => csvRow([
    "TRASPASO", "S", folioTransaccion, fecha, glosa, cuenta, 0, monto,
    glosa, rendicion.rut_empleado || "", rendicion.empleado_nombre, "Otros", folioDoc,
    fecha, "", "", "",
  ]);

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
  const splitPorId = new Map();
  const solicitudIds = [...new Set((rendicionesFondo || []).map((r) => r.solicitud_fondo_id).filter(Boolean))];
  if (!solicitudIds.length) return splitPorId;

  const { data: solicitudes } = await db.from("solicitudes_fondos").select("id, monto_solicitado").in("id", solicitudIds);
  const solicitudPorId = new Map((solicitudes || []).map((s) => [s.id, s]));

  const { data: historial } = await db
    .from("rendiciones")
    .select("id, solicitud_fondo_id, monto_total")
    .in("solicitud_fondo_id", solicitudIds)
    .eq("estado", "Aprobado")
    .order("fecha_aprobacion", { ascending: true });

  const consumido = new Map();
  (historial || []).forEach((r) => {
    const solicitud = solicitudPorId.get(r.solicitud_fondo_id);
    if (!solicitud) return;
    const antes = consumido.get(r.solicitud_fondo_id) || 0;
    const saldoAntes = Math.max(0, Number(solicitud.monto_solicitado) - antes);
    const dentroDelFondo = Math.min(Number(r.monto_total), saldoAntes);
    const excedente = Math.max(0, Number(r.monto_total) - saldoAntes);
    splitPorId.set(r.id, { dentroDelFondo, excedente });
    consumido.set(r.solicitud_fondo_id, antes + Number(r.monto_total));
  });
  return splitPorId;
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
  if (!perfil) return rendicion;
  return {
    ...rendicion,
    rut_empleado: perfil.rut || rendicion.rut_empleado,
    empleado_nombre: perfil.nombre || rendicion.empleado_nombre,
  };
}

async function descargarCSV(rendicion, items) {
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
const PDF_IMG_MAX_DIM = 1400;
const PDF_IMG_CALIDAD = 0.72;

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

async function obtenerImagenDeAdjunto(path) {
  try {
    const { data: signed, error } = await db.storage.from("comprobantes").createSignedUrl(path, 120);
    if (error || !signed?.signedUrl) return null;
    const resp = await fetch(signed.signedUrl);
    const blob = await resp.blob();

    if (blob.type === "application/pdf" || path.toLowerCase().endsWith(".pdf")) {
      const buf = await blob.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      return canvasAJpegRedimensionado(canvas);
    }

    // Foto normal (jpg/png del celular): la pasamos por un canvas igual,
    // así se reescala/comprime como cualquier otro adjunto en vez de
    // meterse íntegra al PDF.
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return canvasAJpegRedimensionado(canvas);
  } catch (err) {
    console.error("No se pudo preparar el adjunto para el PDF:", err);
    return null;
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

    doc.setFontSize(15);
    doc.text(`RindeWellness · Informe de rendición N° ${rendicion.folio ?? "-"}`, 14, 16);
    doc.setFontSize(10);
    doc.setTextColor(90);
    let y = 24;
    const linea = (label, valor) => {
      doc.setTextColor(90);
      doc.text(`${label}:`, 14, y);
      doc.setTextColor(20);
      doc.text(String(valor ?? "-"), 55, y);
      y += 6;
    };
    linea("Empleado", rendicion.empleado_nombre);
    linea("RUT", rendicion.rut_empleado);
    linea("Empresa", rendicion.empresa);
    linea("Fecha", fmtDate(rendicion.created_at));
    linea("Tipo", rendicion.tipo_rendicion === "FondoPorRendir" ? "Rendición de fondo por rendir" : "Reembolso");
    linea("Estado", rendicion.estado);
    if (rendicion.comentario) linea("Comentario", rendicion.comentario);
    if (rendicion.estado === "Aprobado") {
      linea("Aprobado por", rendicion.aprobador_nombre);
      linea("Fecha aprobación", fmtDate(rendicion.fecha_aprobacion));
    }
    if (rendicion.estado === "Rechazado") {
      linea("Rechazado por", rendicion.aprobador_nombre);
      linea("Motivo", rendicion.motivo_rechazo || "No se dejó un motivo.");
    }
    linea("Monto total", fmtCLP(rendicion.monto_total));
    y += 4;

    doc.autoTable({
      startY: y,
      head: [["#", "Tipo", "Proveedor / Categoría", "RUT", "Documento", "C. Costo", "Descripción", "Monto", "Estado"]],
      body: (items || []).map((it, i) => {
        const esCon = it.tipo_item === "ConDocumento";
        return [
          i + 1,
          tipoItemLabel(it.tipo_item),
          [it.categoria, it.nombre_proveedor].filter(Boolean).join(" · ") || "-",
          esCon ? (it.rut_proveedor || "-") : "-",
          esCon ? `${it.tipo_documento || "-"}${it.nro_documento ? " #" + it.nro_documento : ""}` : "-",
          it.centro_costo || "-",
          it.descripcion || "-",
          fmtCLP(it.monto),
          it.estado || "Pendiente",
        ];
      }),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [21, 156, 142] },
      columnStyles: { 7: { halign: "right" } },
    });

    // Una página por cada comprobante adjunto, para que el informe quede
    // completo (rendición + respaldos) en un solo PDF descargable. Las
    // imágenes se piden todas en paralelo (antes era una por una, una
    // rendición con varios ítems tardaba varios segundos de más); las
    // páginas igual se agregan en orden al PDF.
    const itemsConAdjunto = (items || [])
      .map((it, indiceOriginal) => ({ it, indiceOriginal }))
      .filter(({ it }) => it.adjunto_url);
    const imagenes = await Promise.all(itemsConAdjunto.map(({ it }) => obtenerImagenDeAdjunto(it.adjunto_url)));
    for (const [i, { it, indiceOriginal }] of itemsConAdjunto.entries()) {
      const img = imagenes[i];
      if (!img) continue;
      doc.addPage();
      doc.setFontSize(11);
      doc.setTextColor(20);
      const titulo = `Comprobante · Ítem ${indiceOriginal + 1}${it.nombre_proveedor ? " · " + it.nombre_proveedor : it.categoria ? " · " + it.categoria : ""}`;
      doc.text(titulo, 14, 16);
      const propiedades = doc.getImageProperties(img);
      const pageWidth = doc.internal.pageSize.getWidth() - 20;
      const pageHeight = doc.internal.pageSize.getHeight() - 30;
      let w = pageWidth;
      let h = (propiedades.height * w) / propiedades.width;
      if (h > pageHeight) {
        h = pageHeight;
        w = (propiedades.width * h) / propiedades.height;
      }
      doc.addImage(img, "JPEG", 10, 24, w, h);
    }

    // Nombre de archivo con quién rinde, para poder identificarlo de un
    // vistazo entre varios PDFs descargados (ej. "informe_rendicion_1_nataly_alvarez.pdf").
    const nombreArchivo = (rendicion.empleado_nombre || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // saca tildes
      .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    doc.save(`informe_rendicion_${rendicion.folio ?? rendicion.id.slice(0, 8)}${nombreArchivo ? "_" + nombreArchivo : ""}.pdf`);
    toast("PDF generado.");
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
    const { data: rendiciones, error: errR } = await db
      .from("rendiciones")
      .select("*")
      .eq("estado", "Aprobado")
      .gte("fecha_aprobacion", `${desde}T00:00:00`)
      .lte("fecha_aprobacion", `${hasta}T23:59:59`);
    if (errR) throw errR;

    if (!rendiciones || !rendiciones.length) {
      statusEl.textContent = "No hay rendiciones aprobadas en ese rango de fechas.";
      statusEl.className = "ocr-status show err";
      return;
    }

    const ids = rendiciones.map((r) => r.id);
    const { data: items, error: errI } = await db
      .from("rendicion_items")
      .select("*")
      .in("rendicion_id", ids);
    if (errI) throw errI;

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
async function exportarExcel() {
  toast("Generando Excel...");
  try {
    const { data: rendiciones, error: errR } = await db
      .from("rendiciones")
      .select("*, solicitudes_fondos(folio)")
      .order("folio", { ascending: true });
    if (errR) throw errR;

    const { data: items, error: errI } = await db
      .from("rendicion_items")
      .select("*, rendiciones(folio, empleado_nombre, rut_empleado, empresa)")
      .order("rendicion_id");
    if (errI) throw errI;

    const { data: solicitudes, error: errS } = await db
      .from("solicitudes_fondos")
      .select("*")
      .order("folio", { ascending: true });
    if (errS) throw errS;

    const { data: rendicionesFondoAprobadas } = await db
      .from("rendiciones")
      .select("solicitud_fondo_id, monto_total")
      .eq("tipo_rendicion", "FondoPorRendir")
      .eq("estado", "Aprobado")
      .not("solicitud_fondo_id", "is", null);
    const rendidoPorSolicitud = {};
    (rendicionesFondoAprobadas || []).forEach((r) => {
      rendidoPorSolicitud[r.solicitud_fondo_id] = (rendidoPorSolicitud[r.solicitud_fondo_id] || 0) + Number(r.monto_total || 0);
    });

    const resumen = (rendiciones || []).map((r) => ({
      "Folio": r.folio ?? "",
      "Fecha": fmtDate(r.created_at),
      "Empleado": r.empleado_nombre,
      "RUT Empleado": r.rut_empleado || "",
      "Empresa": r.empresa || "",
      "Tipo": r.tipo_rendicion,
      "Fondo Asociado": r.solicitudes_fondos?.folio ? `S-${r.solicitudes_fondos.folio}` : "",
      "Comentario": r.comentario || "",
      "Monto Total": Number(r.monto_total || 0),
      "Estado": r.estado,
      "Aprobador": r.aprobador_nombre || "",
      "Fecha Aprobación": r.fecha_aprobacion ? fmtDate(r.fecha_aprobacion) : "",
    }));

    const solicitudesSheet = (solicitudes || []).map((s) => {
      const rendido = rendidoPorSolicitud[s.id] || 0;
      return {
        "Folio": s.folio ? `S-${s.folio}` : "",
        "Fecha": fmtDate(s.created_at),
        "Empleado": s.empleado_nombre,
        "RUT Empleado": s.rut_empleado || "",
        "Empresa": s.empresa || "",
        "Centro de Costo": s.centro_costo || "",
        "Monto Solicitado": Number(s.monto_solicitado || 0),
        "Motivo": s.motivo || "",
        "Fecha Necesaria": s.fecha_necesaria ? fmtDate(s.fecha_necesaria) : "",
        "Estado": s.estado,
        "Monto Rendido": rendido,
        "Saldo Disponible": s.estado === "Aprobado" ? Math.max(0, Number(s.monto_solicitado || 0) - rendido) : "",
        "Aprobador": s.aprobador_nombre || "",
        "Fecha Aprobación": s.fecha_aprobacion ? fmtDate(s.fecha_aprobacion) : "",
        "Motivo Rechazo": s.motivo_rechazo || "",
      };
    });

    const detalle = (items || []).map((it) => ({
      "Folio Rendición": it.rendiciones?.folio ?? "",
      "Empleado": it.rendiciones?.empleado_nombre || "",
      "RUT Empleado": it.rendiciones?.rut_empleado || "",
      "Empresa": it.empresa || it.rendiciones?.empresa || "",
      "Centro de Costo": it.centro_costo || "",
      "Tipo Ítem": it.tipo_item,
      "Proveedor": it.nombre_proveedor || "",
      "RUT Proveedor": it.rut_proveedor || "",
      "Tipo Documento": it.tipo_documento || "",
      "N° Documento": it.nro_documento || "",
      "Fecha Vencimiento": it.fecha_vencimiento ? fmtDate(it.fecha_vencimiento) : "",
      "Categoría": it.categoria || "",
      "Cuenta Contable": it.cuenta_contable || "",
      "Nombre Cuenta": nombreCuenta(it.cuenta_contable),
      "Monto": Number(it.monto || 0),
      "Descripción": it.descripcion || "",
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumen), "Resumen");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalle), "Detalle");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(solicitudesSheet), "Solicitudes Fondos");

    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `rendiciones_${fecha}.xlsx`);
    toast("Excel descargado.");
  } catch (err) {
    console.error("Error exportando a Excel:", err);
    toast("No se pudo generar el Excel: " + (err.message || ""));
  }
}
