// ============================================================
// RindeWellness - lógica de la app (vanilla JS + Supabase)
// ============================================================

// Formatea un RUT chileno con puntos de miles y guión (ej. "21.315.322-6").
// Se aplica al guardar/perder foco, para que quede así en toda la app,
// exportaciones y comprobantes -- nunca sin puntos.
function formatearRut(rut) {
  const limpio = String(rut || "").replace(/[^0-9kK]/g, "").toUpperCase();
  if (limpio.length < 2) return limpio;
  const cuerpo = limpio.slice(0, -1).replace(/^0+/, "") || "0";
  const dv = limpio.slice(-1);
  const cuerpoFormateado = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cuerpoFormateado}-${dv}`;
}

// Valida el dígito verificador de un RUT chileno (algoritmo módulo 11).
// No confirma que la persona exista, solo que el número está bien escrito
// (pesca typos como transponer dígitos).
function validarRut(rut) {
  const limpio = String(rut || "").replace(/[^0-9kK]/g, "").toUpperCase();
  if (limpio.length < 2) return false;
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  let suma = 0;
  let multiplo = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += parseInt(cuerpo[i], 10) * multiplo;
    multiplo = multiplo === 7 ? 2 : multiplo + 1;
  }
  const resto = 11 - (suma % 11);
  const dvEsperado = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
  return dv === dvEsperado;
}

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
  "Neo Gym Chile SpA": ["Casa Matriz", "NEO GYM", "NEO INDEPENDENCIA", "NEO LA FLORIDA"],
  "Neo App SpA": ["Casa Matriz", "NEO APP"],
  "RFA SpA": ["Casa Matriz"],
  "Centros Deportivos SpA": ["Casa Matriz"],
};

// "Con documento" es solo para lo que realmente llega a contabilidad vía
// SII y se puede verificar (facturas y boletas de honorarios). Las boletas
// electrónicas comunes (de un local, bencinera, etc.) NUNCA llegan por SII
// a la contabilidad, así que van como "Gasto directo" -- se categorizan
// igual que cualquier otro gasto directo, con foto obligatoria igual.
const TIPOS_DOCUMENTO = ["Factura Electronica", "Factura Exenta Electronica", "Boleta de Honorarios"];

const CUENTA_POR_TIPO_DOC = {
  "Factura Electronica": "2.01.07.01",
  "Factura Exenta Electronica": "2.01.07.01",
  "Boleta de Honorarios": "2.01.07.03",
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
function fmtCLP(n) {
  return "$" + Math.round(n || 0).toLocaleString("es-CL");
}
function fmtDate(d) {
  if (!d) return "";
  // Una fecha "sola" (YYYY-MM-DD, sin hora) hay que leerla como fecha de
  // calendario local: si se la pasamos tal cual a `new Date()`, JS la
  // interpreta como medianoche UTC y, en Chile (UTC-3/-4), se muestra un
  // día antes. Los timestamps completos (con hora) sí se convierten a hora
  // local normalmente.
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.exec(String(d));
  if (soloFecha) {
    const [y, m, day] = String(d).split("-").map(Number);
    return new Date(y, m - 1, day).toLocaleDateString("es-CL");
  }
  return new Date(d).toLocaleDateString("es-CL");
}
// Kame espera DD/MM/AAAA. fmtDate ya da DD-MM-AAAA (formato es-CL), así que
// alcanza con cambiar los guiones por barras -- OJO: dar vuelta el orden acá
// (como se hacía antes) invierte el día y el año.
function fmtDateSlash(d) {
  return fmtDate(d).replace(/-/g, "/");
}
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
  return viewId.replace("view-", "");
}
function estadoDesdeHash() {
  const [base, param] = location.hash.replace(/^#/, "").split("/");
  if (base === "detalle" && param) return { viewId: "view-detalle", params: { id: param } };
  if (base === "admin") return { viewId: "view-admin", params: {} };
  if (base === "nueva") return { viewId: "view-nueva", params: {} };
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
  if (viewId === "view-admin") { openAdminUsuarios(false); return; }
  if (viewId === "view-nueva") { openNuevaRendicion(false); return; }
  show("view-dashboard");
  loadDashboard();
}
window.addEventListener("popstate", (e) => renderRoute(e.state));
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
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
  const a = document.getElementById("btn-theme-toggle");
  const b = document.getElementById("btn-theme-toggle-login");
  if (a) a.textContent = icon;
  if (b) b.textContent = icon;
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const isDark = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("rw-theme", next); } catch (e) {}
  applyThemeIcon();
}
function wireTheme() {
  applyThemeIcon();
  document.getElementById("btn-theme-toggle")?.addEventListener("click", toggleTheme);
  document.getElementById("btn-theme-toggle-login")?.addEventListener("click", toggleTheme);
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
  wireDashboard();
  wireNuevaRendicion();

  const { data } = await db.auth.getSession();
  if (data.session) {
    await onLoggedIn(data.session.user);
  }

  db.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      currentProfile = null;
      document.getElementById("app-shell").style.display = "none";
      show("view-login");
    }
  });
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

  document.getElementById("btn-ver-password").addEventListener("click", () => {
    const input = document.getElementById("login-password");
    const btn = document.getElementById("btn-ver-password");
    const verEmpezar = input.type === "password";
    input.type = verEmpezar ? "text" : "password";
    btn.textContent = verEmpezar ? "🙈" : "👁";
    btn.setAttribute("aria-label", verEmpezar ? "Ocultar contraseña" : "Mostrar contraseña");
  });

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
  currentProfile = profile;

  document.getElementById("user-name").textContent = `${profile?.nombre || user.email} · ${profile?.rol || "empleado"}`;
  document.getElementById("app-shell").style.display = "block";
  document.getElementById("tab-aprobaciones").style.display =
    profile && (profile.rol === "aprobador" || profile.rol === "admin") ? "inline-block" : "none";
  document.getElementById("btn-admin-usuarios").style.display =
    profile && profile.rol === "admin" ? "inline-block" : "none";
  document.getElementById("btn-exportar-excel").style.display =
    profile && (profile.rol === "aprobador" || profile.rol === "admin") ? "inline-block" : "none";
  document.getElementById("btn-comprobante-rango").style.display =
    profile && (profile.rol === "aprobador" || profile.rol === "admin") ? "inline-block" : "none";

  await cargarCuentasPermitidas();

  // Si venías de un F5 (recarga) en "Nueva rendición", el detalle de una
  // rendición o "Usuarios", te dejamos en esa misma pantalla en vez de
  // mandarte siempre al dashboard -- el hash de la URL sobrevive la recarga.
  const estadoInicial = estadoDesdeHash();
  if (estadoInicial.viewId === "view-admin" && profile?.rol !== "admin") {
    replaceView("view-dashboard");
    await loadDashboard();
  } else {
    renderRoute(estadoInicial);
  }
}

async function cargarCuentasPermitidas() {
  const { data, error } = await db.from("perfil_cuentas").select("cuenta_cod").eq("profile_id", currentUser.id);
  if (error) { console.error("Error cargando cuentas permitidas:", error); cuentasPermitidas = null; return; }
  cuentasPermitidas = (data && data.length) ? new Set(data.map((d) => d.cuenta_cod)) : null;
}

// ------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------
function wireDashboard() {
  document.getElementById("btn-nueva").addEventListener("click", () => openNuevaRendicion());
  document.getElementById("btn-admin-usuarios").addEventListener("click", () => openAdminUsuarios());
  document.getElementById("btn-exportar-excel").addEventListener("click", exportarExcel);
  document.getElementById("btn-comprobante-rango").addEventListener("click", () => {
    document.getElementById("panel-rango").style.display = "block";
  });
  document.getElementById("btn-cancelar-rango").addEventListener("click", () => {
    document.getElementById("panel-rango").style.display = "none";
    document.getElementById("rango-status").className = "ocr-status";
  });
  document.getElementById("btn-generar-rango").addEventListener("click", () => {
    const desde = document.getElementById("rango-desde").value;
    const hasta = document.getElementById("rango-hasta").value;
    if (!desde || !hasta) { toast("Elige ambas fechas."); return; }
    generarComprobantesPorRango(desde, hasta);
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
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const tab = b.dataset.tab;
      document.getElementById("list-mias").style.display = tab === "mias" ? "flex" : "none";
      document.getElementById("list-aprobaciones").style.display = tab === "aprobaciones" ? "flex" : "none";
    })
  );
}

// Cache de la última carga, para poder filtrar sin volver a golpear la base.
const dashboardData = { mias: [], aprobaciones: [] };

async function loadDashboard() {
  const { data: mias } = await db
    .from("rendiciones")
    .select("*")
    .eq("empleado_id", currentUser.id)
    .order("created_at", { ascending: false });
  dashboardData.mias = mias || [];

  const pendiente = dashboardData.mias.filter((r) => r.estado === "Pendiente").reduce((s, r) => s + Number(r.monto_total), 0);
  const aprobado = dashboardData.mias.filter((r) => r.estado === "Aprobado").reduce((s, r) => s + Number(r.monto_total), 0);
  renderStats(pendiente, aprobado, dashboardData.mias.length);

  if (currentProfile && (currentProfile.rol === "aprobador" || currentProfile.rol === "admin")) {
    // El admin (usuario maestro) ve todas las rendiciones de todo el grupo;
    // un aprobador normal solo ve las pendientes de aprobar.
    let query = db.from("rendiciones").select("*");
    query = currentProfile.rol === "admin"
      ? query.order("created_at", { ascending: false })
      : query.eq("estado", "Pendiente").order("created_at", { ascending: true });
    const { data: pendientes } = await query;
    dashboardData.aprobaciones = pendientes || [];
    document.getElementById("tab-aprobaciones").textContent =
      currentProfile.rol === "admin" ? "Todas las rendiciones" : "Aprobaciones pendientes";
  } else {
    dashboardData.aprobaciones = [];
  }

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

  renderList(document.getElementById("list-mias"), dashboardData.mias.filter(pasaFiltro), false);
  renderList(document.getElementById("list-aprobaciones"), dashboardData.aprobaciones.filter(pasaFiltro), true);
}

function renderStats(pendiente, aprobado, count) {
  const row = document.getElementById("stat-row");
  row.innerHTML = "";
  row.appendChild(el("div", { class: "stat-card" }, [
    el("div", { class: "label" }, "Rendiciones"),
    el("div", { class: "value" }, String(count)),
  ]));
  row.appendChild(el("div", { class: "stat-card blue" }, [
    el("div", { class: "label" }, "Pendiente de aprobar"),
    el("div", { class: "value" }, fmtCLP(pendiente)),
  ]));
  row.appendChild(el("div", { class: "stat-card teal" }, [
    el("div", { class: "label" }, "Aprobado"),
    el("div", { class: "value" }, fmtCLP(aprobado)),
  ]));
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
    el("tr", {}, columnas.map((c) => el("th", { class: columnasCentradas.has(c) ? "center" : "" }, c))),
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
    tbody.appendChild(el("tr", { class: "row-clickable", onclick: () => openDetalle(r.id) }, celdas));
  });

  container.appendChild(el("div", { class: "table-scroll" }, [tabla]));
}

// ------------------------------------------------------------
// Administración de usuarios (solo admin)
// ------------------------------------------------------------
const ROLES = ["empleado", "aprobador", "admin"];

async function openAdminUsuarios(pushHistory = true) {
  if (pushHistory) pushView("view-admin"); else show("view-admin");
  const list = document.getElementById("list-usuarios");
  list.innerHTML = "<p style='color:var(--ink-soft)'>Cargando...</p>";

  const { data: usuarios, error } = await db.from("profiles").select("*").order("nombre");
  if (error) { list.innerHTML = ""; toast("Error cargando usuarios: " + error.message); return; }

  const { data: permisos, error: permError } = await db.from("perfil_cuentas").select("*");
  if (permError) console.error("Error cargando cuentas permitidas:", permError);
  const permisosPorUsuario = {};
  (permisos || []).forEach((p) => {
    if (!permisosPorUsuario[p.profile_id]) permisosPorUsuario[p.profile_id] = new Set();
    permisosPorUsuario[p.profile_id].add(p.cuenta_cod);
  });

  list.innerHTML = "";

  if (!usuarios || !usuarios.length) {
    list.appendChild(el("div", { class: "empty-state" }, "No hay usuarios registrados todavía."));
    return;
  }

  const tabla = el("table", { class: "items-table" });
  tabla.appendChild(el("thead", {}, [
    el("tr", {}, ["Nombre", "RUT", "Rol", "Cuentas permitidas"].map((c) => el("th", {}, c))),
  ]));
  const tbody = el("tbody");
  tabla.appendChild(tbody);

  usuarios.forEach((u) => {
    const select = el("select", { style: "width:auto" }, ROLES.map((r) => el("option", { value: r }, r)));
    select.value = u.rol;
    select.addEventListener("change", async () => {
      const nuevoRol = select.value;
      const { error: updErr } = await db.from("profiles").update({ rol: nuevoRol }).eq("id", u.id);
      if (updErr) { toast("No se pudo actualizar: " + updErr.message); select.value = u.rol; }
      else { toast(`${u.nombre} ahora es ${nuevoRol}.`); u.rol = nuevoRol; }
    });

    const filaExtra = el("tr", { class: "item-extra-row", style: "display:none;" });
    const extraCell = el("td", { colspan: "4" });
    filaExtra.appendChild(extraCell);

    const nombreCell = el("td", {}, u.nombre || "(sin nombre)");

    // Un solo panel expandible por fila, que se reutiliza para "Cuentas
    // permitidas" o "Editar perfil" según qué botón se apretó.
    const mostrarPanel = (tipo, render) => {
      const yaAbiertoConEsto = filaExtra.style.display !== "none" && extraCell.dataset.tipo === tipo;
      if (yaAbiertoConEsto) { filaExtra.style.display = "none"; return; }
      filaExtra.style.display = "table-row";
      extraCell.dataset.tipo = tipo;
      render(extraCell);
    };

    const btnCuentas = el("button", { class: "btn btn-sm", type: "button" }, "Cuentas permitidas");
    btnCuentas.addEventListener("click", () => {
      mostrarPanel("cuentas", (cell) =>
        renderCuentasPanel(cell, u, permisosPorUsuario[u.id] || new Set(), usuarios, permisosPorUsuario)
      );
    });

    const btnEditar = el("button", { class: "btn btn-sm", type: "button" }, "Editar perfil");
    btnEditar.addEventListener("click", () => {
      mostrarPanel("perfil", (cell) => renderEditarPerfilPanel(cell, u, nombreCell));
    });

    tbody.appendChild(el("tr", {}, [
      nombreCell,
      el("td", {}, u.rut || "-"),
      el("td", {}, select),
      el("td", { class: "acciones-cell" }, [btnEditar, btnCuentas]),
    ]));
    tbody.appendChild(filaExtra);
  });

  list.appendChild(el("div", { class: "table-scroll" }, [tabla]));
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
      const { error } = await db.from("profiles").update({ nombre, rut, cargo, empresa_default }).eq("id", usuario.id);
      if (error) { toast("No se pudo guardar: " + error.message); return; }
      usuario.nombre = nombre;
      usuario.rut = rut;
      usuario.cargo = cargo;
      usuario.empresa_default = empresa_default;
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
  cell.appendChild(el("div", { style: "display:flex; gap:8px; margin-top:8px;" }, [guardar, cancelar]));
}

function renderCuentasPanel(panel, usuario, cuentasActuales, todosLosUsuarios = [], permisosPorUsuario = {}) {
  panel.innerHTML = "";
  const ficha = el("div", { class: "cuentas-ficha" });

  const contador = el("span", { class: "cuentas-ficha-contador" }, `${cuentasActuales.size} seleccionadas`);
  const buscador = el("input", { type: "text", class: "cuentas-buscar", placeholder: "Buscar cuenta..." });
  ficha.appendChild(el("div", { class: "cuentas-ficha-header" }, [
    el("p", { class: "cuentas-panel-hint", style: "margin:0;" },
      "Cuentas de \"gasto directo\" que puede usar. Si no marcas ninguna, puede usar todas."),
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
      renderCuentasPanel(panel, usuario, cuentasActuales, todosLosUsuarios, permisosPorUsuario);
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
        const { error } = await db.from("perfil_cuentas")
          .delete().eq("profile_id", usuario.id).eq("cuenta_cod", c.cuenta);
        if (error) { toast("No se pudo quitar: " + error.message); checkbox.checked = true; return; }
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
// Nueva rendición
// ------------------------------------------------------------
function wireNuevaRendicion() {
  document.getElementById("btn-add-item").addEventListener("click", () => addItemRow());
  document.getElementById("btn-guardar-rendicion").addEventListener("click", submitRendicion);
  const empresaSelect = document.getElementById("nr-empresa");
  EMPRESAS.forEach((emp) => empresaSelect.appendChild(el("option", { value: emp }, emp)));
  empresaSelect.addEventListener("change", actualizarCentrosCostoPorEmpresa);
}

// Los ítems "Gasto directo" ya creados se arman con el Centro de Costo de la
// empresa vigente en ese momento. Si la persona cambia la Empresa del
// encabezado después de agregar ítems, hay que refrescar esos desplegables
// -- si no, quedan mostrando los centros de costo de la empresa anterior.
function actualizarCentrosCostoPorEmpresa() {
  const empresa = document.getElementById("nr-empresa").value;
  const opciones = CENTROS_COSTO_POR_EMPRESA[empresa] || ["Casa Matriz"];
  document.querySelectorAll('.sin-documento select[id$="-cc"]').forEach((sel) => {
    const valorActual = sel.value;
    sel.innerHTML = "";
    opciones.forEach((o) => sel.appendChild(el("option", { value: o }, o)));
    sel.value = opciones.includes(valorActual) ? valorActual : opciones[0];
  });
}

function openNuevaRendicion(pushHistory = true) {
  document.getElementById("nr-fecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("nr-tipo").value = "Reembolso";
  document.getElementById("nr-comentario").value = "";
  document.getElementById("nr-empresa").value = EMPRESAS[0];
  document.getElementById("items-container").innerHTML = "";
  itemSeq = 0;
  addItemRow();
  if (pushHistory) pushView("view-nueva"); else show("view-nueva");
}

function addItemRow() {
  const id = "item-" + ++itemSeq;
  const wrap = el("div", { class: "item-card", id });

  const head = el("div", { class: "item-head" }, [
    el("strong", {}, `Ítem ${itemSeq}`),
    el("button", { class: "btn btn-ghost", type: "button", onclick: () => { wrap.remove(); recalcTotal(); } }, "Quitar"),
  ]);

  const toggle = el("div", { class: "toggle-group" }, [
    el("button", { type: "button", class: "active", "data-tipo": "ConDocumento" }, "Documento electrónico"),
    el("button", { type: "button", "data-tipo": "SinDocumento" }, "Boleta"),
  ]);

  const bodyConDoc = buildConDocumentoFields(id);
  const bodySinDoc = buildSinDocumentoFields(id);
  bodySinDoc.style.display = "none";

  toggle.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      toggle.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
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
  const row3 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-venc`, "Fecha del documento", "date"),
    fieldInputMoney(`${id}-monto`, "Monto"),
  ]);
  const row4 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-desc`, "Descripción", "text"),
  ]);
  const foto = fieldFile(`${id}-foto`, "Comprobante (foto o PDF)");
  const ocrStatus = el("p", { class: "ocr-status", id: `${id}-ocr-status` });
  foto.appendChild(ocrStatus);

  box.appendChild(row1);
  box.appendChild(row2);
  box.appendChild(row3);
  box.appendChild(row4);
  box.appendChild(foto);
  // La verificación contra contabilidad la hace quien aprueba, no quien carga el gasto
  // (ver openDetalle / verificarDocumentoItem).
  [row1, row2, row3, row4].forEach((r) =>
    r.querySelectorAll("input:not([data-money])").forEach((i) => i.addEventListener("input", recalcTotal))
  );

  const fotoInput = foto.querySelector("input[type=file]");
  fotoInput.addEventListener("change", () => {
    if (fotoInput.files && fotoInput.files[0]) analizarComprobante(id, fotoInput.files[0], ocrStatus);
  });

  // Si ese RUT ya aparece en la contabilidad, usamos su razón social real
  // en vez de que la persona tenga que escribirla a mano.
  const rutInput = row1.querySelector(`#${id}-rut`);
  const nombreProvInput = row1.querySelector(`#${id}-nombreprov`);
  rutInput.addEventListener("blur", async () => {
    rutInput.value = formatearRut(rutInput.value);
    const nombre = await buscarNombreProveedorPorRut(rutInput.value);
    if (nombre) nombreProvInput.value = nombre;
  });

  return box;
}

