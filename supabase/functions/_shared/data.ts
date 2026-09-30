import type { createClient } from "https://esm.sh/@supabase/supabase-js@2";
type AdminClient = ReturnType<typeof createClient>;

// Una página chica también funciona cuando el máximo del servidor es menor
// que el solicitado. count evita confundir una respuesta truncada con el final.
export async function leerTodas(crearConsulta: () => any): Promise<any[]> {
  const filas: any[] = [];
  let total: number | null = null;
  for (;;) {
    const { data, error, count } = await crearConsulta().range(filas.length, filas.length + 99);
    if (error) throw error;
    if (!Array.isArray(data) || typeof count !== "number") throw new Error("No se pudo comprobar la lectura completa.");
    if (total !== null && total !== count) throw new Error("Los datos cambiaron durante la lectura; vuelve a intentar.");
    total = count;
    filas.push(...data);
    if (filas.length >= total) return filas;
    if (!data.length) throw new Error("La consulta quedó incompleta.");
  }
}

export async function emailsDePerfiles(admin: AdminClient, perfiles: { id: string }[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  for (const perfil of perfiles) {
    const { data, error } = await admin.auth.admin.getUserById(perfil.id);
    if (error) throw error;
    if (data?.user?.email) emails.set(perfil.id, data.user.email);
  }
  return emails;
}

export function rutaPropia(path: unknown, usuarioId: string): boolean {
  return typeof path === "string" && path.startsWith(usuarioId + "/") && !path.split("/").some((p) => p === ".." || p === "." || !p);
}
