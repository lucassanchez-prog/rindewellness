-- El bot de lectura corre cada 5 minutos y casi siempre no encuentra nada:
-- dejaba ~8.700 eventos vacíos al mes en system_events. El código del bot ya
-- no los registra (ocr-reintento-pendientes), pero redesplegarlo exige subir
-- todo el lector compartido; este filtro logra lo mismo sin tocarlo y sigue
-- sirviendo si alguna versión vuelve a mandarlos. La salud del cron se ve en
-- cron.job_run_details, y Salud del sistema ya ignoraba las corridas vacías.
create or replace function public.omitir_corrida_ocr_vacia()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.tipo = 'ocr_reintento_run' and coalesce((new.metadata->>'procesados')::int, 0) = 0 then
    return null;
  end if;
  return new;
end;
$$;
revoke execute on function public.omitir_corrida_ocr_vacia() from public, anon, authenticated;
drop trigger if exists omitir_corrida_ocr_vacia on public.system_events;
create trigger omitir_corrida_ocr_vacia before insert on public.system_events
  for each row when (new.tipo = 'ocr_reintento_run')
  execute function public.omitir_corrida_ocr_vacia();