// Lee la foto del comprobante, se la manda a la Edge Function "ocr-recibo"
// (que a su vez consulta a Google Gemini con la API key guardada en el
// servidor) y autocompleta los campos del ítem con lo que logre leer.
// Si algo falla, simplemente no autocompleta nada: el empleado sigue
// pudiendo cargar el gasto a mano.
async function analizarComprobante(id, file, statusEl) {
  statusEl.textContent = "🪄 Analizando comprobante con IA...";
  statusEl.className = "ocr-status show";
  try {
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const { data, error } = await db.functions.invoke("ocr-recibo", {
      body: { imageBase64, mimeType: file.type || "image/jpeg" },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    if (data.nombre_proveedor) document.getElementById(`${id}-nombreprov`).value = data.nombre_proveedor;
    if (data.rut_proveedor) {
      const rutFormateado = formatearRut(data.rut_proveedor);
      document.getElementById(`${id}-rut`).value = rutFormateado;
      // Si ese RUT ya está en la contabilidad, su razón social real le gana
      // a lo que la IA haya alcanzado a leer de la imagen.
      const nombreReal = await buscarNombreProveedorPorRut(rutFormateado);
      if (nombreReal) document.getElementById(`${id}-nombreprov`).value = nombreReal;
    }
    if (data.tipo_documento && TIPOS_DOCUMENTO.includes(data.tipo_documento)) {
      document.getElementById(`${id}-tipodoc`).value = data.tipo_documento;
    }
    if (data.nro_documento) document.getElementById(`${id}-folio`).value = data.nro_documento;
    if (data.fecha) document.getElementById(`${id}-venc`).value = data.fecha;
    if (data.descripcion) document.getElementById(`${id}-desc`).value = data.descripcion;
    if (data.monto) {
      const montoInput = document.getElementById(`${id}-monto`);
      montoInput.value = Number(data.monto).toLocaleString("es-CL");
    }
    recalcTotal();

    statusEl.textContent = "✔ Datos completados con IA. Revísalos antes de enviar.";
    statusEl.className = "ocr-status show ok";
  } catch (err) {
    console.error("Error en OCR:", err);
    statusEl.textContent = "No se pudo leer el comprobante automáticamente. Completa los datos a mano.";
    statusEl.className = "ocr-status show err";
  }
}

// Misma IA que en "Con documento", pero para "Gasto directo" (boletas
// comunes que van directo al gasto): solo autocompleta monto y descripción,
// que es lo único que ese formulario tiene y lo único que se puede leer con
// certeza de una boleta (la categoría/CC las define la persona).
async function analizarComprobanteGastoDirecto(id, file, statusEl) {
  statusEl.textContent = "🪄 Analizando comprobante con IA...";
  statusEl.className = "ocr-status show";
  try {
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const { data, error } = await db.functions.invoke("ocr-recibo", {
      body: { imageBase64, mimeType: file.type || "image/jpeg" },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    if (data.descripcion) document.getElementById(`${id}-desc2`).value = data.descripcion;
    if (data.monto) {
      const montoInput = document.getElementById(`${id}-monto2`);
      montoInput.value = Number(data.monto).toLocaleString("es-CL");
    }
    recalcTotal();

    statusEl.textContent = "✔ Datos completados con IA. Revísalos antes de enviar.";
    statusEl.className = "ocr-status show ok";
  } catch (err) {
    console.error("Error en OCR:", err);
    statusEl.textContent = "No se pudo leer el comprobante automáticamente. Completa los datos a mano.";
    statusEl.className = "ocr-status show err";
  }
}

function buildSinDocumentoFields(id) {
  const box = el("div", { class: "sin-documento" });
  const row1 = el("div", { class: "field-row" }, [
    fieldSelectCategoria(`${id}-categoria`),
    fieldInput(`${id}-cuenta`, "Cuenta contable", "text", "4.01.03.xx"),
  ]);
  const empresaActual = document.getElementById("nr-empresa")?.value || EMPRESAS[0];
  const opcionesCC = CENTROS_COSTO_POR_EMPRESA[empresaActual] || ["Casa Matriz"];
  const row2 = el("div", { class: "field-row" }, [
    fieldSelect(`${id}-cc`, "Centro de Costo (Unidad de Negocio)", opcionesCC),
    fieldInputMoney(`${id}-monto2`, "Monto"),
  ]);
  const row3 = el("div", { class: "field-row" }, [
    fieldInput(`${id}-desc2`, "Descripción", "text"),
  ]);
  const foto = fieldFile(`${id}-foto2`, "Comprobante (foto o PDF)");
  const ocrStatus = el("p", { class: "ocr-status", id: `${id}-ocr-status2` });
  foto.appendChild(ocrStatus);

  box.appendChild(row1);
  box.appendChild(row2);
  box.appendChild(row3);
  box.appendChild(foto);

  const fotoInput2 = foto.querySelector("input[type=file]");
  fotoInput2.addEventListener("change", () => {
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
    el("label", {}, label),
    el("input", { id, type, placeholder }),
  ]);
}
function fieldInputMoney(id, label) {
  const input = el("input", { id, type: "text", inputmode: "numeric", placeholder: "0", "data-money": "true" });
  input.addEventListener("input", () => {
    const raw = input.value.replace(/\D/g, "");
    input.value = raw ? Number(raw).toLocaleString("es-CL") : "";
    recalcTotal();
  });
  return el("div", { class: "field" }, [el("label", {}, label), input]);
}
function parseMoneyValue(str) {
  return Number(String(str || "").replace(/\D/g, "")) || 0;
}
function fieldFile(id, label) {
  return el("div", { class: "field" }, [
    el("label", {}, label),
    el("input", { id, type: "file", accept: "image/*,application/pdf" }),
  ]);
}
function fieldSelect(id, label, options) {
  const select = el("select", { id }, options.map((o) => el("option", { value: o }, o)));
  return el("div", { class: "field" }, [el("label", {}, label), select]);
}
function fieldSelectCategoria(id) {
  const filtradas = cuentasPermitidas
    ? CATEGORIAS_GASTO.filter((c) => cuentasPermitidas.has(c.cuenta))
    : CATEGORIAS_GASTO;
  const opciones = filtradas.length ? filtradas : CATEGORIAS_GASTO;
  const select = el("select", { id }, opciones.map((c) => el("option", { value: c.nombre }, c.nombre)));
  return el("div", { class: "field" }, [el("label", {}, "Categoría del gasto"), select]);
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

    box.className = "verify-box show " + (match ? "ok" : "no");
    box.textContent = match
      ? `✔ Registrada en contabilidad · Cuenta ${cuenta}`
      : "✘ Todavía no aparece registrada en contabilidad.";

    await db.from("rendicion_items").update({
      existe_en_contabilidad: !!match,
      cuenta_contable: cuenta,
      comprobante_contable_encontrado: comprobante,
    }).eq("id", item.id);
    item.existe_en_contabilidad = !!match;
    item.cuenta_contable = cuenta;
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

  const items = [];
  for (const [idx, card] of cards.entries()) {
    const id = card.id;
    const isCon = card.querySelector(`[data-tipo="ConDocumento"]`).classList.contains("active");
    if (isCon) {
      const monto = parseMoneyValue(document.getElementById(`${id}-monto`).value);
      if (!monto) continue;
      const tipoDoc = document.getElementById(`${id}-tipodoc`).value;
      const fotoInput = document.getElementById(`${id}-foto`);
      if (!fotoInput.files.length) {
        toast(`Falta adjuntar el comprobante del Ítem ${idx + 1}.`);
        return;
      }
      items.push({
        tipo_item: "ConDocumento",
        nombre_proveedor: document.getElementById(`${id}-nombreprov`).value.trim(),
        rut_proveedor: document.getElementById(`${id}-rut`).value.trim(),
        tipo_documento: tipoDoc,
        nro_documento: document.getElementById(`${id}-folio`).value.trim(),
        fecha_vencimiento: document.getElementById(`${id}-venc`).value || null,
        // La verificación real contra contabilidad la hace el aprobador (ver openDetalle);
        // acá solo dejamos la cuenta por defecto según el tipo de documento.
        cuenta_contable: CUENTA_POR_TIPO_DOC[tipoDoc],
        comprobante_contable_encontrado: null,
        existe_en_contabilidad: null,
        empresa: empresaRendicion,
        categoria: null,
        monto,
        descripcion: document.getElementById(`${id}-desc`).value.trim(),
        _fotoInput: fotoInput,
      });
    } else {
      const monto = parseMoneyValue(document.getElementById(`${id}-monto2`).value);
      if (!monto) continue;
      const fotoInput2 = document.getElementById(`${id}-foto2`);
      if (!fotoInput2.files.length) {
        toast(`Falta adjuntar el comprobante del Ítem ${idx + 1}.`);
        return;
      }
      items.push({
        tipo_item: "SinDocumento",
        rut_proveedor: null,
        tipo_documento: null,
        nro_documento: null,
        fecha_vencimiento: null,
        cuenta_contable: document.getElementById(`${id}-cuenta`).value.trim(),
        empresa: empresaRendicion,
        centro_costo: document.getElementById(`${id}-cc`).value.trim() || empresaRendicion,
        categoria: document.getElementById(`${id}-categoria`).value,
        monto,
        descripcion: document.getElementById(`${id}-desc2`).value.trim(),
        _fotoInput: fotoInput2,
      });
    }
  }

  if (!items.length) { toast("Ingresa el monto de al menos un ítem."); return; }

  const montoTotal = items.reduce((s, i) => s + i.monto, 0);
  const btn = document.getElementById("btn-guardar-rendicion");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Guardando...';

  try {
    const { data: rendicion, error: errR } = await db
      .from("rendiciones")
      .insert({
        empleado_id: currentUser.id,
        empleado_nombre: currentProfile?.nombre || currentUser.email,
        rut_empleado: currentProfile?.rut || null,
        tipo_rendicion: tipoRendicion,
        empresa: empresaRendicion,
        monto_total: montoTotal,
        estado: "Pendiente",
        comentario,
      })
      .select()
      .single();
    if (errR) throw errR;

    for (const item of items) {
      let adjuntoUrl = null;
      const file = item._fotoInput?.files?.[0];
      if (file) {
        const path = `${currentUser.id}/${rendicion.id}-${Date.now()}-${file.name}`;
        const { error: upErr } = await db.storage.from("comprobantes").upload(path, file);
        if (!upErr) adjuntoUrl = path;
      }
      delete item._fotoInput;
      const { error: itemErr } = await db.from("rendicion_items").insert({ ...item, rendicion_id: rendicion.id, adjunto_url: adjuntoUrl });
      if (itemErr) { console.error("Error guardando ítem:", itemErr); toast("No se pudo guardar un ítem: " + itemErr.message); }
    }

    // No bloqueamos el envío si el correo falla (ej. secret de Resend sin
    // configurar todavía): la rendición ya quedó guardada, que es lo que
    // importa. El aprobador igual la va a ver al entrar al dashboard.
    db.functions.invoke("notificar-aprobador", {
      body: {
        folio: rendicion.folio,
        empleado_nombre: rendicion.empleado_nombre,
        empresa: rendicion.empresa,
        monto_total: rendicion.monto_total,
        comentario: rendicion.comentario,
        rendicion_id: rendicion.id,
      },
    }).catch((err) => console.error("No se pudo notificar al aprobador:", err));

    toast("Rendición enviada a aprobación.");
    replaceView("view-dashboard");
    loadDashboard();
  } catch (err) {
    toast("Error: " + (err.message || "no se pudo guardar."));
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar a aprobación";
  }
}

// ------------------------------------------------------------
// Detalle / aprobación
// ------------------------------------------------------------
async function openDetalle(id, pushHistory = true) {
  const { data: r } = await db.from("rendiciones").select("*").eq("id", id).single();
  const { data: items } = await db.from("rendicion_items").select("*").eq("rendicion_id", id);

  const esAprobadorViewer = currentProfile && (currentProfile.rol === "aprobador" || currentProfile.rol === "admin");
  const puedeAprobar = esAprobadorViewer && r.estado === "Pendiente";

  const box = document.getElementById("detalle-card");
  box.innerHTML = "";

  box.appendChild(el("div", { class: "detail-header" }, [
    el("div", {}, [
      el("h2", { style: "margin:0 0 4px" }, `N° ${r.folio ?? "-"} · ${r.comentario || `${r.empresa || "Sin empresa"} / ${r.tipo_rendicion}`}`),
      el("p", { style: "margin:0;color:var(--ink-soft);font-size:0.88rem" }, `${r.empleado_nombre} · ${fmtDate(r.created_at)}`),
    ]),
    el("span", { class: "pill " + r.estado, style: "font-size:0.8rem" }, r.estado),
  ]));

  const puedeEditarItems = r.estado === "Pendiente" && (esAprobadorViewer || r.empleado_id === currentUser.id);

  const columnas = ["Tipo", "Proveedor / Categoría", "RUT", "Documento", "Fecha Venc."];
  if (esAprobadorViewer) columnas.push("Cuenta Contable");
  columnas.push("Centro de Costo", "Descripción", "Monto", "Acciones");

  const tabla = el("table", { class: "items-table" });
  const thead = el("thead", {}, [el("tr", {}, columnas.map((c) => el("th", {}, c)))]);
  const tbody = el("tbody");
  tabla.appendChild(thead);
  tabla.appendChild(tbody);

  (items || []).forEach((it) => {
    const esCon = it.tipo_item === "ConDocumento";

    const celdas = [
      el("td", {}, esCon ? "Documento electrónico" : "Boleta"),
      el("td", { class: "wrap" }, esCon ? (it.nombre_proveedor || "-") : (it.categoria || "-")),
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
    celdas.push(el("td", { class: "wrap" }, esCon ? "-" : (it.centro_costo || it.empresa || "-")));
    celdas.push(el("td", { class: "wrap" }, it.descripcion || "-"));
    celdas.push(el("td", { class: "monto" }, fmtCLP(it.monto)));

    const filaExtra = el("tr", { class: "item-extra-row", style: "display:none;" });
    const extraCell = el("td", { colspan: String(columnas.length) });
    filaExtra.appendChild(extraCell);

    const accionesCell = el("td", { class: "acciones-cell" });
    if (it.adjunto_url) {
      accionesCell.appendChild(el("button", { class: "btn btn-sm", type: "button", onclick: () => verComprobante(it) }, "Ver"));
    }
    if (puedeEditarItems) {
      accionesCell.appendChild(el("button", {
        class: "btn btn-sm", type: "button",
        onclick: () => {
          filaExtra.style.display = "table-row";
          iniciarEdicionItem(it, extraCell, r, esAprobadorViewer);
        },
      }, "Editar"));
    }
    // Las boletas (electrónicas o de honorarios) nunca llegan por el SII a
    // contabilidad, así que verificarlas contra "movimientos" no tiene
    // sentido: van directo como gasto aprobado. Solo las facturas
    // electrónicas se pueden verificar.
    if (esAprobadorViewer && esCon && (it.tipo_documento === "Factura Electronica" || it.tipo_documento === "Factura Exenta Electronica")) {
      accionesCell.appendChild(el("button", {
        class: "btn btn-sm", type: "button",
        onclick: () => {
          filaExtra.style.display = "table-row";
          const verifyBox = el("div", { class: "verify-box show" }, "Consultando...");
          extraCell.innerHTML = "";
          extraCell.appendChild(verifyBox);
          verificarDocumentoItem(it, verifyBox, r.empresa);
        },
      }, "Verificar"));
    }
    celdas.push(accionesCell);

    tbody.appendChild(el("tr", {}, celdas));
    tbody.appendChild(filaExtra);
  });

  box.appendChild(el("div", { class: "table-scroll" }, [tabla]));

  box.appendChild(el("div", { class: "totals-bar" }, [
    el("span", {}, "Total"),
    el("span", { class: "amount" }, fmtCLP(r.monto_total)),
  ]));

  if (r.estado === "Aprobado") {
    box.appendChild(el("p", { style: "color:var(--ink-soft);font-size:0.85rem;margin-top:10px" },
      `Aprobado por ${r.aprobador_nombre || "-"} el ${fmtDate(r.fecha_aprobacion)}`));
    box.appendChild(el("button", { class: "btn btn-secondary", onclick: () => descargarCSV(r, items) }, "Descargar comprobante para Kame"));
  }

  if (puedeAprobar) {
    const actions = el("div", { style: "display:flex;gap:10px;margin-top:16px" }, [
      el("button", { class: "btn btn-success", onclick: () => aprobarRendicion(r, items, "Aprobado") }, "Aprobar"),
      el("button", { class: "btn btn-danger", onclick: () => aprobarRendicion(r, items, "Rechazado") }, "Rechazar"),
    ]);
    box.appendChild(actions);
  }

  if (pushHistory) pushView("view-detalle", { id }); else show("view-detalle");
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

function iniciarEdicionItem(it, lineWrap, rendicion, esAprobadorViewer) {
  lineWrap.innerHTML = "";
  const campos = [];

  if (it.tipo_item === "ConDocumento") {
    const nombreProv = fieldInput("edit-nombreprov", "Nombre del proveedor", "text");
    nombreProv.querySelector("input").value = it.nombre_proveedor || "";
    const rutProv = fieldInput("edit-rut", "RUT del proveedor", "text");
    rutProv.querySelector("input").value = it.rut_proveedor || "";
    campos.push(el("div", { class: "field-row" }, [nombreProv, rutProv]));

    if (esAprobadorViewer) {
      const cuenta = fieldInput("edit-cuenta", "Cuenta contable", "text");
      const cuentaInput = cuenta.querySelector("input");
      cuentaInput.value = it.cuenta_contable || "";
      const nombreHint = el("p", { class: "ocr-status show", id: "edit-cuenta-nombre" }, nombreCuenta(cuentaInput.value));
      cuentaInput.addEventListener("input", () => { nombreHint.textContent = nombreCuenta(cuentaInput.value) || "Cuenta no reconocida"; });
      cuenta.appendChild(nombreHint);
      campos.push(el("div", { class: "field-row" }, [cuenta]));
    }
  } else {
    const catSelect = fieldSelectCategoria("edit-categoria");
    const sel = catSelect.querySelector("select");
    if ([...sel.options].some((o) => o.value === it.categoria)) sel.value = it.categoria;
    const cuenta = fieldInput("edit-cuenta", "Cuenta contable", "text");
    cuenta.querySelector("input").value = it.cuenta_contable || "";
    cuenta.querySelector("input").readOnly = true;
    sel.addEventListener("change", () => {
      const found = CATEGORIAS_GASTO.find((c) => c.nombre === sel.value);
      cuenta.querySelector("input").value = found ? found.cuenta : "";
    });
    campos.push(el("div", { class: "field-row" }, [catSelect, cuenta]));
    const opcionesCC = CENTROS_COSTO_POR_EMPRESA[it.empresa] || ["Casa Matriz"];
    if (it.centro_costo && !opcionesCC.includes(it.centro_costo)) opcionesCC.unshift(it.centro_costo);
    const cc = fieldSelect("edit-cc", "Centro de Costo (Unidad de Negocio)", opcionesCC);
    cc.querySelector("select").value = it.centro_costo || opcionesCC[0];
    campos.push(el("div", { class: "field-row" }, [cc]));
  }

  const monto = fieldInputMoney("edit-monto", "Monto");
  monto.querySelector("input").value = Number(it.monto || 0).toLocaleString("es-CL");
  const desc = fieldInput("edit-desc", "Descripción", "text");
  desc.querySelector("input").value = it.descripcion || "";
  campos.push(el("div", { class: "field-row" }, [monto, desc]));

  campos.forEach((c) => lineWrap.appendChild(c));

  const acciones = el("div", { style: "display:flex; gap:8px;" }, [
    el("button", {
      class: "btn btn-primary", type: "button",
      onclick: async () => {
        const cambios = {
          monto: parseMoneyValue(lineWrap.querySelector("#edit-monto").value),
          descripcion: lineWrap.querySelector("#edit-desc").value.trim(),
        };
        if (it.tipo_item === "ConDocumento") {
          cambios.nombre_proveedor = lineWrap.querySelector("#edit-nombreprov").value.trim();
          cambios.rut_proveedor = formatearRut(lineWrap.querySelector("#edit-rut").value.trim());
          if (esAprobadorViewer) cambios.cuenta_contable = lineWrap.querySelector("#edit-cuenta").value.trim();
        } else {
          cambios.categoria = lineWrap.querySelector("#edit-categoria").value;
          cambios.cuenta_contable = lineWrap.querySelector("#edit-cuenta").value.trim();
          cambios.centro_costo = lineWrap.querySelector("#edit-cc").value.trim();
        }

        const { error } = await db.from("rendicion_items").update(cambios).eq("id", it.id);
        if (error) { toast("No se pudo guardar: " + error.message); return; }

        // Solo se audita lo que realmente formaba parte del formulario editado
        // (p.ej. un empleado no puede tocar cuenta_contable, así que no debe
        // quedar un registro falso de "cambio" en ese campo).
        await Promise.all(
          Object.keys(cambios).map((campo) => registrarCambio(it, rendicion.id, campo, it[campo], cambios[campo]))
        );

        if (cambios.monto !== it.monto) {
          const { data: todos } = await db.from("rendicion_items").select("monto").eq("rendicion_id", rendicion.id);
          const nuevoTotal = (todos || []).reduce((s, x) => s + Number(x.monto), 0);
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

async function aprobarRendicion(rendicion, items, estado) {
  const { error } = await db
    .from("rendiciones")
    .update({
      estado,
      aprobador_id: currentUser.id,
      aprobador_nombre: currentProfile?.nombre || currentUser.email,
      fecha_aprobacion: new Date().toISOString(),
    })
    .eq("id", rendicion.id);

  if (error) { toast("Error al actualizar: " + error.message); return; }

  toast(estado === "Aprobado" ? "Rendición aprobada." : "Rendición rechazada.");
  if (estado === "Aprobado") {
    rendicion.estado = "Aprobado";
    rendicion.aprobador_nombre = currentProfile?.nombre || currentUser.email;
    rendicion.fecha_aprobacion = new Date().toISOString();
    await descargarCSV(rendicion, items);
  }
  replaceView("view-dashboard");
  loadDashboard();
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
function construirFilasCSV(rendicion, items, folioTransaccion = 1) {
  const fecha = fmtDateSlash(rendicion.created_at) || rendicion.created_at;
  const glosa = `RENDICION N° ${rendicion.folio ?? ""} ${rendicion.empleado_nombre}`.replace(/\s+/g, " ").trim();
  const rows = [];

  // "Comentario Linea" va con el mismo texto en todas las líneas de la
  // rendición (así aparece en los comprobantes reales de Kame que revisamos:
  // el mismo glosa se repite en cada línea de una misma transacción).
  (items || []).forEach((it) => {
    if (it.tipo_item === "ConDocumento") {
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

  const contra = CUENTA_CONTRAPARTIDA[rendicion.tipo_rendicion] || CUENTA_CONTRAPARTIDA.Reembolso;
  rows.push(csvRow([
    "TRASPASO", "S", folioTransaccion, fecha, glosa, contra.cuenta, 0, rendicion.monto_total,
    glosa, rendicion.rut_empleado || "", rendicion.empleado_nombre, "Otros", rendicion.folio ?? rendicion.id.slice(0, 8),
    fecha, "", "", "",
  ]));

  return rows;
}

function construirCSV(rendicion, items) {
  const rows = [CSV_HEADER, ...construirFilasCSV(rendicion, items)];
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
  const { fileName, content } = construirCSV(rendicionActualizada, items);
  // El BOM al inicio le indica a Excel que el archivo es UTF-8; sin esto,
  // Excel lo abre asumiendo ANSI/Windows-1252 y las tildes y el "°" salen
  // como caracteres extraños (ej. "NÂ°" en vez de "N°").
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
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

    const nombreCarpeta = formatearRangoFechas(desde, hasta);
    const zip = new JSZip();
    const carpetaRaiz = zip.folder(nombreCarpeta);

    Object.entries(porEmpresa).forEach(([empresa, rends]) => {
      const filas = [CSV_HEADER];
      rends.forEach((r, i) => filas.push(...construirFilasCSV(r, itemsPorRendicion[r.id] || [], i + 1)));
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
      .select("*")
      .order("folio", { ascending: true });
    if (errR) throw errR;

    const { data: items, error: errI } = await db
      .from("rendicion_items")
      .select("*, rendiciones(folio, empleado_nombre, rut_empleado, empresa)")
      .order("rendicion_id");
    if (errI) throw errI;

    const resumen = (rendiciones || []).map((r) => ({
      "Folio": r.folio ?? "",
      "Fecha": fmtDate(r.created_at),
      "Empleado": r.empleado_nombre,
      "RUT Empleado": r.rut_empleado || "",
      "Empresa": r.empresa || "",
      "Tipo": r.tipo_rendicion,
      "Comentario": r.comentario || "",
      "Monto Total": Number(r.monto_total || 0),
      "Estado": r.estado,
      "Aprobador": r.aprobador_nombre || "",
      "Fecha Aprobación": r.fecha_aprobacion ? fmtDate(r.fecha_aprobacion) : "",
    }));

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

    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `rendiciones_${fecha}.xlsx`);
    toast("Excel descargado.");
  } catch (err) {
    console.error("Error exportando a Excel:", err);
    toast("No se pudo generar el Excel: " + (err.message || ""));
  }
}
