// Helpers compartidos por las Edge Functions para dejar registro de fallos
// en public.system_events (ver migracion_mejoras_v2.sql) y aplicar un
// límite simple de frecuencia. Antes cada función solo hacía
// console.error(), que se pierde apenas termina la ejecución -- nadie se
// enteraba de un fallo real (Resend caído, cuota de Gemini agotada, etc.)
// hasta que alguien reclamara. Se usa el cliente con service role: estas
// funciones ya lo tienen a mano y así el insert no depende de RLS.

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AdminClient = ReturnType<typeof createClient>;

export async function logEvent(
  admin: AdminClient,
  tipo: string,
  opts: { usuarioId?: string | null; rendicionId?: string | null; detalle?: string; metadata?: Record<string, unknown> } = {},
) {
  try {
    await admin.from("system_events").insert({
      tipo,
      usuario_id: opts.usuarioId ?? null,
      rendicion_id: opts.rendicionId ?? null,
      detalle: opts.detalle ?? null,
      metadata: opts.metadata ?? null,
    });
  } catch (err) {
    // Si ni siquiera se puede dejar el registro del fallo, no hay más
    // remedio que loguearlo en la consola de la función -- pero nunca debe
    // interrumpir el flujo principal por esto.
    console.error("No se pudo registrar system_event:", err);
  }
}

// Cuenta cuántos eventos de un tipo dejó un usuario (o, si no hay usuario,
// una rendición/solicitud puntual) en los últimos "minutos". Se usa como
// límite de frecuencia liviano -- no es un rate limiter preciso ni
// distribuido, solo una traba barata contra un script que golpea la
// función en loop (spam de correos, cuota de Gemini).
export async function contarEventosRecientes(
  admin: AdminClient,
  tipo: string,
  opts: { usuarioId?: string | null; rendicionId?: string | null },
  minutos: number,
): Promise<number> {
  const desde = new Date(Date.now() - minutos * 60_000).toISOString();
  let query = admin.from("system_events").select("id", { count: "exact", head: true }).eq("tipo", tipo).gte("created_at", desde);
  if (opts.usuarioId) query = query.eq("usuario_id", opts.usuarioId);
  if (opts.rendicionId) query = query.eq("rendicion_id", opts.rendicionId);
  const { count, error } = await query;
  if (error) {
    console.error("No se pudo contar eventos recientes:", error);
    return 0; // si falla el chequeo, no bloqueamos la operación real por esto
  }
  return count || 0;
}
