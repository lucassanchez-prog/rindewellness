// Clasifica los fondos abiertos (filas de estado_fondos_abiertos()) para los
// avisos. MISMA lógica que clasificarFondos en pure.js (la usa la app); una
// prueba compara las dos con los mismos datos.
//   porRendir:   plata sin rendir, nada en revisión y sin movimiento hace
//                diasRendir días o más -> correo a la persona.
//   porLiquidar: nada en revisión y ya gastado entero o quieto hace
//                diasLiquidar días o más -> resumen a administradores,
//                agrupado por persona y empresa (así se liquida).

export interface FilaFondo {
  id: string; folio: number; empleado_id: string; empleado_nombre: string; empresa: string; motivo?: string | null;
  otorgado: number; aprobado: number; pendiente: number; sin_rendir: number; exceso: number;
  rendiciones_pendientes: number; dias_abierto: number; dias_sin_movimiento: number; ultimo_aviso_empleado?: string | null;
}

export function clasificarFondos(filas: FilaFondo[], { diasRendir = 7, diasLiquidar = 15, montoMinimo = 1000 } = {}) {
  const num = (v: unknown) => Number(v) || 0;
  const porRendir = new Map<string, { empleado_id: string; empleado_nombre: string; sin_rendir: number; fondos: FilaFondo[] }>();
  const porLiquidar = new Map<string, { empleado_id: string; empleado_nombre: string; empresa: string; otorgado: number; aprobado: number; neto: number; dias: number; fondos: FilaFondo[] }>();
  for (const f of [...filas].sort((a, b) => num(a.folio) - num(b.folio))) {
    if (num(f.rendiciones_pendientes) > 0) continue;
    // Bajo montoMinimo (vuelto de $27, redondeos) cuenta como gastado entero.
    const saldo = num(f.sin_rendir) < montoMinimo ? 0 : num(f.sin_rendir);
    if (saldo > 0 && num(f.dias_sin_movimiento) >= diasRendir) {
      const g = porRendir.get(f.empleado_id) || { empleado_id: f.empleado_id, empleado_nombre: f.empleado_nombre, sin_rendir: 0, fondos: [] };
      g.sin_rendir += saldo; g.fondos.push(f); porRendir.set(f.empleado_id, g);
    }
    if (saldo === 0 || num(f.dias_sin_movimiento) >= diasLiquidar) {
      const k = f.empleado_id + "|" + f.empresa;
      const g = porLiquidar.get(k) || { empleado_id: f.empleado_id, empleado_nombre: f.empleado_nombre, empresa: f.empresa, otorgado: 0, aprobado: 0, neto: 0, dias: 0, fondos: [] };
      g.otorgado += num(f.otorgado); g.aprobado += num(f.aprobado); g.neto = g.otorgado - g.aprobado;
      g.dias = Math.max(g.dias, num(f.dias_abierto)); g.fondos.push(f); porLiquidar.set(k, g);
    }
  }
  return {
    porRendir: [...porRendir.values()].sort((a, b) => b.sin_rendir - a.sin_rendir),
    porLiquidar: [...porLiquidar.values()].sort((a, b) => b.dias - a.dias),
  };
}
