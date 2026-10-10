/* Appels à Supabase (REST). Aucune dépendance. */
window.BarberAPI = (() => {
  'use strict';

  const cfg = window.BT_CONFIG || {};
  const isConfigured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);

  const ERRORS = {
    slot_taken: 'Ce créneau vient d\'être pris. Merci d\'en choisir un autre.',
    invalid_phone: 'Numéro de téléphone invalide.',
    invalid_name: 'Merci d\'indiquer votre nom et prénom.',
    invalid_email: 'Merci d\'indiquer une adresse e-mail valide.',
    invalid_address: 'Merci d\'indiquer une adresse complète.',
    invalid_party_size: 'Nombre de personnes invalide pour cette prestation.',
    invalid_date: 'Cette date n\'est pas disponible.',
    invalid_slot: 'Cet horaire n\'est pas disponible.',
    too_many_requests: 'Vous avez déjà plusieurs demandes en attente de confirmation.',
    not_configured: 'La réservation en ligne n\'est pas encore ouverte.',
    network: 'Connexion impossible. Vérifiez votre réseau et réessayez.',
    unknown: 'Une erreur est survenue. Merci de réessayer.',
  };

  async function rpc(name, body) {
    if (!isConfigured) throw Object.assign(new Error('not_configured'), { code: 'not_configured' });
    let res;
    try {
      res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: cfg.supabaseKey,
          Authorization: `Bearer ${cfg.supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('network'), { code: 'network' });
    }
    if (!res.ok) {
      let code = 'unknown';
      try {
        const data = await res.json();
        if (data && ERRORS[data.message]) code = data.message;
      } catch { /* réponse non JSON */ }
      throw Object.assign(new Error(code), { code });
    }
    return res.json();
  }

  /** Créneaux pris (en attente ou confirmés) entre deux dates ISO (YYYY-MM-DD). */
  const getTakenSlots = (from, to) => rpc('get_taken_slots', { p_from: from, p_to: to });

  const createBooking = (b) => rpc('create_booking', {
    p_service: b.service,
    p_party_size: b.partySize,
    p_date: b.date,
    p_time: b.time,
    p_name: b.name,
    p_phone: b.phone,
    p_email: b.email,
    p_address: b.address,
  });

  /** Dernière position (arrondie à l'échelle d'une ville) de chaque Barber Truck actif. */
  const getTruckPositions = () => rpc('get_truck_positions', {});

  const message = (code) => ERRORS[code] || ERRORS.unknown;

  return { isConfigured, getTakenSlots, createBooking, getTruckPositions, message };
})();
