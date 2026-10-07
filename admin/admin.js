(() => {
  'use strict';
  const cfg = window.BT_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const SESSION_KEY = 'bt-admin-session';
  const SERVICES = { 'coupe-deplacement': 'Coupe + déplacement', 'offre-groupe': 'Offre groupe' };
  const STATUS = { pending: 'En attente', confirmed: 'Confirmée', declined: 'Refusée', cancelled: 'Annulée' };

  let session = null;
  let rows = [];
  let filter = 'pending';
  let timer = null;
  let trucks = [];
  let lateFlag = false;
  let positions = [];
  const LATE_MS = 60 * 60 * 1000;

  const loginForm = $('#login');
  const panel = $('#panel');
  const actions = $('#bar-actions');
  const listEl = $('#list');
  const listMsg = $('#list-msg');

  const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
  const saveSession = (s) => { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* ignoré */ } };

  const headers = () => ({ apikey: cfg.supabaseKey, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' });

  function show(loggedIn) {
    loginForm.hidden = loggedIn;
    panel.hidden = !loggedIn;
    actions.hidden = !loggedIn;
  }

  function logout(message) {
    session = null; saveSession(null); rows = [];
    clearInterval(timer);
    show(false);
    const msg = $('#login-msg');
    msg.textContent = message || '';
    msg.classList.toggle('is-error', Boolean(message));
  }

  async function login(email, password) {
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('Identifiants incorrects.');
    const data = await res.json();
    const role = data.user && data.user.app_metadata && data.user.app_metadata.role;
    if (role !== 'admin') throw new Error('Ce compte n\'a pas les droits d\'administration.');
    return { token: data.access_token, email: data.user.email };
  }

  async function fetchRows() {
    listMsg.classList.remove('is-error');
    const url = `${cfg.supabaseUrl}/rest/v1/bookings?select=*&order=slot_date.asc,slot_time.asc`;
    let res;
    try { res = await fetch(url, { headers: headers() }); } catch { listMsg.textContent = 'Connexion impossible.'; listMsg.classList.add('is-error'); return; }
    if (res.status === 401 || res.status === 403) return logout('Session expirée, reconnectez-vous.');
    if (!res.ok) { listMsg.textContent = 'Erreur de chargement.'; listMsg.classList.add('is-error'); return; }
    rows = await res.json();
    render();
  }

  async function setStatus(id, status, button) {
    button.disabled = true;
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ status }),
    });
    if (res.status === 401 || res.status === 403) return logout('Session expirée, reconnectez-vous.');
    if (res.status === 409) { listMsg.textContent = 'Ce créneau est déjà occupé par une autre demande active.'; listMsg.classList.add('is-error'); button.disabled = false; return; }
    if (!res.ok) { listMsg.textContent = 'La modification a échoué.'; listMsg.classList.add('is-error'); button.disabled = false; return; }
    await fetchRows();
  }

  const fmtDate = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    const s = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const fmtPhone = (p) => p.replace(/^\+33(\d)/, '0$1').replace(/(\d{2})(?=\d)/g, '$1 ').trim();

  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); });
    children.forEach((c) => n.append(c));
    return n;
  }

  function card(b) {
    const phone = el('a', { href: `tel:${b.phone}`, text: fmtPhone(b.phone) });
    const addr = el('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}`, target: '_blank', rel: 'noopener noreferrer', text: b.address });
    const dl = el('dl', {}, [
      el('dt', { text: 'Client' }), el('dd', { text: b.full_name }),
      el('dt', { text: 'Téléphone' }), el('dd', {}, [phone]),
      el('dt', { text: 'Adresse' }), el('dd', {}, [addr]),
      el('dt', { text: 'Prestation' }), el('dd', { text: `${SERVICES[b.service] || b.service} · ${b.party_size} ${b.party_size > 1 ? 'personnes' : 'personne'}` }),
    ]);
    const btns = el('div', { class: 'card__actions' });
    const act = (label, cls, status) => {
      const bt = el('button', { type: 'button', class: `btn ${cls}`, text: label });
      bt.addEventListener('click', () => setStatus(b.id, status, bt));
      btns.append(bt);
    };
    if (b.status === 'pending') { act('Confirmer', 'btn--ok', 'confirmed'); act('Refuser', 'btn--ko', 'declined'); }
    if (b.status === 'confirmed') act('Annuler le rendez-vous', 'btn--ko', 'cancelled');
    const created = new Date(b.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    return el('li', { class: 'card' }, [
      el('div', { class: 'card__top' }, [
        el('span', { class: 'card__when', text: `${fmtDate(b.slot_date)} · ${b.slot_time}` }),
        el('span', { class: `badge badge--${b.status}`, text: STATUS[b.status] || b.status }),
      ]),
      dl, btns,
      el('p', { class: 'card__meta', text: `Demande reçue le ${created}` }),
    ]);
  }

  function render() {
    const pending = rows.filter((r) => r.status === 'pending').length;
    $('#count-pending').textContent = pending;
    document.title = `${lateFlag ? '⏰ ' : ''}${pending ? `(${pending}) ` : ''}Administration – Barber Truck 93`;
    const match = (r) => filter === 'all' || (filter === 'closed' ? ['declined', 'cancelled'].includes(r.status) : r.status === filter);
    const shown = rows.filter(match);
    listEl.replaceChildren(...shown.map(card));
    listMsg.textContent = shown.length ? '' : 'Aucune demande.';
  }

  /* ---- check-in de position ---- */
  const ckSelect = $('#truck-select');
  const ckBtn = $('#checkin-btn');
  const ckMsg = $('#checkin-msg');
  const ckList = $('#checkin-list');
  const ago = (ms) => {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 2) return 'à l\'instant';
    return min < 60 ? `il y a ${min} min` : `il y a ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  };

  async function fetchTrucks() {
    try {
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/trucks?select=id,name&active=eq.true&order=name.asc`, { headers: headers() });
      if (res.status === 401 || res.status === 403) return logout('Session expirée, reconnectez-vous.');
      if (!res.ok) throw new Error();
      trucks = await res.json();
      const keep = ckSelect.value;
      ckSelect.replaceChildren(...trucks.map((t) => el('option', { value: t.id, text: t.name })));
      if (keep) ckSelect.value = keep;
      const r = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/get_truck_positions`, { method: 'POST', headers: headers(), body: '{}' });
      positions = r.ok ? await r.json() : [];
    } catch { ckMsg.textContent = 'Impossible de charger les camions.'; ckMsg.classList.add('is-error'); }
    renderCheckins();
  }

  function renderCheckins() {
    const now = Date.now();
    let late = false;
    ckList.replaceChildren(...trucks.map((t) => {
      const p = positions.find((x) => x.name === t.name);
      const age = p ? now - new Date(p.checked_at).getTime() : Infinity;
      const isLate = age > LATE_MS;
      late = late || isLate;
      const text = p ? `${t.name} : ${p.city || 'zone approximative'}, ${ago(age)}${isLate ? ' — check-in en retard' : ''}` : `${t.name} : aucun check-in récent — check-in à faire`;
      return el('li', { class: isLate ? 'is-late' : 'is-ok', text });
    }));
    lateFlag = late;
    render();
  }

  async function reverseCity(lat, lng) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=fr&lat=${lat}&lon=${lng}`);
      if (!res.ok) return null;
      const a = (await res.json()).address || {};
      return a.city || a.town || a.village || a.municipality || null;
    } catch { return null; }
  }

  function checkin() {
    ckMsg.classList.remove('is-error');
    if (!trucks.length || !ckSelect.value) { ckMsg.textContent = 'Aucun camion à mettre à jour.'; ckMsg.classList.add('is-error'); return; }
    if (!navigator.geolocation) { ckMsg.textContent = 'La géolocalisation n\'est pas disponible sur cet appareil.'; ckMsg.classList.add('is-error'); return; }
    ckBtn.disabled = true;
    ckMsg.textContent = 'Localisation en cours…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const city = await reverseCity(lat, lng);
      try {
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/truck_checkin`, {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ p_truck: ckSelect.value, p_lat: lat, p_lng: lng, p_city: city }),
        });
        if (res.status === 401 || res.status === 403) return logout('Session expirée, reconnectez-vous.');
        if (!res.ok) throw new Error();
        ckMsg.textContent = `Position envoyée${city ? ` : ${city}` : ''}. Prochain check-in dans 1 h.`;
        await fetchTrucks();
      } catch {
        ckMsg.textContent = 'L\'envoi a échoué. Réessayez.'; ckMsg.classList.add('is-error');
      }
      ckBtn.disabled = false;
    }, (err) => {
      ckMsg.textContent = err.code === 1 ? 'Autorisez la localisation dans le navigateur, puis réessayez.' : 'Position introuvable. Réessayez.';
      ckMsg.classList.add('is-error');
      ckBtn.disabled = false;
    }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 0 });
  }
  ckBtn.addEventListener('click', checkin);

  function start() {
    show(true);
    fetchRows();
    fetchTrucks();
    clearInterval(timer);
    timer = setInterval(() => { fetchRows(); fetchTrucks(); }, 30000);
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#login-msg');
    msg.classList.remove('is-error');
    if (!cfg.supabaseUrl || !cfg.supabaseKey) { msg.textContent = 'Supabase n\'est pas configuré (js/config.js).'; msg.classList.add('is-error'); return; }
    msg.textContent = 'Connexion…';
    try {
      session = await login($('#email').value.trim(), $('#password').value);
      saveSession(session);
      $('#password').value = '';
      msg.textContent = '';
      start();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add('is-error');
    }
  });
  $('#logout').addEventListener('click', () => logout());
  $('#refresh').addEventListener('click', fetchRows);
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
    render();
  });

  session = loadSession();
  if (session && cfg.supabaseUrl) start();
})();
