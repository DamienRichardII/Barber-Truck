-- Rôle « coiffeur » (barber) : accès limité aux sections Camions + Coiffeur de l'admin.
-- À exécuter UNE fois dans le SQL Editor de Supabase, après avoir créé le compte du coiffeur
-- (Authentication > Users > Add user, "Auto confirm user" coché).

-- 1. Donner le rôle au compte du coiffeur (remplace l'e-mail) :
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"barber"}'::jsonb
where email = 'EMAIL-DU-COIFFEUR@exemple.com';

-- 2. Le coiffeur voit uniquement les rendez-vous CONFIRMES (lecture seule, aucune modification).
create policy "coiffeur lit les rdv confirmes" on public.bookings
  for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'barber' and status = 'confirmed');

-- 3. Le coiffeur lit la liste des camions.
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
