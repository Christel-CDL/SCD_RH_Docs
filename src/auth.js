// Connexion des assistantes par lien magique, puis session de 8 heures.
//  - le lien est à usage unique, valable 15 minutes, et n'est connu de la base que par son empreinte ;
//  - ouvrir le lien (GET) ne consomme rien : il faut cliquer sur « Me connecter » (POST). Les antivirus de
//    messagerie (Outlook « Liens fiables »…) ouvrent les liens tout seuls et grilleraient sinon le jeton ;
//  - la session est stockée côté serveur (empreinte du cookie) : la désactivation d'un compte la coupe aussitôt.
import { nouveauJeton, empreinte, egaux, FORME_JETON } from './securite/jetons.js';
import { journaliser } from './db.js';

export const EMAIL = /^[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;

export function creerAuth({ db, config, reglages }) {
  const requetes = {
    utilisateurParEmail: db.prepare('SELECT id, email, nom, role, actif FROM utilisateurs WHERE email = ?'),
    utilisateurParId: db.prepare('SELECT id, email, nom, role, actif FROM utilisateurs WHERE id = ?'),
    creerJeton: db.prepare('INSERT INTO jetons_connexion (empreinte, utilisateur_id, expire_le) VALUES (?, ?, ?)'),
    lireJeton: db.prepare(`
      SELECT j.utilisateur_id FROM jetons_connexion j JOIN utilisateurs u ON u.id = j.utilisateur_id
      WHERE j.empreinte = ? AND j.utilise_le IS NULL AND j.expire_le > ? AND u.actif = 1`),
    // Consommation atomique : deux clics simultanés ne peuvent pas ouvrir deux sessions.
    consommerJeton: db.prepare(`
      UPDATE jetons_connexion SET utilise_le = ?
      WHERE empreinte = ? AND utilise_le IS NULL AND expire_le > ?
      RETURNING utilisateur_id`),
    creerSession: db.prepare('INSERT INTO sessions (empreinte, utilisateur_id, csrf, cree_le, expire_le) VALUES (?, ?, ?, ?, ?)'),
    lireSession: db.prepare(`
      SELECT s.csrf, s.expire_le, u.id, u.email, u.nom, u.role FROM sessions s JOIN utilisateurs u ON u.id = s.utilisateur_id
      WHERE s.empreinte = ? AND s.expire_le > ? AND u.actif = 1`),
    supprimerSession: db.prepare('DELETE FROM sessions WHERE empreinte = ?'),
    purgerJetons: db.prepare('DELETE FROM jetons_connexion WHERE expire_le <= ? OR utilise_le IS NOT NULL'),
    purgerSessions: db.prepare('DELETE FROM sessions WHERE expire_le <= ?'),
  };

  // Renvoie le lien à envoyer, ou null si l'adresse n'est pas autorisée. L'appelant répond pareil dans les deux cas.
  function preparerLien(email) {
    const utilisateur = requetes.utilisateurParEmail.get(email);
    if (!utilisateur || !utilisateur.actif) return null;
    // Une assistante dont le domaine a été retiré de la liste ne peut plus se connecter (l'admin, toujours).
    if (utilisateur.role !== 'admin' && !reglages.domaineAutorise(utilisateur.email)) return null;
    const jeton = nouveauJeton();
    requetes.creerJeton.run(empreinte(jeton), utilisateur.id, Date.now() + config.dureeLienConnexionMs);
    journaliser(db, 'lien_connexion_demande', { utilisateurId: utilisateur.id });
    return { utilisateur, lien: `${config.appUrl}/connexion/lien?jeton=${jeton}` };
  }

  function lienValide(jeton) {
    if (!FORME_JETON.test(String(jeton || ''))) return false;
    return Boolean(requetes.lireJeton.get(empreinte(jeton), Date.now()));
  }

  // Consomme le lien et ouvre une session. Renvoie le jeton de session (valeur du cookie) ou null.
  function connecter(jeton) {
    if (!FORME_JETON.test(String(jeton || ''))) return null;
    const maintenant = Date.now();
    const ligne = requetes.consommerJeton.get(maintenant, empreinte(jeton), maintenant);
    if (!ligne) return null;
    const utilisateur = requetes.utilisateurParId.get(ligne.utilisateur_id);
    if (!utilisateur || !utilisateur.actif) return null;
    const session = nouveauJeton();
    requetes.creerSession.run(empreinte(session), utilisateur.id, nouveauJeton(), maintenant, maintenant + config.dureeSessionMs);
    journaliser(db, 'connexion', { utilisateurId: utilisateur.id });
    return session;
  }

  function lireSession(jetonSession) {
    if (!FORME_JETON.test(String(jetonSession || ''))) return null;
    return requetes.lireSession.get(empreinte(jetonSession), Date.now()) || null;
  }

  function deconnecter(jetonSession) {
    if (FORME_JETON.test(String(jetonSession || ''))) requetes.supprimerSession.run(empreinte(jetonSession));
  }

  function csrfValide(session, recu) {
    return Boolean(session && recu && egaux(session.csrf, recu));
  }

  function purger() {
    const maintenant = Date.now();
    requetes.purgerJetons.run(maintenant);
    requetes.purgerSessions.run(maintenant);
  }

  return { preparerLien, lienValide, connecter, lireSession, deconnecter, csrfValide, purger };
}
