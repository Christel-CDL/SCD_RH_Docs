// Purge de sécurité, faite par l'application elle-même (au démarrage puis toutes les heures), même si n8n est arrêté :
// - toute demande arrivée à expiration (au plus 15 jours après sa création, décision du 17/10/2026) est effacée
//   entièrement, quel que soit son statut : fichiers, pages, pièces, envoi, demande ;
// - si les pièces n'avaient pas été récupérées (dossier non envoyé par le salarié, ou pièces jamais téléchargées),
//   la personne qui a fait la demande en est prévenue par e-mail, avec le conseil de refaire une demande
//   (demande de Christel du 18/10/2026) ;
// - tout fichier chiffré qui n'appartient plus à aucune page (plantage au mauvais moment) est effacé.
// Le journal garde seulement « purge_securite » et l'identifiant technique de la demande.
import { journaliser } from './db.js';

const UNE_HEURE = 3600e3;

export function creerPurge({ db, stockage, emails = null, notificateur = null }) {
  const requetes = {
    expirees: db.prepare('SELECT * FROM demandes WHERE expire_le <= ?'),
    demandeur: db.prepare('SELECT email, nom FROM utilisateurs WHERE id = ?'),
    fichiers: db.prepare('SELECT pg.fichier FROM pages pg JOIN pieces p ON p.id = pg.piece_id WHERE p.demande_id = ?'),
    supprimer: db.prepare('DELETE FROM demandes WHERE id = ?'), // pièces, pages et envoi suivent (ON DELETE CASCADE)
    tousLesFichiers: db.prepare('SELECT fichier FROM pages'),
  };

  // Prévient la personne qui a fait la demande. Un échec d'envoi n'empêche jamais la purge.
  function prevenir(demande) {
    if (!emails || !notificateur || !['envoyee', 'en_cours', 'complete'].includes(demande.statut)) return;
    const demandeur = requetes.demandeur.get(demande.utilisateur_id);
    if (!demandeur) return;
    const message = emails.expiration({ demande, demandeur, piecesPretes: demande.statut === 'complete' });
    notificateur.envoyer('email', message)
      .catch((erreur) => console.error('E-mail d\'expiration non envoyé :', erreur.message));
  }

  function purger(maintenant = Date.now()) {
    let demandes = 0;
    for (const demande of requetes.expirees.all(maintenant)) {
      for (const { fichier } of requetes.fichiers.all(demande.id)) stockage.supprimer(fichier);
      requetes.supprimer.run(demande.id);
      journaliser(db, 'purge_securite', { demandeId: demande.id });
      prevenir(demande); // après l'effacement : les données utiles à l'e-mail ont été lues avant
      demandes += 1;
    }
    const connus = new Set(requetes.tousLesFichiers.all().map((p) => p.fichier));
    const orphelins = stockage.purgerOrphelins(connus, UNE_HEURE);
    if (orphelins) journaliser(db, 'purge_fichiers_orphelins');
    return { demandes, orphelins };
  }

  return { purger };
}
