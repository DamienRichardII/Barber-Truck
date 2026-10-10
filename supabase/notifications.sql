-- Notifications e-mail (Resend) : demande, confirmation, annulation / refus.
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
insert into private.notify_config (url, secret)
values ('https://ebmprxugtwbxdemymlqh.supabase.co/functions/v1/notify-booking', 'A-REMPLACER-PAR-UN-SECRET-LONG')   -- A REMPLACER (même valeur que WEBHOOK_SECRET de la fonction)
on conflict (id) do update set url = excluded.url, secret = excluded.secret;

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
