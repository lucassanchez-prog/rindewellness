-- Rendir gastos en dólares (comprobantes extranjeros: Netlify, software, viajes).
-- El monto que va a Kame, al fondo y a los totales sigue siendo en pesos
-- (rendicion_items.monto). Para un gasto en USD se guarda además el monto en
-- dólares, el tipo de cambio y su fecha, y la base exige que cuadren.
-- Tipo de cambio: dólar observado del Banco Central del día del documento
-- (o el último publicado antes, si cae en fin de semana o feriado); la
-- persona lo puede corregir si su cartola muestra otro cargo.

-- 1. Dólar observado guardado en la base --------------------------------------
-- La fuente pública (mindicador.cl) tarda 15-40 s y no permite consultas desde
-- el navegador, así que la base la consulta sola en segundo plano (pg_net) y
-- la app lee de esta tabla al instante.
create table if not exists public.tipos_cambio (
  moneda text not null default 'USD' check (moneda = 'USD'),
  fecha date not null,
  valor numeric(10,2) not null check (valor between 100 and 5000),
  fuente text not null default 'Dólar observado Banco Central (mindicador.cl)',
  actualizado_en timestamptz not null default now(),
  primary key (moneda, fecha)
);
alter table public.tipos_cambio enable row level security;
drop policy if exists tipos_cambio_lectura on public.tipos_cambio;
create policy tipos_cambio_lectura on public.tipos_cambio for select to authenticated using (true);
revoke insert, update, delete on public.tipos_cambio from anon, authenticated;

create table if not exists public.tipos_cambio_solicitudes (
  request_id bigint primary key,
  url text not null,
  pedido_en timestamptz not null default now(),
  procesado_en timestamptz,
  resultado text
);
alter table public.tipos_cambio_solicitudes enable row level security;
revoke all on public.tipos_cambio_solicitudes from anon, authenticated;

-- Pide la serie a la fuente (respuesta asíncrona en net._http_response).
create or replace function public.pedir_dolar_observado(p_url text default 'https://mindicador.cl/api/dolar')
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  select net.http_get(url := p_url, timeout_milliseconds := 120000) into v_id;
  insert into public.tipos_cambio_solicitudes (request_id, url) values (v_id, p_url);
  return v_id;
end;
$$;

-- Guarda las respuestas que ya llegaron. mindicador fecha cada valor a las
-- 00:00 de Chile ("2026-11-09T03:00:00.000Z" = 9 de noviembre).
create or replace function public.guardar_dolar_observado()
returns integer language plpgsql security definer set search_path = '' as $$
declare s record; r record; n integer := 0; v_total integer := 0;
begin
  for s in select * from public.tipos_cambio_solicitudes where procesado_en is null order by request_id loop
    select * into r from net._http_response where id = s.request_id;
    if not found then
      -- Sin respuesta después de una hora: se da por perdida (la próxima corrida pide de nuevo).
      if s.pedido_en < now() - interval '1 hour' then
        update public.tipos_cambio_solicitudes set procesado_en = now(), resultado = 'sin respuesta' where request_id = s.request_id;
      end if;
      continue;
    end if;
    if r.status_code is distinct from 200 or r.content is null then
      update public.tipos_cambio_solicitudes set procesado_en = now(), resultado = 'HTTP ' || coalesce(r.status_code::text, 'sin código') || coalesce(' ' || left(r.error_msg, 120), '') where request_id = s.request_id;
      continue;
    end if;
    begin
      insert into public.tipos_cambio (moneda, fecha, valor, actualizado_en)
      select 'USD', ((e->>'fecha')::timestamptz at time zone 'America/Santiago')::date, (e->>'valor')::numeric, now()
        from jsonb_array_elements(r.content::jsonb->'serie') e
       where (e->>'valor')::numeric between 100 and 5000
      on conflict (moneda, fecha) do update set valor = excluded.valor, actualizado_en = now()
        where public.tipos_cambio.valor is distinct from excluded.valor;
      get diagnostics n = row_count;
      v_total := v_total + n;
      update public.tipos_cambio_solicitudes set procesado_en = now(), resultado = 'ok: ' || n || ' valores' where request_id = s.request_id;
    exception when others then
      update public.tipos_cambio_solicitudes set procesado_en = now(), resultado = 'error: ' || left(sqlerrm, 150) where request_id = s.request_id;
    end;
  end loop;
  delete from public.tipos_cambio_solicitudes where procesado_en < now() - interval '30 days';
  return v_total;
end;
$$;
revoke execute on function public.pedir_dolar_observado(text) from public, anon, authenticated;
revoke execute on function public.guardar_dolar_observado() from public, anon, authenticated;

