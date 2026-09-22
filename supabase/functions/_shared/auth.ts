// Misma regla que is_admin_or_aprobador() en la base (ver
// migracion_mejoras_v2.sql) y esAprobadorEfectivo() en pure.js: un perfil
// cuenta como aprobador si su rol es aprobador/admin, O si tiene una
// delegación temporal activa y vigente. Se duplica acá (en vez de confiar
// solo en RLS) porque estas Edge Functions corren con el service role, que
// SALTA RLS -- sin este chequeo explícito, un delegado con permiso real en
// la base quedaba igual bloqueado por un chequeo de "profile.rol" literal.
export interface PerfilConDelegacion {
  rol: string;
  delegado_activo?: boolean | null;
  delegado_hasta?: string | null;
}

export function esAprobadorEfectivo(profile: PerfilConDelegacion | null | undefined): boolean {
  if (!profile) return false;
  if (profile.rol === "aprobador" || profile.rol === "admin") return true;
  if (!profile.delegado_activo) return false;
  if (!profile.delegado_hasta) return true;
  return new Date(profile.delegado_hasta).getTime() > Date.now();
}
