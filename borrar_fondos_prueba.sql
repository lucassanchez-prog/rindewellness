-- ============================================================
-- Borrar solicitudes de fondos de prueba y reiniciar su correlativo
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query > Run
-- (proyecto RindeWellness, el de lectura/escritura)
-- ============================================================

-- 1. Si alguna rendición quedó vinculada a una solicitud de fondos, se
--    desvincula primero (no se borra la rendición, solo se le quita la
--    referencia) para poder borrar las solicitudes sin violar la relación.
update public.rendiciones set solicitud_fondo_id = null where solicitud_fondo_id is not null;

-- 2. Borra TODAS las solicitudes de fondos (de prueba). Irreversible.
delete from public.solicitudes_fondos;

-- 3. Reinicia el correlativo: la próxima solicitud que se cree va a
--    quedar como "S-1" de nuevo, en vez de seguir donde iba.
alter table public.solicitudes_fondos alter column folio restart with 1;
