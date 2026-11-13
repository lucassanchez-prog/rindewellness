-- Avisos de fondos (revisión de procesos 2026-11-12): 17 fondos abiertos,
-- $2,8 millones sin rendir, ninguno liquidado; a una persona se le entregaron
-- fondos nuevos con 10 abiertos. Nadie recibía aviso.
--
-- estado_fondos_abiertos() es la única fuente de los tres avisos:
--   - la app, al aprobar o registrar un fondo ("tiene N abiertos, $X sin rendir");
--   - la tarjeta "Fondos por cerrar" de Inicio (administradores);
--   - recordatorios-pendientes: correo a quien tiene un fondo quieto (7 días) y
--     resumen semanal a administradores con fondos para liquidar (15 días).

-- Cuándo se avisó por última vez de cada fondo. Tabla aparte para no tocar la
-- fila del fondo aprobado, que tiene sus propias protecciones.
create table if not exists public.avisos_fondos (
  solicitud_id uuid primary key references public.solicitudes_fondos(id) on delete cascade,
  ultimo_aviso_empleado timestamptz,
  avisos_empleado integer not null default 0
);
alter table public.avisos_fondos enable row level security;
revoke all on public.avisos_fondos from anon, authenticated;

create or replace function public.estado_fondos_abiertos()
returns table (
  id uuid, folio bigint, empleado_id uuid, empleado_nombre text, empresa text, motivo text,
  otorgado numeric, aprobado numeric, pendiente numeric, sin_rendir numeric, exceso numeric,
  rendiciones_pendientes integer, dias_abierto integer, dias_sin_movimiento integer,
  ultimo_aviso_empleado timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not (coalesce(auth.role(), '') = 'service_role' or (auth.uid() is not null and public.is_activo() and public.is_admin_or_aprobador())) then
    raise exception 'Solo administradores y aprobadores ven el estado de los fondos.';
  end if;
  return query
  with consumo as (
    select v.solicitud_fondo_id,
      coalesce(sum(v.monto_total) filter (where v.estado = 'Aprobado'), 0) aprobado,
      coalesce(sum(v.monto_total) filter (where v.estado = 'Pendiente'), 0) pendiente,
      count(*) filter (where v.estado = 'Pendiente')::integer rendiciones_pendientes,
      max(v.created_at) ultima_rendicion
    from public.rendiciones_por_fondo v group by v.solicitud_fondo_id
  )
  select s.id, s.folio, s.empleado_id, s.empleado_nombre, s.empresa, s.motivo,
    s.monto_solicitado,
    coalesce(c.aprobado, 0), coalesce(c.pendiente, 0),
    greatest(s.monto_solicitado - coalesce(c.aprobado, 0) - coalesce(c.pendiente, 0), 0),
    greatest(coalesce(c.aprobado, 0) - s.monto_solicitado, 0),
    coalesce(c.rendiciones_pendientes, 0),
    floor(extract(epoch from now() - s.fecha_aprobacion) / 86400)::integer,
    floor(extract(epoch from now() - greatest(s.fecha_aprobacion, coalesce(c.ultima_rendicion, s.fecha_aprobacion))) / 86400)::integer,
    a.ultimo_aviso_empleado
  from public.solicitudes_fondos s
  left join consumo c on c.solicitud_fondo_id = s.id
  left join public.avisos_fondos a on a.solicitud_id = s.id
  where s.estado = 'Aprobado'
  order by s.empleado_nombre, s.folio;
end;
$$;
revoke execute on function public.estado_fondos_abiertos() from public, anon;
grant execute on function public.estado_fondos_abiertos() to authenticated, service_role;

-- Lo usa recordatorios-pendientes tras mandar el correo a la persona.
create or replace function public.marcar_aviso_fondos(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Solo el servidor marca avisos de fondos.'; end if;
  insert into public.avisos_fondos (solicitud_id, ultimo_aviso_empleado, avisos_empleado)
  select unnest(p_ids), now(), 1
  on conflict (solicitud_id) do update set ultimo_aviso_empleado = now(), avisos_empleado = public.avisos_fondos.avisos_empleado + 1;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.marcar_aviso_fondos(uuid[]) from public, anon, authenticated;
grant execute on function public.marcar_aviso_fondos(uuid[]) to service_role;
