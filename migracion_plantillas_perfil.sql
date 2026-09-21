-- ============================================================
-- Migración: Plantillas de perfil + desactivar usuario
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query > Run
-- (proyecto RindeWellness, el de lectura/escritura)
-- ============================================================

-- ------------------------------------------------------------
-- Plantillas de perfil (ej. "Analista", "Comercial RFA"): agrupan un set de
-- cuentas contables permitidas que se le puede asignar a varias personas a
-- la vez, en vez de configurar cuenta por cuenta a cada una desde cero.
-- Las cuentas permitidas de una persona son la UNIÓN de las de su plantilla
-- (si tiene una) + sus cuentas individuales en perfil_cuentas -- una no
-- reemplaza a la otra, se suman.
-- ------------------------------------------------------------
create table if not exists public.perfil_plantillas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.plantilla_cuentas (
  id uuid primary key default gen_random_uuid(),
  plantilla_id uuid not null references public.perfil_plantillas(id) on delete cascade,
  cuenta_cod text not null,
  cuenta_nombre text,
  unique (plantilla_id, cuenta_cod)
);

create index if not exists idx_plantilla_cuentas_plantilla on public.plantilla_cuentas(plantilla_id);

-- "on delete set null": si se borra la plantilla, la gente que la tenía
-- asignada no queda sin perfil -- simplemente vuelve a depender solo de sus
-- cuentas individuales (si tenía).
alter table public.profiles add column if not exists plantilla_id uuid references public.perfil_plantillas(id) on delete set null;
create index if not exists idx_profiles_plantilla on public.profiles(plantilla_id);

-- Desactivar en vez de eliminar: un borrado real de auth.users no se puede
-- hacer desde el frontend (requiere la Admin API con la clave secreta, que
-- nunca debe quedar expuesta en el navegador) y además rompería el
-- historial contable (rendiciones.empleado_id referencia a auth.users). Una
-- persona desactivada no puede volver a entrar (ver onLoggedIn en app.js),
-- pero todo lo que ya rindió/aprobó queda intacto.
alter table public.profiles add column if not exists activo boolean not null default true;

-- ------------------------------------------------------------
-- RLS: plantillas
-- ------------------------------------------------------------
alter table public.perfil_plantillas enable row level security;
alter table public.plantilla_cuentas enable row level security;

drop policy if exists "plantillas_select" on public.perfil_plantillas;
drop policy if exists "plantillas_admin_write" on public.perfil_plantillas;
drop policy if exists "plantilla_cuentas_select" on public.plantilla_cuentas;
drop policy if exists "plantilla_cuentas_admin_write" on public.plantilla_cuentas;

-- Cualquier autenticado puede leer las plantillas -- las necesita para ver
-- el nombre de la propia y para que cargarCuentasPermitidas() en app.js
-- pueda armar el set de cuentas que le corresponden. Solo el admin las
-- crea/edita/borra.
create policy "plantillas_select" on public.perfil_plantillas
  for select using (auth.uid() is not null);

create policy "plantillas_admin_write" on public.perfil_plantillas
  for all using (public.is_admin()) with check (public.is_admin());

create policy "plantilla_cuentas_select" on public.plantilla_cuentas
  for select using (auth.uid() is not null);

create policy "plantilla_cuentas_admin_write" on public.plantilla_cuentas
  for all using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- validar_cuenta_permitida: además de perfil_cuentas (individual), ahora
-- también cuentan las cuentas de la plantilla asignada al perfil --
-- "plantilla + extras", no "una u otra".
-- ------------------------------------------------------------
create or replace function public.validar_cuenta_permitida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  es_propio boolean;
  tiene_restricciones boolean;
  cuenta_permitida boolean;
