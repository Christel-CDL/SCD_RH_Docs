// Limitation de débit en mémoire, par clé (adresse IP, e-mail…), sur une fenêtre glissante.
// Suffisant pour un seul conteneur ; remis à zéro au redémarrage, ce qui est acceptable.
export function creerLimiteur() {
  const traces = new Map(); // clé → horodatages

  function depasse(cle, max, fenetreMs, maintenant = Date.now()) {
    const liste = (traces.get(cle) || []).filter((t) => maintenant - t < fenetreMs);
    liste.push(maintenant);
    traces.set(cle, liste);
    return liste.length > max;
  }

  function nettoyer(maintenant = Date.now(), fenetreMaxMs = 3600e3) {
    for (const [cle, liste] of traces) if (!liste.some((t) => maintenant - t < fenetreMaxMs)) traces.delete(cle);
  }

  return { depasse, nettoyer };
}
