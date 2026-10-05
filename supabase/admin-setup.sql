-- Donner le rôle admin à ton compte (à exécuter UNE fois, après l'avoir créé).
-- 1. Supabase > Authentication > Users > Add user (e-mail + mot de passe, "Auto confirm user" coché).
-- 2. Remplace l'e-mail ci-dessous puis exécute :
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'TON-EMAIL@exemple.com';
-- 3. Supabase > Authentication > Sign In / Providers : désactive "Allow new users to sign up".
