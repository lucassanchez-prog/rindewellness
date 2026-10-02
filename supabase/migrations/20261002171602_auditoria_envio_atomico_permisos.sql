-- Auditoría 2026-10-02. No elimina ni modifica gastos históricos.
-- Los registros anteriores conservan NULL y muestran su fecha de creación.
alter table public.rendiciones add column fecha_rendicion date;
alter table public.rendiciones alter column fecha_rendicion set default ((now() at time zone 'America/Santiago')::date);
create function public.proteger_fecha_rendicion() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.estado <> 'Pendiente' and new.fecha_rendicion is distinct from old.fecha_rendicion then
    raise exception 'La fecha de una rendición procesada no puede modificarse.';
  end if;
  return new;
end;
$$;
revoke execute on function public.proteger_fecha_rendicion() from public,anon,authenticated;
create trigger trg_proteger_fecha_rendicion before update on public.rendiciones
  for each row execute function public.proteger_fecha_rendicion();
create or replace function public.is_activo()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id = (select auth.uid()) and p.activo);
$$;
revoke execute on function public.is_activo() from public, anon;
grant execute on function public.is_activo() to authenticated, service_role;

-- Un usuario desactivado no conserva acceso a documentos con un JWT anterior.
-- Los aprobadores delegados tienen el mismo acceso que en rendiciones.
alter policy comprobantes_insert_own on storage.objects to authenticated
  with check (bucket_id = 'comprobantes' and (select public.is_activo())
    and (storage.foldername(name))[1] = (select auth.uid())::text);
alter policy comprobantes_select_own_or_approver on storage.objects to authenticated
  using (bucket_id = 'comprobantes' and (select public.is_activo()) and
    ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin_or_aprobador())));

-- Los eventos del servidor no pueden fabricarse desde el navegador.
drop policy if exists system_events_insert_own on public.system_events;
revoke insert, update, delete on public.system_events from anon, authenticated;

-- Evalúa identidad/rol una vez por consulta. Conserva las reglas de propiedad.
-- profiles debe permitir leer el propio perfil desactivado para cerrar sesión,
-- y crear el perfil inicial de una cuenta nueva.
do $$
declare p record; v_using text; v_check text; v_sql text;
begin
  for p in select * from pg_policies where schemaname = 'public' loop
    v_using := p.qual; v_check := p.with_check;
    v_using := replace(replace(replace(replace(v_using,
      'auth.uid()', '(select auth.uid())'), 'is_activo()', '(select public.is_activo())'),
      'is_admin_or_aprobador()', '(select public.is_admin_or_aprobador())'), 'is_admin()', '(select public.is_admin())');
    v_check := replace(replace(replace(replace(v_check,
      'auth.uid()', '(select auth.uid())'), 'is_activo()', '(select public.is_activo())'),
      'is_admin_or_aprobador()', '(select public.is_admin_or_aprobador())'), 'is_admin()', '(select public.is_admin())');
    if p.tablename <> 'profiles' then
      if v_using is not null then v_using := '(' || v_using || ') and (select public.is_activo())'; end if;
      if v_check is not null then v_check := '(' || v_check || ') and (select public.is_activo())'; end if;
    end if;
    if p.cmd in ('UPDATE', 'ALL') and v_check is null then v_check := v_using; end if;
    v_sql := format('alter policy %I on public.%I to authenticated', p.policyname, p.tablename);
    if v_using is not null then v_sql := v_sql || ' using (' || v_using || ')'; end if;
    if v_check is not null then v_sql := v_sql || ' with check (' || v_check || ')'; end if;
    execute v_sql;
  end loop;
end;
$$;

-- Evita políticas SELECT duplicadas y hace explícito el control UPDATE.
drop policy profiles_update_admin on public.profiles;
drop policy profiles_update_own on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (((select auth.uid()) = id and (select public.is_activo())) or (select public.is_admin()))
  with check (((select auth.uid()) = id and (select public.is_activo())) or (select public.is_admin()));
do $$
declare p record;
begin
  for p in select * from pg_policies where schemaname='public' and cmd='ALL' loop
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)',p.policyname||'_insert',p.tablename,p.with_check);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)',p.policyname||'_update',p.tablename,p.qual,p.with_check);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)',p.policyname||'_delete',p.tablename,p.qual);
  end loop;
end;
$$;

-- La cabecera y todos los ítems forman una única transacción bajo las RLS
-- existentes. No se acepta dueño, estado, aprobador ni totales del cliente.
create or replace function public.crear_rendicion_completa(p_cabecera jsonb, p_items jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_usuario uuid := auth.uid(); v_perfil public.profiles;
  v_rendicion public.rendiciones; v_items jsonb; v_count integer;
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
  select * into strict v_perfil from public.profiles where id=v_usuario;
  insert into public.rendiciones(id,empleado_id,empleado_nombre,rut_empleado,tipo_rendicion,empresa,comentario,solicitud_fondo_id,fecha_rendicion)
    values(v_id,v_usuario,v_perfil.nombre,v_perfil.rut,p_cabecera->>'tipo_rendicion',p_cabecera->>'empresa',
      p_cabecera->>'comentario',nullif(p_cabecera->>'solicitud_fondo_id','')::uuid,
      coalesce(nullif(p_cabecera->>'fecha_rendicion','')::date,(now() at time zone 'America/Santiago')::date));
  insert into public.rendicion_items(rendicion_id,tipo_item,monto,nombre_proveedor,rut_proveedor,tipo_documento,nro_documento,
    fecha_vencimiento,cuenta_contable,categoria,empresa,descripcion,adjunto_url,centro_costo,ocr_reintento_estado,ocr_origen)
    select v_id,x.tipo_item,x.monto,x.nombre_proveedor,x.rut_proveedor,x.tipo_documento,x.nro_documento,
      x.fecha_vencimiento,x.cuenta_contable,x.categoria,p_cabecera->>'empresa',x.descripcion,x.adjunto_url,x.centro_costo,
      case when x.ocr_reintento_estado='pendiente' then 'pendiente' else null end,x.ocr_origen
    from jsonb_to_recordset(p_items) as x(tipo_item text,monto numeric,nombre_proveedor text,rut_proveedor text,
      tipo_documento text,nro_documento text,fecha_vencimiento date,cuenta_contable text,categoria text,descripcion text,
      adjunto_url text,centro_costo text,ocr_reintento_estado text,ocr_origen text);
  -- monto_verificado solo se acreditará con evidencia del servidor, nunca por
  -- una bandera enviada por el navegador. Los triggers calculan los totales.
  select * into strict v_rendicion from public.rendiciones where id=v_id;
  select jsonb_agg(to_jsonb(i) order by i.id) into v_items from public.rendicion_items i where rendicion_id=v_id;
  return jsonb_build_object('rendicion',to_jsonb(v_rendicion),'items',v_items,'reutilizada',false);
end;
$$;
revoke execute on function public.crear_rendicion_completa(jsonb,jsonb) from public,anon;
grant execute on function public.crear_rendicion_completa(jsonb,jsonb) to authenticated;
