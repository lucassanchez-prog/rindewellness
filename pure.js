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

  // La entrega crea el activo por rendir: no registra gastos ni usa el saldo.
  function comprobanteEntregaFondo(solicitud, opciones = {}) {
    if (solicitud?.estado !== "Aprobado") throw new Error("Solo se puede preparar la entrega de un fondo aprobado.");
    const monto = Number(solicitud.monto_solicitado);
    if (!Number.isSafeInteger(monto) || monto <= 0) throw new Error("El monto del fondo debe ser un entero positivo en pesos.");
    if (!Number.isSafeInteger(Number(solicitud.folio)) || Number(solicitud.folio) <= 0) throw new Error("El fondo no tiene un folio válido.");
    if (!solicitud.empresa || !solicitud.empleado_nombre?.trim() || !validarRut(solicitud.rut_empleado || "")) throw new Error("Completa la empresa, el nombre y el RUT válido del empleado antes de exportar.");
    const fecha = String(opciones.fecha || ""), parsed = new Date(fecha + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== fecha) throw new Error("Indica una fecha de entrega válida.");
    const hoy = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    if (fecha > hoy) throw new Error("La fecha de entrega no puede estar en el futuro.");
    const cuenta = String(opciones.cuentaBanco || "").trim(), banco = String(opciones.nombreBanco || "").trim();
    if (!/^\d+(?:\.\d+){2,5}$/.test(cuenta) || cuenta === "1.01.11.05") throw new Error("Indica el código de la cuenta bancaria de salida en Kame, distinto de Fondo por Rendir.");
    if (!banco || banco.length > 100) throw new Error("Indica el nombre de la cuenta bancaria (máximo 100 caracteres).");
    if (opciones.entregaConfirmada !== true) throw new Error("Confirma la entrega del dinero y la revisión de duplicados antes de descargar.");
    const referencia = String(opciones.referencia || "").replace(/\s+/g," ").trim();
    if (referencia.length > 100) throw new Error("La referencia de transferencia admite hasta 100 caracteres.");
    const glosa = (`ENTREGA FONDO S-${solicitud.folio} · ${solicitud.empleado_nombre} · ${solicitud.empresa}` + (referencia ? ` · REF ${referencia}` : "")).replace(/\s+/g," ").trim();
    const fechaKame = fecha.split("-").reverse().join("/");
    const filas = [
      ["EGRESO","S",1,fechaKame,glosa,"1.01.11.05",monto,0,glosa,formatearRut(solicitud.rut_empleado),solicitud.empleado_nombre,"Otros",String(solicitud.folio),fechaKame,"","",""],
      ["EGRESO","S",1,fechaKame,glosa,cuenta,0,monto,glosa,"","","","","","","",""],
    ];
    return {filas, monto, glosa, fecha, cuentaBanco:cuenta, nombreBanco:banco, fileName:`comprobante_entrega_fondo_S-${solicitud.folio}.csv`};
  }

  // Asiento de una liquidación de fondos (ver liquidar_fondos en la base).
  // Solo compensa, sin banco: cada exceso quedó en Kame como documento en
  // 2.01.07.29 con el folio de su rendición, y cada restante en 1.01.11.05 con
  // el folio de su fondo. Se cruza lo menor de ambos (TRASPASO) y la diferencia
  // queda abierta en esos mismos documentos: si la empresa debe, Finanzas la
  // paga como cualquier reembolso; si la persona debe, se registra al
  // depositar. Se compensa por orden de folio (fondo y luego rendición).
  // Sin nada que cruzar no hay asiento (filas vacías).
  function comprobanteLiquidacionFondos(liq, detalle) {
    if (!liq || liq.anulada_en) throw new Error("La liquidación no existe o fue anulada.");
    if (!["Devolucion","Pago","Compensado"].includes(liq.resultado)) throw new Error("La liquidación tiene un resultado desconocido.");
    const nombre = String(liq.empleado_nombre || "").replace(/\s+/g," ").trim();
    if (!liq.empresa || !nombre || !validarRut(liq.rut_empleado || "")) throw new Error("Completa el nombre y el RUT válido del empleado antes de exportar.");
    const entero = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error("La liquidación tiene montos no válidos."); return n; };
    const fecha = String(liq.fecha || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error("La liquidación no tiene una fecha válida.");
    const f = fecha.split("-").reverse().join("/"), rut = formatearRut(liq.rut_empleado);
    const glosa = `LIQUIDACION FONDOS L-${liq.folio} · ${nombre} · ${liq.empresa}`.replace(/\s+/g," ").trim();
    const excesos = [], restantes = [];
    let exceso = 0, restante = 0;
    for (const d of [...(detalle || [])].sort((a,b) => Number(a.folio_fondo) - Number(b.folio_fondo))) {
      const ex = entero(d.exceso), re = entero(d.restante);
      const partes = (d.excesos || []).map(e => ({folio:e.folio, monto:entero(e.monto)})).filter(e => e.monto > 0);
      if (partes.reduce((s,e) => s + e.monto, 0) !== ex) throw new Error(`El exceso del fondo S-${d.folio_fondo} no cuadra con sus rendiciones.`);
      partes.forEach(e => excesos.push({cuenta:"2.01.07.29", folio:e.folio, fondo:d.folio_fondo, monto:e.monto}));
      if (re > 0) restantes.push({cuenta:"1.01.11.05", folio:d.folio_fondo, fondo:d.folio_fondo, monto:re});
      exceso += ex; restante += re;
    }
    if (exceso !== entero(liq.total_exceso) || restante !== entero(liq.total_restante)) throw new Error("El detalle de la liquidación no cuadra con sus totales.");
    const neto = entero(liq.monto_neto);
    if (neto !== Math.abs(restante - exceso) || (neto === 0) !== (liq.resultado === "Compensado")
      || (liq.resultado === "Devolucion" && restante <= exceso) || (liq.resultado === "Pago" && exceso <= restante)) {
      throw new Error("El resultado de la liquidación no cuadra con sus montos.");
    }
    const compensado = Math.min(exceso, restante), filas = [], pendientes = [];
    const fila = (d, debe, haber, comentario) => filas.push(["TRASPASO","S",1,f,glosa,d.cuenta,debe,haber,comentario,rut,nombre,"Otros",String(d.folio),f,"","",""]);
    const cruzar = (docs, esExceso) => {
      let falta = compensado;
      for (const d of docs) {
        const usa = Math.min(d.monto, falta); falta -= usa;
        const texto = esExceso ? `Exceso rendición N° ${d.folio} · fondo S-${d.fondo}` : `Restante fondo S-${d.fondo}`;
        if (usa > 0) fila(d, esExceso ? usa : 0, esExceso ? 0 : usa, (usa < d.monto ? "Compensa en parte " : "Compensa ") + texto.charAt(0).toLowerCase() + texto.slice(1));
        if (d.monto - usa > 0) pendientes.push({...d, monto:d.monto - usa, texto});
      }
    };
    cruzar(excesos, true); cruzar(restantes, false);
    const debe = filas.reduce((s,r) => s + r[6], 0), haber = filas.reduce((s,r) => s + r[7], 0);
    if (debe !== haber || debe !== compensado || pendientes.reduce((s,p) => s + p.monto, 0) !== neto) throw new Error("El asiento de la liquidación no cuadra.");
    return {filas, tipo:"TRASPASO", glosa, total:debe, compensado, pendientes, fileName:`comprobante_liquidacion_L-${liq.folio}.csv`};
  }

  // Línea de comprobante Kame invertida (Debe <-> Haber), con la fecha del
  // reverso y "REVERSO" en el comentario. Columnas: 3 Fecha, 4 Comentario,
  // 6 Debe, 7 Haber, 8 Comentario Línea (ver CSV_HEADER en app.js).
  function invertirFilaKame(campos, fecha) {
    const f = [...campos];
    if (f.length < 9) throw new Error("Línea de comprobante incompleta.");
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(fecha || ""))) throw new Error("Fecha del reverso no válida.");
    [f[6], f[7]] = [f[7], f[6]];
    f[3] = fecha;
    f[4] = ("REVERSO " + String(f[4] || "")).trim();
    f[8] = ("REVERSO " + String(f[8] || "")).trim();
    return f;
  }

  // Notas de crédito del proveedor que podrían anular una factura: en la
  // contabilidad la NC no dice a qué factura anula (N° 68, 2026-11: factura
  // 62052 por $148.550 y NC 59532 por $148.560 el mismo día). Se marcan las
  // NC del mismo proveedor y empresa, a 60 días o menos de la factura y por
  // un monto casi igual (2 % o $1.000). "movimientos" son filas de la tabla
  // de contabilidad (documento, concepto, debe, haber, fecha, comprobante).
  function notasCreditoCercanas(movimientos, factura) {
    const monto = Number(factura?.monto), fecha = Date.parse(factura?.fecha || "");
    if (!Number.isFinite(monto) || monto <= 0) return [];
    const tolerancia = Math.max(1000, Math.round(monto * 0.02));
    const vistas = new Map();
    for (const m of movimientos || []) {
      const texto = String(m?.documento || "") + " " + String(m?.concepto || "");
      const nc = /Nota de Cr[eé]dito[^#]*#\s*(\d+)/i.exec(texto);
      if (!nc) continue;
      const importe = Math.max(Number(m.debe) || 0, Number(m.haber) || 0);
      if (Math.abs(importe - monto) > tolerancia) continue;
      const cuando = Date.parse(m.fecha || "");
      if (Number.isFinite(fecha) && Number.isFinite(cuando) && Math.abs(cuando - fecha) > 60 * 86400000) continue;
      if (!vistas.has(nc[1])) vistas.set(nc[1], { folio: nc[1], monto: importe, fecha: m.fecha || null, comprobante: m.comprobante || null });
    }
    return [...vistas.values()];
  }

  // Orden en que se cargaron los gastos al enviar la rendición. La tabla no tiene
  // columna de orden (el id es aleatorio), pero la posición viaja en la ruta del
  // comprobante: "usuario/<envío>-<posición>-..." (ver prepararAdjuntos). Sin esto
  // Postgres devuelve las filas en cualquier orden, y un ítem recién editado saltaba
  // al primer lugar. Ordena en el lugar, como Array.sort, y devuelve el mismo arreglo.
  function posicionItem(item) {
    const m = /^[^/]+\/[0-9a-f-]{36}-(\d+)-/i.exec(String(item?.adjunto_url || ""));
    return m ? Number(m[1]) : Infinity;
  }
  // Desde 2026-11-10 cada gasto guarda su posición en la columna "orden" (la
  // llena la base al insertar). Los gastos sin orden siguen usando la ruta.
  function ordenItem(item) {
    return item?.orden == null || item.orden === "" ? posicionItem(item) : Number(item.orden);
  }
  function ordenarItemsRendicion(items) {
    return items.sort((a, b) => (ordenItem(a) - ordenItem(b)) || String(a.id).localeCompare(String(b.id)));
  }

  // Folio de una factura, factura exenta o boleta de honorarios: el SII los
  // numera solo con dígitos (hasta 10). Un código con letras, como el de un
  // ticket o una boleta de supermercado, no es un documento tributario: va
  // como Comprobante/Boleta. Vacío se permite (el lector puede completarlo).
  // Misma regla que validar_folio_documento en la base.
  function folioDocumentoValido(nro) {
    const v = String(nro ?? "").trim();
    return v === "" || /^0*[1-9]\d{0,9}$/.test(v);
  }

  // Multifondo: una rendición puede rendirse contra varios fondos. Todos menos
  // el último tienen un tope (monto) y el último recibe el resto. Mismo cálculo
  // que la vista rendiciones_por_fondo de la base: se llenan en orden y, si el
  // total baja (un gasto rechazado), los últimos quedan con menos o en cero.
  function repartirEntreFondos(total, fondos) {
    let antes = 0;
    return (fondos || []).map((fondo, i, lista) => {
      const resto = Math.max(0, Number(total || 0) - antes);
      const parte = i === lista.length - 1 ? resto : Math.min(Number(fondo.monto || 0), resto);
      antes += Number(fondo.monto || 0);
      return { ...fondo, parte };
    });
  }

  // Mismas reglas que validar_fondos_rendicion() en la base, para avisar antes
  // de enviar. Devuelve el mensaje de error o null si la lista sirve.
  function validarFondosRendicion(fondos, total) {
    const lista = fondos || [];
    if (!lista.length || lista.length > 10) return "Asocia entre 1 y 10 fondos.";
    if (lista.some((f) => !f.id)) return lista.length > 1 ? "Falta elegir uno de los fondos." : "Selecciona el fondo (solicitud aprobada) que estás rindiendo.";
    if (new Set(lista.map((f) => f.id)).size !== lista.length) return "El mismo fondo aparece dos veces.";
    if (lista.length === 1) return null;
    const topes = lista.slice(0, -1);
    if (topes.some((f) => !Number.isSafeInteger(Number(f.monto)) || Number(f.monto) <= 0)) return "Indica cuánto se rinde de cada fondo (el último recibe el resto).";
    const suma = topes.reduce((s, f) => s + Number(f.monto), 0);
    if (suma >= Number(total || 0)) return "Los montos asignados (" + fmtCLP(suma) + ") cubren todo el total (" + fmtCLP(total) + "): al último fondo no le queda nada.";
    return null;
  }

  const RindeCore = { repartirEntreFondos, validarFondosRendicion, ordenarItemsRendicion, folioDocumentoValido, invertirFilaKame, notasCreditoCercanas,comprobanteEntregaFondo, comprobanteLiquidacionFondos, grupoDocumentoContable, formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash, parseMoneyValue, esAprobadorEfectivo, claveDocumento, documentosDuplicados, campoCSV, campoCSVSeguro, resumenRendicion };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RindeCore;
  } else {
    root.RindeCore = RindeCore;
  }
})(typeof window !== "undefined" ? window : globalThis);
