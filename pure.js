// ============================================================
// RindeWellness - funciones puras (sin DOM, sin red, sin Supabase)
// Separadas de app.js para poder testearlas con Node sin necesitar un
// navegador (ver tests/pure.test.js) -- son justo las funciones donde una
// regresión silenciosa importa más (plata, RUT, fechas de comprobantes) y,
// a diferencia del resto de app.js, no dependen de nada del DOM así que
// separarlas no cambia ningún comportamiento ni orden de carga.
// Se carga como script clásico ANTES que app.js (ver index.html), que las
// toma de window.RindeCore -- no hace falta type="module" ni bundler.
// ============================================================
(function (root) {
  // Formatea un RUT chileno con puntos de miles y guión (ej. "21.315.322-6").
  function formatearRut(rut) {
    const limpio = String(rut || "").replace(/[^0-9kK]/g, "").toUpperCase();
    if (limpio.length < 2) return limpio;
    const cuerpo = limpio.slice(0, -1).replace(/^0+/, "") || "0";
    const dv = limpio.slice(-1);
    const cuerpoFormateado = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${cuerpoFormateado}-${dv}`;
  }

  // Valida el dígito verificador de un RUT chileno (algoritmo módulo 11).
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
  // alcanza con cambiar los guiones por barras.
  function fmtDateSlash(d) {
    return fmtDate(d).replace(/-/g, "/");
  }

  function parseMoneyValue(str) {
    return Number(String(str || "").replace(/\D/g, "")) || 0;
  }

  // Misma regla que is_admin_or_aprobador() en la base (ver
  // migracion_mejoras_v2.sql): un perfil cuenta como aprobador si su rol es
  // aprobador/admin, O si tiene una delegación temporal activa y vigente
  // (delegado_hasta null = indefinida). Duplicar la regla acá (en vez de
  // solo confiar en RLS) es necesario porque la UI también necesita saber
  // esto para decidir qué mostrar -- sin esto, un delegado con permiso real
  // en la base nunca vería los botones para ejercerlo.
  function esAprobadorEfectivo(profile) {
    if (!profile) return false;
    if (profile.rol === "aprobador" || profile.rol === "admin") return true;
    if (!profile.delegado_activo) return false;
    if (!profile.delegado_hasta) return true;
    return new Date(profile.delegado_hasta).getTime() > Date.now();
  }

  const RindeCore = { formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash, parseMoneyValue, esAprobadorEfectivo };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RindeCore;
  } else {
    root.RindeCore = RindeCore;
  }
})(typeof window !== "undefined" ? window : globalThis);
