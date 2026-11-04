-- Los helpers de RLS solo necesitan ser invocados por sesiones autenticadas.
revoke all on function public.is_activo(), public.is_admin(), public.is_admin_or_aprobador() from public,anon;
grant execute on function public.is_activo(), public.is_admin(), public.is_admin_or_aprobador() to authenticated,service_role;
-- Los triggers los invoca PostgreSQL; no son endpoints RPC para el navegador.
revoke all on function public.proteger_aprobacion_item(),public.proteger_aprobacion_rendicion(),public.proteger_aprobacion_solicitud(),public.proteger_plantilla_activo_profile(),public.proteger_rol_profile(),public.validar_cuenta_permitida() from public,anon,authenticated;
create index if not exists idx_historial_item on public.rendicion_items_historial(item_id);
create index if not exists idx_historial_usuario on public.rendicion_items_historial(usuario_id);
create index if not exists idx_rendiciones_aprobador on public.rendiciones(aprobador_id);
create index if not exists idx_solicitudes_aprobador on public.solicitudes_fondos(aprobador_id);
create index if not exists idx_events_rendicion on public.system_events(rendicion_id);
