// Comptes barber : demande publique (en attente) + gestion par les chefs de projet.
// Rôles (app_metadata.role) : admin = chef de projet | barber_pending = demande en attente | barber = valide | barber_revoked = retiré.
// Actions : signup (public) ; list / approve / reject / revoke (réservées au rôle admin).

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const gotrue = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}/auth/v1${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

async function callerIsAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const res = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: auth } });
  if (!res.ok) return false;
  const u = await res.json();
  return u?.app_metadata?.role === 'admin';
}

type U = { id: string; email: string; created_at: string; app_metadata?: { role?: string }; user_metadata?: { full_name?: string } };
const BARBER_ROLES = ['barber_pending', 'barber', 'barber_revoked'];
async function listBarbers(): Promise<U[]> {
  const res = await gotrue('/admin/users?per_page=200');
  if (!res.ok) throw new Error('list');
  const data = await res.json();
  return (data.users as U[]).filter((u) => BARBER_ROLES.includes(u.app_metadata?.role ?? ''));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }

  try {
    if (body.action === 'signup') {
      if (body.website) return json({ ok: true }); // champ piège
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      if (name.length < 2 || name.length > 80) return json({ error: 'invalid_name' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return json({ error: 'invalid_email' }, 400);
      if (password.length < 10 || password.length > 72) return json({ error: 'weak_password' }, 400);
      const pending = (await listBarbers()).filter((u) => u.app_metadata?.role === 'barber_pending').length;
      if (pending >= 20) return json({ error: 'too_many_requests' }, 429);
      const res = await gotrue('/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { role: 'barber_pending' }, user_metadata: { full_name: name } }),
      });
      if (!res.ok) {
        const t = await res.text();
        return json({ error: /already|registered|exists/i.test(t) ? 'email_taken' : 'signup_failed' }, 400);
      }
      return json({ ok: true });
    }

    if (!(await callerIsAdmin(req))) return json({ error: 'forbidden' }, 403);

    if (body.action === 'list') {
      const users = await listBarbers();
      return json({ barbers: users.map((u) => ({ id: u.id, email: u.email, name: u.user_metadata?.full_name ?? '', role: u.app_metadata?.role, created_at: u.created_at })) });
    }

    const id = String(body.id ?? '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'bad_request' }, 400);
    const target = (await listBarbers()).find((u) => u.id === id);
    if (!target) return json({ error: 'not_found' }, 404); // jamais d'action sur un compte admin

    if (body.action === 'approve' || body.action === 'revoke') {
      const role = body.action === 'approve' ? 'barber' : 'barber_revoked';
      const res = await gotrue(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ app_metadata: { role } }) });
      return res.ok ? json({ ok: true }) : json({ error: 'update_failed' }, 500);
    }
    if (body.action === 'reject') {
      if (target.app_metadata?.role !== 'barber_pending') return json({ error: 'bad_request' }, 400);
      const res = await gotrue(`/admin/users/${id}`, { method: 'DELETE' });
      return res.ok ? json({ ok: true }) : json({ error: 'delete_failed' }, 500);
    }
    return json({ error: 'bad_request' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'server' }, 500);
  }
});
