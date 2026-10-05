(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Données de démonstration ---------- */
  const SLOTS = ['18h00', '19h00', '20h00', '21h00', '22h00', '23h00', '00h00', '01h00', '02h00'];
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
    const prevBtn = $('[data-cal="prev"]', root);
    const nextBtn = $('[data-cal="next"]', root);
    const form = $('#booking-form', root);
    const fieldsEl = $('#booking-fields', root);
    const partyField = $('#field-party', root);
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
      taken: new Map(), // "YYYY-MM-DD|18h00" -> "pending" | "confirmed"
      sending: false,
    };

    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sameDay = (a, b) => a && b && iso(a) === iso(b);
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const longDate = (d) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const takenStatus = (d, time) => state.taken.get(`${iso(d)}|${time}`);

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

    function readService() {
      const input = $('input[name="service"]:checked', root);
      state.service = input ? input.value : '';
      state.serviceLabel = input ? input.dataset.label : '';
      partyField.hidden = state.service !== 'offre-groupe';
    }

    /* créneaux déjà pris, pour le mois affiché */
    async function loadTaken() {
      if (!api || !api.isConfigured) return;
      const from = new Date(state.view.getFullYear(), state.view.getMonth(), 1);
      const to = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 0);
      try {
        const rows = await api.getTakenSlots(iso(from), iso(to));
        const monthKey = iso(from).slice(0, 7);
        [...state.taken.keys()].filter((k) => k.startsWith(monthKey)).forEach((k) => state.taken.delete(k));
        rows.forEach((r) => state.taken.set(`${r.slot_date}|${r.slot_time}`, r.status));
        if (state.slot && takenStatus(state.date, state.slot)) { state.slot = null; updateForm(); }
        renderSlots();
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

    function renderSlots() {
      slotsDateEl.textContent = longDate(state.date);
      const frag = document.createDocumentFragment();
      SLOTS.forEach((time) => {
        const status = takenStatus(state.date, time);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'slot';
        b.dataset.time = time;
        if (status) {
          b.disabled = true;
          b.classList.add(status === 'pending' ? 'slot--pending' : 'slot--booked');
          const label = document.createElement('span');
          label.className = 'slot__time';
          label.textContent = time;
          b.append(label);
          if (status === 'pending') {
            const small = document.createElement('small');
            small.textContent = 'En attente';
            b.append(small);
          }
          b.setAttribute('aria-label', `${time} – ${status === 'pending' ? 'en attente de confirmation' : 'indisponible'}`);
        } else {
          b.textContent = time;
          b.setAttribute('aria-pressed', String(state.slot === time));
          if (state.slot === time) b.classList.add('is-selected');
        }
        frag.append(b);
      });
      slotsEl.replaceChildren(frag);
    }

    /* champs de contact visibles dès qu'un créneau est choisi */
    function updateForm() {
      const ready = Boolean(state.slot);
      fieldsEl.hidden = !ready;
      confirmBtn.setAttribute('aria-disabled', String(!ready));
    }

    function clearInvalid() {
      $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
    }

    function validate() {
      clearInvalid();
      const f = form.elements;
      const phone = f.phone.value.replace(/[^\d+]/g, '');
      const checks = [
        [f.name, f.name.value.trim().length >= 2, 'Merci d\'indiquer votre nom et prénom.'],
        [f.phone, /^\+?\d{9,15}$/.test(phone), 'Merci d\'indiquer un numéro de téléphone valide.'],
        [f.address, f.address.value.trim().length >= 8, 'Merci d\'indiquer votre adresse complète.'],
      ];
      if (state.service === 'offre-groupe') {
        const n = Number(f.party.value);
        checks.push([f.party, Number.isInteger(n) && n >= 3 && n <= 20, 'L\'offre groupe demande entre 3 et 20 personnes.']);
      }
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
        partySize: state.service === 'offre-groupe' ? Number(f.party.value) : 1,
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
      renderSlots();
      updateForm();
    }

    /* prestation */
    root.addEventListener('change', (e) => {
      if (e.target.name !== 'service') return;
      readService();
      setStatus('');
      setStep(2);
    });

    /* mois précédent / suivant */
    const changeMonth = (delta) => {
      state.view = new Date(state.view.getFullYear(), state.view.getMonth() + delta, 1);
      renderCalendar();
      loadTaken();
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

      state.sending = true;
      confirmBtn.classList.add('is-loading');
      confirmBtn.setAttribute('aria-disabled', 'true');
      setStatus('Envoi de votre demande…');
      const sent = { date: new Date(state.date), time: state.slot };
      try {
        await api.createBooking({
          service: state.service,
          partySize: contact.partySize,
          date: iso(sent.date),
          time: sent.time,
          name: contact.name,
          phone: contact.phone,
          address: contact.address,
        });
        state.taken.set(`${iso(sent.date)}|${sent.time}`, 'pending');
        form.hidden = true;
        doneText.textContent = `${state.serviceLabel} · ${cap(longDate(sent.date))} à ${sent.time}. `
          + `Votre créneau est en attente de confirmation de notre part. Nous vous contactons au ${contact.phone} pour le valider.`;
        doneEl.hidden = false;
        setStep(3);
        steps.forEach((li) => li.classList.add('is-done'));
        renderSlots();
        doneEl.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
      } catch (err) {
        setStatus(api.message(err.code), true);
        if (err.code === 'slot_taken') { state.slot = null; updateForm(); }
        loadTaken();
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
        setStep(2);
      });
    });

    /* mise à jour quand l'onglet redevient visible */
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadTaken(); });

    readService();
    renderCalendar();
    renderSlots();
    updateForm();
    loadTaken();
  }

  initHeader();
  initActiveLink();
  initReveal();
  initVideos();
  initBooking();
})();
