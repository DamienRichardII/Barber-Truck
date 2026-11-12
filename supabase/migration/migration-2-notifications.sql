-- ============================================================================
-- Barber Truck 93 — MIGRATION 2/3 : LIEN BASE -> ENVOI DES SMS
-- À exécuter APRÈS : (a) migration-1, (b) déploiement de la fonction notify-booking, (c) secret WEBHOOK_SECRET défini.
-- Remplace les deux valeurs marquées A REMPLACER, puis Run.
-- ============================================================================
insert into private.notify_config (url, secret)
values (
  'https://qjwvyuvyeauagrbqcpeg.supabase.co/functions/v1/notify-booking',   -- A REMPLACER (Project Settings > General > Reference ID)
  'YKeQudwhi2FproMZNm4Ha65jBxP9EIWbSgy1A0Lq'                                           -- A REMPLACER (identique au secret WEBHOOK_SECRET de la fonction)
)
on conflict (id) do update set url = excluded.url, secret = excluded.secret;

select url, left(secret, 4) || '…' as secret_debut from private.notify_config;
