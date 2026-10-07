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
  address     text not null check (char_length(address) between 8 and 200),
  status      text not null default 'pending' check (status in ('pending', 'confirmed', 'declined', 'cancelled')),
  constraint bookings_party_ck check (
    (service = 'offre-groupe' and party_size >= 3) or (service = 'coupe-deplacement' and party_size between 1 and 2)
  )
);

-- Un créneau ne peut être occupé que par une seule demande active (en attente ou confirmée).
-- Refusée / annulée => le créneau redevient libre.
create unique index if not exists bookings_slot_active_uidx
  on public.bookings (slot_date, slot_time)
  where status in ('pending', 'confirmed');

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
  where b.status in ('pending', 'confirmed')
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
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'invalid_name';
  end if;
  if v_phone !~ '^\+?[0-9]{9,15}$' then
    raise exception 'invalid_phone';
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

  begin
    insert into public.bookings (service, party_size, slot_date, slot_time, full_name, phone, address)
    values (p_service, v_size, p_date, p_time, v_name, v_phone, v_addr)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'slot_taken';
  end;

  return v_id;
end;
$$;

revoke all on function public.get_taken_slots(date, date) from public;
revoke all on function public.create_booking(text, int, date, text, text, text, text) from public;
grant execute on function public.get_taken_slots(date, date) to anon, authenticated;
grant execute on function public.create_booking(text, int, date, text, text, text, text) to anon, authenticated;


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
