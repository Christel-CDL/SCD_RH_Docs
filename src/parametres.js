// Écran « Réglages » de l'administration (étape 6, décisions de Christel du 18/10/2026) : durées et quotas, seuils de
// lisibilité, textes des e-mails, mention RGPD, conseils et messages de la page de dépôt.
//
// Les fichiers config/*.json restent les valeurs d'origine. Seules les valeurs modifiées à l'écran sont gardées en base
// (table reglages, clés parametres_*), par-dessus les fichiers, et passent les mêmes contrôles qu'au démarrage.
// « Revenir à l'origine » efface la surcouche. Les objets partagés (textes, controles, reglagesEnvoi) sont modifiés
// sur place : les modules les lisent au moment de s'en servir, les changements valent donc aussitôt, sans redémarrage.
// La purge à 15 jours et la date limite à J+14 ne sont pas réglables (décision de l'étape 0).
import {
  lireTextesBruts, lireControlesBruts, lireEnvoiBrut, validerTextes, validerControles, validerReglagesEnvoi, BORNES_CONTROLES,
} from './catalogue.js';
import { creerEmails } from './emails.js';
import { journaliser } from './db.js';

const CLES = { envoi: 'parametres_envoi', controles: 'parametres_controles', textes: 'parametres_textes' };
const VARIABLE = /\{\{(\w+)\}\}/g;
const TEXTE_MAX = 6000;
const copie = (o) => JSON.parse(JSON.stringify(o));

export const variables = (texte) => [...new Set([...String(texte).matchAll(VARIABLE)].map((m) => m[1]))];

// ── Champs numériques ─────────────────────────────────────────────

export const CHAMPS_ENVOI = [
  { cle: 'relance_salarie_jours', libelle: 'Relance automatique du salarié au bout de (jours)', aide: '0 pour ne pas relancer. Une seule relance, avec le même lien.', min: 0, max: 13 },
  { cle: 'quota_journalier', libelle: 'E-mails par jour réservés à l\'outil', aide: 'Sur 300 par jour pour tout le compte Brevo, partagé avec Constats et PENA.', min: 1, max: 300 },
  { cle: 'alerte_quota_pourcent', libelle: 'Alerte à l\'administratrice à (% de cette part)', min: 10, max: 100 },
  { cle: 'bilan_quotidien_heure', libelle: 'Heure du bilan quotidien envoyé à l\'administratrice', aide: 'Heure de Paris, de 0 à 23 ; -1 pour ne plus le recevoir. S\'il n\'arrive pas un matin, l\'outil ou n8n est peut-être arrêté.', min: -1, max: 23 },
  { cle: 'nouvelles_tentatives_minutes', libelle: 'Si un e-mail ne part pas, nouvelles tentatives après (minutes)', aide: 'Délais séparés par des virgules, par exemple : 15, 60, 240. Après le dernier, l\'administratrice est prévenue.', liste: true },
];

const libellesControles = {
  'lisibilite.petit_cote_min_px': ['Résolution minimale d\'une photo (pixels, petit côté)'],
  'lisibilite.nettete_min': ['Netteté minimale', 'Au calibrage du 17/10/2026 : photo nette 120 à 210, légèrement floue mais lisible 70 à 150, floue 45 ou moins.'],
  'lisibilite.luminosite_min': ['Luminosité minimale', '0 = noir, 255 = blanc.'],
  'lisibilite.luminosite_max': ['Luminosité maximale', '0 = noir, 255 = blanc.'],
  'lisibilite.reflet_max_pourcent': ['Reflet maximal (% de pixels blancs)'],
  'lisibilite.echecs_avant_forcer': ['Échecs avant de pouvoir envoyer la photo quand même', 'La pièce est alors marquée « À VÉRIFIER ».'],
  'photo.cote_max_px': ['Grand côté des photos envoyées (pixels)'],
  'photo.qualite_jpeg': ['Qualité des photos envoyées (0,3 à 1)'],
  'pdf.objectif_ko': ['Taille visée d\'un PDF de pièce (Ko)'],
  'pdf.plafond_ko': ['Taille maximale d\'un PDF de pièce (Ko)', 'Au-delà, la pièce est refusée.'],
};
export const CHAMPS_CONTROLES = Object.entries(BORNES_CONTROLES).map(([cle, [min, max]]) => ({
  cle, min, max, libelle: libellesControles[cle]?.[0] || cle, aide: libellesControles[cle]?.[1] || '', decimal: cle === 'photo.qualite_jpeg',
}));

