// Demandes de pièces : création (avec ses pièces et le lien du salarié), lecture, liste pour le suivi.
import crypto from 'node:crypto';
import { nouveauJeton, empreinte, FORME_JETON } from './securite/jetons.js';
import { EMAIL } from './auth.js';
import { dateLimite, expiration } from './dates.js';
import { journaliser } from './db.js';

export const TYPES = { embauche: 'Embauche', mise_a_jour: 'Mise à jour du dossier' };
export const CIVILITES = ['M.', 'Mme'];
export const STATUTS = {
  envoyee: 'Invitation envoyée',
  en_cours: 'En cours',
  complete: 'Complète, envoi en cours',
  transmise: 'Complète et transmise',
  expiree: 'Expirée',
  annulee: 'Annulée',
};
const NOM = /^\p{L}[\p{L}' -]{0,79}$/u;

const identifiant = () => crypto.randomBytes(12).toString('base64url');

// Contrôle du formulaire. Renvoie { valeurs } ou { erreurs } (messages simples, un par champ).
export function validerDemande(saisie, catalogue) {
  const erreurs = {};
  const type = String(saisie.type || '');
  const civilite = String(saisie.civilite || '');
  const nom = String(saisie.nom || '').normalize('NFC').trim().replace(/\s+/g, ' ').replace(/’/g, "'");
  const email = String(saisie.email || '').trim().toLowerCase();
  const abrevs = [...new Set(saisie.pieces || [])];

  if (!TYPES[type]) erreurs.type = 'Choisissez le type de demande.';
  if (!CIVILITES.includes(civilite)) erreurs.civilite = 'Choisissez M. ou Mme.';
  if (!NOM.test(nom)) erreurs.nom = 'Saisissez le nom de famille (lettres, espaces, apostrophes et tirets uniquement).';
  if (!EMAIL.test(email)) erreurs.email = 'Cette adresse e-mail n\'est pas valide.';
  if (abrevs.length === 0) erreurs.pieces = 'Cochez au moins une pièce.';
  else if (abrevs.some((a) => !catalogue.pieces.has(a))) erreurs.pieces = 'Une pièce cochée est inconnue. Rechargez la page.';
  else if (catalogue.conflits(abrevs).length) {
    const [choix, piece] = catalogue.conflits(abrevs)[0];
    erreurs.pieces = `Cochez soit « ${catalogue.pieces.get(choix).libelle} », soit « ${catalogue.pieces.get(piece).libelle} », pas les deux.`;
  }
  if (Object.keys(erreurs).length) return { erreurs };
  // Les pièces gardent l'ordre du catalogue, quel que soit l'ordre des cases cochées.
  const ordre = catalogue.liste.map((p) => p.abrev);
  return { valeurs: { type, civilite, nom, email, abrevs: abrevs.sort((a, b) => ordre.indexOf(a) - ordre.indexOf(b)) } };
}

export function creerDemandes({ db, config }) {
  const requetes = {
    inserer: db.prepare(`
      INSERT INTO demandes (id, utilisateur_id, type, civilite, nom, email_salarie, jeton_empreinte, cree_le, date_limite, expire_le)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insererPiece: db.prepare('INSERT INTO pieces (id, demande_id, abrev) VALUES (?, ?, ?)'),
    supprimer: db.prepare('DELETE FROM demandes WHERE id = ?'),
    parId: db.prepare('SELECT * FROM demandes WHERE id = ?'),
    parJeton: db.prepare(`SELECT * FROM demandes WHERE jeton_empreinte = ? AND statut IN ('envoyee', 'en_cours') AND expire_le > ?`),
    pieces: db.prepare('SELECT abrev, abrev_fournie, statut, a_verifier FROM pieces WHERE demande_id = ? ORDER BY rowid'),
    lister: db.prepare(`
      SELECT d.id, d.type, d.civilite, d.nom, d.statut, d.cree_le, d.date_limite,
             COUNT(p.id) AS total, SUM(p.statut = 'deposee') AS deposees
      FROM demandes d LEFT JOIN pieces p ON p.demande_id = d.id
      WHERE d.utilisateur_id = ? AND (? IS NULL OR d.type = ?)
      GROUP BY d.id ORDER BY d.cree_le DESC LIMIT 200`),
  };

  // Crée la demande et ses pièces dans une seule transaction. Renvoie la demande et le jeton du lien (jamais stocké).
  function creer(utilisateur, valeurs) {
    const id = identifiant();
    const jeton = nouveauJeton();
    const maintenant = Date.now();
    db.exec('BEGIN');
    try {
      requetes.inserer.run(id, utilisateur.id, valeurs.type, valeurs.civilite, valeurs.nom, valeurs.email, empreinte(jeton), maintenant,
        dateLimite(maintenant, config.dureeLienSalarieJours), expiration(maintenant, config.dureeLienSalarieJours));
      for (const abrev of valeurs.abrevs) requetes.insererPiece.run(identifiant(), id, abrev);
      db.exec('COMMIT');
    } catch (erreur) {
      db.exec('ROLLBACK');
      throw erreur;
    }
    journaliser(db, 'demande_creee', { utilisateurId: utilisateur.id, demandeId: id });
    return { demande: requetes.parId.get(id), jeton };
  }

  // Annule une création dont l'invitation n'a pas pu partir : aucune donnée orpheline ne reste.
  function abandonner(id) {
    requetes.supprimer.run(id);
  }

  function parJeton(jeton) {
    if (!FORME_JETON.test(String(jeton || ''))) return null;
    return requetes.parJeton.get(empreinte(jeton), Date.now()) || null;
  }

  const pieces = (demandeId) => requetes.pieces.all(demandeId);
  const lister = (utilisateurId, type = null) => requetes.lister.all(utilisateurId, type, type);
  const lienSalarie = (jeton) => `${config.appUrl}/d/${jeton}`;

  return { creer, abandonner, parJeton, pieces, lister, lienSalarie };
}
