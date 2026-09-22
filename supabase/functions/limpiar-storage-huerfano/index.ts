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

    // Todas las rutas referenciadas hoy (nunca son demasiadas como para
    // que esto sea un problema de memoria -- una por ítem con comprobante).
    const { data: items, error: errItems } = await admin.from("rendicion_items").select("adjunto_url").not("adjunto_url", "is", null);
    if (errItems) throw errItems;
    const referenciados = new Set((items || []).map((i) => i.adjunto_url));

    // OJO: ocr_previos (la cola de OCR de antes de enviar la rendición, ver
    // migracion_ocr_previo.sql) también apunta a archivos de este bucket, y
    // esta función no la conocía -- tal como estaba, habría borrado
    // comprobantes que el agente todavía tenía pendientes de leer. Los
    // 'pendiente' se protegen; los ya resueltos ('listo'/'agotado') sí son
    // descartables: su resultado quedó guardado en la propia fila, el
    // archivo ya no hace falta.
    const { data: previos, error: errPrevios } = await admin.from("ocr_previos").select("id, storage_path, estado, created_at");
    if (errPrevios) throw errPrevios;
    (previos || []).forEach((p) => {
      if (p.estado === "pendiente") referenciados.add(p.storage_path);
    });

    // Storage no tiene un "listar todo el bucket" plano -- hay que recorrer
    // carpeta por carpeta (una por usuario, ver el path "userId/..." en
    // submitRendicion). Se listan las carpetas de primer nivel y después
    // cada una.
    const { data: carpetas, error: errCarpetas } = await admin.storage.from("comprobantes").list("", { limit: 1000 });
    if (errCarpetas) throw errCarpetas;

    const limiteFecha = Date.now() - HORAS_MINIMAS * 60 * 60 * 1000;
    const huerfanos: string[] = [];
    for (const carpeta of carpetas || []) {
      if (!carpeta.name || carpeta.id) continue; // carpeta.id existe en archivos sueltos en la raíz, se ignoran (no debería haber ninguno)
      const { data: archivos, error: errArchivos } = await admin.storage.from("comprobantes").list(carpeta.name, { limit: 1000 });
      if (errArchivos) continue;
      for (const archivo of archivos || []) {
        const path = `${carpeta.name}/${archivo.name}`;
        if (referenciados.has(path)) continue;
        const creado = archivo.created_at ? new Date(archivo.created_at).getTime() : 0;
        if (creado && creado > limiteFecha) continue; // muy reciente, podría estar a mitad de un submitRendicion en curso
        huerfanos.push(path);
      }
    }

    // Filas de ocr_previos ya resueltas y viejas: se borran junto con sus
    // archivos, si no la tabla crece para siempre con filas cuyo archivo ya
    // no existe. Las 'pendiente' no se tocan nunca, sin importar la edad --
    // el agente las sigue trabajando.
    const previosABorrar = (previos || [])
      .filter((p) => p.estado !== "pendiente")
      .filter((p) => !p.created_at || new Date(p.created_at as string).getTime() <= limiteFecha)
      .map((p) => p.id as string);

    if (!huerfanos.length && !previosABorrar.length) {
      return new Response(JSON.stringify({ ok: true, borrados: 0, nota: "No se encontraron archivos huérfanos." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (huerfanos.length) {
      const { error: errBorrar } = await admin.storage.from("comprobantes").remove(huerfanos);
      if (errBorrar) throw errBorrar;
    }
    if (previosABorrar.length) {
      await admin.from("ocr_previos").delete().in("id", previosABorrar);
    }

    await logEvent(admin, "limpieza_storage_ok", { usuarioId: callerId, metadata: { borrados: huerfanos.length, filas_ocr_previos: previosABorrar.length } });
    return new Response(JSON.stringify({ ok: true, borrados: huerfanos.length, filas_ocr_previos: previosABorrar.length }), {
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
