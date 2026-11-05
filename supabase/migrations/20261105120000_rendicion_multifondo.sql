-- Rendir una rendición contra VARIOS fondos (multifondo).
--
-- Hasta ahora una rendición FondoPorRendir apuntaba a un solo fondo
-- (rendiciones.solicitud_fondo_id). Una factura que sirve para dos eventos
-- (ej. Día del Coach + Master class) no se podía repartir.
--
-- Modelo: rendiciones.solicitud_fondo_id sigue siendo el fondo PRINCIPAL (el
-- primero), así que todo lo que ya existe sigue funcionando igual. Si hay más
-- de un fondo, rendicion_fondos guarda la lista en orden: cada fondo menos el
-- último tiene un tope (monto) y el ÚLTIMO recibe el resto. Si el total cambia
-- (un gasto rechazado, un monto corregido), el reparto se recalcula solo:
-- se llenan los fondos en orden hasta su tope y el último absorbe la
-- diferencia. Una rendición con un solo fondo no tiene filas aquí.

create table if not exists public.rendicion_fondos (
  rendicion_id uuid not null references public.rendiciones(id) on delete cascade,
  solicitud_fondo_id uuid not null references public.solicitudes_fondos(id),
  orden smallint not null check (orden between 0 and 9),
  monto numeric(12,2) check (monto is null or (monto > 0 and monto = trunc(monto))),
  primary key (rendicion_id, solicitud_fondo_id),
  unique (rendicion_id, orden)
);
create index if not exists rendicion_fondos_fondo_idx on public.rendicion_fondos(solicitud_fondo_id);

alter table public.rendicion_fondos enable row level security;
drop policy if exists rendicion_fondos_select on public.rendicion_fondos;
-- Se ve si se puede ver la rendición (la RLS de rendiciones aplica en la subconsulta).
create policy rendicion_fondos_select on public.rendicion_fondos for select to authenticated
  using (exists (select 1 from public.rendiciones r where r.id = rendicion_fondos.rendicion_id));
-- Solo se escribe a través de las funciones de abajo.
revoke all on public.rendicion_fondos from public, anon, authenticated;
grant select on public.rendicion_fondos to authenticated;

-- Una fila por (rendición, fondo) con la PARTE de la rendición que le toca a
-- ese fondo. monto_total / monto_aprobado son esa parte, con los mismos
-- nombres que en rendiciones para que el cálculo de saldos no cambie.
create or replace view public.rendiciones_por_fondo with (security_invoker = true) as
with base as (
  select r.id, r.folio, r.estado, r.empleado_id, r.empresa, r.created_at, r.fecha_aprobacion,
    coalesce(r.monto_total, 0) as total,
    coalesce(r.monto_aprobado, case when r.estado = 'Aprobado' then r.monto_total else 0 end, 0) as aprobado,
    coalesce(f.solicitud_fondo_id, r.solicitud_fondo_id) as solicitud_fondo_id,
    coalesce(f.orden, 0) as orden,
    f.monto as tope,
    coalesce(sum(f.monto) over (partition by r.id order by f.orden rows between unbounded preceding and 1 preceding), 0) as antes,
    coalesce(f.orden, 0) = max(coalesce(f.orden, 0)) over (partition by r.id) as ultimo
  from public.rendiciones r
  left join public.rendicion_fondos f on f.rendicion_id = r.id
  where r.tipo_rendicion = 'FondoPorRendir' and r.solicitud_fondo_id is not null
)
select id, folio, estado, empleado_id, empresa, created_at, fecha_aprobacion, solicitud_fondo_id, orden, tope,
  case when ultimo then greatest(0, total - antes) else least(tope, greatest(0, total - antes)) end as monto_total,
  case when ultimo then greatest(0, aprobado - antes) else least(tope, greatest(0, aprobado - antes)) end as monto_aprobado,
  total as monto_total_rendicion
from base;

revoke all on public.rendiciones_por_fondo from public, anon;
grant select on public.rendiciones_por_fondo to authenticated;

