// Mise à disposition du dossier complet à la personne qui a fait la demande (étape 5, revue le 18/10/2026).
//
// Les pièces ne partent JAMAIS par e-mail : à l'essai réel, Brevo conservait les pièces jointes dans ses journaux,
// consultables depuis son tableau de bord. Désormais :
// 1. le salarié clique sur « Envoyer mon dossier » : l'application envoie, par n8n, un e-mail SANS pièce jointe à la
//    personne qui a fait la demande, avec un bouton vers la page de téléchargement (connexion obligatoire) ;
// 2. elle télécharge les PDF (un par un ou en ZIP), fabriqués à la demande, en mémoire, depuis les pages chiffrées ;
// 3. les pièces sont effacées (fichiers, pages, pièces, lien et e-mail du salarié) au premier des trois moments :
//    elle confirme les avoir enregistrées ; 24 h après le premier téléchargement ; la purge absolue à 15 jours.
// Si l'e-mail ne part pas (n8n ou Brevo en panne) : nouvelles tentatives espacées (config/envoi.json), puis alerte à
// l'administratrice. La page de téléchargement reste accessible depuis « Mes demandes » pendant ce temps.
import crypto from 'node:crypto';
import { journaliser } from './db.js';
import { creerZip } from './zip.js';

const VINGT_QUATRE_HEURES = 24 * 3600e3;

