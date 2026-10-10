// Envoi des e-mails Resend : nouvelle demande (équipe + client), confirmation, annulation / refus (client).
// Appelée par le trigger `bookings_notify` (voir supabase/notifications.sql).
// Secrets requis : RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO, WEBHOOK_SECRET, SITE_URL (optionnel).

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('NOTIFY_FROM') ?? 'Barber Truck 93 <onboarding@resend.dev>';
const TO_TEAM = (Deno.env.get('NOTIFY_TO') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';
const SITE = Deno.env.get('SITE_URL') ?? 'https://barbertruck.vercel.app';

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
      // Client : accusé de réception
      if (b.email) await send([b.email], 'Votre demande de rendez-vous – Barber Truck 93', layout(
        'Demande bien reçue',
        `Bonjour ${esc(b.full_name)}, nous avons bien reçu votre demande. Elle sera définitivement réservée <strong>après notre confirmation</strong> : vous recevrez un e-mail dès que c'est fait.`,
        recap,
      ));
    } else if (payload.op === 'UPDATE' && b.status === 'confirmed' && b.email) {
      await send([b.email], 'Rendez-vous confirmé – Barber Truck 93', layout(
        'Rendez-vous confirmé',
        `Bonjour ${esc(b.full_name)}, votre rendez-vous est confirmé. Le Barber Truck viendra à l'adresse indiquée.`,
        recap,
        'Un empêchement ? Appelez-nous au 07 58 04 13 74.',
      ));
    } else if (payload.op === 'UPDATE' && (b.status === 'cancelled' || b.status === 'declined') && b.email) {
      const declined = b.status === 'declined';
      await send([b.email], declined ? 'Demande de rendez-vous non retenue – Barber Truck 93' : 'Rendez-vous annulé – Barber Truck 93', layout(
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
