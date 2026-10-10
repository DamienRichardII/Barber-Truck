# notify-booking (e-mails Resend)

1. Resend : crée un compte, une clé API (Full access) et vérifie ton domaine (sans domaine vérifié,
   Resend n'envoie qu'à ton propre e-mail de compte).
2. Déploie la fonction (Supabase CLI) :
   supabase functions deploy notify-booking --no-verify-jwt --project-ref ebmprxugtwbxdemymlqh
3. Secrets de la fonction :
   supabase secrets set --project-ref ebmprxugtwbxdemymlqh RESEND_API_KEY=re_xxx NOTIFY_FROM="Barber Truck 93 <rdv@ton-domaine.fr>" NOTIFY_TO="yaniskali5@gmail.com,sofiane.pediac@outlook.fr" WEBHOOK_SECRET=un-secret-long-aleatoire
4. Exécute supabase/notifications.sql dans le SQL Editor (remplace le secret par la même valeur que WEBHOOK_SECRET).
