alter table public.rendiciones add column if not exists monto_rendido numeric(12,2) not null default 0;
alter table public.rendiciones add column if not exists monto_aprobado numeric(12,2) not null default 0;
-- Correcciones de auditoría. No elimina rendiciones ni comprobantes.
-- Aplicar antes de publicar el frontend y las Edge Functions de esta versión.

alter table public.system_events add column if not exists solicitud_id uuid references public.solicitudes_fondos(id) on delete set null;
create index if not exists idx_events_solicitud on public.system_events(solicitud_id, tipo, created_at desc);

-- La cola previa solo la crea ocr-recibo después de autenticar al usuario.
drop policy if exists ocr_previos_insert_propio on public.ocr_previos;
revoke insert, update, delete on public.ocr_previos from anon, authenticated;
grant select on public.ocr_previos to authenticated;

create or replace function public.ruta_comprobante_propia(p_ruta text, p_usuario uuid)
returns boolean language sql immutable set search_path = '' as $$
  select p_ruta is null or (split_part(p_ruta, '/', 1) = p_usuario::text
    and p_ruta !~ '(^|/)(\.{1,2})?(/|$)' and position('/' in p_ruta) > 0);
$$;

-- Se ejecutan ANTES de los triggers existentes; no se relajan sus controles.
create or replace function public.validar_integridad_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; permitido text[];
begin
  if tg_op = 'UPDATE' and (new.rendicion_id is distinct from old.rendicion_id or new.id is distinct from old.id) then
    raise exception 'No se puede trasladar un ítem a otra rendición.';
  end if;
  select * into r from public.rendiciones where id = new.rendicion_id for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if (tg_op = 'INSERT' or new.adjunto_url is distinct from old.adjunto_url)
     and not public.ruta_comprobante_propia(new.adjunto_url, r.empleado_id) then
    raise exception 'El comprobante debe pertenecer al empleado de la rendición.';
  end if;
  if tg_op = 'INSERT' and r.estado <> 'Pendiente' then
    raise exception 'No se pueden agregar ítems a una rendición procesada.';
  end if;
  if tg_op = 'UPDATE' and r.estado <> 'Pendiente' then
    permitido := array['cuenta_contable','existe_en_contabilidad','comprobante_contable_encontrado',
      'ocr_reintento_estado','ocr_reintento_resultado','ocr_reintento_intentos','ocr_reintento_ultimo','ocr_lease_token','ocr_lease_hasta'];
    if (to_jsonb(new) - permitido) is distinct from (to_jsonb(old) - permitido) then
      raise exception 'La rendición ya fue procesada; no se puede modificar este gasto.';
    end if;
    if (new.cuenta_contable is distinct from old.cuenta_contable
      or new.existe_en_contabilidad is distinct from old.existe_en_contabilidad
      or new.comprobante_contable_encontrado is distinct from old.comprobante_contable_encontrado)
      and not public.is_admin_or_aprobador() then
      raise exception 'Solo un aprobador puede corregir la verificación contable.';
    end if;
  end if;
  -- La reserva OCR no puede ser alterada por llamadas directas del cliente.
  if tg_op = 'UPDATE' and auth.uid() is not null and auth.role() <> 'service_role' and (
    new.ocr_lease_token is distinct from old.ocr_lease_token or new.ocr_lease_hasta is distinct from old.ocr_lease_hasta
    or new.ocr_reintento_intentos is distinct from old.ocr_reintento_intentos
    or new.ocr_reintento_resultado is distinct from old.ocr_reintento_resultado
    or new.ocr_reintento_estado is distinct from old.ocr_reintento_estado) then
    raise exception 'Solo el procesador OCR puede actualizar su resultado.';
  end if;
  return new;
end;
$$;

