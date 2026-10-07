/* Configuration Supabase (la clé "publishable" est publique par conception :
   la sécurité repose sur les règles RLS définies dans supabase/schema.sql). */
window.BT_CONFIG = {
  supabaseUrl: 'https://ebmprxugtwbxdemymlqh.supabase.co',
  mapboxToken: '',     // jeton public Mapbox (pk.…), restreint à ton domaine ; vide = autre carte
  mapboxStyle: 'mapbox://styles/mapbox/dark-v11',   // ou 'mapbox://styles/mapbox/light-v11'
  openfreemapStyle: 'dark',   // carte gratuite sans clé : 'dark', 'positron', 'liberty', 'bright' ou 'fiord'
  googleMapsKey: '',   // clé Google Maps JavaScript API (restreinte à ton domaine) ; vide = carte OpenStreetMap
  supabaseKey: 'sb_publishable_Wwq9ArF08qv4cLXbx_NddA_SWHZRzie',
};
