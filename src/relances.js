// Relances du salarié qui n'a pas encore envoyé son dossier, toujours avec LE MÊME lien :
//  - automatique (demande de M. Domingo, 18/10/2026) : une seule, au bout de config/envoi.json « relance_salarie_jours »
//    (7 jours par défaut) ; si l'e-mail ne part pas, nouvel essai au passage suivant ;
//  - à la main (étape 6) : bouton « Relancer le salarié », au plus une relance (automatique ou manuelle) par 24 h.
// Le lien n'est connu que sous forme chiffrée (colonne jeton_chiffre, clé FILE_ENCRYPTION_KEY), effacée dès que le
// dossier est envoyé ou la demande annulée. Pas de relance après la date limite.
import { dechiffrer } from './securite/chiffrement.js';
import { journaliser } from './db.js';

const JOUR = 24 * 3600e3;

// Moment à partir duquel une nouvelle relance est permise (null : tout de suite).
export const prochaineRelance = (d) => {
  const derniere = Math.max(d.relance_le || 0, d.relance_manuelle_le || 0);
  return derniere ? derniere + JOUR : null;
};

export function creerRelances({ db, config, catalogue, emails, notificateur, reglagesEnvoi }) {
  const requetes = {
    aRelancer: db.prepare(`
      SELECT * FROM demandes
      WHERE statut IN ('envoyee', 'en_cours') AND relance_le IS NULL AND jeton_chiffre IS NOT NULL
        AND cree_le <= ? AND date_limite > ? AND (relance_manuelle_le IS NULL OR relance_manuelle_le <= ?)`),
    parId: db.prepare('SELECT * FROM demandes WHERE id = ? AND utilisateur_id = ?'),
    demandeur: db.prepare('SELECT email, nom FROM utilisateurs WHERE id = ?'),
    manquantes: db.prepare("SELECT abrev FROM pieces WHERE demande_id = ? AND statut <> 'deposee' ORDER BY rowid"),
    noter: db.prepare('UPDATE demandes SET relance_le = ?, relances = relances + 1 WHERE id = ? AND relance_le IS NULL'),
    // Réserve la relance avant l'envoi : un double clic ne peut pas envoyer deux e-mails.
    reserver: db.prepare(`
      UPDATE demandes SET relance_manuelle_le = ?, relances = relances + 1
      WHERE id = ? AND (relance_manuelle_le IS NULL OR relance_manuelle_le <= ?) AND (relance_le IS NULL OR relance_le <= ?)`),
    annulerReservation: db.prepare('UPDATE demandes SET relance_manuelle_le = ?, relances = relances - 1 WHERE id = ?'),
  };

  // Compose et envoie l'e-mail de relance (lève une erreur si n8n ne l'a pas pris).
  async function envoyerRelance(demande) {
    const jeton = dechiffrer(config.cleFichiers, Buffer.from(demande.jeton_chiffre, 'base64'), `jeton:${demande.id}`).toString();
    await notificateur.envoyer('email', emails.relance({
      demande,
      manquantes: requetes.manquantes.all(demande.id).map((p) => catalogue.pieces.get(p.abrev)?.libelle || p.abrev),
      assistante: requetes.demandeur.get(demande.utilisateur_id),
      lien: `${config.appUrl}/d/${jeton}`,
    }));
  }

  async function relancer(maintenant = Date.now()) {
    if (!reglagesEnvoi.relanceJours || !config.cleFichiers) return 0;
    let n = 0;
    for (const demande of requetes.aRelancer.all(maintenant - reglagesEnvoi.relanceJours * JOUR, maintenant, maintenant - JOUR)) {
      try {
        await envoyerRelance(demande);
        requetes.noter.run(maintenant, demande.id);
        journaliser(db, 'relance_salarie', { demandeId: demande.id });
        n += 1;
      } catch (erreur) {
        console.error('Relance non envoyée (nouvel essai plus tard) :', erreur.message);
      }
    }
    return n;
  }

  // Relance à la main par la personne qui a fait la demande.
  // Renvoie 'ok', 'impossible' (dossier envoyé, annulé, date limite passée…), 'trop_tot' ou 'echec' (e-mail non parti).
  async function relancerALaMain(demandeId, utilisateurId, maintenant = Date.now()) {
    const demande = requetes.parId.get(String(demandeId), utilisateurId);
    if (!demande || !['envoyee', 'en_cours'].includes(demande.statut) || !demande.jeton_chiffre
      || demande.date_limite <= maintenant || !config.cleFichiers) return 'impossible';
    const prochaine = prochaineRelance(demande);
    if (prochaine && prochaine > maintenant) return 'trop_tot';
    if (requetes.reserver.run(maintenant, demande.id, maintenant - JOUR, maintenant - JOUR).changes !== 1) return 'trop_tot';
    try {
      await envoyerRelance(demande);
    } catch (erreur) {
      console.error('Relance manuelle non envoyée :', erreur.message);
      requetes.annulerReservation.run(demande.relance_manuelle_le ?? null, demande.id);
      return 'echec';
    }
    journaliser(db, 'relance_manuelle', { utilisateurId, demandeId: demande.id });
    return 'ok';
  }

  return { relancer, relancerALaMain };
}
