-- Una persona ve las boletas de sus propias rendiciones aunque estén guardadas
-- en la carpeta de otra (por ejemplo, cuando un administrador traspasa una
-- rendición a otro empleado: el archivo queda donde se subió).
-- Subir sigue limitado a la carpeta propia.

create index if not exists rendicion_items_adjunto_url_idx
  on public.rendicion_items (adjunto_url);

create or replace function public.comprobante_de_mis_rendiciones(p_nombre text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.rendicion_items i
    join public.rendiciones r on r.id = i.rendicion_id
    where i.adjunto_url = p_nombre
      and r.empleado_id = (select auth.uid())
  );
$$;
revoke execute on function public.comprobante_de_mis_rendiciones(text) from public, anon;
grant execute on function public.comprobante_de_mis_rendiciones(text) to authenticated, service_role;

alter policy comprobantes_select_own_or_approver on storage.objects to authenticated
  using (bucket_id = 'comprobantes' and (select public.is_activo()) and
    ((storage.foldername(name))[1] = (select auth.uid())::text
     or (select public.is_admin_or_aprobador())
     or public.comprobante_de_mis_rendiciones(name)));
