// Réglages modifiables depuis l'administration, stockés en base (table reglages, valeurs JSON).
export function creerReglages(db) {
  const lireLigne = db.prepare('SELECT valeur FROM reglages WHERE cle = ?');
  const ecrireLigne = db.prepare('INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur');

  function lire(cle, defaut) {
    const ligne = lireLigne.get(cle);
    if (!ligne) return defaut;
    try { return JSON.parse(ligne.valeur); } catch { return defaut; }
  }
  function ecrire(cle, valeur) { ecrireLigne.run(cle, JSON.stringify(valeur)); }

  // Domaines autorisés pour les comptes des assistantes. Liste vide : tous les domaines.
  const domaines = () => lire('domaines_autorises', []);
  function domaineAutorise(email) {
    const liste = domaines();
    return liste.length === 0 || liste.includes(String(email).split('@')[1]);
  }

  return { lire, ecrire, domaines, domaineAutorise };
}

const DOMAINE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// « exemple.fr, autre.fr » → ['exemple.fr', 'autre.fr'] ; null si un domaine est invalide.
export function analyserDomaines(texte) {
  const liste = [...new Set(String(texte || '').toLowerCase().split(/[\s,;]+/).map((d) => d.replace(/^@/, '')).filter(Boolean))];
  return liste.every((d) => DOMAINE.test(d)) ? liste : null;
}
