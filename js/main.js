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

  /* ---------- Réservation (front uniquement) ---------- */
  function initBooking() {
    const root = $('#reservation');
    if (!root) return;

    const daysEl = $('#cal-days', root);
    const titleEl = $('#cal-title', root);
    const slotsEl = $('#slots-grid', root);
    const slotsDateEl = $('#slots-date', root);
    const prevBtn = $('[data-cal="prev"]', root);
    const nextBtn = $('[data-cal="next"]', root);
    const confirmBtn = $('#booking-confirm', root);
    const statusEl = $('#booking-status', root);
    const steps = $$('.steps__item', root);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const state = {
      view: new Date(today.getFullYear(), today.getMonth(), 1),
      date: new Date(today),
      slot: null,
      service: $('input[name="service"]:checked', root)?.dataset.label || '',
    };

    const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const longDate = (d) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

    function setStep(n) {
      steps.forEach((li, i) => {
        li.classList.toggle('is-done', i + 1 < n);
        li.classList.toggle('is-current', i + 1 === n);
      });
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
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'slot';
        b.textContent = time;
        b.dataset.time = time;
        b.setAttribute('aria-pressed', String(state.slot === time));
        if (state.slot === time) b.classList.add('is-selected');
        frag.append(b);
      });
      slotsEl.replaceChildren(frag);
    }

    function updateConfirm() {
      const ready = Boolean(state.slot);
      confirmBtn.setAttribute('aria-disabled', String(!ready));
      confirmBtn.classList.remove('is-done');
      confirmBtn.querySelector('span').textContent = 'Confirmer mon rendez-vous';
    }

    // prestation
    root.addEventListener('change', (e) => {
      if (e.target.name !== 'service') return;
      state.service = e.target.dataset.label;
      statusEl.textContent = '';
      setStep(2);
    });

    // mois précédent / suivant
    prevBtn.addEventListener('click', () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1); renderCalendar(); });
    nextBtn.addEventListener('click', () => { state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1); renderCalendar(); });

    // date
    daysEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.day');
      if (!btn || btn.disabled) return;
      state.date = new Date(state.view.getFullYear(), state.view.getMonth(), Number(btn.dataset.day));
      state.slot = null;
      statusEl.textContent = '';
      renderCalendar();
      renderSlots();
      updateConfirm();
      setStep(3);
    });

    // créneau
    slotsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.slot');
      if (!btn) return;
      state.slot = btn.dataset.time;
      statusEl.textContent = '';
      renderSlots();
      updateConfirm();
      setStep(3);
    });

    // confirmation (démonstration : aucun envoi de données)
    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.getAttribute('aria-disabled') === 'true') {
        statusEl.textContent = 'Choisissez un horaire pour continuer.';
        return;
      }
      statusEl.textContent = `${state.service} · ${cap(longDate(state.date))} · ${state.slot}`;
      confirmBtn.classList.add('is-done');
      confirmBtn.querySelector('span').textContent = 'Sélection enregistrée';
    });

    // CTA des cartes prestations → présélection + défilement vers la réservation
    $$('[data-service]').forEach((link) => {
      link.addEventListener('click', () => {
        const input = $(`input[name="service"][value="${link.dataset.service}"]`, root);
        if (!input) return;
        input.checked = true;
        state.service = input.dataset.label;
        setStep(2);
      });
    });

    renderCalendar();
    renderSlots();
    updateConfirm();
  }

  initHeader();
  initActiveLink();
  initReveal();
  initVideos();
  initBooking();
})();
