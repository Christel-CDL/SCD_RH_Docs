// Annulation d'une demande par la personne qui l'a faite (étape 6, décision de Christel du 18/10/2026) :
// pièces déposées (fichiers chiffrés et lignes), envoi en attente, lien chiffré et e-mail du salarié effacés aussitôt.
// Il ne reste que civilité, nom et statut « Annulée », jusqu'à la purge à J+15. L'empreinte du lien est gardée
// (elle ne permet pas de retrouver le lien) pour que le salarié voie « demande annulée » s'il l'ouvre. Pas d'e-mail.
import { journaliser } from './db.js';

export const ANNULABLES = ['envoyee', 'en_cours', 'complete'];

export function creerAnnulation({ db, depot }) {
  const requetes = {
    demande: db.prepare('SELECT * FROM demandes WHERE id = ? AND utilisateur_id = ?'),
    supprimerPieces: db.prepare('DELETE FROM pieces WHERE demande_id = ?'),
    supprimerEnvoi: db.prepare('DELETE FROM envois WHERE demande_id = ?'),
    annuler: db.prepare(`
      UPDATE demandes SET statut = 'annulee', annulee_le = ?, jeton_chiffre = NULL, email_salarie = ''
      WHERE id = ? AND statut IN ('envoyee', 'en_cours', 'complete')`),
  };

  // Demande annulable de cet utilisateur, ou null.
  function annulable(demandeId, utilisateurId) {
    const demande = requetes.demande.get(String(demandeId), utilisateurId);
    return demande && ANNULABLES.includes(demande.statut) ? demande : null;
  }

  function annuler(demandeId, utilisateurId) {
    const demande = annulable(demandeId, utilisateurId);
    if (!demande) return false;
    // 1. Statut changé d'abord : le lien du salarié ne mène plus à rien, aucun nouveau dépôt n'est accepté.
    if (requetes.annuler.run(Date.now(), demande.id).changes !== 1) return false;
    // 2. Fichiers chiffrés (leurs noms sont lus dans la base, donc avant d'effacer les lignes).
    depot.supprimerFichiers(demande.id);
    // 3. Lignes des pièces (les pages suivent : ON DELETE CASCADE) et envoi en attente.
    db.exec('BEGIN');
    try {
      requetes.supprimerPieces.run(demande.id);
      requetes.supprimerEnvoi.run(demande.id);
      db.exec('COMMIT');
    } catch (erreur) {
      db.exec('ROLLBACK');
      throw erreur;
    }
    journaliser(db, 'demande_annulee', { utilisateurId, demandeId: demande.id });
    return true;
  }

  return { annulable, annuler };
}