-- Valida una lista de fondos [{id, monto}] para una rendición: entre 1 y 10,
-- sin repetir, todos aprobados, del mismo empleado y empresa; todos menos el
-- último con monto entero positivo, y que al último le quede algo.
create or replace function public.validar_fondos_rendicion(p_empleado uuid, p_empresa text, p_fondos jsonb, p_total numeric)
returns void language plpgsql stable set search_path = '' as $$
declare n integer; v_topes numeric;
begin
  if jsonb_typeof(p_fondos) is distinct from 'array' then raise exception 'Los fondos deben ser una lista.'; end if;
  n := jsonb_array_length(p_fondos);
  if n < 1 or n > 10 then raise exception 'Asocia entre 1 y 10 fondos.'; end if;
  if exists (select 1 from jsonb_array_elements(p_fondos) x where coalesce(x->>'id','') !~ '^[0-9a-fA-F-]{36}$') then
    raise exception 'Falta elegir uno de los fondos.';
  end if;
  if (select count(distinct x->>'id') from jsonb_array_elements(p_fondos) x) <> n then
    raise exception 'El mismo fondo aparece dos veces.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_fondos) with ordinality x(v, i) where i < n and (
      jsonb_typeof(v->'monto') is distinct from 'number' or (v->>'monto')::numeric <= 0
      or (v->>'monto')::numeric <> trunc((v->>'monto')::numeric))) then
    raise exception 'Indica cuánto se rinde de cada fondo (el último recibe el resto).';
  end if;
  if (select count(*) from public.solicitudes_fondos s join jsonb_array_elements(p_fondos) x on s.id = (x->>'id')::uuid
      where s.empleado_id = p_empleado and s.estado = 'Aprobado' and s.empresa is not distinct from p_empresa) <> n then
    raise exception 'Selecciona fondos aprobados propios de la misma empresa.';
  end if;
  select coalesce(sum((v->>'monto')::numeric), 0) into v_topes
    from jsonb_array_elements(p_fondos) with ordinality x(v, i) where i < n;
  if p_total is not null and n > 1 and v_topes >= p_total then
    raise exception 'Los montos asignados (%) cubren todo el total (%): al último fondo no le queda nada.', v_topes, p_total;
  end if;
end;
$$;
revoke execute on function public.validar_fondos_rendicion(uuid, text, jsonb, numeric) from public, anon, authenticated;

-- Reemplaza la lista de fondos de una rendición todavía Pendiente. Lista vacía
-- = pasa a Reembolso. Lo puede hacer el dueño o un aprobador/admin.
create or replace function public.asignar_fondos_rendicion(p_rendicion uuid, p_fondos jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.rendiciones; v_total numeric; n integer; v_folios text;
begin
  if auth.uid() is null or not public.is_activo() then raise exception 'Tu cuenta no está habilitada.'; end if;
  select * into r from public.rendiciones where id = p_rendicion for update;
  if not found then raise exception 'La rendición no existe.'; end if;
  if r.empleado_id <> auth.uid() and not public.is_admin_or_aprobador() then
    raise exception 'Solo el dueño o un aprobador pueden cambiar los fondos.';
  end if;
  if r.estado <> 'Pendiente' then raise exception 'Solo se pueden cambiar los fondos de una rendición pendiente.'; end if;
  n := coalesce(jsonb_array_length(p_fondos), 0);
  perform pg_catalog.set_config('rinde.asignando_fondos', '1', true);
  delete from public.rendicion_fondos where rendicion_id = r.id;
  if n = 0 then
    update public.rendiciones set tipo_rendicion = 'Reembolso', solicitud_fondo_id = null where id = r.id;
  else
    select coalesce(sum(monto), 0) into v_total from public.rendicion_items where rendicion_id = r.id and estado <> 'Rechazado';
    perform public.validar_fondos_rendicion(r.empleado_id, r.empresa, p_fondos, v_total);
    update public.rendiciones set tipo_rendicion = 'FondoPorRendir', solicitud_fondo_id = (p_fondos->0->>'id')::uuid where id = r.id;
    if n > 1 then
      insert into public.rendicion_fondos(rendicion_id, solicitud_fondo_id, orden, monto)
      select r.id, (v->>'id')::uuid, (i - 1)::smallint, case when i < n then (v->>'monto')::numeric end
      from jsonb_array_elements(p_fondos) with ordinality x(v, i);
    end if;
  end if;
  perform pg_catalog.set_config('rinde.asignando_fondos', '', true);
  select string_agg('S-' || s.folio, ', ' order by x.i) into v_folios
    from jsonb_array_elements(p_fondos) with ordinality x(v, i) join public.solicitudes_fondos s on s.id = (x.v->>'id')::uuid;
  insert into public.system_events (tipo, usuario_id, rendicion_id, detalle, metadata)
  values ('fondos_asignados', auth.uid(), r.id,
    'Rendición N° ' || r.folio || ': ' || coalesce('fondos ' || v_folios, 'pasa a Reembolso'),
    jsonb_build_object('fondos', coalesce(p_fondos, '[]'::jsonb)));
end;
$$;
revoke execute on function public.asignar_fondos_rendicion(uuid, jsonb) from public, anon;
grant execute on function public.asignar_fondos_rendicion(uuid, jsonb) to authenticated;

-- Si se cambia el fondo principal, el tipo o la empresa por otra vía (ej. un
-- update directo del dueño), la lista vieja deja de ser válida: se borra y la
-- rendición queda con un solo fondo, como antes.
create or replace function public.limpiar_fondos_multiples()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('rinde.asignando_fondos', true), '') <> '1' then
    delete from public.rendicion_fondos where rendicion_id = new.id;
  end if;
  return null;
