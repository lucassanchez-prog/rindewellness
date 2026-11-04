// Edge Function: limpiar-storage-huerfano
// Borra archivos del bucket "comprobantes" que ya no están referenciados
// por ningún rendicion_items.adjunto_url -- pasa cuando se sube un
// comprobante pero después falla el insert de la fila del ítem (ej. el
// navegador se cierra o se corta la conexión justo entre la subida y el
// insert), dejando el archivo huérfano ocupando espacio para siempre, sin
// que nadie lo note ni lo borre.
//
// Se dispara A MANO desde el botón "Limpiar archivos huérfanos" en el
// panel de Usuarios (solo admin, ver app.js) -- mismo motivo que
// recordatorios-pendientes para no dejarlo programado con pg_cron: una
// tarea automática mal configurada falla en silencio sin forma de
// comprobarlo desde acá.
//
// Es deliberadamente conservador: solo borra archivos con más de 24 horas
// de antigüedad (storage.objects.created_at), para no arriesgarse a
// borrar un archivo recién subido por alguien que todavía no terminó de
// guardar su rendición (ver submitRendicion en app.js: primero sube todos
// los archivos, recién después inserta las filas -- hay una ventana real,
// aunque corta, donde un archivo válido existe sin su fila todavía).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent } from "../_shared/logging.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HORAS_MINIMAS = 24;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function requireAdmin(req: Request, admin: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error("No autenticado.");
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: userRes, error: userErr } = await anon.auth.getUser(jwt);
  if (userErr || !userRes?.user) throw new Error("Sesión inválida o expirada.");
  const { data: profile, error: profileErr } = await admin.from("profiles").select("id, rol, activo").eq("id", userRes.user.id).maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile || profile.activo === false || profile.rol !== "admin") throw new Error("Solo un admin puede limpiar archivos huérfanos.");
  return profile;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let callerId: string | null = null;
  try {
    const caller = await requireAdmin(req, admin);
    callerId = caller.id;

    let borrados = 0;
    // Lotes acotados: cada llamada comprueba las referencias en la base completa.
    for (let lote = 0; lote < 10; lote++) {
      const { data: candidatos, error } = await admin.rpc("archivos_huerfanos");
      if (error) throw error;
      if (!candidatos?.length) break;
      const rutas = candidatos.map((fila: { path: string }) => fila.path);
      // Revalidar inmediatamente antes de eliminar, también ante nuevas referencias.
      const { data: confirmados, error: errConfirmar } = await admin.rpc("archivos_huerfanos", { p_rutas: rutas });
      if (errConfirmar) throw errConfirmar;
      const seguros = (confirmados || []).map((fila: { path: string }) => fila.path);
      if (!seguros.length) break;
      const { error: errBorrar } = await admin.storage.from("comprobantes").remove(seguros);
      if (errBorrar) throw errBorrar;
      borrados += seguros.length;
    }

    await logEvent(admin, "limpieza_storage_ok", { usuarioId: callerId, metadata: { borrados: borrados, filas_ocr_previos: 0 } });
    return new Response(JSON.stringify({ ok: true, borrados, filas_ocr_previos: 0, nota: "Se revisaron hasta 1000 archivos por ejecución; puedes repetir la limpieza si quedan más." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensaje = String(err instanceof Error ? err.message : err);
    await logEvent(admin, "limpieza_storage_fail", { usuarioId: callerId, detalle: mensaje });
    return new Response(JSON.stringify({ error: mensaje }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
