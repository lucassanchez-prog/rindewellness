// ============================================================
// RindeWellness - módulo de borradores de rendición
// Guarda en el navegador (separado por usuario) las rendiciones que se
// empezaron y no se enviaron. Cada borrador caduca UNA SEMANA después de su
// última edición. Sin DOM ni red: recibe el "storage" y el reloj, así que se
// prueba en Node (ver tests/borradores.test.js). Se carga como script clásico
// antes de app.js, que lo toma de window.RindeBorradores.
// Los archivos adjuntos NO se guardan: un <input type=file> no se puede
// rellenar por código.
// ============================================================
(function (root) {
  "use strict";

  const DIA_MS = 24 * 60 * 60 * 1000;
  const VIGENCIA_MS = 7 * DIA_MS;
  const CLAVE = "rw-borradores:";
  const CLAVE_ANTIGUA = "rw-borrador-rendicion:"; // un solo borrador por usuario (primera versión)
  const POR_VENCER_DIAS = 2;

  const aEntero = (texto) => Number(String(texto ?? "").replace(/\D/g, "")) || 0;
  const hora = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

  function entradaValida(e) {
    return !!e && typeof e.id === "string" && e.id !== "" && hora(e.actualizado) !== null
      && !!e.datos && typeof e.datos === "object" && Array.isArray(e.datos.items);
  }

  // Milisegundos que le quedan a una entrada antes de caducar (negativo = ya caducó).
  function restanteMs(entrada, ahora, vigenciaMs = VIGENCIA_MS) {
    return hora(entrada.actualizado) + vigenciaMs - ahora;
  }

  function crearAlmacen({ storage, ahora = () => Date.now(), vigenciaMs = VIGENCIA_MS } = {}) {
    const clave = (usuarioId) => CLAVE + usuarioId;

    function leerCrudo(usuarioId) {
      try {
        const lista = JSON.parse(storage.getItem(clave(usuarioId)) || "null");
        return lista && lista.version === 2 && Array.isArray(lista.entradas) ? lista.entradas : [];
      } catch { return []; }
    }

    function escribir(usuarioId, entradas) {
      try {
        if (entradas.length) storage.setItem(clave(usuarioId), JSON.stringify({ version: 2, entradas }));
        else storage.removeItem(clave(usuarioId));
        return true;
      } catch { return false; } // sin almacenamiento (modo privado o lleno)
    }

    // La primera versión guardaba un único borrador en otra clave. Se convierte
    // en una entrada más y se borra la clave vieja, una sola vez.
    function migrarAntiguo(usuarioId) {
      let viejo = null;
      try { viejo = storage.getItem(CLAVE_ANTIGUA + usuarioId); } catch { return; }
      if (viejo === null) return;
      try {
        const b = JSON.parse(viejo);
        if (b && b.version === 1 && Array.isArray(b.items)) {
          const { version, guardado, ...datos } = b;
          const entradas = leerCrudo(usuarioId);
          entradas.push({ id: "migrado-" + (hora(guardado) ?? ahora()), creado: guardado, actualizado: hora(guardado) !== null ? guardado : new Date(ahora()).toISOString(), datos });
          escribir(usuarioId, entradas);
        }
      } catch { /* ilegible: se descarta */ }
      try { storage.removeItem(CLAVE_ANTIGUA + usuarioId); } catch { /* nada que borrar */ }
    }

    // Quita lo inválido y lo caducado, y deja el resto de más reciente a más antiguo.
    function listar(usuarioId) {
      if (!usuarioId) return [];
      migrarAntiguo(usuarioId);
      const todas = leerCrudo(usuarioId);
      const vigentes = todas.filter((e) => entradaValida(e) && restanteMs(e, ahora(), vigenciaMs) >= 0);
      if (vigentes.length !== todas.length) escribir(usuarioId, vigentes);
      return vigentes.sort((a, b) => hora(b.actualizado) - hora(a.actualizado));
    }

    return {
      vigenciaMs,
      listar,
      contar: (usuarioId) => listar(usuarioId).length,
      obtener: (usuarioId, id) => listar(usuarioId).find((e) => e.id === id) || null,
      // Crea o actualiza. Cada guardado renueva la semana de vigencia.
      guardar(usuarioId, id, datos) {
        if (!usuarioId || !id) return null;
        const entradas = listar(usuarioId);
        const marca = new Date(ahora()).toISOString();
        const previa = entradas.find((e) => e.id === id);
        const entrada = { id, creado: previa?.creado || marca, actualizado: marca, datos };
        return escribir(usuarioId, [...entradas.filter((e) => e.id !== id), entrada]) ? entrada : null;
      },
      eliminar(usuarioId, id) {
        if (!usuarioId || !id) return;
        const entradas = listar(usuarioId);
        if (entradas.some((e) => e.id === id)) escribir(usuarioId, entradas.filter((e) => e.id !== id));
      },
    };
  }

  // Lo que se muestra de un borrador en la lista.
  function describir(entrada, ahora = Date.now(), vigenciaMs = VIGENCIA_MS) {
    const datos = entrada.datos;
    const items = datos.items || [];
    const total = items.reduce((suma, it) => suma + aEntero(it.tipo === "SinDocumento" ? it.campos?.monto2 : it.campos?.monto), 0);
    const primerProveedor = items.map((it) => (it.tipo === "SinDocumento" ? it.campos?.nombreprov2 : it.campos?.nombreprov)).find((n) => n && n.trim());
    const dias = Math.max(0, Math.ceil(restanteMs(entrada, ahora, vigenciaMs) / DIA_MS));
    return {
      id: entrada.id,
      titulo: (datos.comentario || "").trim() || (primerProveedor ? primerProveedor.trim() : "Rendición sin título"),
      empresa: datos.empresa || "",
      gastos: items.length,
      total,
      actualizado: entrada.actualizado,
      diasRestantes: dias,
      porVencer: dias <= POR_VENCER_DIAS,
    };
  }

  const RindeBorradores = { VIGENCIA_MS, crearAlmacen, describir };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RindeBorradores;
  } else {
    root.RindeBorradores = RindeBorradores;
  }
})(typeof window !== "undefined" ? window : globalThis);
