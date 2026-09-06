// Configuración de conexión a Supabase.
// Completá estos dos valores desde:
// https://supabase.com/dashboard/project/_/settings/api
//   - Project URL           -> SUPABASE_URL
//   - anon / public key     -> SUPABASE_ANON_KEY
// La anon key es segura de dejar en el frontend: la seguridad real
// la dan las políticas RLS definidas en supabase-schema.sql.

window.RINDE_WELLNESS_CONFIG = {
  // Proyecto NUEVO: acá vive la data propia de la app (rendiciones, items, perfiles).
  // Lectura Y escritura.
  SUPABASE_URL: "https://rbmmwgndtrgdzherqxko.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_WkA9ffiooztxpI2Ieob9rw_o7fJoNJ0",

  // Proyecto de CONTABILIDAD (ya existente, tatzrjekbpbrjjvdbqoe): SOLO LECTURA.
  // La app únicamente hace SELECT sobre la tabla "movimientos" para verificar
  // si una factura/boleta ya está contabilizada. Nunca escribe acá.
  CONTABILIDAD_URL: "https://tatzrjekbpbrjjvdbqoe.supabase.co",
  CONTABILIDAD_ANON_KEY: "sb_publishable_66m9AzaCJrH2VwOKtR0e2Q_nSHgBaDX",
};
