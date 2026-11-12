-- Recorrido guiado (recorrido.js): se muestra solo la primera vez que cada
-- persona entra, en cualquier dispositivo. Antes de esto se recordaba solo en
-- el navegador, y en otro teléfono o computador volvía a aparecer.
alter table public.profiles add column if not exists recorrido_visto_en timestamptz;

-- Cada persona marca solo su propio perfil y solo esta columna (la primera
-- fecha se conserva). No pasa por las protecciones de rol, plantilla o activo
-- porque no cambia ninguno de esos campos.
create or replace function public.marcar_recorrido_visto()
returns timestamptz language sql security definer set search_path = '' as $$
  update public.profiles set recorrido_visto_en = coalesce(recorrido_visto_en, now())
   where id = auth.uid()
  returning recorrido_visto_en;
$$;
revoke execute on function public.marcar_recorrido_visto() from public, anon;
grant execute on function public.marcar_recorrido_visto() to authenticated;
