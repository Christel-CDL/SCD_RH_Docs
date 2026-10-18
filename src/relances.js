// Relance automatique du salarié qui n'a pas encore envoyé son dossier (demande de M. Domingo, 18/10/2026) :
// une seule relance, au bout de config/envoi.json « relance_salarie_jours » (7 jours par défaut), avec LE MÊME lien.
// Le lien n'est connu que sous forme chiffrée (colonne jeton_chiffre, clé FILE_ENCRYPTION_KEY), effacée dès que le
// dossier est envoyé. Pas de relance après la date limite. Si l'e-mail ne part pas, nouvel essai au passage suivant.
import { dechiffrer } from './securite/chiffrement.js';
import { journaliser } from './db.js';

const JOUR = 24 * 3600e3;

export function creerRelances({ db, config, catalogue, emails, notificateur, reglagesEnvoi }) {
  const requetes = {
    aRelancer: db.prepare(`
      SELECT * FROM demandes
      WHERE statut IN ('envoyee', 'en_cours') AND relance_le IS NULL AND jeton_chiffre IS NOT NULL
        AND cree_le <= ? AND date_limite > ?`),
    demandeur: db.prepare('SELECT email, nom FROM utilisateurs WHERE id = ?'),
    manquantes: db.prepare("SELECT abrev FROM pieces WHERE demande_id = ? AND statut <> 'deposee' ORDER BY rowid"),
    noter: db.prepare('UPDATE demandes SET relance_le = ?, relances = relances + 1 WHERE id = ? AND relance_le IS NULL'),
  };

  async function relancer(maintenant = Date.now()) {
    if (!reglagesEnvoi.relanceJours || !config.cleFichiers) return 0;
    let n = 0;
    for (const demande of requetes.aRelancer.all(maintenant - reglagesEnvoi.relanceJours * JOUR, maintenant)) {
      try {
        const jeton = dechiffrer(config.cleFichiers, Buffer.from(demande.jeton_chiffre, 'base64'), `jeton:${demande.id}`).toString();
        const message = emails.relance({
          demande,
          manquantes: requetes.manquantes.all(demande.id).map((p) => catalogue.pieces.get(p.abrev)?.libelle || p.abrev),
          assistante: requetes.demandeur.get(demande.utilisateur_id),
          lien: `${config.appUrl}/d/${jeton}`,
        });
        await notificateur.envoyer('email', message);
        requetes.noter.run(maintenant, demande.id);
        journaliser(db, 'relance_salarie', { demandeId: demande.id });
        n += 1;
      } catch (erreur) {
        console.error('Relance non envoyée (nouvel essai plus tard) :', erreur.message);
      }
    }
    return n;
  }

  return { relancer };
}
