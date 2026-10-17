// Chargement et contrôle des fichiers de configuration modifiables sans code : config/pieces.json et config/textes.json.
// Une erreur de saisie dans ces fichiers bloque le démarrage avec un message précis, plutôt qu'un bug en cours d'usage.
import fs from 'node:fs';
import path from 'node:path';

const PAGES = new Set(['recto_verso', 'une', 'plusieurs']);
const ABREV = /^[A-Z][A-Z0-9_]{0,11}$/;

export function chargerCatalogue(dossier) {
  const brut = JSON.parse(fs.readFileSync(path.join(dossier, 'pieces.json'), 'utf8'));
  const pieces = new Map();
  for (const p of brut.pieces || []) {
    if (!ABREV.test(p.abrev || '')) throw new Error(`pieces.json : abréviation invalide « ${p.abrev} »`);
    if (pieces.has(p.abrev)) throw new Error(`pieces.json : abréviation en double « ${p.abrev} »`);
    if (!p.libelle) throw new Error(`pieces.json : libellé manquant pour ${p.abrev}`);
    if (p.choix) {
      if (!Array.isArray(p.choix) || p.choix.length < 2) throw new Error(`pieces.json : « choix » de ${p.abrev} doit lister au moins deux pièces`);
    } else if (!PAGES.has(p.pages)) {
      throw new Error(`pieces.json : « pages » de ${p.abrev} doit valoir recto_verso, une ou plusieurs`);
    }
    pieces.set(p.abrev, { ...p, controle_seulement: Boolean(p.controle_seulement), choix: p.choix || null });
  }
  for (const p of pieces.values()) {
    for (const c of p.choix || []) {
      if (!pieces.has(c) || pieces.get(c).choix) throw new Error(`pieces.json : le choix « ${c} » de ${p.abrev} n'est pas une pièce simple`);
    }
  }
  const modeles = {};
  for (const type of ['embauche', 'mise_a_jour']) {
    const liste = brut.modeles?.[type] || [];
    for (const abrev of liste) if (!pieces.has(abrev)) throw new Error(`pieces.json : modèle ${type}, pièce inconnue « ${abrev} »`);
    modeles[type] = liste;
  }

  // Pièces qu'une pièce « au choix » recouvre (CNI_PASS → CNI, PASS) : on ne peut pas cocher les deux.
  function conflits(selection) {
    const ensemble = new Set(selection);
    const trouves = [];
    for (const abrev of selection) {
      for (const c of pieces.get(abrev)?.choix || []) if (ensemble.has(c)) trouves.push([abrev, c]);
    }
    return trouves;
  }

  return { pieces, modeles, liste: [...pieces.values()], conflits };
}

export function chargerTextes(dossier) {
  const textes = JSON.parse(fs.readFileSync(path.join(dossier, 'textes.json'), 'utf8'));
  const requis = [
    ['nom_expediteur'], ['lien_connexion', 'sujet'], ['lien_connexion', 'texte'],
    ['invitation', 'embauche', 'sujet'], ['invitation', 'embauche', 'intro'],
    ['invitation', 'mise_a_jour', 'sujet'], ['invitation', 'mise_a_jour', 'intro'], ['invitation', 'texte'],
  ];
  for (const chemin of requis) {
    if (typeof chemin.reduce((o, k) => o?.[k], textes) !== 'string') throw new Error(`textes.json : « ${chemin.join(' › ')} » manquant`);
  }
  return textes;
}

// Remplace {{nom}} par sa valeur. Un mot inconnu reste visible, pour qu'une faute de frappe se remarque à la relecture.
export function remplir(modele, valeurs) {
  return modele.replace(/\{\{(\w+)\}\}/g, (tout, cle) => (cle in valeurs ? String(valeurs[cle]) : tout));
}