// ── Textes ────────────────────────────────────────────────────────

const GROUPES = [
  ['nom_expediteur', 'Tous les e-mails'], ['lien_secours', 'Tous les e-mails'],
  ['lien_connexion', 'E-mail de connexion'],
  ['invitation', 'Invitation du salarié'],
  ['relance', 'Relance du salarié'],
  ['envoi_final', 'Pièces reçues (e-mail à la personne qui a fait la demande)'],
  ['expiration', 'Lien expiré (e-mail à la personne qui a fait la demande)'],
  ['alerte', 'Alertes à l\'administratrice'],
  ['bilan', 'Bilan quotidien à l\'administratrice'],
  ['mention_rgpd', 'Page de dépôt : mention RGPD'],
  ['aide_depot', 'Page de dépôt : conseils'],
  ['lisibilite', 'Page de dépôt : messages quand une photo est refusée'],
];
const LIBELLES = {
  nom_expediteur: 'Nom de l\'expéditeur', lien_secours: 'Phrase sous le bouton (lien en clair)',
  sujet: 'Objet', texte: 'Texte', bouton: 'Bouton', intro: 'Phrase d\'introduction', titre: 'Titre',
  embauche: 'Embauche', mise_a_jour: 'Mise à jour du dossier',
  manquantes: 'Liste des pièces manquantes', toutes_deposees: 'Si toutes les pièces sont déposées',
  a_verifier: 'Mention « À VÉRIFIER » (sous une pièce)', controle_seulement: 'Mention « CONTRÔLE SEULEMENT » (sous une pièce)',
  mention_a_verifier: 'Paragraphe si une pièce est « À VÉRIFIER »', mention_controle_seulement: 'Paragraphe si une pièce est « CONTRÔLE SEULEMENT »',
  non_envoye: 'Texte si le dossier n\'a pas été envoyé', non_telecharge: 'Texte si les pièces n\'ont pas été téléchargées',
  petite: 'Photo trop petite', floue: 'Photo floue', sombre: 'Photo trop sombre', claire: 'Photo trop claire', reflet: 'Reflet',
  forcer: 'Après plusieurs échecs', bouton_forcer: 'Bouton « envoyer quand même »', pdf_lecture: 'PDF illisible', pdf_pages: 'PDF trop long',
  heic: 'Photo HEIC illisible',
};
function libelle(cle) {
  const segments = cle.split('.');
  if (segments[0] === 'mention_rgpd') return `Bloc ${Number(segments[1]) + 1} – ${LIBELLES[segments[2]]}`;
  if (segments[0] === 'aide_depot') return `Conseil ${Number(segments[1]) + 1}`;
  const utiles = segments.length > 1 ? segments.slice(1) : segments;
  return utiles.map((s) => LIBELLES[s] || s).join(' – ');
}

// Toutes les feuilles texte d'un objet : [['invitation.texte', '…'], ['mention_rgpd.0.titre', '…'], …], sans les notes « _ ».
function feuilles(objet, prefixe = '') {
  return Object.entries(objet).flatMap(([k, v]) => {
    if (k.startsWith('_')) return [];
    const cle = prefixe ? `${prefixe}.${k}` : k;
    if (typeof v === 'string') return [[cle, v]];
    return v && typeof v === 'object' ? feuilles(v, cle) : [];
  });
}
const lireChemin = (objet, cle) => cle.split('.').reduce((o, k) => o?.[k], objet);
function poser(objet, cle, valeur) {
  const segments = cle.split('.');
  const parent = segments.slice(0, -1).reduce((o, k) => o?.[k], objet);
  if (!parent || typeof parent !== 'object' || typeof parent[segments.at(-1)] !== typeof valeur) return false;
  parent[segments.at(-1)] = valeur;
  return true;
}