create or replace function public.validar_integridad_cabecera()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.solicitudes_fondos; v_total numeric; v_aprobados integer;
begin
  if tg_op = 'UPDATE' and (new.empleado_id is distinct from old.empleado_id or new.id is distinct from old.id) then
    raise exception 'No se puede cambiar el dueño de una rendición.';
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and (
    new.solicitud_fondo_id is distinct from old.solicitud_fondo_id or new.tipo_rendicion is distinct from old.tipo_rendicion
    or new.empresa is distinct from old.empresa or new.estado is distinct from old.estado)) then
    if new.tipo_rendicion = 'FondoPorRendir' then
      select * into s from public.solicitudes_fondos where id = new.solicitud_fondo_id for share;
      if not found or s.empleado_id <> new.empleado_id or s.estado <> 'Aprobado' or s.empresa is distinct from new.empresa then
        raise exception 'Selecciona un fondo aprobado propio de la misma empresa.';
      end if;
    elsif new.solicitud_fondo_id is not null then
      raise exception 'Solo FondoPorRendir puede estar asociado a un fondo.';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.estado is distinct from old.estado and old.estado = 'Pendiente' then
    if auth.uid() is null or not public.is_admin_or_aprobador() or new.empleado_id = auth.uid() then
      raise exception 'Otro aprobador activo debe finalizar esta rendición.';
    end if;
    if not exists(select 1 from public.rendicion_items where rendicion_id = new.id) then
      raise exception 'No se puede finalizar una rendición vacía.';
    end if;
    if exists(select 1 from public.rendicion_items where rendicion_id = new.id and estado = 'Pendiente') then
      raise exception 'Faltan gastos por aprobar o rechazar.';
    end if;
    select coalesce(sum(monto),0),count(*) into v_total,v_aprobados
      from public.rendicion_items where rendicion_id = new.id and estado = 'Aprobado';
    new.estado := case when v_aprobados > 0 then 'Aprobado' else 'Rechazado' end;
    new.monto_total := v_total;
    new.aprobador_id := auth.uid();
    new.aprobador_nombre := (select nombre from public.profiles where id = auth.uid());
    new.fecha_aprobacion := now();
  end if;
  -- Ambos importes se derivan de los ítems; el cliente no puede falsificarlos.
  select coalesce(sum(monto),0), coalesce(sum(monto) filter(where estado='Aprobado'),0)
    into new.monto_rendido,new.monto_aprobado from public.rendicion_items where rendicion_id=new.id;
  return new;
end;
$$;

alter table public.rendicion_items add column if not exists ocr_lease_token uuid;
alter table public.rendicion_items add column if not exists ocr_lease_hasta timestamptz;
alter table public.ocr_previos add column if not exists ocr_lease_token uuid;
alter table public.ocr_previos add column if not exists ocr_lease_hasta timestamptz;
drop trigger if exists trg_00_integridad_item on public.rendicion_items;
create trigger trg_00_integridad_item before insert or update on public.rendicion_items for each row execute function public.validar_integridad_item();
drop trigger if exists trg_00_integridad_cabecera on public.rendiciones;
create trigger trg_00_integridad_cabecera before insert or update on public.rendiciones for each row execute function public.validar_integridad_cabecera();

create or replace function public.validar_dueno_solicitud()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.empleado_id is distinct from old.empleado_id or new.id is distinct from old.id then
    raise exception 'No se puede cambiar el dueño de una solicitud.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_00_dueno_solicitud on public.solicitudes_fondos;
create trigger trg_00_dueno_solicitud before update on public.solicitudes_fondos for each row execute function public.validar_dueno_solicitud();

-- Todos los cambios de negocio se auditan dentro de la transacción del gasto.
drop policy if exists historial_insert on public.rendicion_items_historial;
revoke insert, update, delete on public.rendicion_items_historial from anon, authenticated;
create or replace function public.auditar_cambio_estado_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare campo text; campos text[] := array['estado','motivo_rechazo','monto','descripcion','nombre_proveedor',
  'rut_proveedor','tipo_documento','nro_documento','fecha_vencimiento','cuenta_contable','centro_costo','categoria',
  'tipo_item','empresa','adjunto_url','existe_en_contabilidad','comprobante_contable_encontrado'];
begin
  if auth.uid() is null then return new; end if;
  foreach campo in array campos loop
    if to_jsonb(new)->campo is distinct from to_jsonb(old)->campo then
      insert into public.rendicion_items_historial(item_id,rendicion_id,usuario_id,usuario_nombre,campo,valor_anterior,valor_nuevo)
      values(new.id,new.rendicion_id,auth.uid(),(select nombre from public.profiles where id=auth.uid()),campo,to_jsonb(old)->>campo,to_jsonb(new)->>campo);
    end if;
  end loop;
  return new;
end;
$$;

create or replace function public.recalcular_total_pendiente()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.monto is not distinct from old.monto and new.estado is not distinct from old.estado then return new; end if;
  update public.rendiciones set monto_total = (select coalesce(sum(monto),0) from public.rendicion_items where rendicion_id=new.rendicion_id and estado<>'Rechazado')
    where id=new.rendicion_id and estado='Pendiente';
  return new;
end;
$$;
drop trigger if exists trg_recalcular_total on public.rendicion_items;
create trigger trg_recalcular_total after insert or update on public.rendicion_items for each row execute function public.recalcular_total_pendiente();

-- Corrige las policies desplegadas que miraban solo rol e ignoraban delegación.
drop policy if exists items_select on public.rendicion_items;
create policy items_select on public.rendicion_items for select to authenticated using (
  exists(select 1 from public.rendiciones r where r.id=rendicion_id and (r.empleado_id=auth.uid() or public.is_admin_or_aprobador())));
drop policy if exists rendiciones_select on public.rendiciones;
create policy rendiciones_select on public.rendiciones for select to authenticated using (empleado_id=auth.uid() or public.is_admin_or_aprobador());

