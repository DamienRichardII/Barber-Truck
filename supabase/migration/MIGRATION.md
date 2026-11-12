# Barber Truck 93 : basculer le site sur un autre projet Supabase

Le projet d'origine (`ebmprxugtwbxdemymlqh`) est en pause (factures impayées de l'organisation) : ni les pages ni /admin ne peuvent fonctionner tant que le site pointe dessus.
Les données qu'il contient (réservations, camions, comptes) ne sont pas récupérables tant que l'organisation n'est pas régularisée ; la structure, elle, est entièrement dans ce dossier.

## Ordre des opérations (≈ 20 min)

1. **Créer le projet** dans la nouvelle organisation (région UE de préférence). Noter : *Project URL*, *Reference ID*, clé *publishable* (Project Settings > API Keys).
2. **SQL Editor** : coller `migration-1-structure.sql` en entier, Run. (Tables, règles de sécurité, fonctions, lundi fermé, camion « Barber Truck 1 ».)
3. **Authentication > Users > Add user** : créer les comptes des chefs de projet (e-mail + mot de passe, « Auto Confirm User » coché). Puis SQL Editor : `migration-3-comptes.sql`, Run (chaque compte doit afficher `admin`).
   Authentication > Sign In / Providers : désactiver « Allow new users to sign up ».
4. **Edge Functions** (Dashboard > Edge Functions > Deploy a new function, ou CLI) — « Verify JWT » désactivé pour les deux :
   - `notify-booking` : code dans `supabase/functions/notify-booking/index.ts`
   - `barber-accounts` : code dans `supabase/functions/barber-accounts/index.ts`
5. **Edge Functions > Secrets** (les valeurs de l'ancien projet ne sont pas lisibles : à ressaisir) :
   `WEBHOOK_SECRET` (chaîne aléatoire longue), `BREVO_API_KEY`, `SMS_SENDER` (ex. BarberTruck), `NOTIFY_SMS_TO` (06…, séparés par des virgules),
   optionnels : `SITE_URL` (https://www.barbertruck.fr), `SMS_DAILY_CAP`, et pour l'e-mail équipe `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_TO`.
6. **SQL Editor** : `migration-2-notifications.sql` après avoir remplacé l'URL (Reference ID) et le secret (= `WEBHOOK_SECRET`). Run.
7. **Site** : dans `js/config.js`, remplacer `supabaseUrl` et `supabaseKey` par ceux du nouveau projet, puis `git add -A`, `git commit`, `git push` (Vercel redéploie).
8. **Test** : réserver depuis le site (nom « Test Damien », créneau lointain), vérifier la demande dans /admin et les SMS (Edge Functions > notify-booking > Logs), puis refuser la demande de test.

## Retour au projet d'origine

Remettre l'ancien `supabaseUrl` / `supabaseKey` dans `js/config.js` et pousser. Le projet d'origine doit d'abord être restauré (règlement des factures de l'organisation).
Les réservations prises sur le projet temporaire restent dans celui-ci : les exporter (Table Editor > bookings > Export CSV) avant de revenir en arrière.
