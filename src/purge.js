// Purge de sécurité, faite par l'application elle-même (au démarrage puis toutes les heures), même si n8n est arrêté :
// - toute demande arrivée à expiration (au plus 15 jours après sa création, décision du 17/10/2026) est effacée
//   entièrement, quel que soit son statut, même si l'envoi n'a pas réussi : fichiers, pages, pièces, envoi, demande ;
// - tout fichier chiffré qui n'appartient plus à aucune page (plantage au mauvais moment) est effacé.
// Le journal garde seulement « purge_securite » et l'identifiant technique de la demande.
import { journaliser } from './db.js';

const UNE_HEURE = 3600e3;

export function creerPurge({ db, stockage }) {
  const requetes = {
    expirees: db.prepare('SELECT id FROM demandes WHERE expire_le <= ?'),
    fichiers: db.prepare('SELECT pg.fichier FROM pages pg JOIN pieces p ON p.id = pg.piece_id WHERE p.demande_id = ?'),
    supprimer: db.prepare('DELETE FROM demandes WHERE id = ?'), // pièces, pages et envoi suivent (ON DELETE CASCADE)
    tousLesFichiers: db.prepare('SELECT fichier FROM pages'),
  };

  function purger(maintenant = Date.now()) {
    let demandes = 0;
    for (const { id } of requetes.expirees.all(maintenant)) {
      for (const { fichier } of requetes.fichiers.all(id)) stockage.supprimer(fichier);
      requetes.supprimer.run(id);
      journaliser(db, 'purge_securite', { demandeId: id });
      demandes += 1;
    }
    const connus = new Set(requetes.tousLesFichiers.all().map((p) => p.fichier));
    const orphelins = stockage.purgerOrphelins(connus, UNE_HEURE);
    if (orphelins) journaliser(db, 'purge_fichiers_orphelins');
    return { demandes, orphelins };
  }

  return { purger };
}
