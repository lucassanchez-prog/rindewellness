-- 1. Orden estable de los gastos de una rendición.
-- Hasta ahora la posición salía solo del nombre del archivo
-- ("usuario/<envío>-<posición>-..."). Al unir rendiciones, o en cualquier
-- caso sin esa ruta, el orden quedaba al azar (por id). Ahora se guarda en
-- una columna; la app ordena por ella y usa la ruta solo si falta. Las rutas
-- antiguas con marca de tiempo en vez de posición quedan sin orden (igual que hoy).
alter table public.rendicion_items add column if not exists orden integer;

alter table public.rendicion_items disable trigger user;
update public.rendicion_items
  set orden = substring(adjunto_url from '^[^/]+/[0-9a-fA-F-]{36}-([0-9]{1,4})-')::integer
  where orden is null and adjunto_url ~ '^[^/]+/[0-9a-fA-F-]{36}-[0-9]{1,4}-';
-- N° 69: unión de las N° 69 a 74 (10-11-2026), en el orden en que se enviaron.
update public.rendicion_items i set orden = v.orden
  from (values ('5fc6938c-087c-4b42-a063-28137b463cab'::uuid, 0), ('9b217150-ba4e-4762-8843-03693fbe8821', 1),
               ('c29a25a2-8eb4-4a74-bab7-43f92769d765', 2), ('1f6c8f60-965a-4996-bab3-fa4b31de3aa9', 3),
               ('45ecf72e-1d9d-4896-aea6-1c3ca3387863', 4), ('c606e78f-f23a-4954-a8b2-9ec5a9b1efec', 5),
               ('47850625-90df-4ab9-82df-ee8a332034c7', 6), ('4c64cfc1-29e5-49ee-9788-1a31594f9d60', 7)) v(id, orden)
  where i.id = v.id;
alter table public.rendicion_items enable trigger user;

create or replace function public.asignar_orden_item()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.orden is null then
    new.orden := coalesce(
      substring(new.adjunto_url from '^[^/]+/[0-9a-fA-F-]{36}-([0-9]{1,4})-')::integer,
      (select coalesce(max(i.orden) + 1, 0) from public.rendicion_items i where i.rendicion_id = new.rendicion_id));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_01_orden_item on public.rendicion_items;
create trigger trg_01_orden_item before insert on public.rendicion_items
  for each row execute function public.asignar_orden_item();

-- 2. Folio de un documento tributario: solo dígitos (hasta 10, ceros a la
-- izquierda permitidos). Un código con letras es de una boleta o ticket, que
-- va como Comprobante/Boleta; cargado como factura dejaba en Kame un abono a
-- Proveedores contra una factura inexistente (N° 72 y 74, 10-11-2026).
-- Vacío se permite: el lector OCR puede completarlo después. Si quien
-- escribe es el lector (sin sesión de usuario), el folio inválido se descarta
-- en vez de hacer fallar el reintento. Misma regla que folioDocumentoValido.
create or replace function public.validar_folio_documento()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.tipo_item = 'ConDocumento' and nullif(btrim(coalesce(new.nro_documento, '')), '') is not null
     and btrim(new.nro_documento) !~ '^0*[1-9][0-9]{0,9}$' then
    if auth.uid() is null then
      new.nro_documento := null;
    else
      raise exception 'El N° de documento debe tener solo números (como el folio de una factura). Si es una boleta o un ticket con letras, cárgalo como Comprobante/Boleta.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_01_folio_documento on public.rendicion_items;
create trigger trg_01_folio_documento before insert or update of nro_documento, tipo_item, tipo_documento on public.rendicion_items
  for each row execute function public.validar_folio_documento();

revoke execute on function public.asignar_orden_item() from public, anon, authenticated;
revoke execute on function public.validar_folio_documento() from public, anon, authenticated;