create or replace function public.finalizar_rendicion(p_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.rendiciones; resultado jsonb;
begin
  if auth.uid() is null or not public.is_admin_or_aprobador() then raise exception 'Solo un aprobador activo puede finalizar.'; end if;
  select * into r from public.rendiciones where id=p_id for update;
  if not found or r.empleado_id=auth.uid() then raise exception 'No autorizado para finalizar esta rendición.'; end if;
  if r.estado<>'Pendiente' then raise exception 'La rendición ya fue procesada.'; end if;
  update public.rendiciones set estado='Aprobado',motivo_rechazo=(select string_agg(motivo_rechazo,' | ') from public.rendicion_items where rendicion_id=p_id and estado='Rechazado')
    where id=p_id returning * into r;
  select jsonb_build_object('rendicion',to_jsonb(r),'items',coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb)) into resultado
    from public.rendicion_items i where i.rendicion_id=p_id;
  return resultado;
end;
$$;
revoke all on function public.finalizar_rendicion(uuid) from public,anon;
grant execute on function public.finalizar_rendicion(uuid) to authenticated;

-- Comparación normalizada y con tipo; sin privilegios públicos implícitos.
create or replace function public.buscar_documento_duplicado(p_rut text,p_nro text,p_tipo text)
returns table(folio bigint,rendicion_id uuid,estado text,empleado_nombre text)
language sql security definer set search_path='' stable as $$
  select r.folio,r.id,r.estado,r.empleado_nombre from public.rendicion_items i join public.rendiciones r on r.id=i.rendicion_id
  where auth.uid() is not null and public.is_activo() and nullif(trim(p_rut),'') is not null and nullif(trim(p_nro),'') is not null
    and upper(regexp_replace(i.rut_proveedor,'[^0-9kK]','','g'))=upper(regexp_replace(p_rut,'[^0-9kK]','','g'))
    and upper(regexp_replace(trim(i.nro_documento),'^0+([0-9])','\1'))=upper(regexp_replace(trim(p_nro),'^0+([0-9])','\1'))
    and (p_tipo is null or translate(lower(trim(i.tipo_documento)),'áéíóú','aeiou')=translate(lower(trim(p_tipo)),'áéíóú','aeiou'))
    and i.estado<>'Rechazado' and r.estado<>'Rechazado' order by r.created_at desc limit 5;
$$;
create or replace function public.buscar_documento_duplicado(p_rut text,p_nro text)
returns table(folio bigint,rendicion_id uuid,estado text,empleado_nombre text)
language sql security invoker set search_path='' stable as $$ select * from public.buscar_documento_duplicado(p_rut,p_nro,null::text); $$;
revoke all on function public.buscar_documento_duplicado(text,text) from public,anon;
revoke all on function public.buscar_documento_duplicado(text,text,text) from public,anon;
grant execute on function public.buscar_documento_duplicado(text,text),public.buscar_documento_duplicado(text,text,text) to authenticated;

-- Reservas OCR atómicas; el token evita que un proceso vencido pise al nuevo.
create or replace function public.reservar_trabajos_ocr(p_usuario uuid default null,p_lote integer default 1)
returns jsonb language plpgsql security definer set search_path='' as $$
declare fila record; resultado jsonb:='[]'::jsonb; token uuid;
begin
  for fila in select o.* from public.ocr_previos o join public.profiles p on p.id=o.usuario_id
    where o.estado='pendiente' and p.activo and o.intentos<2 and (p_usuario is null or o.usuario_id=p_usuario)
      and (o.ocr_lease_hasta is null or o.ocr_lease_hasta<now())
    order by o.ultimo_intento nulls first,o.id limit least(greatest(p_lote,1),2) for update of o skip locked loop
    token:=gen_random_uuid();
    update public.ocr_previos set ocr_lease_token=token,ocr_lease_hasta=now()+interval '5 minutes' where id=fila.id;
    resultado:=resultado||jsonb_build_array(jsonb_build_object('tabla','ocr_previos','id',fila.id,'usuario_id',fila.usuario_id,'path',fila.storage_path,'intentos',fila.intentos,'parciales',fila.datos_parciales,'token',token));
  end loop;
  for fila in select i.*,r.empleado_id from public.rendicion_items i join public.rendiciones r on r.id=i.rendicion_id join public.profiles p on p.id=r.empleado_id
    where i.ocr_reintento_estado='pendiente' and r.estado='Pendiente' and p.activo and i.ocr_reintento_intentos<2 and i.adjunto_url is not null
      and (p_usuario is null or r.empleado_id=p_usuario) and (i.ocr_lease_hasta is null or i.ocr_lease_hasta<now())
    order by i.ocr_reintento_ultimo nulls first,i.id limit least(greatest(p_lote,1),2) for update of i skip locked loop
    token:=gen_random_uuid();
    update public.rendicion_items set ocr_lease_token=token,ocr_lease_hasta=now()+interval '5 minutes' where id=fila.id;
    resultado:=resultado||jsonb_build_array(jsonb_build_object('tabla','rendicion_items','id',fila.id,'usuario_id',fila.empleado_id,'path',fila.adjunto_url,'intentos',fila.ocr_reintento_intentos,'parciales',null,'token',token));
  end loop;
  return resultado;
