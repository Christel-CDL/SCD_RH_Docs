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
    pieces.set(p.abrev, { ...p, controle_seulement: Boolean(p.controle_seulement), choix: p.choix || null, dans_formulaire: p.dans_formulaire !== false });
  }
  for (const p of pieces.values()) {
    for (const c of p.choix || []) {
      if (!pieces.has(c) || pieces.get(c).choix) throw new Error(`pieces.json : le choix « ${c} » de ${p.abrev} n'est pas une pièce simple`);
    }
  }
  const modeles = {};
  for (const type of ['embauche', 'mise_a_jour']) {
    const liste = brut.modeles?.[type] || [];
    for (const abrev of liste) {
      if (!pieces.has(abrev)) throw new Error(`pieces.json : modèle ${type}, pièce inconnue « ${abrev} »`);
      if (!pieces.get(abrev).dans_formulaire) throw new Error(`pieces.json : modèle ${type}, « ${abrev} » n'est pas proposée dans le formulaire (dans_formulaire: false)`);
    }
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
    ['nom_expediteur'], ['lien_secours'], ['lien_connexion', 'sujet'], ['lien_connexion', 'texte'], ['lien_connexion', 'bouton'], ['invitation', 'bouton'],
    ['invitation', 'embauche', 'sujet'], ['invitation', 'embauche', 'intro'],
    ['invitation', 'mise_a_jour', 'sujet'], ['invitation', 'mise_a_jour', 'intro'], ['invitation', 'texte'],
    ...['sujet', 'texte', 'a_verifier', 'controle_seulement', 'mention_a_verifier', 'mention_controle_seulement', 'suite'].map((m) => ['envoi_final', m]),
    ['alerte', 'sujet'], ['alerte', 'texte'],
    ...['petite', 'floue', 'sombre', 'claire', 'reflet', 'forcer', 'bouton_forcer', 'pdf_lecture', 'pdf_pages', 'heic'].map((m) => ['lisibilite', m]),
  ];
  for (const chemin of requis) {
    if (typeof chemin.reduce((o, k) => o?.[k], textes) !== 'string') throw new Error(`textes.json : « ${chemin.join(' › ')} » manquant`);
  }
  return textes;
}

// config/controles.json : seuils de lisibilité, réencodage des photos, taille des PDF.
export function chargerControles(dossier) {
  const brut = JSON.parse(fs.readFileSync(path.join(dossier, 'controles.json'), 'utf8'));
  const bornes = {
    'lisibilite.petit_cote_min_px': [200, 4000],
    'lisibilite.nettete_min': [0, 255],
    'lisibilite.luminosite_min': [0, 255],
    'lisibilite.luminosite_max': [0, 255],
    'lisibilite.reflet_max_pourcent': [0, 100],
    'lisibilite.echecs_avant_forcer': [1, 10],
    'photo.cote_max_px': [1000, 6000],
    'photo.qualite_jpeg': [0.3, 1],
    'pdf.objectif_ko': [100, 4000],
    'pdf.plafond_ko': [500, 4000],
  };
  for (const [chemin, [min, max]] of Object.entries(bornes)) {
    const valeur = chemin.split('.').reduce((o, k) => o?.[k], brut);
    if (typeof valeur !== 'number' || valeur < min || valeur > max) {
      throw new Error(`controles.json : « ${chemin.replace('.', ' › ')} » doit être un nombre entre ${min} et ${max}`);
    }
  }
  const { lisibilite: l, photo, pdf } = brut;
  if (l.luminosite_min >= l.luminosite_max) throw new Error('controles.json : luminosite_min doit être inférieure à luminosite_max');
  if (pdf.objectif_ko > pdf.plafond_ko) throw new Error('controles.json : objectif_ko ne peut pas dépasser plafond_ko');
  const sansAide = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== '_aide'));
  return { lisibilite: sansAide(l), photo: sansAide(photo), pdf: sansAide(pdf) };
}

// config/envoi.json : découpage des envois, quota d'e-mails, nouvelles tentatives.
export function chargerReglagesEnvoi(dossier) {
  const brut = JSON.parse(fs.readFileSync(path.join(dossier, 'envoi.json'), 'utf8'));
  const nombre = (cle, min, max) => {
    if (typeof brut[cle] !== 'number' || brut[cle] < min || brut[cle] > max) {
      throw new Error(`envoi.json : « ${cle} » doit être un nombre entre ${min} et ${max}`);
    }
    return brut[cle];
  };
  const delais = brut.nouvelles_tentatives_minutes;
  if (!Array.isArray(delais) || delais.length < 1 || delais.length > 10 || delais.some((d) => typeof d !== 'number' || d < 1 || d > 1440)) {
    throw new Error('envoi.json : « nouvelles_tentatives_minutes » doit lister de 1 à 10 délais, en minutes (1 à 1440)');
  }
  return {
    seuilDecoupageOctets: nombre('seuil_decoupage_mo', 4, 19) * 1024 * 1024,
    quotaJournalier: nombre('quota_journalier', 1, 300),
    alerteQuotaPourcent: nombre('alerte_quota_pourcent', 10, 100),
    delaisMs: delais.map((d) => d * 60e3),
    silenceMs: nombre('silence_alerte_heures', 1, 48) * 3600e3,
  };
}

// Remplace {{nom}} par sa valeur. Un mot inconnu reste visible, pour qu'une faute de frappe se remarque à la relecture.
export function remplir(modele, valeurs) {
  return modele.replace(/\{\{(\w+)\}\}/g, (tout, cle) => (cle in valeurs ? String(valeurs[cle]) : tout));
}
