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
    if (!profile || profile.activo === false) return false;
    if (profile.rol === "aprobador" || profile.rol === "admin") return true;
    if (!profile.delegado_activo) return false;
    if (!profile.delegado_hasta) return true;
    return new Date(profile.delegado_hasta).getTime() > Date.now();
  }

  function claveDocumento(item) {
    const rut = String(item.rut_proveedor || "").replace(/[^0-9kK]/g, "").toUpperCase();
    const tipo = String(item.tipo_documento || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const folio = String(item.nro_documento || "").trim().toUpperCase().replace(/^0+(?=\d)/, "");
    return rut && tipo && folio ? JSON.stringify([rut, tipo, folio]) : null;
  }

  function documentosDuplicados(items) {
    const grupos = new Map();
    items.forEach((item, indice) => {
      const clave = claveDocumento(item);
      if (!clave) return;
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(indice);
    });
    return [...grupos.values()].filter((indices) => indices.length > 1);
  }

  function campoCSV(valor) {
    const texto = valor === null || valor === undefined ? "" : String(valor);
    return /[,;"\r\n]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
  }

  function campoCSVSeguro(valor) {
    // Los textos del reporte general no deben ejecutarse como fórmulas al abrir Excel.
    const protegido=typeof valor === "string" && /^[\s]*[=+@\-\t\r]/.test(valor) ? "'"+valor : valor;
    return campoCSV(protegido);
  }

  function resumenRendicion(items) {
    const resumen = { rendido: 0, aprobado: 0, rechazado: 0, pendiente: 0, total: items.length, aprobados: 0, rechazados: 0, pendientes: 0 };
    items.forEach((item) => {
      const monto = Number(item.monto || 0);
      resumen.rendido += monto;
      if (item.estado === "Aprobado") { resumen.aprobado += monto; resumen.aprobados++; }
      else if (item.estado === "Rechazado") { resumen.rechazado += monto; resumen.rechazados++; }
      else { resumen.pendiente += monto; resumen.pendientes++; }
    });
    return resumen;
  }

  function grupoDocumentoContable(item, items) {
    const clave=claveDocumento(item);
    const candidatos=clave ? items.filter(i => i.estado!=="Rechazado" && claveDocumento(i)===clave) : [item];
    const grupo=candidatos.length ? candidatos : [item];
    return {monto:grupo.reduce((sum,i)=>sum+Number(i.monto||0),0),miembros:grupo.map(i=>({id:i.id,monto:Number(i.monto||0),estado:i.estado})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))};
  }

  const RindeCore = { grupoDocumentoContable, formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash, parseMoneyValue, esAprobadorEfectivo, claveDocumento, documentosDuplicados, campoCSV, campoCSVSeguro, resumenRendicion };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RindeCore;
  } else {
    root.RindeCore = RindeCore;
  }
})(typeof window !== "undefined" ? window : globalThis);
