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
