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
