-- Planning à la demi-heure + durée des rendez-vous (30 min de déplacement + 30 min par personne) + e-mail facultatif.
-- À exécuter UNE fois dans le SQL Editor de Supabase, APRES schema.sql et notifications.sql (il remplace create_booking).
-- Déjà appliqué en production le 14/10/2026. Idempotent : peut être rejoué sans risque.
--
-- Règles :
--   * durée = 30 + 30 × nombre de personnes (1 pers. = 1 h, 2 pers. = 1 h 30, groupe de 3 = 2 h, …) ;
--   * créneaux de départ toutes les 30 min, de 18h00 à 02h00 ; un rendez-vous doit finir avant 03h00 ;
--   * offre groupe : 3 à 17 personnes (17 personnes = 9 h = toute la soirée) ;
--   * deux rendez-vous CONFIRMÉS ne peuvent pas se chevaucher le même soir (trigger, verrou par date) ;
--   * 00h00-02h30 appartiennent à la soirée du jour indiqué (+24 h).

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

-- 3. plages occupées par des rendez-vous confirmés (sans donnée personnelle) : utilisé par le site
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
    and b.slot_date between p_from and least(p_to, p_from + 62);
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
  return new;
end;
$$;
revoke all on function public.bookings_check_overlap() from public, anon, authenticated;

drop trigger if exists bookings_no_overlap on public.bookings;
create trigger bookings_no_overlap
  before insert or update of status, slot_date, slot_time, duration_min on public.bookings
  for each row when (new.status = 'confirmed')
  execute function public.bookings_check_overlap();

-- 5. création d'une demande : durée, fin avant 03h00, pas de chevauchement avec un RDV confirmé, e-mail facultatif
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
  if p_time is null or p_time !~ '^(18|19|2[0-3]|0[0-2])h(00|30)$' then raise exception 'invalid_slot'; end if;
  if p_date is null or p_date < v_today or p_date > v_today + 120 then raise exception 'invalid_date'; end if;

  if p_service = 'offre-groupe' then
    v_size := coalesce(p_party_size, 0);
    if v_size < 3 or v_size > 17 then raise exception 'invalid_party_size'; end if;
  else
    v_size := coalesce(p_party_size, 1);
    if v_size < 1 or v_size > 2 then raise exception 'invalid_party_size'; end if;
  end if;

  -- durée : 30 min de déplacement + 30 min par personne ; le rendez-vous doit se terminer avant 03h00
  v_dur   := 30 + 30 * v_size;
  v_start := public.slot_minutes(p_time);
  if v_start + v_dur > 1620 then raise exception 'invalid_slot'; end if;

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

  -- la plage demandée ne doit pas chevaucher un rendez-vous déjà confirmé
  if exists (
    select 1 from public.bookings b
    where b.slot_date = p_date and b.status = 'confirmed'
      and public.slot_minutes(b.slot_time) < v_start + v_dur
      and v_start < public.slot_minutes(b.slot_time) + coalesce(b.duration_min, 60)
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
