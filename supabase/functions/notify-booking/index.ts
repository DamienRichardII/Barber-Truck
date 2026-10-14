// Envoi des e-mails Resend + SMS Brevo : nouvelle demande (équipe + client), confirmation, annulation / refus (client).
// Appelée par le trigger `bookings_notify` (voir supabase/notifications.sql).
// Secrets requis : RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO, WEBHOOK_SECRET, SITE_URL (optionnel).
// SMS (optionnels, désactivés sans BREVO_API_KEY) : BREVO_API_KEY, SMS_SENDER, NOTIFY_SMS_TO (numéros équipe, séparés par des virgules),
// SMS_DAILY_CAP (anti-abus : au-delà de ce nombre de demandes en 24 h, plus de SMS sur les nouvelles demandes ; 60 par défaut).

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('NOTIFY_FROM') ?? 'Barber Truck 93 <onboarding@resend.dev>';
const TO_TEAM = (Deno.env.get('NOTIFY_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';
const SITE = Deno.env.get('SITE_URL') ?? 'https://www.barbertruck.fr';
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SMS_SENDER = Deno.env.get('SMS_SENDER') ?? 'BarberTruck';
const SMS_DAILY_CAP = Number(Deno.env.get('SMS_DAILY_CAP') ?? '60');
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SMS_TEAM = (Deno.env.get('NOTIFY_SMS_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

type Booking = {
  id: string; status: 'pending' | 'confirmed' | 'declined' | 'cancelled';
  service: string; party_size: number; slot_date: string; slot_time: string;
  full_name: string; phone: string; email: string | null; address: string;
};

const SERVICES: Record<string, string> = { 'coupe-deplacement': 'Coupe + déplacement', 'offre-groupe': 'Offre groupe' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const when = (b: Booking) => {
  const d = new Date(`${b.slot_date}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `${d} à ${b.slot_time}`;
};
const people = (n: number) => `${n} ${n > 1 ? 'personnes' : 'personne'}`;

function layout(title: string, intro: string, rows: [string, string][], outro = '') {
  const lines = rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b6b68">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`).join('');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#0b0b0b">
<div style="max-width:520px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
<p style="margin:0 0 16px;line-height:1.5">${intro}</p>
<table style="border-collapse:collapse;font-size:15px">${lines}</table>
${outro ? `<p style="margin:16px 0 0;line-height:1.5">${outro}</p>` : ''}
</div>
<p style="text-align:center;font-size:12px;color:#6b6b68;margin:16px 0 0">Barber Truck 93 · barber shop mobile en Île-de-France<br>07 58 04 13 74</p>
</div></body></html>`;
}

async function send(to: string[], subject: string, html: string, replyTo?: string) {
  if (!RESEND_API_KEY || to.length === 0) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!res.ok) console.error('Resend', res.status, await res.text());
}

// 06 12 34 56 78 -> 33612345678 (format attendu par Brevo, sans le +)
const intl = (p: string) => p.replace(/[^0-9+]/g, '').replace(/^\+/, '').replace(/^00/, '').replace(/^0/, '33');

// Un SMS ne doit jamais bloquer les e-mails : toute erreur est seulement journalisée.
async function sms(phone: string, content: string) {
  if (!BREVO_API_KEY || !phone) return;
  try {
    const res = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: SMS_SENDER, recipient: intl(phone), content, type: 'transactional' }),
    });
    if (!res.ok) console.error('Brevo', res.status, await res.text());
  } catch (e) { console.error('Brevo', e); }
}

// Anti-abus : le site est public et le numéro saisi n'est pas vérifié. Si le nombre de demandes des
// dernières 24 h dépasse le plafond, on n'envoie plus de SMS pour les nouvelles demandes (les e-mails partent
// toujours). En cas d'erreur de comptage, on bloque aussi : mieux vaut un SMS en moins qu'un compte vidé.
async function newRequestSmsAllowed(): Promise<boolean> {
  if (!BREVO_API_KEY) return false;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await fetch(`${SB_URL}/rest/v1/bookings?select=id&created_at=gte.${encodeURIComponent(since)}`, {
      method: 'HEAD',
      headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`, Prefer: 'count=exact' },
    });
    const total = Number((res.headers.get('content-range') ?? '').split('/')[1]);
    if (!res.ok || !Number.isFinite(total)) { console.error('SMS cap: comptage impossible', res.status); return false; }
    if (total > SMS_DAILY_CAP) { console.error(`SMS cap atteint (${total} demandes en 24 h > ${SMS_DAILY_CAP}) : aucun SMS envoyé`); return false; }
    return true;
  } catch (e) { console.error('SMS cap', e); return false; }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' || !SECRET || req.headers.get('x-webhook-secret') !== SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  let payload: { op: string; record: Booking };
  try { payload = await req.json(); } catch { return new Response('bad request', { status: 400 }); }
  const b = payload.record;
  if (!b || !b.id) return new Response('bad request', { status: 400 });

  const service = `${SERVICES[b.service] ?? b.service} · ${people(b.party_size)}`;
  const recap: [string, string][] = [['Quand', when(b)], ['Prestation', service], ['Adresse', b.address]];

  try {
    if (payload.op === 'INSERT' && b.status === 'pending') {
      // Équipe : nouvelle demande à traiter
      await send(TO_TEAM, `Nouvelle demande de RDV – ${when(b)}`, layout(
        'Nouvelle demande de rendez-vous',
        `Une demande est en attente de confirmation. <a href="${SITE}/admin/">Ouvrir l'administration</a>.`,
        [...recap, ['Client', b.full_name], ['Téléphone', b.phone], ['E-mail', b.email ?? '—']],
      ), b.email ?? undefined);
      // SMS : équipe (nouvelle demande) + client (accusé de réception)
      if (await newRequestSmsAllowed()) await Promise.all([
        ...SMS_TEAM.map((n) => sms(n, `Barber Truck : nouvelle demande ${when(b)} - ${b.full_name} ${b.phone}. Voir ${SITE}/admin/`)),
        sms(b.phone, `Barber Truck 93 : demande reçue pour ${when(b)}. Elle sera réservée après notre confirmation, vous recevrez un SMS.`),
      ]);
      // Client : accusé de réception
      if (b.email) await send([b.email], 'Votre demande de rendez-vous – Barber Truck 93', layout(
        'Demande bien reçue',
        `Bonjour ${esc(b.full_name)}, nous avons bien reçu votre demande. Elle sera définitivement réservée <strong>après notre confirmation</strong> : vous recevrez un e-mail dès que c'est fait.`,
        recap,
      ));
    } else if (payload.op === 'UPDATE' && b.status === 'confirmed') {
      await sms(b.phone, `Barber Truck 93 : RDV confirmé ${when(b)}. Un empêchement ? Appelez le 07 58 04 13 74.`);
      if (b.email) await send([b.email], 'Rendez-vous confirmé – Barber Truck 93', layout(
        'Rendez-vous confirmé',
        `Bonjour ${esc(b.full_name)}, votre rendez-vous est confirmé. Le Barber Truck viendra à l'adresse indiquée.`,
        recap,
        'Un empêchement ? Appelez-nous au 07 58 04 13 74.',
      ));
    } else if (payload.op === 'UPDATE' && (b.status === 'cancelled' || b.status === 'declined')) {
      const declined = b.status === 'declined';
      await sms(b.phone, declined
        ? `Barber Truck 93 : nous ne pouvons pas honorer le créneau du ${when(b)}. Autre créneau sur ${SITE.replace('https://', '')} ou 07 58 04 13 74.`
        : `Barber Truck 93 : votre RDV du ${when(b)} est annulé. Nouveau créneau sur ${SITE.replace('https://', '')} ou 07 58 04 13 74.`);
      if (b.email) await send([b.email], declined ? 'Demande de rendez-vous non retenue – Barber Truck 93' : 'Rendez-vous annulé – Barber Truck 93', layout(
        declined ? 'Demande non retenue' : 'Rendez-vous annulé',
        declined
          ? `Bonjour ${esc(b.full_name)}, nous ne pouvons malheureusement pas honorer ce créneau.`
          : `Bonjour ${esc(b.full_name)}, votre rendez-vous a été annulé.`,
        recap,
        `Vous pouvez choisir un autre créneau sur <a href="${SITE}/#reservation">${SITE.replace('https://', '')}</a> ou nous appeler au 07 58 04 13 74.`,
      ));
    }
  } catch (e) {
    console.error(e);
    return new Response('error', { status: 500 });
  }
  return new Response('ok');
});
