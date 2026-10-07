/* Carte « Où sommes-nous ? » : position des Barber Trucks à l'échelle de la ville.
   - Mapbox si BT_CONFIG.mapboxToken est renseigné, sinon Google Maps si BT_CONFIG.googleMapsKey l'est,
     sinon OpenFreeMap (gratuit, sans clé, style sombre par défaut), sinon OpenStreetMap (Leaflet) :
     la carte n'est jamais vide ;
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

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Repère comme sur la maquette : carte blanche (nom, « Actuellement ici », ville) + photo ronde du camion. */
  function truckPin(t) {
    const live = Date.now() - t.at <= LIVE_MS;
    const sub = live ? 'Actuellement ici' : `Dernière position · ${fmtAgo(Date.now() - t.at)}`;
    return `<span class="tp-card"><strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(sub)}</span><span>${escapeHtml(t.city || 'Zone approximative')}</span></span>`
      + '<img class="tp-photo" src="assets/img/truck-pin.jpg" alt="" width="56" height="56" decoding="async">';
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
        el.innerHTML = truckPin(this.t);
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
  /* Rendu Mapbox (style sombre ou clair, noms de rues masqués)          */
  /* ------------------------------------------------------------------ */
  const MAPBOX_VERSION = 'v3.9.0';

  function loadMapbox() {
    return new Promise((resolve, reject) => {
      if (window.mapboxgl) return resolve();
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}/mapbox-gl.css`;
      document.head.append(css);
      const s = document.createElement('script');
      s.src = `https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}/mapbox-gl.js`;
      s.async = true;
      s.onload = () => (window.mapboxgl ? resolve() : reject(new Error('mb_load')));
      s.onerror = () => reject(new Error('mb_load'));
      document.head.append(s);
      setTimeout(() => reject(new Error('mb_timeout')), 15000);
    });
  }

  function createGLRenderer(gl, style, token) {
    if (token) gl.accessToken = token;
    const map = new gl.Map({
      container: mapEl,
      style,
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: Boolean(token),   // Mapbox : logo/crédit natif ; OpenFreeMap : crédit en pied de page
      cooperativeGestures: true,     // défilement de la page préservé sur mobile
      pitchWithRotate: false,
      dragRotate: false,
    });
    map.addControl(new gl.NavigationControl({ showCompass: false }), 'top-left');
    map.touchZoomRotate.disableRotation();

    // sécurité : on masque les noms de rues et les adresses, on garde les villes
    const hideStreets = () => {
      (map.getStyle().layers || []).forEach((l) => {
        if (l.type === 'symbol' && /road|street|highway|poi|transit|airport|aerodrome|settlement-subdivision|housenum|address|shield/i.test(l.id)) {
          map.setLayoutProperty(l.id, 'visibility', 'none');
        }
      });
    };
    map.on('style.load', hideStreets);

    let markers = [];
    const place = (list) => {
      markers.forEach((mk) => mk.remove());
      markers = [];
      const located = list.filter((t) => t.located);
      located.forEach((t) => {
        const el = document.createElement('div');
        el.className = `truck-pin gm-truck gl-truck${isLive(t) ? ' is-live' : ''}`;
        el.title = t.name;
        el.innerHTML = truckPin(t);
        markers.push(new gl.Marker({ element: el, anchor: 'center' }).setLngLat([t.lng, t.lat]).addTo(map));
      });
      if (located.length === 1) map.easeTo({ center: [located[0].lng, located[0].lat], zoom: MAX_ZOOM, duration: 0 });
      else if (located.length > 1) {
        const b = new gl.LngLatBounds();
        located.forEach((t) => b.extend([t.lng, t.lat]));
        map.fitBounds(b, { padding: 70, maxZoom: MAX_ZOOM, duration: 0 });
      } else map.easeTo({ center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], zoom: DEFAULT_ZOOM, duration: 0 });
    };
    window.addEventListener('resize', () => map.resize());
    return { draw: place };
  }

  const MAPLIBRE_BASE = 'assets/vendor/maplibre/maplibre-gl';

  function loadMapLibre() {
    return new Promise((resolve, reject) => {
      if (window.maplibregl) return resolve();
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${MAPLIBRE_BASE}.css`;
      document.head.append(css);
      const s = document.createElement('script');
      s.src = `${MAPLIBRE_BASE}.js`;
      s.async = true;
      s.onload = () => (window.maplibregl ? resolve() : reject(new Error('ml_load')));
      s.onerror = () => reject(new Error('ml_load'));
      document.head.append(s);
      setTimeout(() => reject(new Error('ml_timeout')), 15000);
    });
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
            icon: L.divIcon({ className: `truck-pin${isLive(t) ? ' is-live' : ''}`, html: truckPin(t), iconSize: [56, 56], iconAnchor: [28, 28] }),
          }).addTo(layer);
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
    if (cfg.mapboxToken) {
      try {
        await loadMapbox();
        const style = cfg.mapboxStyle || 'mapbox://styles/mapbox/dark-v11';
        renderer = createGLRenderer(window.mapboxgl, style, cfg.mapboxToken);
        mapEl.classList.add('is-mapbox');
        if (/dark|night|satellite/i.test(style)) mapEl.classList.add('is-dark');
      } catch {
        renderer = null;
        mapEl.replaceChildren();
      }
    }
    if (!renderer && cfg.googleMapsKey) {
      try {
        await loadGoogle(cfg.googleMapsKey);
        renderer = createGoogleRenderer();
        mapEl.classList.add('is-google');
      } catch {
        mapEl.replaceChildren();      // nettoie un éventuel message d'erreur Google
      }
    }
    if (!renderer) {
      try {
        await loadMapLibre();
        if (!maplibregl.supported || maplibregl.supported()) {
          const name = cfg.openfreemapStyle || 'dark';
          renderer = createGLRenderer(window.maplibregl, `https://tiles.openfreemap.org/styles/${encodeURIComponent(name)}`, '');
          mapEl.classList.add('is-openfreemap');
          if (/dark|fiord/i.test(name)) mapEl.classList.add('is-dark');
        }
      } catch {
        renderer = null;
        mapEl.replaceChildren();
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