end;
$$;
revoke execute on function public.limpiar_fondos_multiples() from public, anon, authenticated;
drop trigger if exists limpiar_fondos_multiples on public.rendiciones;
create trigger limpiar_fondos_multiples after update of solicitud_fondo_id, tipo_rendicion, empresa on public.rendiciones
  for each row when (new.solicitud_fondo_id is distinct from old.solicitud_fondo_id
    or new.tipo_rendicion is distinct from old.tipo_rendicion or new.empresa is distinct from old.empresa)
  execute function public.limpiar_fondos_multiples();

-- El CSV contable reparte cada rendición entre sus fondos y, dentro de cada
-- fondo, separa lo que cabe en su saldo (Fondo por Rendir) del excedente
-- (Rendiciones por Pagar), en orden de aprobación como antes.
create or replace function public.distribuir_fondos_csv(p_rendiciones uuid[])
returns jsonb language plpgsql stable set search_path = '' as $$
declare salida jsonb; n integer;
begin
  if auth.uid() is null or not public.is_activo() then raise exception 'Se requiere un usuario activo.'; end if;
  if cardinality(p_rendiciones)>500 or cardinality(p_rendiciones)=0 then raise exception 'Selecciona entre 1 y 500 rendiciones.'; end if;
  select count(*) into n from public.rendiciones r join public.solicitudes_fondos s on s.id=r.solicitud_fondo_id
  where r.id=any(p_rendiciones) and r.estado='Aprobado' and r.tipo_rendicion='FondoPorRendir' and s.estado='Aprobado';
  if n <> (select count(distinct x) from unnest(p_rendiciones) x) then raise exception 'No se pudo comprobar el fondo de todas las rendiciones seleccionadas.'; end if;
  with fondos as (select distinct solicitud_fondo_id from public.rendiciones_por_fondo where id=any(p_rendiciones)),
  porciones as (
    select v.id, v.orden, v.monto_total as porcion, s.monto_solicitado, s.folio,
      coalesce(sum(v.monto_total) over(partition by v.solicitud_fondo_id order by v.fecha_aprobacion nulls last, v.id rows between unbounded preceding and 1 preceding),0) as antes
    from public.rendiciones_por_fondo v join fondos f on f.solicitud_fondo_id=v.solicitud_fondo_id
    join public.solicitudes_fondos s on s.id=v.solicitud_fondo_id where v.estado='Aprobado'
  ),
  por_rendicion as (
    select id, sum(least(porcion, greatest(0, monto_solicitado-antes))) as dentro,
      string_agg(folio::text, ' / S-' order by orden) as folios
    from porciones where id=any(p_rendiciones) group by id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'dentroDelFondo',p.dentro,
    'excedente',greatest(0,r.monto_total-p.dentro),'fondoFolio',p.folios)),'[]'::jsonb)
    into salida from por_rendicion p join public.rendiciones r on r.id=p.id;
  return salida;
end;
$$;