-- Dólar observado para una fecha: el del día o el último publicado antes
-- (fin de semana, feriado), con un máximo de 10 días de antigüedad.
create or replace function public.dolar_observado(p_fecha date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('fecha', fecha, 'valor', valor, 'fuente', fuente)
    from public.tipos_cambio
   where moneda = 'USD' and fecha <= p_fecha and fecha >= p_fecha - 10
   order by fecha desc limit 1;
$$;
revoke execute on function public.dolar_observado(date) from public, anon;
grant execute on function public.dolar_observado(date) to authenticated;

-- Dos veces al día pide los últimos ~30 días; cada 10 minutos guarda lo que llegó.
select cron.unschedule(jobid) from cron.job where jobname in ('dolar-observado-pedir', 'dolar-observado-guardar');
select cron.schedule('dolar-observado-pedir', '20 13,22 * * *', $c$select public.pedir_dolar_observado();$c$);
select cron.schedule('dolar-observado-guardar', '*/10 * * * *', $c$select public.guardar_dolar_observado();$c$);
-- Carga inicial: el año completo (para rendir gastos de meses anteriores) y los últimos días.
select public.pedir_dolar_observado('https://mindicador.cl/api/dolar/' || extract(year from now())::int);
select public.pedir_dolar_observado();

-- 2. Gastos en dólares -------------------------------------------------------
alter table public.rendicion_items add column if not exists moneda text not null default 'CLP';
alter table public.rendicion_items add column if not exists monto_original numeric(12,2);
alter table public.rendicion_items add column if not exists tipo_cambio numeric(10,2);
alter table public.rendicion_items add column if not exists fecha_tipo_cambio date;

create or replace function public.validar_moneda_item()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.moneda := upper(coalesce(nullif(btrim(new.moneda), ''), 'CLP'));
  if new.moneda = 'CLP' then
    new.monto_original := null; new.tipo_cambio := null; new.fecha_tipo_cambio := null;
    return new;
  end if;
  if new.moneda <> 'USD' then raise exception 'Moneda no admitida: %. Usa pesos o dólares.', new.moneda; end if;
  if new.tipo_item <> 'SinDocumento' then
    raise exception 'Un gasto en dólares va como Comprobante/Boleta: una factura chilena siempre viene en pesos.';
  end if;
  if new.monto_original is null or new.monto_original <= 0 or new.monto_original > 100000 then
    raise exception 'Indica el monto en dólares del gasto.';
  end if;
  if new.tipo_cambio is null or new.tipo_cambio < 100 or new.tipo_cambio > 5000 then
    raise exception 'Indica un tipo de cambio válido (pesos por dólar).';
  end if;
  if new.fecha_tipo_cambio is null then raise exception 'Falta la fecha del tipo de cambio.'; end if;
  -- Los pesos son el monto en dólares por el tipo de cambio, redondeado al peso.
  if abs(new.monto - round(new.monto_original * new.tipo_cambio)) > 1 then
    raise exception 'El monto en pesos (%) no calza con USD % × % = %. Corrige el monto en dólares o el tipo de cambio.',
      new.monto, new.monto_original, new.tipo_cambio, round(new.monto_original * new.tipo_cambio);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_01_moneda_item on public.rendicion_items;
create trigger trg_01_moneda_item before insert or update of moneda, monto, monto_original, tipo_cambio, fecha_tipo_cambio, tipo_item
  on public.rendicion_items for each row execute function public.validar_moneda_item();
revoke execute on function public.validar_moneda_item() from public, anon, authenticated;

-- 3. El envío de la rendición guarda la moneda --------------------------------
do $$
declare d text;
begin
  d := pg_get_functiondef('public.crear_rendicion_completa(jsonb,jsonb)'::regprocedure);
  if position('monto_original' in d) = 0 then
    d := replace(d, 'adjunto_url,centro_costo,ocr_reintento_estado,ocr_origen)
    select', 'adjunto_url,centro_costo,ocr_reintento_estado,ocr_origen,moneda,monto_original,tipo_cambio,fecha_tipo_cambio)
    select');
    d := replace(d, 'case when x.ocr_reintento_estado=''pendiente'' then ''pendiente'' else null end,x.ocr_origen
    from', 'case when x.ocr_reintento_estado=''pendiente'' then ''pendiente'' else null end,x.ocr_origen,
      coalesce(nullif(x.moneda,''''),''CLP''),x.monto_original,x.tipo_cambio,x.fecha_tipo_cambio
    from');
    d := replace(d, 'adjunto_url text,centro_costo text,ocr_reintento_estado text,ocr_origen text);',
      'adjunto_url text,centro_costo text,ocr_reintento_estado text,ocr_origen text,
      moneda text,monto_original numeric,tipo_cambio numeric,fecha_tipo_cambio date);');
    if (length(d) - length(replace(d, 'monto_original', ''))) / length('monto_original') <> 3 then
      raise exception 'crear_rendicion_completa cambió; revisar la migración de moneda.';
    end if;
    execute d;
  end if;
end $$;
