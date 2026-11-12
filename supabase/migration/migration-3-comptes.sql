-- ============================================================================
-- Barber Truck 93 — MIGRATION 3/3 : RÔLES DES COMPTES
-- À exécuter APRÈS avoir créé les comptes dans Authentication > Users > Add user
-- (e-mail + mot de passe, case « Auto Confirm User » cochée).
-- Les coiffeurs, eux, créent leur compte depuis /admin (onglet « Barber ») : un chef de projet les valide.
-- ============================================================================

-- Chefs de projet (accès complet à /admin) — adapte la liste si besoin
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email in ('yaniskali5@gmail.com', 'sofiane.pediac@outlook.fr', 'damien.miyouna@gmail.com');

-- Vérification : chaque compte doit afficher « admin »
select email, raw_app_meta_data ->> 'role' as role from auth.users order by email;

-- Après cette étape : Authentication > Sign In / Providers > désactiver « Allow new users to sign up »
-- (les comptes coiffeurs passent par la fonction barber-accounts, pas par l'inscription publique).