export function creerEnvoi({ db, config, emails, depot, notificateur, reglagesEnvoi }) {
  const requetes = {
    parDemande: db.prepare('SELECT * FROM envois WHERE demande_id = ?'),
    parId: db.prepare('SELECT * FROM envois WHERE id = ?'),
    inserer: db.prepare("INSERT INTO envois (id, demande_id, plan, prochaine_tentative, cree_le) VALUES (?, ?, '[]', ?, ?)"),
    notifie: db.prepare("UPDATE envois SET statut = 'notifie', notifie_le = ?, alerte_le = NULL WHERE id = ?"),
    reessayer: db.prepare("UPDATE envois SET statut = 'a_notifier', tentatives = ?, prochaine_tentative = ? WHERE id = ?"),
    abandonner: db.prepare("UPDATE envois SET statut = 'echec', tentatives = ?, alerte_le = ? WHERE id = ?"),
    termine: db.prepare("UPDATE envois SET statut = 'termine' WHERE demande_id = ?"),
    telecharge: db.prepare('UPDATE envois SET telecharge_le = ? WHERE demande_id = ? AND telecharge_le IS NULL'),
    dus: db.prepare("SELECT * FROM envois WHERE statut = 'a_notifier' AND prochaine_tentative <= ?"),
    aEffacer: db.prepare("SELECT demande_id FROM envois WHERE statut <> 'termine' AND telecharge_le IS NOT NULL AND telecharge_le <= ?"),
    // Dossiers complets sans envoi : l'application s'est arrêtée (redéploiement…) juste après le clic du salarié.
    orphelins: db.prepare("SELECT d.id FROM demandes d LEFT JOIN envois e ON e.demande_id = d.id WHERE d.statut = 'complete' AND e.id IS NULL AND d.complete_le <= ?"),
    enEchec: db.prepare("SELECT id, demande_id, tentatives, alerte_le FROM envois WHERE statut = 'echec' ORDER BY alerte_le DESC"),
    demande: db.prepare('SELECT * FROM demandes WHERE id = ?'),
    demandeur: db.prepare('SELECT email, nom FROM utilisateurs WHERE id = ?'),
    supprimerPieces: db.prepare('DELETE FROM pieces WHERE demande_id = ?'),
    transmise: db.prepare(`
      UPDATE demandes SET statut = 'transmise', transmise_le = ?, jeton_empreinte = NULL, jeton_chiffre = NULL, email_salarie = ''
      WHERE id = ? AND statut = 'complete'`),
  };
  const enCours = new Set(); // envois en train d'être confiés à n8n : jamais deux fois en même temps

  const lienTelechargement = (demandeId) => `${config.appUrl}/demandes/${demandeId}/pieces`;

  async function alerter(titre, detail, reference) {
    try {
      await notificateur.envoyer('email', emails.alerte({ titre, detail, reference }));
    } catch (erreur) {
      // n8n lui-même est injoignable : l'alerte reste au moins dans le journal du conteneur.
      console.error(`ALERTE (non envoyée par e-mail, ${erreur.message}) : ${titre} – ${reference}`);
    }
  }

  // E-mail « pièces prêtes » : texte, liste des pièces (libellés seulement), bouton vers la page de téléchargement.
  function message(demande) {
    return emails.envoiFinal({
      demande,
      assistante: requetes.demandeur.get(demande.utilisateur_id),
      pieces: depot.pdfs(demande, { avecContenu: false }),
      lien: lienTelechargement(demande.id),
    });
  }

  // Échec (n8n injoignable ou e-mail refusé) : nouvelle tentative plus tard, ou abandon et alerte.
  async function echouer(envoi, raison) {
    const tentatives = envoi.tentatives + 1;
    if (tentatives <= reglagesEnvoi.delaisMs.length) {
      requetes.reessayer.run(tentatives, Date.now() + reglagesEnvoi.delaisMs[tentatives - 1], envoi.id);
      journaliser(db, 'envoi_a_reessayer', { demandeId: envoi.demande_id });
      return;
    }
    requetes.abandonner.run(tentatives, Date.now(), envoi.id);
    journaliser(db, 'envoi_en_echec', { demandeId: envoi.demande_id });
    await alerter(
      'la personne qui a fait une demande n\'a pas pu être prévenue',
      `Après ${tentatives} tentatives, l'e-mail annonçant qu'un dossier est complet n'a pas pu être envoyé (${raison}). `
      + 'Les pièces restent téléchargeables depuis « Mes demandes », chiffrées, jusqu\'à la purge automatique à 15 jours après la demande. '
      + 'Vérifiez n8n et le compte Brevo, puis relancez l\'envoi depuis l\'administration.',
      envoi.demande_id,
    );
  }

  // Confie l'e-mail à n8n, qui répond une fois l'e-mail parti (ou en échec).
  async function transmettre(envoi) {
    if (enCours.has(envoi.id)) return;
    enCours.add(envoi.id);
    try {
      await notificateur.envoyer('email', message(requetes.demande.get(envoi.demande_id)));
      requetes.notifie.run(Date.now(), envoi.id);
      journaliser(db, 'pieces_annoncees', { demandeId: envoi.demande_id });
    } catch (erreur) {
      console.error('E-mail « pièces prêtes » non envoyé :', erreur.message);
      await echouer(envoi, 'n8n ou Brevo indisponible');
    } finally {
      enCours.delete(envoi.id);
    }
  }

  // Appelé quand le salarié envoie son dossier complet. Un seul envoi par demande.
  async function lancer(demandeId) {
    let envoi = requetes.parDemande.get(demandeId);
    if (!envoi) {
      const demande = requetes.demande.get(demandeId);
      if (!demande || demande.statut !== 'complete') return;
      requetes.inserer.run(crypto.randomBytes(24).toString('base64url'), demandeId, Date.now(), Date.now());
      envoi = requetes.parDemande.get(demandeId);
    }
    if (envoi.statut === 'a_notifier') await transmettre(envoi);
  }

  // ── Page de téléchargement (personne qui a fait la demande, connectée) ──

  // La demande, si elle appartient à cet utilisateur et que ses pièces sont téléchargeables ; sinon null.
  function demandeTelechargeable(demandeId, utilisateurId) {
    const demande = requetes.demande.get(String(demandeId));
    if (!demande || demande.utilisateur_id !== utilisateurId) return null;
    return demande;
  }

  // Liste des pièces (sans contenu), pour la page.
  const pieces = (demande) => (demande.statut === 'complete' ? depot.pdfs(demande, { avecContenu: false }) : []);

  // Un PDF, ou tous en ZIP. Le premier téléchargement déclenche le compte à rebours de 24 h avant l'effacement.
  function telecharger(demande, abrev = null) {
    if (demande.statut !== 'complete') return null;
    const pdfs = depot.pdfs(demande, { seulement: abrev });
    if (!pdfs.length) return null;
    requetes.telecharge.run(Date.now(), demande.id);
    journaliser(db, abrev ? 'piece_telechargee' : 'pieces_telechargees_zip', { demandeId: demande.id });
    if (abrev) return { nom: pdfs[0].nom, type: 'application/pdf', contenu: pdfs[0].contenu };
    const base = pdfs[0].nom.replace(/-[A-Z0-9_]+\.pdf$/, '');
    return { nom: `${base}-pieces.zip`, type: 'application/zip', contenu: creerZip(pdfs) };
  }

  // Effacement de tout ce qui permettait d'accéder aux pièces. origine : 'confirmation' ou 'automatique'.
  function terminer(demandeId, origine) {
    const demande = requetes.demande.get(demandeId);
    if (!demande || demande.statut !== 'complete') return false;
    depot.supprimerFichiers(demandeId);
    db.exec('BEGIN');
    try {
      requetes.supprimerPieces.run(demandeId); // les pages suivent (ON DELETE CASCADE)
      requetes.transmise.run(Date.now(), demandeId);
      requetes.termine.run(demandeId);
      db.exec('COMMIT');
    } catch (erreur) {
      db.exec('ROLLBACK');
      throw erreur;
    }
    journaliser(db, origine === 'confirmation' ? 'pieces_effacees_apres_confirmation' : 'pieces_effacees_24h_apres_telechargement', { demandeId });
    return true;
  }

  // Appelé chaque minute : envois oubliés, nouvelles tentatives, effacement 24 h après le premier téléchargement.
  async function tic() {
    for (const { id } of requetes.orphelins.all(Date.now() - 60e3)) await lancer(id);
    for (const envoi of requetes.dus.all(Date.now())) await transmettre(envoi);
    for (const { demande_id: id } of requetes.aEffacer.all(Date.now() - VINGT_QUATRE_HEURES)) terminer(id, 'automatique');
  }

  const etat = (demandeId) => requetes.parDemande.get(demandeId) || null;

  // Administration : envois abandonnés après toutes les tentatives, et relance manuelle (après réparation de n8n ou Brevo).
  const enEchec = () => requetes.enEchec.all();
  async function relancer(envoiId) {
    const envoi = requetes.parId.get(String(envoiId));
    if (!envoi || envoi.statut !== 'echec') return false;
    requetes.reessayer.run(0, Date.now(), envoi.id);
    journaliser(db, 'envoi_relance', { demandeId: envoi.demande_id });
    await transmettre(requetes.parId.get(envoi.id));
    return true;
  }

  return { lancer, tic, demandeTelechargeable, pieces, telecharger, terminer, etat, enEchec, relancer, message };
}
