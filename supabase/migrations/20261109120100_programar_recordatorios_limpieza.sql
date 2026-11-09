-- Programa los recordatorios de pendientes y la limpieza de archivos, que hasta
-- ahora eran solo botones manuales (los recordatorios nunca se enviaron y la
-- limpieza corrió una sola vez, el 2026-09-22).
--
-- ANTES DE APLICAR:
--   1. Desplegar recordatorios-pendientes y limpiar-storage-huerfano con la
--      versión que acepta el secreto del cron, y con verify_jwt = false (el
--      secreto no es un JWT; cada función valida el acceso por su cuenta, igual
--      que ocr-reintento-pendientes).
--   2. Confirmar que no hay comprobantes que se quieran conservar sin rendición:
--      la limpieza borra los archivos sin gasto asociado con más de 24 horas
--      (al 2026-11-09, entre ellos los de las rendiciones N° 64 y 65 borradas).
--
-- Usa el mismo secreto que el bot de lectura (vault: ocr_cron_secret, que en
-- las funciones es CRON_SECRET).

select cron.unschedule(jobid) from cron.job where jobname in ('recordatorios-pendientes', 'limpiar-storage-huerfano');

-- Lunes a viernes, 09:00 de Chile en horario de verano (12:00 UTC).
select cron.schedule('recordatorios-pendientes', '0 12 * * 1-5', $$
  select net.http_post(
    url := 'https://rbmmwgndtrgdzherqxko.supabase.co/functions/v1/recordatorios-pendientes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ocr_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);

-- Domingos a las 04:00 de Chile (07:00 UTC), cuando nadie está cargando gastos.
select cron.schedule('limpiar-storage-huerfano', '0 7 * * 0', $$
  select net.http_post(
    url := 'https://rbmmwgndtrgdzherqxko.supabase.co/functions/v1/limpiar-storage-huerfano',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ocr_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
