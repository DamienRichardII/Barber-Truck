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

  function draw() {
    layer.clearLayers();
    const now = Date.now();
    const points = [];
    trucks.forEach((t) => {
      const live = now - t.at <= LIVE_MS;
      const color = live ? '#0b0b0b' : '#8a8a86';
      const ll = [t.lat, t.lng];
      points.push(ll);
      L.circle(ll, { radius: ZONE_RADIUS_M, color, weight: 2, fillColor: color, fillOpacity: live ? 0.16 : 0.08 }).addTo(layer);
      L.marker(ll, {
        keyboard: false,
        icon: L.divIcon({ className: `truck-pin${live ? ' is-live' : ''}`, html: '<span></span>', iconSize: [18, 18] }),
      }).bindTooltip(t.name, { direction: 'top', offset: [0, -8] }).addTo(layer);
    });
    if (points.length === 1) map.setView(points[0], 12);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.4), { maxZoom: 12 });
    else map.setView(DEFAULT_VIEW, 11);
  }

  function renderStatus() {
    if (!trucks.length) {
      statusEl.textContent = 'Position bientôt disponible';
      goEl.hidden = true;
      return;
    }
    const now = Date.now();
    statusEl.replaceChildren(...trucks.flatMap((t, i) => {
      const live = now - t.at <= LIVE_MS;
      const line = document.createElement('span');
      line.className = 'loc-line';
      line.textContent = `${t.name} · ${t.city || 'zone approximative'} · ${live ? 'mis à jour' : 'dernière position'} ${fmtAgo(now - t.at)}`;
      return i ? [document.createElement('br'), line] : [line];
    }));
    const first = trucks.find((t) => t.city && now - t.at <= LIVE_MS);
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
      trucks = (rows || []).map((r) => ({
        name: String(r.name),
        lat: Number(r.lat),
        lng: Number(r.lng),
        city: r.city ? String(r.city) : '',
        at: new Date(r.checked_at).getTime(),
      })).filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng) && Number.isFinite(t.at));
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
