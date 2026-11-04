-- Ejecutar dentro de BEGIN / ROLLBACK. Solo identidades y objetos sintéticos;
-- no invoca notificaciones, OCR ni servicios externos.
create temporary table auditoria_ids as select gen_random_uuid() empleado,gen_random_uuid() otro,
  gen_random_uuid() delegado,gen_random_uuid() sin_perfil,gen_random_uuid() envio,gen_random_uuid() fallido;
grant select on auditoria_ids to authenticated;
do $$
declare a uuid; t record;
begin
  select id into strict a from public.profiles where rol='admin' and activo limit 1;
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
  select * into t from auditoria_ids;
  insert into auth.users(id,email) select u,'auditoria-'||u||'@test.invalid' from unnest(array[t.empleado,t.otro,t.delegado,t.sin_perfil]) u;
  insert into public.profiles(id,nombre,rol,activo,delegado_activo,delegado_hasta) values
    (t.empleado,'Empleado sintético','empleado',true,false,null),
    (t.otro,'Otro sintético','empleado',true,false,null),
    (t.delegado,'Delegado sintético','empleado',true,true,now()+interval '1 day');
  insert into storage.objects(bucket_id,name) values ('comprobantes',t.empleado||'/auditoria-a.pdf'),('comprobantes',t.empleado||'/auditoria-b.png');
end;
$$;
set local role authenticated;
do $$
declare t record; cab jsonb; gastos jsonb; r jsonb; fallo boolean;
begin
  select * into t from auditoria_ids;
  perform set_config('request.jwt.claim.sub',t.sin_perfil::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',t.sin_perfil,'role','authenticated')::text,true);
  assert not public.is_activo(),'Sin perfil no es una cuenta activa';
  perform set_config('request.jwt.claim.sub',t.empleado::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',t.empleado,'role','authenticated')::text,true);
  cab:=jsonb_build_object('id',t.envio,'tipo_rendicion','Reembolso','empresa','Prueba','fecha_rendicion','2026-09-24','empleado_id',t.otro,'estado','Aprobado','monto_total',999999);
  gastos:=jsonb_build_array(jsonb_build_object('tipo_item','SinDocumento','monto',100,'adjunto_url',t.empleado||'/auditoria-a.pdf','estado','Aprobado','monto_verificado',true),
    jsonb_build_object('tipo_item','SinDocumento','monto',50,'adjunto_url',t.empleado||'/auditoria-b.png'));
  fallo:=false;
  begin perform public.crear_rendicion_completa(cab||jsonb_build_object('id',t.fallido),jsonb_set(gastos,'{1,fecha_vencimiento}','"fecha-inválida"'));
    exception when invalid_datetime_format then fallo:=true; end;
  assert fallo,'Último ítem inválido aborta el envío';
  assert not exists(select 1 from public.rendiciones where id=t.fallido),'No queda cabecera parcial';
  assert not exists(select 1 from public.rendicion_items where rendicion_id=t.fallido),'No queda primer ítem parcial';
  r:=public.crear_rendicion_completa(cab,gastos);
  assert not (r->>'reutilizada')::boolean and jsonb_array_length(r->'items')=2,'Envío completo';
  assert r->'rendicion'->>'empleado_id'=t.empleado::text and r->'rendicion'->>'estado'='Pendiente','Identidad y estado canónicos';
  assert r->'rendicion'->>'empleado_nombre'='Empleado sintético','Nombre sale del perfil';
  assert (r->'rendicion'->>'monto_total')::numeric=150 and (r->'rendicion'->>'monto_rendido')::numeric=150,'Total calculado por el servidor';
  assert r->'rendicion'->>'fecha_rendicion'='2026-09-24','Se conserva fecha seleccionada';
  assert not exists(select 1 from public.rendicion_items where rendicion_id=t.envio and (estado<>'Pendiente' or monto_verificado is true)),'El cliente no acredita aprobación ni verificación';
  r:=public.crear_rendicion_completa(cab,gastos);
  assert (r->>'reutilizada')::boolean,'Reintento reconocido';
  assert (select count(*) from public.rendicion_items where rendicion_id=t.envio)=2,'Reintento no duplica gastos';
  update public.profiles set rol='admin' where id=t.empleado;
  assert (select rol from public.profiles where id=t.empleado)='empleado','No elevar rol propio';
  fallo:=false;
  begin insert into public.system_events(tipo,usuario_id) values('evento_falso',t.empleado); exception when insufficient_privilege then fallo:=true; end;
  assert fallo,'No fabricar eventos';
  perform set_config('request.jwt.claim.sub',t.otro::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',t.otro,'role','authenticated')::text,true);
  assert not exists(select 1 from public.rendiciones where id=t.envio),'Empleado no lee rendición ajena';
  assert not exists(select 1 from storage.objects where bucket_id='comprobantes' and name=t.empleado||'/auditoria-a.pdf'),'Empleado no lee archivo ajeno';
  fallo:=false;
  begin perform public.crear_rendicion_completa(cab,gastos); exception when unique_violation or raise_exception then fallo:=true; end;
  assert fallo,'Empleado no reutiliza un envío ajeno';
  perform set_config('request.jwt.claim.sub',t.delegado::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',t.delegado,'role','authenticated')::text,true);
  assert public.is_admin_or_aprobador(),'Delegación efectiva';
  assert exists(select 1 from public.rendiciones where id=t.envio),'Delegado lee rendición';
  assert exists(select 1 from storage.objects where bucket_id='comprobantes' and name=t.empleado||'/auditoria-a.pdf'),'Delegado lee comprobante';
end;
$$;
reset role;
do $$
declare a uuid; t record;
begin
  select id into strict a from public.profiles where rol='admin' and activo limit 1;
  select * into t from auditoria_ids;
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
  update public.profiles set activo=false where id in (t.empleado,t.delegado);
end;
$$;
set local role authenticated;
do $$
declare t record; u uuid; fallo boolean;
begin
  select * into t from auditoria_ids;
  foreach u in array array[t.empleado,t.delegado] loop
    perform set_config('request.jwt.claim.sub',u::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
    assert not public.is_activo(),'Desactivación invalida acceso con JWT previo';
    assert not exists(select 1 from public.rendiciones where id=t.envio),'Desactivado no lee rendición';
    assert not exists(select 1 from public.rendicion_items where rendicion_id=t.envio),'Desactivado no lee gastos';
    assert not exists(select 1 from storage.objects where bucket_id='comprobantes' and name=t.empleado||'/auditoria-a.pdf'),'Desactivado no lee archivo';
    fallo:=false;
    begin insert into storage.objects(bucket_id,name) values('comprobantes',u||'/bloqueado.pdf'); exception when insufficient_privilege then fallo:=true; end;
    assert fallo,'Desactivado no sube archivos';
  end loop;
end;
$$;
reset role;
select 'Pruebas de envío atómico, idempotencia y permisos: OK' as resultado;
