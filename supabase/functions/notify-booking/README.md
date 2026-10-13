# notify-booking (e-mails Resend + SMS Brevo)

1. Resend : crée un compte, une clé API (Full access) et vérifie ton domaine (sans domaine vérifié,
   Resend n'envoie qu'à ton propre e-mail de compte).
2. Déploie la fonction (Supabase CLI) :
   supabase functions deploy notify-booking --no-verify-jwt --project-ref ebmprxugtwbxdemymlqh
3. Secrets de la fonction :
   supabase secrets set --project-ref ebmprxugtwbxdemymlqh RESEND_API_KEY=re_xxx NOTIFY_FROM="Barber Truck 93 <rdv@ton-domaine.fr>" NOTIFY_TO="yaniskali5@gmail.com,sofiane.pediac@outlook.fr" WEBHOOK_SECRET=un-secret-long-aleatoire
4. Exécute supabase/notifications.sql dans le SQL Editor (remplace le secret par la même valeur que WEBHOOK_SECRET).

## SMS (Brevo)

1. Brevo : ID d'expéditeur approuvé, crédits SMS achetés, clé API (SMTP & API > Clés API).
2. Secrets (NOTIFY_SMS_TO = numéros de l'équipe prévenus à chaque nouvelle demande, optionnel) :
   supabase secrets set --project-ref ebmprxugtwbxdemymlqh BREVO_API_KEY=xkeysib-xxx SMS_SENDER=BarberTruck NOTIFY_SMS_TO="0612345678"
3. Redéploie la fonction (commande de l'étape 2). Sans BREVO_API_KEY, aucun SMS n'est envoyé.
4. Erreurs d'envoi : Supabase > Edge Functions > notify-booking > Logs.
