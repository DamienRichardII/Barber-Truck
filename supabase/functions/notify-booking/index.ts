// Notifications de réservation par SMS (Brevo) : nouvelle demande (équipe + client), confirmation, annulation / refus (client).
// Aucun e-mail n'est envoyé. Appelée par le trigger `bookings_notify` (voir supabase/notifications.sql).
// Secrets requis : WEBHOOK_SECRET, BREVO_API_KEY, SMS_SENDER, NOTIFY_SMS_TO (numéros de l'équipe, séparés par des virgules),
// SITE_URL (optionnel), SMS_DAILY_CAP (anti-abus : au-delà de ce nombre de demandes en 24 h, plus de SMS sur les nouvelles demandes ; 60 par défaut).
// Les textes évitent les caractères hors alphabet GSM (ê, ç, î, ô, û…) : un seul de ces caractères fait passer le SMS en
// format Unicode (70 caractères par SMS au lieu de 160), donc plus de crédits consommés.

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
  service: string; party_size: number; slot_date: string; slot_time: string; duration_min?: number;
  full_name: string; phone: string; email: string | null; address: string;
};

// "mercredi 15 octobre de 20h30 à 22h00" (les créneaux 00h00-02h30 appartiennent à la soirée du jour indiqué)
const startMin = (t: string) => { const h = parseInt(t.slice(0, 2), 10); return h * 60 + parseInt(t.slice(3, 5), 10) + (h < 6 ? 1440 : 0); };
const hm = (m: number) => { const x = m % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}h${String(x % 60).padStart(2, '0')}`; };
const when = (b: Booking) => {
  const d = new Date(`${b.slot_date}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `${d} de ${b.slot_time} à ${hm(startMin(b.slot_time) + (b.duration_min ?? 60))}`;
};

// 06 12 34 56 78 -> 33612345678 (format attendu par Brevo, sans le +)
const intl = (p: string) => p.replace(/[^0-9+]/g, '').replace(/^\+/, '').replace(/^00/, '').replace(/^0/, '33');

// Un SMS qui échoue est seulement journalisé : il ne doit jamais faire échouer la réservation.
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
// dernières 24 h dépasse le plafond, on n'envoie plus de SMS pour les nouvelles demandes.
// En cas d'erreur de comptage, on bloque aussi : mieux vaut un SMS en moins qu'un compte vidé.
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

  const site = SITE.replace('https://', '');
  try {
    if (payload.op === 'INSERT' && b.status === 'pending') {
      if (await newRequestSmsAllowed()) await Promise.all([
        ...SMS_TEAM.map((n) => sms(n, `Barber Truck : nouvelle demande ${when(b)} - ${b.full_name} ${b.phone} (${b.party_size} pers.). Voir ${SITE}/admin/`)),
        sms(b.phone, `Barber Truck 93 : demande enregistrée pour ${when(b)}. Nous la confirmons très vite par SMS.`),
      ]);
    } else if (payload.op === 'UPDATE' && b.status === 'confirmed') {
      await sms(b.phone, `Barber Truck 93 : RDV confirmé ${when(b)}. Un souci ? Appelez le 07 59 04 73 74.`);
    } else if (payload.op === 'UPDATE' && b.status === 'declined') {
      await sms(b.phone, `Barber Truck 93 : nous ne pouvons pas honorer le créneau du ${when(b)}. Autre créneau sur ${site} ou 07 59 04 73 74.`);
    } else if (payload.op === 'UPDATE' && b.status === 'cancelled') {
      await sms(b.phone, `Barber Truck 93 : votre RDV du ${when(b)} est annulé. Nouveau créneau sur ${site} ou 07 59 04 73 74.`);
    }
  } catch (e) {
    console.error(e);
    return new Response('error', { status: 500 });
  }
  return new Response('ok');
});