begin
  if new.tipo_item <> 'SinDocumento' or new.cuenta_contable is null or new.cuenta_contable = '' then
    return new;
  end if;

  select exists (
    select 1 from public.rendiciones r
    where r.id = new.rendicion_id and r.empleado_id = auth.uid()
  ) into es_propio;

  if not es_propio then
    return new;
  end if;

  select exists (
    select 1 from public.perfil_cuentas where profile_id = auth.uid()
    union all
    select 1 from public.profiles p
      join public.plantilla_cuentas pc on pc.plantilla_id = p.plantilla_id
    where p.id = auth.uid()
  ) into tiene_restricciones;

  if not tiene_restricciones then
    return new;
  end if;

  select exists (
    select 1 from public.perfil_cuentas
    where profile_id = auth.uid() and cuenta_cod = new.cuenta_contable
    union all
    select 1 from public.profiles p
      join public.plantilla_cuentas pc on pc.plantilla_id = p.plantilla_id
    where p.id = auth.uid() and pc.cuenta_cod = new.cuenta_contable
  ) into cuenta_permitida;

  if not cuenta_permitida then
    raise exception 'La cuenta % no está habilitada para tu perfil.', new.cuenta_contable;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- Protege plantilla_id/activo igual que ya se protegía "rol" (ver
-- proteger_rol_profile en migracion_seguridad_rls.sql): sin esto, cualquier
-- usuario autenticado podría auto-asignarse una plantilla con más cuentas o
-- reactivarse a sí mismo con un UPDATE directo a la API REST, sin pasar por
-- la UI. Solo un admin puede cambiar estos dos campos.
-- ------------------------------------------------------------
create or replace function public.proteger_plantilla_activo_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Mismo criterio que proteger_rol_profile con "rol": un signup propio
    -- (profiles_upsert_own solo exige id = auth.uid(), no restringe estas
    -- columnas) no puede nacer con una plantilla auto-asignada ni
    -- desactivado -- sin este branch, alguien podía registrarse eligiendo
    -- de antemano la plantilla con más cuentas permitidas.
    if not public.is_admin() then
      new.plantilla_id := null;
      new.activo := true;
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.plantilla_id is distinct from old.plantilla_id or new.activo is distinct from old.activo)
       and not public.is_admin() then
      new.plantilla_id := old.plantilla_id;
      new.activo := old.activo;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_proteger_plantilla_activo_profile on public.profiles;
create trigger trg_proteger_plantilla_activo_profile
  before insert or update on public.profiles
  for each row execute function public.proteger_plantilla_activo_profile();

-- ------------------------------------------------------------
-- Policy de DELETE en rendiciones (no relacionada a plantillas, pero se
-- agrega en esta misma migración porque la necesita el fix de "rendición
-- fantasma" en app.js): hoy rendiciones tiene RLS activado pero SIN
-- ninguna policy de DELETE, así que cualquier intento de borrar (incluido
-- el que hace submitRendicion() cuando todos los ítems de una rendición
-- recién creada fallan al guardarse) queda bloqueado en silencio -- el
-- DELETE "funciona" (error: null) pero afecta 0 filas, dejando la
-- rendición fantasma igual. Esta policy es deliberadamente angosta: solo
-- deja borrar una rendición PROPIA, Pendiente, y que todavía no tenga
-- ningún ítem guardado -- no habilita "eliminar rendición" como función
-- general para el usuario.
-- ------------------------------------------------------------
drop policy if exists "rendiciones_delete_propia_vacia" on public.rendiciones;
create policy "rendiciones_delete_propia_vacia" on public.rendiciones
  for delete using (
    empleado_id = auth.uid()
    and estado = 'Pendiente'
    and not exists (select 1 from public.rendicion_items ri where ri.rendicion_id = rendiciones.id)
  );

-- ------------------------------------------------------------
-- "Desactivar usuario" hasta acá solo bloqueaba el login DESDE LA APP
-- (onLoggedIn en app.js) -- nada en las policies revisaba "activo", así
-- que una persona desactivada que igual conservara su sesión/contraseña
-- podía seguir usando la API REST de Supabase directo, sin pasar por la
-- app, con los mismos permisos de siempre. Si era aprobador/admin,
-- mantenía ESE poder indefinidamente incluso desactivada. Esto lo cierra
-- del lado del servidor, que es el único lado que realmente cuenta.
-- ------------------------------------------------------------
create or replace function public.is_admin_or_aprobador()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.rol in ('aprobador','admin') and p.activo
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.rol = 'admin' and p.activo
  );
$$;

-- Además, para que una persona desactivada tampoco pueda seguir creando
-- rendiciones/ítems/solicitudes nuevas a su propio nombre vía API directa
-- (ver una desactivada su propio historial viejo no es un problema de
-- seguridad, así que las policies de SELECT no se tocan -- solo las de
-- INSERT de cosas nuevas).
create or replace function public.is_activo()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select p.activo from public.profiles p where p.id = auth.uid()), true);
$$;

drop policy if exists "rendiciones_insert_own" on public.rendiciones;
create policy "rendiciones_insert_own" on public.rendiciones
  for insert with check (empleado_id = auth.uid() and public.is_activo());

drop policy if exists "items_insert_own" on public.rendicion_items;
create policy "items_insert_own" on public.rendicion_items
  for insert with check (
    public.is_activo()
    and exists (
      select 1 from public.rendiciones r
      where r.id = rendicion_items.rendicion_id and r.empleado_id = auth.uid()
    )
  );

drop policy if exists "solicitudes_fondos_insert_own" on public.solicitudes_fondos;
create policy "solicitudes_fondos_insert_own" on public.solicitudes_fondos
  for insert with check (empleado_id = auth.uid() and public.is_activo());
