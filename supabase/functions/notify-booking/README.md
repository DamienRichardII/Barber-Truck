# notify-booking (SMS Brevo uniquement)

Envoie les SMS du parcours de réservation. **Aucun e-mail n'est envoyé** (le site ne demande plus d'adresse e-mail) :

| Événement | SMS client | SMS équipe |
|---|---|---|
| Nouvelle demande | « demande enregistrée… » | oui (nom, téléphone, nombre de personnes, lien admin) |
| Confirmée | « RDV confirmé… » | non |
| Refusée / annulée | message + lien pour reprendre un créneau | non |

Chaque SMS indique la plage horaire (« de 20h30 à 22h00 »). Les textes n'utilisent que des caractères de l'alphabet GSM
(pas de ê, ç, î, ô, û…) pour rester en SMS de 160 caractères (un seul de ces caractères passe le SMS en Unicode : 70 caractères).

## Mise en place

1. Brevo : ID d'expéditeur approuvé, crédits SMS achetés, clé API (SMTP & API > Clés API), blocage d'IP désactivé.
2. Déploie la fonction :
   `supabase functions deploy notify-booking --no-verify-jwt --project-ref ebmprxugtwbxdemymlqh`
3. Secrets :
   `supabase secrets set --project-ref ebmprxugtwbxdemymlqh WEBHOOK_SECRET=un-secret-long BREVO_API_KEY=xkeysib-xxx SMS_SENDER=BarberTruck NOTIFY_SMS_TO="0612345678,0698765432"`
   (`SITE_URL` optionnel, `https://www.barbertruck.fr` par défaut ; les anciens secrets Resend ne servent plus.)
4. Exécute `supabase/notifications.sql` (remplace le secret par la valeur de `WEBHOOK_SECRET`), puis `supabase/durations.sql`.
5. Erreurs d'envoi : Supabase > Edge Functions > notify-booking > Logs (lignes `Brevo …`).

## Anti-abus

- Au-delà de `SMS_DAILY_CAP` demandes en 24 h (60 par défaut, secret optionnel), les nouvelles demandes ne déclenchent plus de SMS
  (confirmations et annulations continuent). Le message « SMS cap atteint » apparaît alors dans les logs.
- La base limite aussi à 3 demandes en attente et 4 demandes par 24 h pour un même numéro (`create_booking`).
