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

  const auth = $('#auth');
  const loginForm = $('#login');
  let loginRole = 'admin';
  const panel = $('#panel');
  const actions = $('#bar-actions');
  const listEl = $('#list');
  const listMsg = $('#list-msg');

  const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
  const saveSession = (s) => { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* ignoré */ } };

  const headers = () => ({ apikey: cfg.supabaseKey, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' });

  function show(loggedIn) {
    auth.hidden = loggedIn;
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
    if (loginRole === 'admin' && role !== 'admin') throw new Error(role === 'barber' ? 'Ce compte est un compte barber : utilisez l\'onglet « Barber ».' : 'Ce compte n\'a pas les droits d\'accès.');
    if (loginRole === 'barber') {
      if (role === 'barber_pending') throw new Error('Votre compte est en attente de validation par un chef de projet.');
      if (role === 'barber_revoked') throw new Error('L\'accès de ce compte a été retiré. Contactez un chef de projet.');
      if (role !== 'barber') throw new Error(role === 'admin' ? 'Ce compte est un compte chef de projet : utilisez l\'onglet « Chef de projet ».' : 'Ce compte n\'a pas les droits d\'accès.');
    }
    return { token: data.access_token, email: data.user.email, role };
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

  function card(b, readOnly) {
    const phone = el('a', { href: `tel:${b.phone}`, text: fmtPhone(b.phone) });
    const addr = el('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}`, target: '_blank', rel: 'noopener noreferrer', text: b.address });
    const dl = el('dl', {}, [
      el('dt', { text: 'Client' }), el('dd', { text: b.full_name }),
      el('dt', { text: 'Téléphone' }), el('dd', {}, [phone]),
      ...(b.email ? [el('dt', { text: 'E-mail' }), el('dd', {}, [el('a', { href: `mailto:${b.email}`, text: b.email })])] : []),
      el('dt', { text: 'Adresse' }), el('dd', {}, [addr]),
      el('dt', { text: 'Prestation' }), el('dd', { text: `${SERVICES[b.service] || b.service} · ${b.party_size} ${b.party_size > 1 ? 'personnes' : 'personne'}` }),
    ]);
    const btns = el('div', { class: 'card__actions' });
    const act = (label, cls, status) => {
      const bt = el('button', { type: 'button', class: `btn ${cls}`, text: label });
      bt.addEventListener('click', () => setStatus(b.id, status, bt));
      btns.append(bt);
    };
    if (!readOnly && b.status === 'pending') { act('Confirmer', 'btn--ok', 'confirmed'); act('Refuser', 'btn--ko', 'declined'); }
    if (!readOnly && b.status === 'confirmed') act('Annuler le rendez-vous', 'btn--ko', 'cancelled');
    const created = new Date(b.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    return el('li', { class: 'card' }, [
      el('div', { class: 'card__top' }, [
        el('span', { class: 'card__when', text: `${fmtDate(b.slot_date)} · ${b.slot_time}` }),
        el('span', { class: `badge badge--${b.status}`, text: STATUS[b.status] || b.status }),
      ]),
      dl, ...(readOnly ? [] : [btns, el('p', { class: 'card__meta', text: `Demande reçue le ${created}` })]),
    ]);
  }

  function render() {
    const pending = rows.filter((r) => r.status === 'pending').length;
    $('#count-pending').textContent = pending;
    $('#count-pending-nav').textContent = pending;
    $('#count-pending-nav').hidden = !pending;
    document.title = `${lateFlag ? '⏰ ' : ''}${pending ? `(${pending}) ` : ''}Administration – Barber Truck 93`;
    const match = (r) => filter === 'all' || (filter === 'closed' ? ['declined', 'cancelled'].includes(r.status) : r.status === filter);
    const shown = rows.filter(match);
    listEl.replaceChildren(...shown.map((b) => card(b)));
    listMsg.textContent = shown.length ? '' : 'Aucune demande.';
    renderPlanning();
    if (!$('#view-barber').hidden) renderBarber();
  }

  /* ---- planning : toutes les réservations avec toutes leurs informations ---- */
  const SLOT_ORDER = ['18h00', '19h00', '20h00', '21h00', '22h00', '23h00', '00h00', '01h00', '02h00'];
  const planBody = $('#plan-body');
  const planMsg = $('#plan-msg');
  const planPeriod = $('#plan-period');
  const planStatus = $('#plan-status');
  const planSearch = $('#plan-search');
  const todayParis = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const slotRank = (t) => { const i = SLOT_ORDER.indexOf(t); return i < 0 ? 99 : i; };
  const fmtShort = (iso) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const peopleLabel = (n) => `${n} ${n > 1 ? 'personnes' : 'personne'}`;

  function planFiltered() {
    const today = todayParis();
    const q = planSearch.value.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return rows.filter((r) => {
      const p = planPeriod.value;
      if (p === 'upcoming' && r.slot_date < today) return false;
      if (p === 'today' && r.slot_date !== today) return false;
      if (p === 'past' && r.slot_date >= today) return false;
      const s = planStatus.value;
      if (s === 'active' && !['pending', 'confirmed'].includes(r.status)) return false;
      if (s === 'closed' && !['declined', 'cancelled'].includes(r.status)) return false;
      if (['pending', 'confirmed'].includes(s) && r.status !== s) return false;
      if (q) {
        const hay = `${r.full_name} ${r.address} ${r.phone}`.toLowerCase();
        if (!hay.includes(q) && !(qDigits.length >= 3 && (r.phone.replace(/\D/g, '').includes(qDigits) || r.phone.replace(/^\+33/, '0').replace(/\D/g, '').includes(qDigits)))) return false;
      }
      return true;
    }).sort((a, b) => (a.slot_date < b.slot_date ? -1 : a.slot_date > b.slot_date ? 1 : slotRank(a.slot_time) - slotRank(b.slot_time)));
  }

  function renderStats() {
    const today = todayParis();
    const n = (f) => rows.filter(f).length;
    const stats = [
      [n((r) => r.status === 'pending'), 'À traiter'],
      [n((r) => r.status === 'confirmed' && r.slot_date === today), 'Confirmées aujourd\'hui'],
      [n((r) => r.status === 'confirmed' && r.slot_date > today), 'Confirmées à venir'],
      [rows.filter((r) => r.status === 'confirmed' && r.slot_date >= today).reduce((s, r) => s + r.party_size, 0), 'Personnes à couper (à venir)'],
    ];
    $('#plan-stats').replaceChildren(...stats.map(([v, l]) => el('li', {}, [el('strong', { text: String(v) }), el('span', { text: l })])));
  }

  function planRow(b) {
    const td = (label, child, cls = '') => {
      const c = el('td', { 'data-label': label, ...(cls ? { class: cls } : {}) });
      c.append(child);
      return c;
    };
    const phone = el('a', { href: `tel:${b.phone}`, text: fmtPhone(b.phone) });
    const addr = el('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}`, target: '_blank', rel: 'noopener noreferrer', text: b.address });
    const acts = el('div', { class: 'plan__actions' });
    const act = (label, cls, status) => {
      const bt = el('button', { type: 'button', class: `btn ${cls}`, text: label });
      bt.addEventListener('click', () => setStatus(b.id, status, bt));
      acts.append(bt);
    };
    if (b.status === 'pending') { act('Confirmer', 'btn--ok', 'confirmed'); act('Refuser', 'btn--ko', 'declined'); }
    if (b.status === 'confirmed') act('Annuler', 'btn--ko', 'cancelled');
    const tr = el('tr', { class: `row is-${b.status}` });
    tr.append(
      td('Heure', document.createTextNode(b.slot_time), 'plan__time'),
      td('Client', document.createTextNode(b.full_name)),
      td('Téléphone', phone),
      td('Adresse', addr),
      td('Prestation', document.createTextNode(SERVICES[b.service] || b.service)),
      td('Personnes', document.createTextNode(peopleLabel(b.party_size))),
      td('Statut', el('span', { class: `badge badge--${b.status}`, text: STATUS[b.status] || b.status })),
      td('Reçue le', document.createTextNode(fmtShort(b.created_at))),
      td('Actions', acts, 'plan__actionscell'),
    );
    return tr;
  }

  function renderPlanning() {
    renderStats();
    const shown = planFiltered();
    const today = todayParis();
    const out = [];
    let day = null;
    shown.forEach((b) => {
      if (b.slot_date !== day) {
        day = b.slot_date;
        const count = shown.filter((x) => x.slot_date === day).length;
        const th = el('th', { colspan: '9', text: `${day === today ? 'Aujourd\'hui · ' : ''}${fmtDate(day)} · ${count} ${count > 1 ? 'réservations' : 'réservation'}` });
        out.push(el('tr', { class: `day${day === today ? ' is-today' : ''}` }, [th]));
      }
      out.push(planRow(b));
    });
    planBody.replaceChildren(...out);
    planMsg.textContent = shown.length ? `${shown.length} réservation${shown.length > 1 ? 's' : ''}` : 'Aucune réservation pour ces filtres.';
  }

  function exportCsv() {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Date', 'Heure', 'Nom', 'Téléphone', 'Adresse', 'Prestation', 'Personnes', 'Statut', 'Reçue le', 'Décidée le'];
    const lines = planFiltered().map((b) => [
      b.slot_date, b.slot_time, b.full_name, fmtPhone(b.phone), b.address, SERVICES[b.service] || b.service, b.party_size,
      STATUS[b.status] || b.status, b.created_at ? fmtShort(b.created_at) : '', b.decided_at ? fmtShort(b.decided_at) : '',
    ].map(q).join(';'));
    const blob = new Blob(['﻿' + [head.map(q).join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `reservations-barber-truck-${todayParis()}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  [planPeriod, planStatus].forEach((x) => x.addEventListener('change', renderPlanning));
  planSearch.addEventListener('input', renderPlanning);
  $('#plan-csv').addEventListener('click', exportCsv);

  /* ---- rôles : admin = tout ; barber (coiffeur) = Camions + Coiffeur ---- */
  const isAdmin = () => Boolean(session && session.role === 'admin');
  function renderBarber() {
    const today = todayParis();
    const mine = rows.filter((r) => r.status === 'confirmed' && r.slot_date >= today)
      .sort((a, b) => (a.slot_date < b.slot_date ? -1 : a.slot_date > b.slot_date ? 1 : slotRank(a.slot_time) - slotRank(b.slot_time)));
    $('#barber-msg').textContent = mine.length ? '' : 'Aucun rendez-vous confirmé à venir.';
    $('#barber-list').replaceChildren(...mine.map((b) => card(b, true)));
  }

  /* ---- comptes barber (chefs de projet) ---- */
  const FN = `${cfg.supabaseUrl}/functions/v1/barber-accounts`;
  const ROLE_LABEL = { barber_pending: 'En attente', barber: 'Actif', barber_revoked: 'Accès retiré' };
  async function barberCall(body, token) {
    const res = await fetch(FN, { method: 'POST', headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${token || (session && session.token) || cfg.supabaseKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch { /* vide */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'server'), { code: data.error || 'server' });
    return data;
  }
  async function loadBarbers() {
    const msg = $('#barbers-msg'); msg.classList.remove('is-error');
    try {
      const { barbers } = await barberCall({ action: 'list' });
      const order = { barber_pending: 0, barber: 1, barber_revoked: 2 };
      barbers.sort((a, b) => order[a.role] - order[b.role] || a.created_at.localeCompare(b.created_at));
      const waiting = barbers.filter((b) => b.role === 'barber_pending').length;
      const badge = $('#count-barbers'); badge.textContent = waiting; badge.hidden = !waiting;
      msg.textContent = barbers.length ? '' : 'Aucun compte barber pour le moment.';
      $('#barbers-list').replaceChildren(...barbers.map((b) => {
        const btns = el('div', { class: 'card__actions' });
        const act = (label, cls, action) => {
          const bt = el('button', { type: 'button', class: `btn ${cls}`, text: label });
          bt.addEventListener('click', async () => { bt.disabled = true; try { await barberCall({ action, id: b.id }); await loadBarbers(); } catch { msg.textContent = 'Action impossible, réessayez.'; msg.classList.add('is-error'); bt.disabled = false; } });
          btns.append(bt);
        };
        if (b.role === 'barber_pending') { act('Valider', 'btn--ok', 'approve'); act('Refuser', 'btn--ko', 'reject'); }
        if (b.role === 'barber') act('Retirer l\'accès', 'btn--ko', 'revoke');
        if (b.role === 'barber_revoked') act('Réactiver', 'btn--ok', 'approve');
        return el('li', { class: 'card' }, [
          el('div', { class: 'card__top' }, [el('span', { class: 'card__when', text: b.name || b.email }), el('span', { class: `badge badge--${b.role === 'barber' ? 'confirmed' : b.role === 'barber_pending' ? 'pending' : 'cancelled'}`, text: ROLE_LABEL[b.role] })]),
          el('p', { class: 'card__meta', text: `${b.email} · demande du ${new Date(b.created_at).toLocaleDateString('fr-FR')}` }),
          btns,
        ]);
      }));
    } catch { msg.textContent = 'Impossible de charger les comptes barber.'; msg.classList.add('is-error'); }
  }

  /* ---- navigation entre les sections ---- */
  function showView(name) {
    if (!isAdmin() && !['trucks', 'barber'].includes(name)) name = 'barber';
    ['requests', 'planning', 'trucks', 'barber', 'barbers'].forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
    if (name === 'barber') renderBarber();
    if (name === 'barbers') loadBarbers();
    document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  }
  $('#views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });

  /* ---- check-in de position ---- */
  const ckSelect = $('#truck-select');
  const ckBtn = $('#checkin-btn');
  const ckMsg = $('#checkin-msg');
  const ckList = $('#checkin-list');
  const cityInput = $('#city-input');
  const cityBtn = $('#city-btn');
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
      ckSelect.hidden = trucks.length < 2;
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
      const age = p && p.checked_at ? now - new Date(p.checked_at).getTime() : Infinity;
      const isLate = age > LATE_MS;
      late = late || isLate;
      const text = p && p.checked_at ? `${t.name} : ${p.city || 'zone approximative'}, ${ago(age)}${isLate ? ' — check-in en retard' : ''}` : `${t.name} : aucun check-in récent — check-in à faire`;
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

  async function sendCheckin(lat, lng, city) {
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
  }

  function checkin() {
    ckMsg.classList.remove('is-error');
    if (!trucks.length || !ckSelect.value) { ckMsg.textContent = 'Aucun camion à mettre à jour.'; ckMsg.classList.add('is-error'); return; }
    const noGps = (msg) => { ckMsg.textContent = `${msg} Indiquez plutôt la ville ci-dessous.`; ckMsg.classList.add('is-error'); ckBtn.disabled = false; cityInput.focus(); };
    if (!navigator.geolocation) return noGps('La géolocalisation n\'est pas disponible sur cet appareil.');
    ckBtn.disabled = true;
    ckMsg.textContent = 'Localisation en cours…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const city = await reverseCity(lat, lng);
      await sendCheckin(lat, lng, city);
      ckBtn.disabled = false;
    }, (err) => noGps(err.code === 1 ? 'Localisation refusée par le navigateur.' : 'Position introuvable.'),
    { enableHighAccuracy: false, timeout: 20000, maximumAge: 0 });
  }

  /* Saisie manuelle de la ville : on la géocode (centre-ville) puis on envoie comme un check-in. */
  async function checkinCity() {
    ckMsg.classList.remove('is-error');
    const name = cityInput.value.trim();
    if (!trucks.length || !ckSelect.value) { ckMsg.textContent = 'Aucun camion à mettre à jour.'; ckMsg.classList.add('is-error'); return; }
    if (name.length < 2) { ckMsg.textContent = 'Indiquez le nom de la ville.'; ckMsg.classList.add('is-error'); cityInput.focus(); return; }
    cityBtn.disabled = true;
    ckMsg.textContent = 'Recherche de la ville…';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=fr&accept-language=fr&addressdetails=1&q=${encodeURIComponent(name)}`);
      const hit = res.ok ? (await res.json())[0] : null;
      if (!hit) { ckMsg.textContent = 'Ville introuvable. Vérifiez l\'orthographe.'; ckMsg.classList.add('is-error'); }
      else {
        const a = hit.address || {};
        const label = a.city || a.town || a.village || a.municipality || name;
        await sendCheckin(Number(hit.lat), Number(hit.lon), label);
        cityInput.value = '';
      }
    } catch { ckMsg.textContent = 'Recherche impossible. Réessayez.'; ckMsg.classList.add('is-error'); }
    cityBtn.disabled = false;
  }
  ckBtn.addEventListener('click', checkin);
  cityBtn.addEventListener('click', checkinCity);
  cityInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); checkinCity(); } });

  function start() {
    show(true);
    document.querySelectorAll('[data-admin-only]').forEach((b) => { b.hidden = !isAdmin(); });
    $('#tabs').hidden = !isAdmin();
    showView(isAdmin() ? 'requests' : 'barber');
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

  /* onglets de connexion + création de compte barber */
  const signupForm = $('#signup');
  function setLoginRole(r) {
    loginRole = r;
    document.querySelectorAll('#auth-tabs button').forEach((b) => { const on = b.dataset.role === r; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on)); });
    $('#login-title').textContent = r === 'admin' ? 'Connexion chef de projet' : 'Connexion barber';
    $('#to-signup').hidden = r !== 'barber';
    loginForm.hidden = false; signupForm.hidden = true;
    $('#login-msg').textContent = '';
  }
  $('#auth-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-role]'); if (b) setLoginRole(b.dataset.role); });
  $('#show-signup').addEventListener('click', () => { loginForm.hidden = true; signupForm.hidden = false; $('#signup-msg').textContent = ''; });
  $('#back-login').addEventListener('click', () => setLoginRole('barber'));
  const SIGNUP_ERR = { invalid_name: 'Merci d\'indiquer votre nom et prénom.', invalid_email: 'Adresse e-mail invalide.', weak_password: 'Mot de passe : 10 caractères minimum.', email_taken: 'Un compte existe déjà avec cet e-mail.', too_many_requests: 'Trop de demandes en attente, réessayez plus tard.' };
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#signup-msg'); msg.classList.remove('is-error');
    if ($('#su-pass').value !== $('#su-pass2').value) { msg.textContent = 'Les deux mots de passe ne correspondent pas.'; msg.classList.add('is-error'); return; }
    msg.textContent = 'Envoi…';
    try {
      await barberCall({ action: 'signup', name: $('#su-name').value, email: $('#su-email').value, password: $('#su-pass').value, website: $('#su-website').value });
      signupForm.reset();
      setLoginRole('barber');
      const lm = $('#login-msg'); lm.textContent = 'Demande envoyée. Un chef de projet doit la valider avant votre première connexion.'; lm.classList.remove('is-error');
    } catch (err) { msg.textContent = SIGNUP_ERR[err.code] || 'Une erreur est survenue, réessayez.'; msg.classList.add('is-error'); }
  });
  $('#refresh').addEventListener('click', fetchRows);
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
    render();
  });

  session = loadSession();
  if (session && !session.role) {
    try { session.role = (JSON.parse(atob(session.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).app_metadata || {}).role; } catch { session = null; }
  }
  if (session && cfg.supabaseUrl) start();
})();
