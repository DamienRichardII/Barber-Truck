-- ============================================================================
-- Barber Truck 93 — MIGRATION 1/3 : STRUCTURE COMPLÈTE (nouveau projet Supabase)
-- Colle ce fichier en entier dans SQL Editor du NOUVEAU projet et clique sur Run (une seule fois).
-- Il regroupe, dans l'ordre : schema.sql, notifications.sql (sans la config), durations.sql,
-- barber-role.sql (sans l'attribution du rôle), booking-outcome.sql. Rejouable sans risque.
-- ============================================================================

-- ===== 1/5 schema.sql =====
-- Barber Truck 93 – réservations (Supabase / Postgres)
-- À exécuter une seule fois dans le SQL Editor du projet Supabase.
--
-- Principe :
--   * la table `bookings` est fermée au public (RLS, aucune policy anon) ;
--     téléphone et adresse ne sont donc jamais lisibles depuis le site ;
--   * le site appelle uniquement deux fonctions :
--       get_taken_slots()  -> créneaux déjà pris (date, heure, statut), sans données client
--       create_booking()   -> crée une demande au statut 'pending' après validation
--   * seuls les comptes dont app_metadata.role = 'admin' lisent / modifient les demandes.

create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  service     text not null check (service in ('coupe-deplacement', 'offre-groupe')),
  party_size  int  not null default 1 check (party_size between 1 and 20),
  slot_date   date not null,
  slot_time   text not null check (slot_time in ('18h00','19h00','20h00','21h00','22h00','23h00','00h00','01h00','02h00')),
  full_name   text not null check (char_length(full_name) between 2 and 80),
  phone       text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  email       text check (email is null or email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  address     text not null check (char_length(address) between 8 and 200),
  status      text not null default 'pending' check (status in ('pending', 'confirmed', 'declined', 'cancelled')),
  constraint bookings_party_ck check (
    (service = 'offre-groupe' and party_size >= 3) or (service = 'coupe-deplacement' and party_size between 1 and 2)
  )
);

-- Plusieurs clients peuvent demander le même créneau (statut 'pending') : seuls les chefs de projet choisissent.
-- Un créneau n'est bloqué que s'il est CONFIRMÉ (une seule demande confirmée par créneau).
-- Refusée / annulée => le créneau redevient libre.
create unique index if not exists bookings_slot_confirmed_uidx
  on public.bookings (slot_date, slot_time)
  where status = 'confirmed';

create index if not exists bookings_status_date_idx on public.bookings (status, slot_date, slot_time);

alter table public.bookings enable row level security;

revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;
grant update (status, decided_at) on public.bookings to authenticated;

drop policy if exists "admin lit les reservations" on public.bookings;
create policy "admin lit les reservations" on public.bookings
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "admin modifie le statut" on public.bookings;
create policy "admin modifie le statut" on public.bookings
  for update to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

create or replace function public.set_decided_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.decided_at := case when new.status = 'pending' then null else now() end;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_decided_at on public.bookings;
create trigger bookings_decided_at
  before update on public.bookings
  for each row execute function public.set_decided_at();

-- Créneaux pris, sans aucune donnée personnelle.
create or replace function public.get_taken_slots(p_from date, p_to date)
returns table (slot_date date, slot_time text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.slot_date, b.slot_time, b.status
  from public.bookings b
  where b.status = 'confirmed'
    and b.slot_date between p_from and least(p_to, p_from + 62);
$$;

-- Création d'une demande (toujours en 'pending').
create or replace function public.create_booking(
  p_service    text,
  p_party_size int,
  p_date       date,
  p_time       text,
  p_name       text,
  p_phone      text,
  p_email      text,
  p_address    text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_name  text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_addr  text := btrim(coalesce(p_address, ''));
  v_size  int;
begin
  if p_service not in ('coupe-deplacement', 'offre-groupe') then
    raise exception 'invalid_service';
  end if;
  if p_time not in ('18h00','19h00','20h00','21h00','22h00','23h00','00h00','01h00','02h00') then
    raise exception 'invalid_slot';
  end if;
  if p_date is null or p_date < v_today or p_date > v_today + 120 then
    raise exception 'invalid_date';
  end if;
  -- créneau déjà passé aujourd'hui (heure de Paris ; 00h00-02h00 = lendemain de la soirée)
  if p_date::timestamp + make_interval(hours => substr(p_time, 1, 2)::int + case when substr(p_time, 1, 2)::int < 6 then 24 else 0 end)
     <= (now() at time zone 'Europe/Paris') then
    raise exception 'slot_passed';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'invalid_name';
  end if;
  if v_phone !~ '^\+?[0-9]{9,15}$' then
    raise exception 'invalid_phone';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 120 then
    raise exception 'invalid_email';
  end if;
  if char_length(v_addr) < 8 or char_length(v_addr) > 200 then
    raise exception 'invalid_address';
  end if;

  if p_service = 'offre-groupe' then
    v_size := coalesce(p_party_size, 0);
    if v_size < 3 or v_size > 20 then
      raise exception 'invalid_party_size';
    end if;
  else
    v_size := coalesce(p_party_size, 1);
    if v_size < 1 or v_size > 2 then
      raise exception 'invalid_party_size';
    end if;
  end if;

  -- anti-abus : 3 demandes en attente maximum par numéro
  if (select count(*) from public.bookings where phone = v_phone and status = 'pending') >= 3 then
    raise exception 'too_many_requests';
  end if;
  -- anti-abus SMS : 4 demandes maximum par numéro et par 24 h, quel que soit leur statut
  if (select count(*) from public.bookings where phone = v_phone and created_at > now() - interval '24 hours') >= 4 then
    raise exception 'too_many_requests';
  end if;

  begin
    insert into public.bookings (service, party_size, slot_date, slot_time, full_name, phone, email, address)
    values (p_service, v_size, p_date, p_time, v_name, v_phone, v_email, v_addr)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'slot_taken';
  end;

  return v_id;
end;
$$;

revoke all on function public.get_taken_slots(date, date) from public;
revoke all on function public.create_booking(text, int, date, text, text, text, text, text) from public;
grant execute on function public.get_taken_slots(date, date) to anon, authenticated;
grant execute on function public.create_booking(text, int, date, text, text, text, text, text) to anon, authenticated;


-- ============================================================================
-- Position des Barber Trucks (carte "Où sommes-nous ?")
-- ============================================================================
-- Sécurité : la position n'est JAMAIS enregistrée précisément. Chaque check-in est
-- arrondi à une grille d'environ 2 km (échelle d'une ville) AVANT d'être stocké.
-- Le site public ne peut que lire la dernière position arrondie (get_truck_positions) ;
-- seul un compte admin peut en enregistrer une (truck_checkin).

create table if not exists public.trucks (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null unique check (char_length(name) between 2 and 60),
  active     boolean not null default true
);

create table if not exists public.truck_checkins (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  truck_id   uuid not null references public.trucks (id) on delete cascade,
  lat        double precision not null check (lat between -90 and 90),
  lng        double precision not null check (lng between -180 and 180),
  city       text check (city is null or char_length(city) <= 80)
);

create index if not exists truck_checkins_truck_time_idx on public.truck_checkins (truck_id, created_at desc);

alter table public.trucks enable row level security;
alter table public.truck_checkins enable row level security;
revoke all on public.trucks, public.truck_checkins from anon, authenticated;
grant select on public.trucks to authenticated;

drop policy if exists "admin lit les camions" on public.trucks;
create policy "admin lit les camions" on public.trucks
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

-- Un camion au départ. Pour en ajouter : insert into public.trucks (name) values ('Barber Truck 2');
-- Pour renommer : update public.trucks set name = '…' where name = 'Barber Truck 1';
insert into public.trucks (name) values ('Barber Truck 1')
on conflict (name) do nothing;

-- Dernière position (arrondie) de chaque camion actif, pour les 12 dernières heures
-- (un camion sans check-in récent est renvoyé avec lat/lng à null).
create or replace function public.get_truck_positions()
returns table (name text, lat double precision, lng double precision, city text, checked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.name, c.lat, c.lng, c.city, c.created_at
  from public.trucks t
  left join lateral (
    select ci.lat, ci.lng, ci.city, ci.created_at
    from public.truck_checkins ci
    where ci.truck_id = t.id
      and ci.created_at > now() - interval '12 hours'
    order by ci.created_at desc
    limit 1
  ) c on true
  where t.active
  order by t.name;
$$;

-- Check-in (admin uniquement) : arrondit la position à ~2 km avant de l'enregistrer.
create or replace function public.truck_checkin(
  p_truck uuid,
  p_lat   double precision,
  p_lng   double precision,
  p_city  text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_at   timestamptz;
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'forbidden';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_position';
  end if;
  if not exists (select 1 from public.trucks where id = p_truck and active) then
    raise exception 'invalid_truck';
  end if;
  if v_city is not null and char_length(v_city) > 80 then
    v_city := left(v_city, 80);
  end if;

  insert into public.truck_checkins (truck_id, lat, lng, city)
  values (p_truck, round(round((p_lat / 0.02)::numeric) * 0.02, 2)::double precision,
                   round(round((p_lng / 0.02)::numeric) * 0.02, 2)::double precision, v_city)
  returning created_at into v_at;

  return v_at;
end;
$$;

revoke all on function public.get_truck_positions() from public;
revoke all on function public.truck_checkin(uuid, double precision, double precision, text) from public;
grant execute on function public.get_truck_positions() to anon, authenticated;
grant execute on function public.truck_checkin(uuid, double precision, double precision, text) to authenticated;

-- Un chef de projet confirme une demande à la place du client déjà confirmé sur le même horaire
-- (le premier passe en 'cancelled', une seule opération). Réservé au rôle admin.
create or replace function public.confirm_booking_replacing(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings;
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'forbidden';
  end if;
  select * into b from public.bookings where id = p_id for update;
  if b.id is null or b.status <> 'pending' then
    raise exception 'invalid_booking';
  end if;
  update public.bookings set status = 'cancelled'
   where slot_date = b.slot_date and slot_time = b.slot_time and status = 'confirmed' and id <> p_id;
  update public.bookings set status = 'confirmed' where id = p_id;
end;
$$;

revoke execute on function public.confirm_booking_replacing(uuid) from public, anon;
grant execute on function public.confirm_booking_replacing(uuid) to authenticated;


-- ===== 2/5 notifications.sql =====
-- Notifications de réservation : appelle la fonction `notify-booking` (SMS Brevo) à chaque demande et changement de statut.
-- ATTENTION : la définition de create_booking ci-dessous est remplacée par supabase/durations.sql (à exécuter ensuite).
-- À exécuter UNE fois dans le SQL Editor de Supabase, APRES avoir déployé la fonction `notify-booking`
-- (voir supabase/functions/notify-booking/README.md).
--
-- Remplace les deux valeurs marquées A REMPLACER avant d'exécuter.

-- 1. Colonne e-mail du client + nouvelle version de create_booking (8 paramètres)
alter table public.bookings add column if not exists email text
  check (email is null or email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$');

drop function if exists public.create_booking(text, int, date, text, text, text, text);

create or replace function public.create_booking(
  p_service    text,
  p_party_size int,
  p_date       date,
  p_time       text,
  p_name       text,
  p_phone      text,
  p_email      text,
  p_address    text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_name  text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_addr  text := btrim(coalesce(p_address, ''));
  v_size  int;
begin
  if p_service not in ('coupe-deplacement', 'offre-groupe') then raise exception 'invalid_service'; end if;
  if p_time not in ('18h00','19h00','20h00','21h00','22h00','23h00','00h00','01h00','02h00') then raise exception 'invalid_slot'; end if;
  if p_date is null or p_date < v_today or p_date > v_today + 120 then raise exception 'invalid_date'; end if;
  -- créneau déjà passé aujourd'hui (heure de Paris ; 00h00-02h00 = lendemain de la soirée)
  if p_date::timestamp + make_interval(hours => substr(p_time, 1, 2)::int + case when substr(p_time, 1, 2)::int < 6 then 24 else 0 end)
     <= (now() at time zone 'Europe/Paris') then raise exception 'slot_passed'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then raise exception 'invalid_name'; end if;
  if v_phone !~ '^\+?[0-9]{9,15}$' then raise exception 'invalid_phone'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 120 then raise exception 'invalid_email'; end if;
  if char_length(v_addr) < 8 or char_length(v_addr) > 200 then raise exception 'invalid_address'; end if;

  if p_service = 'offre-groupe' then
    v_size := coalesce(p_party_size, 0);
    if v_size < 3 or v_size > 20 then raise exception 'invalid_party_size'; end if;
  else
    v_size := coalesce(p_party_size, 1);
    if v_size < 1 or v_size > 2 then raise exception 'invalid_party_size'; end if;
  end if;

  if (select count(*) from public.bookings where phone = v_phone and status = 'pending') >= 3 then
    raise exception 'too_many_requests';
  end if;
  -- anti-abus SMS : 4 demandes maximum par numéro et par 24 h, quel que soit leur statut
  if (select count(*) from public.bookings where phone = v_phone and created_at > now() - interval '24 hours') >= 4 then
    raise exception 'too_many_requests';
  end if;

  begin
    insert into public.bookings (service, party_size, slot_date, slot_time, full_name, phone, email, address)
    values (p_service, v_size, p_date, p_time, v_name, v_phone, v_email, v_addr)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'slot_taken';
  end;

  return v_id;
end;
$$;

revoke all on function public.create_booking(text, int, date, text, text, text, text, text) from public;
grant execute on function public.create_booking(text, int, date, text, text, text, text, text) to anon, authenticated;

-- 2. Appel de la fonction d'envoi à chaque nouvelle demande et à chaque changement de statut
create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.notify_config (
  id     boolean primary key default true check (id),
  url    text not null,
  secret text not null
);
-- (la configuration URL + secret est dans migration-2-notifications.sql)

create or replace function public.notify_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c private.notify_config;
begin
  select * into c from private.notify_config limit 1;
  if c.url is null then return new; end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  begin
    perform net.http_post(
      url     := c.url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', c.secret),
      body    := jsonb_build_object('op', tg_op, 'record', to_jsonb(new))
    );
  exception when others then
    null;  -- une panne d'e-mail ne doit jamais bloquer une réservation
  end;
  return new;
end;
$$;

drop trigger if exists bookings_notify on public.bookings;
create trigger bookings_notify
  after insert or update of status on public.bookings
  for each row execute function public.notify_booking();


-- ===== 3/5 durations.sql =====
-- Planning à la demi-heure + durée des rendez-vous (30 min de déplacement + 30 min par personne) + e-mail facultatif.
-- À exécuter UNE fois dans le SQL Editor de Supabase, APRES schema.sql et notifications.sql (il remplace create_booking).
-- Déjà appliqué en production le 14/10/2026. Idempotent : peut être rejoué sans risque.
--
-- Règles :
--   * durée = 30 + 30 × nombre de personnes (1 pers. = 1 h, 2 pers. = 1 h 30, groupe de 3 = 2 h, …) ;
--   * créneaux de départ toutes les 30 min, de 18h00 à 02h30 ; un rendez-vous doit finir avant 05h30 ;
--   * offre groupe : 3 à 17 personnes (17 personnes = 9 h 00) ;
--   * deux rendez-vous CONFIRMÉS ne peuvent pas se chevaucher le même soir (trigger, verrou par date) ;
--   * 00h00-02h30 appartiennent à la soirée du jour indiqué (+24 h) ;
--   * les chefs de projet peuvent bloquer / débloquer une plage à la main (table slot_blocks) : elle est grisée sur le site,
--     refusée à la réservation et à la confirmation.

-- 1. durée (30 + 30 × personnes) et horaires à la demi-heure
alter table public.bookings add column if not exists duration_min int;
update public.bookings set duration_min = 30 + 30 * party_size where duration_min is null;
alter table public.bookings alter column duration_min set not null;

alter table public.bookings drop constraint if exists bookings_slot_time_check;
alter table public.bookings add constraint bookings_slot_time_check
  check (slot_time ~ '^(18|19|2[0-3]|0[0-2])h(00|30)$');
alter table public.bookings drop constraint if exists bookings_duration_ck;
alter table public.bookings add constraint bookings_duration_ck check (duration_min between 60 and 540);

-- 2. minutes écoulées depuis 00h00 du jour de la soirée
create or replace function public.slot_minutes(p_time text)
returns int
language sql
immutable
set search_path = ''
as $$
  select substr(p_time, 1, 2)::int * 60 + substr(p_time, 4, 2)::int + case when substr(p_time, 1, 2)::int < 6 then 1440 else 0 end
$$;
revoke all on function public.slot_minutes(text) from public, anon, authenticated;


-- 2b. plages bloquées à la main par les chefs de projet (rôle admin uniquement ; jamais lisibles par le public)
create table if not exists public.slot_blocks (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  slot_date   date not null,
  slot_time   text not null check (slot_time ~ '^(18|19|2[0-3]|0[0-2])h(00|30)$'),
  duration_min int not null check (duration_min between 60 and 540),
  note        text check (note is null or char_length(note) <= 120),
  client_phone   text check (client_phone is null or client_phone ~ '^\+?[0-9]{9,15}$'),
  client_address text check (client_address is null or char_length(client_address) between 8 and 200),
  constraint slot_blocks_fit_ck check (
    substr(slot_time, 1, 2)::int * 60 + substr(slot_time, 4, 2)::int + case when substr(slot_time, 1, 2)::int < 6 then 1440 else 0 end + duration_min <= 1770
  )
);
-- tables créées avant l'ajout du téléphone / de l'adresse du client
alter table public.slot_blocks add column if not exists client_phone text check (client_phone is null or client_phone ~ '^\+?[0-9]{9,15}$');
alter table public.slot_blocks add column if not exists client_address text check (client_address is null or char_length(client_address) between 8 and 200);
alter table public.slot_blocks enable row level security;
revoke all on public.slot_blocks from anon, authenticated;
grant select, insert, delete on public.slot_blocks to authenticated;

drop policy if exists "admin lit les blocages" on public.slot_blocks;
create policy "admin lit les blocages" on public.slot_blocks
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');
drop policy if exists "admin bloque un creneau" on public.slot_blocks;
create policy "admin bloque un creneau" on public.slot_blocks
  for insert to authenticated
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');
drop policy if exists "admin debloque un creneau" on public.slot_blocks;
create policy "admin debloque un creneau" on public.slot_blocks
  for delete to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

-- 3. plages occupées (rendez-vous confirmés + plages bloquées) (sans donnée personnelle) : utilisé par le site
create or replace function public.get_busy_slots(p_from date, p_to date)
returns table (slot_date date, slot_time text, duration_min int)
language sql
stable
security definer
set search_path = ''
as $$
  select b.slot_date, b.slot_time, b.duration_min
  from public.bookings b
  where b.status = 'confirmed'
    and b.slot_date between p_from and least(p_to, p_from + 62)
  union all
  select k.slot_date, k.slot_time, k.duration_min
  from public.slot_blocks k
  where k.slot_date between p_from and least(p_to, p_from + 62);
$$;
revoke all on function public.get_busy_slots(date, date) from public;
grant execute on function public.get_busy_slots(date, date) to anon, authenticated;

-- 4. pas de chevauchement entre rendez-vous confirmés (course-safe : verrou par date)
create or replace function public.bookings_check_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('bookings:' || new.slot_date::text));
  if exists (
    select 1 from public.bookings b
    where b.id <> new.id
      and b.slot_date = new.slot_date
      and b.status = 'confirmed'
      and public.slot_minutes(b.slot_time) < public.slot_minutes(new.slot_time) + coalesce(new.duration_min, 60)
      and public.slot_minutes(new.slot_time) < public.slot_minutes(b.slot_time) + coalesce(b.duration_min, 60)
  ) then
    raise exception 'slot_taken' using errcode = '23505';   -- 409 côté API : « créneau déjà confirmé »
  end if;
  -- plage bloquée à la main par un chef de projet
  if exists (
    select 1 from public.slot_blocks k
    where k.slot_date = new.slot_date
      and public.slot_minutes(k.slot_time) < public.slot_minutes(new.slot_time) + coalesce(new.duration_min, 60)
      and public.slot_minutes(new.slot_time) < public.slot_minutes(k.slot_time) + k.duration_min
  ) then
    raise exception 'slot_blocked' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.bookings_check_overlap() from public, anon, authenticated;

drop trigger if exists bookings_no_overlap on public.bookings;
create trigger bookings_no_overlap
  before insert or update of status, slot_date, slot_time, duration_min on public.bookings
  for each row when (new.status = 'confirmed')
  execute function public.bookings_check_overlap();

-- 5. création d'une demande : durée, fin avant 05h30, pas de chevauchement avec un RDV confirmé, e-mail facultatif
create or replace function public.create_booking(
  p_service    text,
  p_party_size int,
  p_date       date,
  p_time       text,
  p_name       text,
  p_phone      text,
  p_email      text,
  p_address    text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_name  text := btrim(coalesce(p_name, ''));
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_addr  text := btrim(coalesce(p_address, ''));
  v_size  int;
  v_dur   int;
  v_start int;
begin
  if p_service not in ('coupe-deplacement', 'offre-groupe') then raise exception 'invalid_service'; end if;
  -- départs toutes les 30 min, de 18h00 à 02h30
  if p_time is null or p_time !~ '^(18|19|2[0-3]|0[0-2])h(00|30)$' then raise exception 'invalid_slot'; end if;
  -- la soirée d'hier reste réservable après minuit (créneaux 00h00-02h30 encore à venir) ; slot_passed écarte ce qui est passé
  if p_date is null or p_date < v_today - 1 or p_date > v_today + 120 then raise exception 'invalid_date'; end if;
  -- fermé le lundi (soirée du lundi jusqu'à 02h30 le mardi comprise : c'est la date de service qui compte)
  if extract(isodow from p_date) = 1 then raise exception 'closed_day'; end if;

  if p_service = 'offre-groupe' then
    v_size := coalesce(p_party_size, 0);
    if v_size < 3 or v_size > 17 then raise exception 'invalid_party_size'; end if;
  else
    v_size := coalesce(p_party_size, 1);
    if v_size < 1 or v_size > 2 then raise exception 'invalid_party_size'; end if;
  end if;

  -- durée : 30 min de déplacement + 30 min par personne ; le rendez-vous doit se terminer avant 05h30
  v_dur   := 30 + 30 * v_size;
  v_start := public.slot_minutes(p_time);
  if v_start + v_dur > 1770 then raise exception 'invalid_slot'; end if;

  -- créneau déjà passé aujourd'hui (heure de Paris ; 00h00-02h30 = lendemain de la soirée)
  if p_date::timestamp + make_interval(mins => v_start) <= (now() at time zone 'Europe/Paris') then raise exception 'slot_passed'; end if;

  if char_length(v_name) < 2 or char_length(v_name) > 80 then raise exception 'invalid_name'; end if;
  if v_phone !~ '^\+?[0-9]{9,15}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and (v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 120) then raise exception 'invalid_email'; end if;
  if char_length(v_addr) < 8 or char_length(v_addr) > 200 then raise exception 'invalid_address'; end if;

  if (select count(*) from public.bookings where phone = v_phone and status = 'pending') >= 3 then
    raise exception 'too_many_requests';
  end if;
  -- anti-abus SMS : 4 demandes maximum par numéro et par 24 h, quel que soit leur statut
  if (select count(*) from public.bookings where phone = v_phone and created_at > now() - interval '24 hours') >= 4 then
    raise exception 'too_many_requests';
  end if;

  -- la plage demandée ne doit chevaucher ni un rendez-vous confirmé, ni une plage bloquée à la main
  if exists (
    select 1 from public.bookings b
    where b.slot_date = p_date and b.status = 'confirmed'
      and public.slot_minutes(b.slot_time) < v_start + v_dur
      and v_start < public.slot_minutes(b.slot_time) + coalesce(b.duration_min, 60)
  ) or exists (
    select 1 from public.slot_blocks k
    where k.slot_date = p_date
      and public.slot_minutes(k.slot_time) < v_start + v_dur
      and v_start < public.slot_minutes(k.slot_time) + k.duration_min
  ) then
    raise exception 'slot_taken';
  end if;

  begin
    insert into public.bookings (service, party_size, slot_date, slot_time, full_name, phone, email, address, duration_min)
    values (p_service, v_size, p_date, p_time, v_name, v_phone, v_email, v_addr, v_dur)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'slot_taken';
  end;

  return v_id;
end;
$$;

-- 6. « Confirmer à la place » : annule les rendez-vous confirmés qui chevauchent la plage (une seule opération)
create or replace function public.confirm_booking_replacing(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings;
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'forbidden';
  end if;
  select * into b from public.bookings where id = p_id for update;
  if b.id is null or b.status <> 'pending' then
    raise exception 'invalid_booking';
  end if;
  update public.bookings set status = 'cancelled'
   where slot_date = b.slot_date and status = 'confirmed' and id <> p_id
     and public.slot_minutes(slot_time) < public.slot_minutes(b.slot_time) + coalesce(b.duration_min, 60)
     and public.slot_minutes(b.slot_time) < public.slot_minutes(slot_time) + coalesce(duration_min, 60);
  update public.bookings set status = 'confirmed' where id = p_id;
end;
$$;


-- ===== 4/5 barber-role.sql =====
-- Rôle coiffeur (barber) : politiques de lecture + check-in (le rôle est attribué dans migration-3-comptes.sql)
-- 2. Le coiffeur voit uniquement les rendez-vous CONFIRMES (lecture seule, aucune modification).
drop policy if exists "coiffeur lit les rdv confirmes" on public.bookings;
create policy "coiffeur lit les rdv confirmes" on public.bookings
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'barber' and status = 'confirmed');

-- 3. Le coiffeur lit la liste des camions.
drop policy if exists "coiffeur lit les camions" on public.trucks;
create policy "coiffeur lit les camions" on public.trucks
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'barber');

-- 4. Le coiffeur peut faire le check-in du camion (admin ou barber).
create or replace function public.truck_checkin(
  p_truck uuid,
  p_lat   double precision,
  p_lng   double precision,
  p_city  text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_at   timestamptz;
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') not in ('admin', 'barber') then
    raise exception 'forbidden';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_position';
  end if;
  if not exists (select 1 from public.trucks where id = p_truck and active) then
    raise exception 'invalid_truck';
  end if;
  if v_city is not null and char_length(v_city) > 80 then
    v_city := left(v_city, 80);
  end if;

  insert into public.truck_checkins (truck_id, lat, lng, city)
  values (p_truck, round(round((p_lat / 0.02)::numeric) * 0.02, 2)::double precision,
                   round(round((p_lng / 0.02)::numeric) * 0.02, 2)::double precision, v_city)
  returning created_at into v_at;

  return v_at;
end;
$$;


-- ===== 5/5 booking-outcome.sql =====
-- Clôture d'un rendez-vous par le coiffeur : « RDV validé » / « RDV non validé ».
-- À exécuter UNE fois dans le SQL Editor de Supabase. N'envoie aucun e-mail (le statut reste 'confirmed').

alter table public.bookings
  add column if not exists outcome text check (outcome in ('done', 'no_show')),
  add column if not exists closed_at timestamptz;

-- p_outcome : 'done' (validé), 'no_show' (non validé) ou null (rouvrir). Admin ou barber, rdv confirmés uniquement.
create or replace function public.close_booking(p_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') not in ('admin', 'barber') then
    raise exception 'forbidden';
  end if;
  if p_outcome is not null and p_outcome not in ('done', 'no_show') then
    raise exception 'invalid_outcome';
  end if;
  update public.bookings
     set outcome = p_outcome,
         closed_at = case when p_outcome is null then null else now() end
   where id = p_id and status = 'confirmed';
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

revoke all on function public.close_booking(uuid, text) from public, anon;
grant execute on function public.close_booking(uuid, text) to authenticated;