// Contrôle d'un texte saisi. Renvoie un message d'erreur, ou null.
export function verifierTexte(origine, valeur) {
  if (!valeur.trim()) return 'Le texte ne peut pas être vide. Pour revenir au texte d\'origine, utilisez le bouton prévu.';
  if (valeur.length > TEXTE_MAX) return `Le texte est trop long (${TEXTE_MAX} caractères au plus).`;
  const permises = variables(origine);
  const inconnues = variables(valeur).filter((v) => !permises.includes(v));
  if (inconnues.length) {
    return `Mot inconnu : ${inconnues.map((v) => `{{${v}}}`).join(', ')}. ${permises.length
      ? `Mots possibles : ${permises.map((v) => `{{${v}}}`).join(', ')}.` : 'Ce texte ne peut contenir aucun mot entre {{ }}.'}`;
  }
  if (permises.includes('lien') && !valeur.split('\n').some((l) => l.trim() === '{{lien}}')) {
    return '{{lien}} doit rester seul sur sa ligne : c\'est lui qui devient le bouton de l\'e-mail.';
  }
  return null;
}

export function creerParametres({ db, config, catalogue, reglages, textes, controles, reglagesEnvoi }) {
  const origine = {
    textes: lireTextesBruts(config.configDir),
    controles: lireControlesBruts(config.configDir),
    envoi: lireEnvoiBrut(config.configDir),
  };
  const surcouche = (section) => reglages.lire(CLES[section], {});

  // Valeurs effectives (origine + surcouches), contrôlées comme au démarrage ; lève une erreur au message lisible.
  function effectifs({ envoi = surcouche('envoi'), controlesModifies = surcouche('controles'), textesModifies = surcouche('textes') } = {}) {
    const controlesBruts = copie(origine.controles);
    for (const [cle, valeur] of Object.entries(controlesModifies)) poser(controlesBruts, cle, valeur);
    const textesBruts = copie(origine.textes);
    for (const [cle, valeur] of Object.entries(textesModifies)) poser(textesBruts, cle, valeur);
    // Message d'erreur des fichiers, avec les libellés de l'écran au lieu des noms techniques.
    const message = (e) => [...CHAMPS_CONTROLES, ...CHAMPS_ENVOI].reduce((texte, c) => {
      const nom = c.cle.split('.').at(-1);
      return texte.replace(`« ${c.cle.replace('.', ' › ')} »`, `« ${c.libelle} »`).replace(new RegExp(`\\b${nom}\\b`, 'g'), `« ${c.libelle} »`);
    }, e.message.replace(/^\w+\.json : /, ''));
    try {
      return {
        envoi: validerReglagesEnvoi({ ...origine.envoi, ...envoi }),
        controles: validerControles(controlesBruts),
        textes: validerTextes(textesBruts),
      };
    } catch (erreur) {
      throw new Error(message(erreur));
    }
  }

  function appliquer(valeurs) {
    for (const cle of Object.keys(textes)) delete textes[cle];
    Object.assign(textes, valeurs.textes);
    for (const section of Object.keys(valeurs.controles)) Object.assign(controles[section] ??= {}, valeurs.controles[section]);
    Object.assign(reglagesEnvoi, valeurs.envoi);
  }

  // Au démarrage : une surcouche devenue invalide (fichier d'origine modifié par une mise à jour) est ignorée, pas bloquante.
  try {
    appliquer(effectifs());
  } catch (erreur) {
    console.error('Réglages modifiés ignorés (valeurs d\'origine utilisées) :', erreur.message);
    appliquer(effectifs({ envoi: {}, controlesModifies: {}, textesModifies: {} }));
  }

  // ── Nombres ──
  const champsNombres = { envoi: CHAMPS_ENVOI, controles: CHAMPS_CONTROLES };
  const valeurOrigine = (section, cle) => (section === 'envoi' ? origine.envoi[cle] : lireChemin(origine.controles, cle));
  const enTexte = (v) => (Array.isArray(v) ? v.join(', ') : String(v).replace('.', ','));

  function nombres(section) {
    const modifies = surcouche(section);
    return champsNombres[section].map((c) => ({
      ...c,
      valeur: enTexte(c.cle in modifies ? modifies[c.cle] : valeurOrigine(section, c.cle)),
      origine: enTexte(valeurOrigine(section, c.cle)),
      modifie: c.cle in modifies,
    }));
  }

  // Enregistre les nombres saisis. Renvoie { erreurs: { cle: message } } ou { ok: true }.
  function enregistrerNombres(section, formulaire, utilisateurId) {
    const erreurs = {};
    const nouveaux = {};
    for (const c of champsNombres[section]) {
      const saisi = String(formulaire.get(c.cle) ?? '').trim();
      let valeur;
      if (c.liste) {
        valeur = saisi.split(/[\s,;]+/).filter(Boolean).map(Number);
        if (!valeur.length || valeur.some((n) => !Number.isInteger(n))) { erreurs[c.cle] = 'Saisissez des nombres entiers séparés par des virgules.'; continue; }
      } else {
        valeur = Number(saisi.replace(',', '.'));
        if (!saisi || !Number.isFinite(valeur) || (!c.decimal && !Number.isInteger(valeur))) { erreurs[c.cle] = `Saisissez un nombre${c.decimal ? '' : ' entier'}.`; continue; }
        if (valeur < c.min || valeur > c.max) { erreurs[c.cle] = `Saisissez un nombre entre ${enTexte(c.min)} et ${enTexte(c.max)}.`; continue; }
      }
      if (JSON.stringify(valeur) !== JSON.stringify(valeurOrigine(section, c.cle))) nouveaux[c.cle] = valeur;
    }
    if (Object.keys(erreurs).length) return { erreurs };
    let valeurs;
    try {
      valeurs = effectifs(section === 'envoi' ? { envoi: nouveaux } : { controlesModifies: nouveaux });
    } catch (erreur) {
      return { erreurs: { general: erreur.message } };
    }
    reglages.ecrire(CLES[section], nouveaux);
    appliquer(valeurs);
    journaliser(db, section === 'envoi' ? 'reglages_envoi_modifies' : 'reglages_controles_modifies', { utilisateurId });
    return { ok: true };
  }

  function retablirNombres(section, utilisateurId) {
    reglages.ecrire(CLES[section], {});
    appliquer(effectifs());
    journaliser(db, section === 'envoi' ? 'reglages_envoi_retablis' : 'reglages_controles_retablis', { utilisateurId });
  }

  // ── Textes ──
  const champsOrigine = feuilles(origine.textes);
  const groupe = (cle) => GROUPES.find(([prefixe]) => cle === prefixe || cle.startsWith(`${prefixe}.`))?.[1] || 'Autres textes';

  // saisie : valeurs proposées (aperçu ou erreur), sinon les valeurs enregistrées.
  function champsTextes(saisie = null) {
    const modifies = surcouche('textes');
    return champsOrigine.map(([cle, valeurOrigine]) => ({
      cle,
      groupe: groupe(cle),
      libelle: libelle(cle),
      valeur: saisie?.[cle] ?? modifies[cle] ?? valeurOrigine,
      origine: valeurOrigine,
      modifie: cle in modifies,
      variables: variables(valeurOrigine),
      long: valeurOrigine.length > 90 || valeurOrigine.includes('\n'),
    }));
  }

  // Lit et contrôle les textes du formulaire. Renvoie { saisie, nouveaux, erreurs }.
  function lireTextes(formulaire) {
    const saisie = {};
    const nouveaux = {};
    const erreurs = {};
    for (const [cle, valeurOrigine] of champsOrigine) {
      const brut = formulaire.get(cle);
      const valeur = brut == null ? (surcouche('textes')[cle] ?? valeurOrigine) : String(brut).replace(/\r\n?/g, '\n');
      saisie[cle] = valeur;
      const erreur = verifierTexte(valeurOrigine, valeur);
      if (erreur) erreurs[cle] = erreur;
      else if (valeur !== valeurOrigine) nouveaux[cle] = valeur;
    }
    return { saisie, nouveaux, erreurs };
  }

  function enregistrerTextes(nouveaux, utilisateurId) {
    const valeurs = effectifs({ textesModifies: nouveaux });
    reglages.ecrire(CLES.textes, nouveaux);
    appliquer(valeurs);
    journaliser(db, 'textes_modifies', { utilisateurId });
  }

  function retablirTexte(cle, utilisateurId) {
    const modifies = surcouche('textes');
    if (cle === '*') reglages.ecrire(CLES.textes, {});
    else if (cle in modifies) { delete modifies[cle]; reglages.ecrire(CLES.textes, modifies); } else return false;
    appliquer(effectifs());
    journaliser(db, 'textes_retablis', { utilisateurId });
    return true;
  }

  // Aperçu des e-mails avec des données fictives, pour des textes proposés (non enregistrés) ou enregistrés.
  function apercu(nouveaux = surcouche('textes')) {
    const { textes: proposes } = effectifs({ textesModifies: nouveaux });
    const emails = creerEmails({ textes: proposes, catalogue, config });
    const maintenant = Date.now();
    const demande = {
      type: 'embauche', civilite: 'Mme', nom: 'ZZ EXEMPLE', email_salarie: 'salarie@exemple.test',
      cree_le: maintenant, date_limite: maintenant + 14 * 864e5, expire_le: maintenant + 15 * 864e5,
    };
    const demandeur = { nom: 'Prénom NOM', email: 'agence@exemple.test' };
    const lien = `${config.appUrl}/…`;
    const pieces = catalogue.liste.filter((p) => p.dans_formulaire).slice(0, 3);
    const libelles = pieces.map((p) => p.libelle);
    return [
      ['E-mail de connexion', emails.lienConnexion({ utilisateur: demandeur, lien })],
      ['Invitation (embauche)', emails.invitation({ demande, abrevs: pieces.map((p) => p.abrev), assistante: demandeur, lien })],
      ['Invitation (mise à jour)', emails.invitation({ demande: { ...demande, type: 'mise_a_jour' }, abrevs: pieces.map((p) => p.abrev), assistante: demandeur, lien })],
      ['Relance du salarié', emails.relance({ demande, manquantes: libelles.slice(1), assistante: demandeur, lien })],
      ['Pièces reçues', emails.envoiFinal({
        demande, assistante: demandeur, lien,
        pieces: [{ libelle: libelles[0], aVerifier: true }, { libelle: 'Extrait de casier judiciaire (bulletin n°3)', controleSeulement: true }],
      })],
      ['Lien expiré', emails.expiration({ demande, demandeur, piecesPretes: false })],
      ['Alerte', emails.alerte({ titre: 'exemple d\'alerte', detail: 'Description du problème.', reference: 'identifiant-technique' })],
      ['Bilan quotidien', emails.bilan({
        date: 'lundi 19 octobre 2026', chiffres: '  • Demandes envoyées aux salariés : 2\n  • Dossiers envoyés par les salariés : 1',
        etat: '  • Dossiers complets, pièces à télécharger : 1', lien: `${config.appUrl}/admin/tableau-de-bord`, sante: `${config.appUrl}/sante`,
      })],
    ].map(([titre, m]) => ({ titre, expediteur: m.nom_expediteur, sujet: m.sujet, texte: m.texte }));
  }

  return { nombres, enregistrerNombres, retablirNombres, champsTextes, lireTextes, enregistrerTextes, retablirTexte, apercu };
}