end;
$$;
revoke all on function public.reservar_trabajos_ocr(uuid,integer) from public,anon,authenticated;
grant execute on function public.reservar_trabajos_ocr(uuid,integer) to service_role;

-- Cupo de correo independiente de los registros de observabilidad.
create table if not exists public.notificacion_cupos(id uuid primary key default gen_random_uuid(),usuario_id uuid not null references auth.users(id),operacion text not null,entidad uuid not null,created_at timestamptz not null default now());
alter table public.notificacion_cupos enable row level security;
revoke all on public.notificacion_cupos from anon,authenticated;
create index if not exists idx_cupos_usuario on public.notificacion_cupos(usuario_id,operacion,created_at);
create index if not exists idx_cupos_entidad on public.notificacion_cupos(entidad,operacion,created_at);
create or replace function public.reservar_cupo_notificacion(p_usuario uuid,p_operacion text,p_entidad uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_operacion||p_usuario::text,0));
  perform pg_advisory_xact_lock(hashtextextended(p_operacion||p_entidad::text,1));
  if (select count(*) from public.notificacion_cupos where usuario_id=p_usuario and operacion=p_operacion and created_at>now()-interval '1 hour')>=30 then return false; end if;
  if p_operacion='notificar_aprobador' and exists(select 1 from public.notificacion_cupos where entidad=p_entidad and operacion=p_operacion and created_at>now()-interval '2 minutes') then return false; end if;
  insert into public.notificacion_cupos(usuario_id,operacion,entidad) values(p_usuario,p_operacion,p_entidad);
  delete from public.notificacion_cupos where created_at<now()-interval '2 days';
  return true;
end;
$$;
revoke all on function public.reservar_cupo_notificacion(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.reservar_cupo_notificacion(uuid,text,uuid) to service_role;

-- La comprobación de referencias ocurre en SQL sobre TODO el histórico.
create or replace function public.archivos_huerfanos(p_rutas text[] default null)
returns table(path text) language sql security definer set search_path='' stable as $$
  select o.name from storage.objects o where o.bucket_id='comprobantes'
    and greatest(o.created_at,o.updated_at)<now()-interval '24 hours'
    and (p_rutas is null or o.name=any(p_rutas))
    and not exists(select 1 from public.rendicion_items i where i.adjunto_url=o.name)
    and not exists(select 1 from public.ocr_previos p where p.storage_path=o.name and (p.estado='pendiente' or p.ocr_lease_hasta>now()))
    order by o.name limit 100;
$$;
revoke all on function public.archivos_huerfanos(text[]) from public,anon,authenticated;
grant execute on function public.archivos_huerfanos(text[]) to service_role;

-- Funciones internas de triggers: sin API pública ejecutable.
revoke all on function public.validar_integridad_item(),public.validar_integridad_cabecera(),public.validar_dueno_solicitud(),public.auditar_cambio_estado_item(),public.recalcular_total_pendiente() from public,anon,authenticated;

-- Actualiza también las rendiciones históricas sin alterar su monto contable.
update public.rendiciones r set monto_total=s.vigente
from (select rendicion_id,coalesce(sum(monto) filter(where estado<>'Rechazado'),0) vigente
from public.rendicion_items group by rendicion_id) s where r.id=s.rendicion_id and r.estado='Pendiente';
update public.rendiciones r set monto_rendido=s.rendido,monto_aprobado=s.aprobado
from (select rendicion_id,coalesce(sum(monto),0) rendido,
coalesce(sum(monto) filter(where estado='Aprobado'),0) aprobado
from public.rendicion_items group by rendicion_id) s where r.id=s.rendicion_id;

-- Caché privada por usuario, versión de lector y huella exacta del archivo.
create table if not exists public.ocr_lecturas_cache (
 usuario_id uuid not null references public.profiles(id) on delete cascade,
 contenido_hash text not null check(contenido_hash ~ '^[a-f0-9]{64}$'),
 version integer not null, resultado jsonb not null,
 created_at timestamptz not null default now(), primary key(usuario_id,contenido_hash,version)
);
alter table public.ocr_lecturas_cache enable row level security;
revoke all on public.ocr_lecturas_cache from public,anon,authenticated;
grant select,insert,update,delete on public.ocr_lecturas_cache to service_role;
create index if not exists ocr_lecturas_cache_fecha_idx on public.ocr_lecturas_cache(created_at);