-- crear_rendicion_completa acepta además p_cabecera.fondos = [{id, monto}].
-- Con un solo fondo se comporta igual que antes (solo solicitud_fondo_id).
create or replace function public.crear_rendicion_completa(p_cabecera jsonb, p_items jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v_id uuid; v_usuario uuid := auth.uid(); v_perfil public.profiles;
  v_rendicion public.rendiciones; v_items jsonb; v_count integer; v_fondos jsonb; v_principal uuid;
begin
  if v_usuario is null or not public.is_activo() then raise exception 'Tu cuenta no está habilitada.'; end if;
  v_id := (p_cabecera->>'id')::uuid;
  if v_id is null then raise exception 'Falta el identificador del envío.'; end if;
  -- Serializa dos reintentos simultáneos con el mismo identificador.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text, 0));
  select * into v_rendicion from public.rendiciones where id=v_id;
  if found then
    if v_rendicion.empleado_id <> v_usuario then raise exception 'Identificador de envío no disponible.'; end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) into v_items
      from public.rendicion_items i where rendicion_id=v_id;
    if jsonb_array_length(v_items)=0 then raise exception 'El envío anterior está incompleto. Contacta a un administrador.'; end if;
    return jsonb_build_object('rendicion',to_jsonb(v_rendicion),'items',v_items,'reutilizada',true);
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Los gastos deben ser una lista.'; end if;
  v_count := jsonb_array_length(p_items);
  if v_count < 1 or v_count > 1000 then raise exception 'Agrega entre 1 y 1000 gastos.'; end if;
  if coalesce(p_cabecera->>'tipo_rendicion','') not in ('Reembolso','FondoPorRendir')
    or nullif(btrim(p_cabecera->>'empresa'),'') is null then raise exception 'Revisa el tipo y la empresa de la rendición.'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where
    jsonb_typeof(x->'monto') is distinct from 'number' or (x->>'monto')::numeric <= 0
    or (x->>'monto')::numeric <> trunc((x->>'monto')::numeric)
    or coalesce(x->>'tipo_item','') not in ('ConDocumento','SinDocumento')
    or nullif(x->>'adjunto_url','') is null
    or not public.ruta_comprobante_propia(x->>'adjunto_url',v_usuario)
    or not exists(select 1 from storage.objects o where o.bucket_id='comprobantes' and o.name=x->>'adjunto_url'))
    then raise exception 'Revisa los montos y los comprobantes: todos los gastos deben tener un archivo subido.'; end if;
  v_principal := nullif(p_cabecera->>'solicitud_fondo_id','')::uuid;
  v_fondos := case when p_cabecera->>'tipo_rendicion'='FondoPorRendir' and jsonb_typeof(p_cabecera->'fondos')='array'
    and jsonb_array_length(p_cabecera->'fondos') > 1 then p_cabecera->'fondos' end;
  if v_fondos is not null then v_principal := (v_fondos->0->>'id')::uuid; end if;
  select * into strict v_perfil from public.profiles where id=v_usuario;
  insert into public.rendiciones(id,empleado_id,empleado_nombre,rut_empleado,tipo_rendicion,empresa,comentario,solicitud_fondo_id,fecha_rendicion)
    values(v_id,v_usuario,v_perfil.nombre,v_perfil.rut,p_cabecera->>'tipo_rendicion',p_cabecera->>'empresa',
      p_cabecera->>'comentario',v_principal,
      coalesce(nullif(p_cabecera->>'fecha_rendicion','')::date,(now() at time zone 'America/Santiago')::date));
  insert into public.rendicion_items(rendicion_id,tipo_item,monto,nombre_proveedor,rut_proveedor,tipo_documento,nro_documento,
    fecha_vencimiento,cuenta_contable,categoria,empresa,descripcion,adjunto_url,centro_costo,ocr_reintento_estado,ocr_origen)
    select v_id,x.tipo_item,x.monto,x.nombre_proveedor,x.rut_proveedor,x.tipo_documento,x.nro_documento,
      x.fecha_vencimiento,x.cuenta_contable,x.categoria,p_cabecera->>'empresa',x.descripcion,x.adjunto_url,x.centro_costo,
      case when x.ocr_reintento_estado='pendiente' then 'pendiente' else null end,x.ocr_origen
    from jsonb_to_recordset(p_items) as x(tipo_item text,monto numeric,nombre_proveedor text,rut_proveedor text,
      tipo_documento text,nro_documento text,fecha_vencimiento date,cuenta_contable text,categoria text,descripcion text,
      adjunto_url text,centro_costo text,ocr_reintento_estado text,ocr_origen text);
  -- Con varios fondos, la lista pasa por la misma función validada que usa el
  -- detalle (dueño, pendiente, fondos propios y montos); si falla, se revierte todo.
  if v_fondos is not null then perform public.asignar_fondos_rendicion(v_id, v_fondos); end if;
  -- monto_verificado solo se acreditará con evidencia del servidor, nunca por
  -- una bandera enviada por el navegador. Los triggers calculan los totales.
  select * into strict v_rendicion from public.rendiciones where id=v_id;
  select jsonb_agg(to_jsonb(i) order by i.id) into v_items from public.rendicion_items i where rendicion_id=v_id;
  return jsonb_build_object('rendicion',to_jsonb(v_rendicion),'items',v_items,'reutilizada',false);
end;
$$;
