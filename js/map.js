/* Carte « Où sommes-nous ? » : position des Barber Trucks à l'échelle de la ville.
   - Google Maps stylisé si BT_CONFIG.googleMapsKey est renseignée (js/config.js),
     sinon repli automatique sur OpenStreetMap (Leaflet) : la carte n'est jamais vide ;
   - la position publique est déjà arrondie (~2 km) côté base de données ;
   - pas de cercle, noms de rues masqués, zoom plafonné au niveau ville ;
   - positions rechargées toutes les 5 min (les check-ins sont horaires). */
(() => {
  'use strict';
  const mapEl = document.getElementById('map');
  if (!mapEl) return;

  const statusEl = document.getElementById('loc-status');
  const goEl = document.getElementById('loc-go');
  const cfg = window.BT_CONFIG || {};
  const LIVE_MS = 90 * 60 * 1000;      // au-delà : « dernière position connue »
  const REFRESH_MS = 5 * 60 * 1000;
  const DEFAULT_CENTER = { lat: 48.93, lng: 2.55 };  // Seine-Saint-Denis (93)
  const DEFAULT_ZOOM = 11;
  const MIN_ZOOM = 9;
  const MAX_ZOOM = 12;                 // niveau ville, jamais la rue

  let trucks = [];
  let renderer = null;                 // { draw(trucks) } une fois la carte prête

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
  const isLive = (t) => Date.now() - t.at <= LIVE_MS;

  /* ------------------------------------------------------------------ */
  /* Rendu Google Maps (stylisé, monochrome)                             */
  /* ------------------------------------------------------------------ */
  const GOOGLE_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#f1f1ef' }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#6d6d69' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#f8f8f6' }] },
    { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#2a2a2a' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e4e4e0' }] },
    { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },   // pas de noms de rues
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dcdcd7' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#dde2e6' }] },
    { featureType: 'water', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#ececE9' }] },
  ];

  function loadGoogle(key) {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps) return resolve();
      const cb = `__btGmapsReady${Date.now()}`;
      window[cb] = () => { delete window[cb]; resolve(); };
      window.gm_authFailure = () => reject(new Error('gm_auth'));   // clé invalide / restreinte / facturation
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=fr&region=FR&loading=async&callback=${cb}`;
      s.async = true;
      s.onerror = () => reject(new Error('gm_load'));
      document.head.append(s);
      setTimeout(() => reject(new Error('gm_timeout')), 15000);
    });
  }

  function createGoogleRenderer() {
    const gm = google.maps;
    const map = new gm.Map(mapEl, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      styles: GOOGLE_STYLE,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'cooperative',   // défilement de la page préservé sur mobile
      clickableIcons: false,
      keyboardShortcuts: false,
      backgroundColor: '#f1f1ef',
    });

    class TruckOverlay extends gm.OverlayView {
      constructor(t) { super(); this.t = t; this.pos = new gm.LatLng(t.lat, t.lng); this.el = null; }
      onAdd() {
        const el = document.createElement('div');
        el.className = `truck-pin gm-truck${isLive(this.t) ? ' is-live' : ''}`;
        el.title = this.t.name;
        el.innerHTML = `${truckIcon(this.t.name)}<span class="gm-truck__label">${escapeHtml(this.t.name)}</span>`;
        this.el = el;
        this.getPanes().overlayMouseTarget.append(el);
      }
      draw() {
        const p = this.getProjection().fromLatLngToDivPixel(this.pos);
        if (p && this.el) { this.el.style.left = `${p.x}px`; this.el.style.top = `${p.y}px`; }
      }
      onRemove() { if (this.el) { this.el.remove(); this.el = null; } }
    }

    let overlays = [];
    return {
      draw(list) {
        overlays.forEach((o) => o.setMap(null));
        overlays = [];
        const located = list.filter((t) => t.located);
        located.forEach((t) => { const o = new TruckOverlay(t); o.setMap(map); overlays.push(o); });
        if (located.length === 1) {
          map.setCenter({ lat: located[0].lat, lng: located[0].lng });
          map.setZoom(MAX_ZOOM);
        } else if (located.length > 1) {
          const b = new gm.LatLngBounds();
          located.forEach((t) => b.extend({ lat: t.lat, lng: t.lng }));
          map.fitBounds(b, 60);
          gm.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > MAX_ZOOM) map.setZoom(MAX_ZOOM); });
        } else {
          map.setCenter(DEFAULT_CENTER);
          map.setZoom(DEFAULT_ZOOM);
        }
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rendu Leaflet / OpenStreetMap (repli)                               */
  /* ------------------------------------------------------------------ */
  function createLeafletRenderer() {
    const map = L.map(mapEl, {
      center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      scrollWheelZoom: false,
      dragging: !L.Browser.mobile,
      tap: false,
      attributionControl: false,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: MAX_ZOOM }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    window.addEventListener('load', () => map.invalidateSize());
    window.addEventListener('resize', () => map.invalidateSize());
    return {
      draw(list) {
        layer.clearLayers();
        const points = [];
        list.filter((t) => t.located).forEach((t) => {
          const ll = [t.lat, t.lng];
          points.push(ll);
          L.marker(ll, {
            keyboard: false,
            title: t.name,
            icon: L.divIcon({ className: `truck-pin${isLive(t) ? ' is-live' : ''}`, html: truckIcon(t.name), iconSize: [40, 40], iconAnchor: [20, 20] }),
          }).bindTooltip(t.name, { permanent: true, direction: 'bottom', offset: [0, 18], className: 'truck-label' }).addTo(layer);
        });
        if (points.length === 1) map.setView(points[0], MAX_ZOOM);
        else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.4), { maxZoom: MAX_ZOOM });
        else map.setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Texte sous la carte + chargement des positions                      */
  /* ------------------------------------------------------------------ */
  function renderStatus() {
    if (!trucks.some((t) => t.located)) {
      statusEl.textContent = 'Position bientôt disponible';
      goEl.hidden = true;
      return;
    }
    const now = Date.now();
    statusEl.replaceChildren(...trucks.flatMap((t, i) => {
      const line = document.createElement('span');
      line.className = 'loc-line';
      line.textContent = t.located
        ? `${t.name} · ${t.city || 'zone approximative'} · ${isLive(t) ? 'mis à jour' : 'dernière position'} ${fmtAgo(now - t.at)}`
        : `${t.name} · position non communiquée`;
      return i ? [document.createElement('br'), line] : [line];
    }));
    const first = trucks.find((t) => t.located && t.city && isLive(t));
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
      if (renderer) renderer.draw(trucks);
    } catch { /* on garde l'affichage précédent */ }
    renderStatus();
  }

  async function init() {
    if (cfg.googleMapsKey) {
      try {
        await loadGoogle(cfg.googleMapsKey);
        renderer = createGoogleRenderer();
        mapEl.classList.add('is-google');
      } catch {
        mapEl.replaceChildren();      // nettoie un éventuel message d'erreur Google
      }
    }
    if (!renderer && window.L) renderer = createLeafletRenderer();
    if (renderer) renderer.draw(trucks);
    refresh();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(refresh, REFRESH_MS);
  setInterval(renderStatus, 60000);
  init();
})();
