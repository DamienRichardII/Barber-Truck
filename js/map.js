/* Carte « Où sommes-nous ? » : position des Barber Trucks à l'échelle de la ville.
   - la position publique est déjà arrondie (~2 km) côté base de données ;
   - le zoom est plafonné au niveau ville (pas de vue rue) ;
   - les positions sont rechargées toutes les 5 min (les check-ins sont horaires). */
(() => {
  'use strict';
  const mapEl = document.getElementById('map');
  if (!mapEl || !window.L) return;

  const statusEl = document.getElementById('loc-status');
  const goEl = document.getElementById('loc-go');
  const LIVE_MS = 90 * 60 * 1000;      // au-delà : « dernière position connue »
  const REFRESH_MS = 5 * 60 * 1000;
  const ZONE_RADIUS_M = 1500;
  const DEFAULT_VIEW = [48.93, 2.55];  // Seine-Saint-Denis (93), vue ville par défaut

  const map = L.map(mapEl, {
    center: DEFAULT_VIEW,
    zoom: 11,
    minZoom: 9,
    maxZoom: 12,
    scrollWheelZoom: false,
    dragging: !L.Browser.mobile,
    tap: false,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);
  let trucks = [];

  const fmtAgo = (ms) => {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 2) return 'à l\'instant';
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    return `il y a ${h} h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`;
  };

  const TRUCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6.5A1.5 1.5 0 0 1 4.5 5h9A1.5 1.5 0 0 1 15 6.5V8h2.6c.5 0 .9.2 1.2.6l2.2 2.9c.3.3.4.7.4 1.1V16a1 1 0 0 1-1 1h-.6a2.5 2.5 0 0 1-4.8 0H9.4a2.5 2.5 0 0 1-4.8 0H4a1 1 0 0 1-1-1V6.5Zm12 3v2.5h4.3l-1.9-2.5H15ZM7 15a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm9 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg>';
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function truckIcon(name) {
    const num = (String(name).match(/(\d+)\s*$/) || [])[1] || '';
    return `<span class="truck-pin__badge">${TRUCK_SVG}${num ? `<b>${escapeHtml(num)}</b>` : ''}</span>`;
  }

  function draw() {
    layer.clearLayers();
    const now = Date.now();
    const points = [];
    trucks.filter((t) => t.located).forEach((t) => {
      const live = now - t.at <= LIVE_MS;
      const color = live ? '#0b0b0b' : '#8a8a86';
      const ll = [t.lat, t.lng];
      points.push(ll);
      L.circle(ll, { radius: ZONE_RADIUS_M, color, weight: 2, fillColor: color, fillOpacity: live ? 0.16 : 0.08 }).addTo(layer);
      L.marker(ll, {
        keyboard: false,
        title: t.name,
        icon: L.divIcon({ className: `truck-pin${live ? ' is-live' : ''}`, html: truckIcon(t.name), iconSize: [40, 40], iconAnchor: [20, 20] }),
      }).bindTooltip(t.name, { permanent: true, direction: 'bottom', offset: [0, 18], className: 'truck-label' }).addTo(layer);
    });
    if (points.length === 1) map.setView(points[0], 12);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.4), { maxZoom: 12 });
    else map.setView(DEFAULT_VIEW, 11);
  }

  function renderStatus() {
    if (!trucks.length || !trucks.some((t) => t.located)) {
      statusEl.textContent = 'Position bientôt disponible';
      goEl.hidden = true;
      return;
    }
    const now = Date.now();
    statusEl.replaceChildren(...trucks.flatMap((t, i) => {
      const live = t.located && now - t.at <= LIVE_MS;
      const line = document.createElement('span');
      line.className = 'loc-line';
      line.textContent = t.located
        ? `${t.name} · ${t.city || 'zone approximative'} · ${live ? 'mis à jour' : 'dernière position'} ${fmtAgo(now - t.at)}`
        : `${t.name} · position non communiquée`;
      return i ? [document.createElement('br'), line] : [line];
    }));
    const first = trucks.find((t) => t.located && t.city && now - t.at <= LIVE_MS);
    if (first) {
      goEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(first.city)}`;
      goEl.hidden = false;
    } else {
      goEl.hidden = true;
    }
  }

  async function refresh() {
    if (!window.BarberAPI || !BarberAPI.isConfigured) { renderStatus(); return; }
    try {
      const rows = await BarberAPI.getTruckPositions();
      trucks = (rows || []).map((r) => {
        const t = {
          name: String(r.name),
          lat: r.lat === null ? NaN : Number(r.lat),
          lng: r.lng === null ? NaN : Number(r.lng),
          city: r.city ? String(r.city) : '',
          at: r.checked_at ? new Date(r.checked_at).getTime() : NaN,
        };
        t.located = Number.isFinite(t.lat) && Number.isFinite(t.lng) && Number.isFinite(t.at);
        return t;
      });
      draw();
    } catch { /* on garde l'affichage précédent */ }
    renderStatus();
  }

  window.addEventListener('load', () => map.invalidateSize());
  window.addEventListener('resize', () => map.invalidateSize());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(refresh, REFRESH_MS);
  setInterval(renderStatus, 60000);
  refresh();
})();
