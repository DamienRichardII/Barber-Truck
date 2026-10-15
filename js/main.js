(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Données de démonstration ---------- */
  /* Planning à la demi-heure. Durée d'un rendez-vous = 30 min de déplacement + 30 min par personne
     (1 personne : 1 h, 2 personnes : 1 h 30, groupe de 3 : 2 h…). Tout doit se terminer avant 05h30. */
  const OPEN = 18 * 60;          // premier départ possible : 18h00
  const LAST_START = 26 * 60 + 30;   // dernier départ proposé : 02h30
  const CLOSE = 29 * 60 + 30;    // un rendez-vous doit se terminer avant 05h30 (lendemain)
  const TRAVEL = 30;
  const PER_PERSON = 30;
  const PRICE_PER_PERSON = 25;   // 25 € par personne : 1 pers. 25 €, duo 50 €, trio 75 €, groupe de 4 100 €…
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtMin = (m) => `${pad2(Math.floor((m % 1440) / 60))}h${pad2(m % 60)}`;
  const toMin = (t) => { const h = parseInt(t, 10); return h * 60 + parseInt(t.slice(3), 10) + (h < 6 ? 1440 : 0); };
  const durationFor = (n) => TRAVEL + PER_PERSON * n;
  const fmtDuration = (min) => { const h = Math.floor(min / 60); const m = min % 60; return h ? (m ? `${h} h ${pad2(m)}` : `${h} h`) : `${m} min`; };
  const SLOTS = [];
  for (let m = OPEN; m <= LAST_START; m += 30) SLOTS.push(fmtMin(m));   // 18h00 … 02h30
  const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

  /* ---------- Header : ombre au scroll + menu mobile ---------- */
  function initHeader() {
    const header = $('.site-header');
    const burger = $('.burger');
    const nav = $('#menu');

    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const setMenu = (open) => {
      nav.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
    };
    burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
    window.matchMedia('(min-width: 1180px)').addEventListener('change', () => setMenu(false));
  }

  /* ---------- Lien actif dans le menu ---------- */
  function initActiveLink() {
    const links = $$('.nav__link');
    const map = new Map(links.map((l) => [l.getAttribute('href').slice(1), l]));
    const targets = ['accueil', 'prestations', 'reservation', 'concept', 'galerie', 'contact']
      .map((id) => document.getElementById(id)).filter(Boolean);
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((l) => { l.classList.remove('is-active'); l.removeAttribute('aria-current'); });
        const link = map.get(en.target.id);
        if (link) { link.classList.add('is-active'); link.setAttribute('aria-current', 'page'); }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    targets.forEach((t) => io.observe(t));
  }

  /* ---------- Apparition au scroll ---------- */
  function initReveal() {
    const items = $$('.reveal');
    if (!('IntersectionObserver' in window) || reducedMotion) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    // léger décalage entre éléments frères
    $$('.services__grid, .gallery__grid').forEach((grid) => {
      $$('.reveal', grid).forEach((el, i) => el.style.setProperty('--d', `${i * 0.08}s`));
    });
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-visible');
        obs.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    items.forEach((el) => io.observe(el));
  }

  /* ---------- Vidéos : lecture uniquement quand visibles ---------- */
  function initVideos() {
    const videos = $$('video');
    if (!videos.length) return;

    if (reducedMotion || !('IntersectionObserver' in window)) {
      // pas de lecture automatique : un clic lance / met en pause
      videos.forEach((v) => {
        v.style.cursor = 'pointer';
        v.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
      });
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const v = en.target;
        if (en.isIntersecting) v.play().catch(() => {});
        else v.pause();
      });
    }, { threshold: 0.35 });
    videos.forEach((v) => io.observe(v));
  }

  /* ---------- Réservation ---------- */
  function initBooking() {
    const root = $('#reservation');
    if (!root) return;

    const api = window.BarberAPI;
    const daysEl = $('#cal-days', root);
    const titleEl = $('#cal-title', root);
    const slotsEl = $('#slots-grid', root);
    const slotsDateEl = $('#slots-date', root);
    const rangeEl = $('#slots-range', root);
    const prevBtn = $('[data-cal="prev"]', root);
    const nextBtn = $('[data-cal="next"]', root);
    const form = $('#booking-form', root);
    const fieldsEl = $('#booking-fields', root);
    const partyInput = $('#f-party', root);
    const durationEl = $('#party-duration', root);
    const priceEl = $('#party-price', root);
    const confirmBtn = $('#booking-confirm', root);
    const statusEl = $('#booking-status', root);
    const doneEl = $('#booking-done', root);
    const doneText = $('#booking-done-text', root);
    const steps = $$('.steps__item', root);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const state = {
      view: new Date(today.getFullYear(), today.getMonth(), 1),
      date: new Date(today),
      slot: null,
      service: '',
      serviceLabel: '',
      busy: new Map(), // "YYYY-MM-DD" -> [[début, fin], …] en minutes (rendez-vous confirmés)
      sending: false,
    };

    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sameDay = (a, b) => a && b && iso(a) === iso(b);
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const longDate = (d) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

    /* heure de Paris (le créneau 00h00-02h00 d'une soirée tombe le lendemain) */
    const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    function parisNow() {
      const p = Object.fromEntries(PARIS.formatToParts(new Date()).map((x) => [x.type, x.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
    }
    function isPast(d, time) {
      const h = parseInt(time, 10);
      const [y, mo, da] = iso(d).split('-').map(Number);
      const slotDate = new Date(Date.UTC(y, mo - 1, da + (h < 6 ? 1 : 0))).toISOString().slice(0, 10);
      const now = parisNow();
      return slotDate < now.date || (slotDate === now.date && h * 60 + parseInt(time.slice(3), 10) <= now.minutes);
    }
    const fmtPhone = (p) => (/^0\d{9}$/.test(p) ? p.replace(/(\d{2})(?=\d)/g, '$1 ') : p);

    /* nombre de personnes (toujours dans la plage autorisée pour la prestation) → durée */
    const partyCount = () => {
      const n = Number(partyInput.value);
      const lo = Number(partyInput.min);
      const hi = Number(partyInput.max);
      return Number.isInteger(n) && n >= lo && n <= hi ? n : lo;
    };
    const currentDuration = () => durationFor(partyCount());

    /* 'late' = finirait après 05h30 · 'past' = déjà passé · 'busy' = chevauche un rendez-vous confirmé · null = libre */
    function slotStatus(d, time) {
      const start = toMin(time);
      const end = start + currentDuration();
      if (end > CLOSE) return 'late';
      if (isPast(d, time)) return 'past';
      const list = state.busy.get(iso(d)) || [];
      return list.some(([s, e]) => s < end && start < e) ? 'busy' : null;
    }

    function setStatus(msg, isError = false) {
      statusEl.textContent = msg;
      statusEl.classList.toggle('is-error', isError);
    }

    function setStep(n) {
      steps.forEach((li, i) => {
        li.classList.toggle('is-done', i + 1 < n);
        li.classList.toggle('is-current', i + 1 === n);
      });
    }

    function updateDuration() {
      const n = partyCount();
      durationEl.textContent = `Durée du rendez-vous : ${fmtDuration(durationFor(n))} (30 min de déplacement + 30 min par personne).`;
      priceEl.textContent = `Prix : ${n * PRICE_PER_PERSON} €${n > 1 ? ` (${n} × ${PRICE_PER_PERSON} €)` : ''}`;
    }

    function readService() {
      const input = $('input[name="service"]:checked', root);
      state.service = input ? input.value : '';
      state.serviceLabel = input ? input.dataset.label : '';
      const group = state.service === 'offre-groupe';
      const pl = $('#l-party', root);
      partyInput.min = group ? '3' : '1';
      partyInput.max = group ? '17' : '2';
      pl.textContent = group ? 'Nombre de personnes (minimum 3)' : 'Nombre de personnes (1 ou 2)';
      const cur = Number(partyInput.value);
      if (!Number.isInteger(cur) || cur < Number(partyInput.min) || cur > Number(partyInput.max)) partyInput.value = partyInput.min;
    }

    /* après un changement de prestation / de nombre de personnes : la durée change, donc les créneaux libres aussi */
    function refresh() {
      updateDuration();
      if (state.slot && slotStatus(state.date, state.slot)) state.slot = null;
      renderSlots();
      updateForm();
    }

    /* créneaux déjà pris (début + durée), pour le mois affiché */
    async function loadBusy() {
      if (!api || !api.isConfigured) return;
      const from = new Date(state.view.getFullYear(), state.view.getMonth(), 1);
      const to = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 0);
      try {
        const rows = await api.getBusySlots(iso(from), iso(to));
        const monthKey = iso(from).slice(0, 7);
        [...state.busy.keys()].filter((k) => k.startsWith(monthKey)).forEach((k) => state.busy.delete(k));
        rows.forEach((r) => {
          const start = toMin(r.slot_time);
          const list = state.busy.get(r.slot_date) || [];
          list.push([start, start + (r.duration_min || 60)]);
          state.busy.set(r.slot_date, list);
        });
        refresh();
      } catch { /* on garde l'affichage actuel : l'envoi vérifiera de toute façon */ }
    }

    function renderCalendar() {
      const { view } = state;
      titleEl.textContent = `${MONTHS[view.getMonth()]} ${view.getFullYear()}`;
      prevBtn.disabled = view <= new Date(today.getFullYear(), today.getMonth(), 1);

      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const offset = (first.getDay() + 6) % 7; // semaine commençant le lundi
      const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const frag = document.createDocumentFragment();

      for (let i = 0; i < offset; i++) frag.append(document.createElement('span'));
      for (let n = 1; n <= count; n++) {
        const d = new Date(view.getFullYear(), view.getMonth(), n);
        const past = d < today;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day';
        btn.textContent = n;
        btn.dataset.day = n;
        if (past) {
          btn.classList.add('day--disabled');
          btn.disabled = true;
        } else {
          btn.classList.add(sameDay(d, state.date) ? 'day--selected' : 'day--available');
          btn.setAttribute('aria-label', longDate(d));
          btn.setAttribute('aria-pressed', String(sameDay(d, state.date)));
        }
        frag.append(btn);
      }
      daysEl.replaceChildren(frag);
    }

    const LABELS = { busy: 'indisponible', past: 'horaire passé', late: 'trop tard pour cette durée' };
    function renderSlots() {
      slotsDateEl.textContent = longDate(state.date);
      const frag = document.createDocumentFragment();
      SLOTS.forEach((time) => {
        const status = slotStatus(state.date, time);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'slot';
        b.dataset.time = time;
        b.textContent = time;
        if (status) {
          b.disabled = true;
          b.classList.add('slot--booked');
          b.setAttribute('aria-label', `${time} – ${LABELS[status]}`);
        } else {
          b.setAttribute('aria-pressed', String(state.slot === time));
          if (state.slot === time) b.classList.add('is-selected');
        }
        frag.append(b);
      });
      slotsEl.replaceChildren(frag);
      rangeEl.textContent = state.slot
        ? `Votre rendez-vous : de ${state.slot} à ${fmtMin(toMin(state.slot) + currentDuration())} (déplacement inclus).`
        : '';
    }

    /* champs de contact visibles dès qu'un créneau est choisi */
    function updateForm() {
      const ready = Boolean(state.slot);
      fieldsEl.hidden = !ready;
      confirmBtn.setAttribute('aria-disabled', String(!ready));
    }

    function clearInvalid() {
      $$('[aria-invalid]', root).forEach((el) => el.removeAttribute('aria-invalid'));
    }

    function validate() {
      clearInvalid();
      const f = form.elements;
      const phone = f.phone.value.replace(/[^\d+]/g, '');
      const group = state.service === 'offre-groupe';
      const lo = Number(partyInput.min);
      const hi = Number(partyInput.max);
      const n = Number(partyInput.value);
      const checks = [
        [f.name, f.name.value.trim().length >= 2, 'Merci d\'indiquer votre nom et prénom.'],
        [f.phone, /^\+?\d{9,15}$/.test(phone), 'Merci d\'indiquer un numéro de téléphone valide.'],
        [f.address, f.address.value.trim().length >= 8, 'Merci d\'indiquer votre adresse complète.'],
        [partyInput, Number.isInteger(n) && n >= lo && n <= hi, group ? `L'offre groupe demande entre ${lo} et ${hi} personnes.` : 'Indiquez 1 ou 2 personnes (à partir de 3, choisissez l\'offre groupe).'],
      ];
      const bad = checks.find(([, ok]) => !ok);
      if (bad) {
        bad[0].setAttribute('aria-invalid', 'true');
        bad[0].focus();
        setStatus(bad[2], true);
        return null;
      }
      return {
        name: f.name.value.trim(),
        phone,
        address: f.address.value.trim(),
        partySize: n,
      };
    }

    function resetFlow() {
      doneEl.hidden = true;
      form.hidden = false;
      form.reset();
      state.slot = null;
      setStatus('');
      setStep(1);
      readService();
      partyInput.value = partyInput.min;
      refresh();
    }

    /* prestation */
    root.addEventListener('change', (e) => {
      if (e.target.name !== 'service') return;
      readService();
      partyInput.value = partyInput.min;
      setStatus('');
      setStep(2);
      refresh();
    });

    /* nombre de personnes : champ + boutons − / + */
    partyInput.addEventListener('input', () => { setStatus(''); refresh(); });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-party]');
      if (!btn) return;
      const next = partyCount() + Number(btn.dataset.party);
      partyInput.value = Math.min(Number(partyInput.max), Math.max(Number(partyInput.min), next));
      setStatus('');
      refresh();
    });

    /* mois précédent / suivant */
    const changeMonth = (delta) => {
      state.view = new Date(state.view.getFullYear(), state.view.getMonth() + delta, 1);
      renderCalendar();
      loadBusy();
    };
    prevBtn.addEventListener('click', () => changeMonth(-1));
    nextBtn.addEventListener('click', () => changeMonth(1));

    /* date */
    daysEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.day');
      if (!btn || btn.disabled) return;
      state.date = new Date(state.view.getFullYear(), state.view.getMonth(), Number(btn.dataset.day));
      state.slot = null;
      setStatus('');
      renderCalendar();
      renderSlots();
      updateForm();
      setStep(3);
    });

    /* créneau */
    slotsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.slot');
      if (!btn || btn.disabled) return;
      state.slot = btn.dataset.time;
      setStatus('');
      renderSlots();
      updateForm();
      setStep(3);
    });

    /* envoi de la demande */
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (state.sending) return;
      if (!state.slot) {
        setStatus('Choisissez un horaire pour continuer.', true);
        return;
      }
      if (form.elements.website.value) return; // anti-spam (champ piège)
      const contact = validate();
      if (!contact) return;
      if (slotStatus(state.date, state.slot)) {
        state.slot = null;
        refresh();
        setStatus('Cet horaire n\'est plus disponible. Merci d\'en choisir un autre.', true);
        return;
      }

      state.sending = true;
      confirmBtn.classList.add('is-loading');
      confirmBtn.setAttribute('aria-disabled', 'true');
      setStatus('Envoi de votre demande…');
      const sent = { price: contact.partySize * PRICE_PER_PERSON, date: new Date(state.date), time: state.slot, end: fmtMin(toMin(state.slot) + durationFor(contact.partySize)) };
      try {
        await api.createBooking({
          service: state.service,
          partySize: contact.partySize,
          date: iso(sent.date),
          time: sent.time,
          name: contact.name,
          phone: contact.phone,
          email: '',
          address: contact.address,
        });
        form.hidden = true;
        doneText.textContent = `${state.serviceLabel} · ${cap(longDate(sent.date))} de ${sent.time} à ${sent.end} · ${sent.price} €. `
          + `Votre créneau est en attente de confirmation de notre part. Dès qu'il est confirmé, vous recevrez un SMS au ${fmtPhone(contact.phone)}. `
          + `Une question ? Appelez-nous ou écrivez-nous sur WhatsApp au 07 59 04 73 74.`;
        doneEl.hidden = false;
        setStep(3);
        steps.forEach((li) => li.classList.add('is-done'));
        renderSlots();
        doneEl.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
      } catch (err) {
        setStatus(api.message(err.code), true);
        if (err.code === 'slot_taken' || err.code === 'slot_passed' || err.code === 'invalid_slot') { state.slot = null; updateForm(); }
        loadBusy();
      } finally {
        state.sending = false;
        confirmBtn.classList.remove('is-loading');
        confirmBtn.setAttribute('aria-disabled', String(!state.slot));
      }
    });
    $('#booking-reset', root).addEventListener('click', resetFlow);

    /* CTA des cartes prestations : présélection puis défilement vers la réservation */
    $$('[data-service]').forEach((link) => {
      link.addEventListener('click', () => {
        const input = $(`input[name="service"][value="${link.dataset.service}"]`, root);
        if (!input) return;
        input.checked = true;
        readService();
        partyInput.value = partyInput.min;
        refresh();
        setStep(2);
      });
    });

    /* mise à jour quand l'onglet redevient visible */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      loadBusy();
      refresh();
    });

    readService();
    updateDuration();
    renderCalendar();
    renderSlots();
    updateForm();
    loadBusy();
  }

  initHeader();
  initActiveLink();
  initReveal();
  initVideos();
  initBooking();
})();
