-- Distribución calculada en una sola lectura y con los permisos del usuario.
create or replace function public.distribuir_fondos_csv(p_rendiciones uuid[])
returns jsonb language plpgsql security invoker set search_path='' stable as $$
declare salida jsonb; n integer;
begin
  if auth.uid() is null or not public.is_activo() then raise exception 'Se requiere un usuario activo.'; end if;
  if cardinality(p_rendiciones)>500 or cardinality(p_rendiciones)=0 then raise exception 'Selecciona entre 1 y 500 rendiciones.'; end if;
  select count(*) into n from public.rendiciones r join public.solicitudes_fondos s on s.id=r.solicitud_fondo_id
  where r.id=any(p_rendiciones) and r.estado='Aprobado' and r.tipo_rendicion='FondoPorRendir' and s.estado='Aprobado';
  if n <> (select count(distinct x) from unnest(p_rendiciones) x) then raise exception 'No se pudo comprobar el fondo de todas las rendiciones seleccionadas.'; end if;
  with fondos as (select distinct solicitud_fondo_id from public.rendiciones where id=any(p_rendiciones)),
  historial as (
    select r.id,r.monto_total,s.monto_solicitado,s.folio,
      coalesce(sum(r.monto_total) over(partition by r.solicitud_fondo_id order by r.fecha_aprobacion nulls last,r.id rows between unbounded preceding and 1 preceding),0) antes
    from public.rendiciones r join fondos f on f.solicitud_fondo_id=r.solicitud_fondo_id
    join public.solicitudes_fondos s on s.id=r.solicitud_fondo_id where r.estado='Aprobado'
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'dentroDelFondo',least(monto_total,greatest(0,monto_solicitado-antes)),
    'excedente',greatest(0,monto_total-greatest(0,monto_solicitado-antes)),'fondoFolio',folio)),'[]'::jsonb)
    into salida from historial where id=any(p_rendiciones);
  return salida;
end;
$$;
revoke all on function public.distribuir_fondos_csv(uuid[]) from public,anon;
grant execute on function public.distribuir_fondos_csv(uuid[]) to authenticated;

alter table public.rendicion_items add column if not exists verificacion_contable jsonb;
-- El guard existente sigue protegiendo los gastos cerrados; permite el nuevo
-- registro de comprobación, que tiene autorización propia en el trigger siguiente.
do $$
declare definicion text;
begin
  select pg_get_functiondef('public.validar_integridad_item()'::regprocedure) into definicion;
  if position('''verificacion_contable''' in definicion)=0 then
    definicion:=replace(definicion,'''cuenta_contable'',''existe_en_contabilidad''','''verificacion_contable'',''cuenta_contable'',''existe_en_contabilidad''');
    if position('''verificacion_contable''' in definicion)=0 then raise exception 'No se encontró el guard esperado.'; end if;
    execute definicion;
  end if;
end $$;

create or replace function public.controlar_verificacion_contable()
returns trigger language plpgsql security invoker set search_path='' as $$
declare cambio boolean;
begin
  if tg_op='INSERT' then
    new.verificacion_contable:=null;
    return new;
  end if;
  cambio := new.monto is distinct from old.monto or new.rut_proveedor is distinct from old.rut_proveedor
    or new.nro_documento is distinct from old.nro_documento or new.tipo_documento is distinct from old.tipo_documento
    or new.tipo_item is distinct from old.tipo_item or new.adjunto_url is distinct from old.adjunto_url
    or new.empresa is distinct from old.empresa or new.estado is distinct from old.estado
    or (new.cuenta_contable is distinct from old.cuenta_contable and new.verificacion_contable is not distinct from old.verificacion_contable);
  if new.verificacion_contable is distinct from old.verificacion_contable and not public.is_admin_or_aprobador() then
    raise exception 'Solo un aprobador activo puede registrar una verificación contable.';
  end if;
  if new.verificacion_contable is distinct from old.verificacion_contable and new.verificacion_contable is not null then
    if jsonb_typeof(new.verificacion_contable)<>'object' then raise exception 'Verificación contable inválida.'; end if;
    if (new.verificacion_contable->>'monto_rendido')::numeric is distinct from new.monto
      or new.verificacion_contable->>'rut_proveedor' is distinct from new.rut_proveedor
      or new.verificacion_contable->>'nro_documento' is distinct from new.nro_documento
      or new.verificacion_contable->>'tipo_documento' is distinct from new.tipo_documento then
      raise exception 'El gasto cambió durante la verificación. Actualiza y verifica nuevamente.';
    end if;
    new.verificacion_contable := new.verificacion_contable || jsonb_build_object('verificado_en',now(),'verificado_por',auth.uid());
  end if;
  -- Se ejecuta después de los guards de permisos: editar un gasto propio
  -- puede invalidar una comprobación anterior sin conceder permiso para verificar.
  if cambio then
    new.verificacion_contable:=null;
    new.existe_en_contabilidad:=null;
    new.comprobante_contable_encontrado:=null;
    new.monto_verificado:=false;
  end if;
  return new;
end;
$$;
revoke all on function public.controlar_verificacion_contable() from public,anon,authenticated;
drop trigger if exists trg_zz_verificacion_contable on public.rendicion_items;
create trigger trg_zz_verificacion_contable before insert or update on public.rendicion_items for each row execute function public.controlar_verificacion_contable();
