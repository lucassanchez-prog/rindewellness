-- La consulta de "los últimos 30 días" (https://mindicador.cl/api/dolar) no
-- respondió en 120 s; la del año completo sí (218 valores, 2026-11-12). La
-- tarea diaria pide el año en curso: trae también los días recientes y, si un
-- valor ya estaba, no lo reescribe.
select cron.unschedule(jobid) from cron.job where jobname = 'dolar-observado-pedir';
select cron.schedule('dolar-observado-pedir', '20 13,22 * * *',
  $c$select public.pedir_dolar_observado('https://mindicador.cl/api/dolar/' || extract(year from (now() at time zone 'America/Santiago'))::int);$c$);
