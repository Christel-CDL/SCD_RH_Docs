// Envoi final du dossier à l'assistante, par n8n (étape 5).
//
// 1. Le salarié clique sur « Envoyer mon dossier » : l'application prépare un « envoi » (plan des e-mails, découpé
//    au-delà de 15 Mo de pièces jointes) puis prévient n8n par un webhook signé. Le message contient le texte des
//    e-mails et, pour chaque pièce jointe, l'adresse INTERNE où n8n ira chercher le PDF : jamais les pièces elles-mêmes.
// 2. n8n télécharge les PDF sur le port interne (non relié à Internet, protégé par un secret), envoie chaque e-mail,
//    puis confirme chaque envoi réussi. Les PDF sont fabriqués à la demande, en mémoire, depuis les pages chiffrées.
// 3. Quand tous les e-mails sont confirmés, tout est effacé : fichiers, pages, pièces, lien du salarié, son e-mail.
//    Il ne reste que la civilité, le nom et le statut « transmise », jusqu'à la purge absolue à 15 jours.
// En cas d'échec (n8n injoignable ou envoi refusé) : nouvelles tentatives espacées (config/envoi.json), puis alerte à
// l'administratrice. Rien n'est supprimé avant un envoi réussi… sauf par la purge absolue à 15 jours (décision du 17/10/2026).
import crypto from 'node:crypto';
import { journaliser } from './db.js';

// Plan des e-mails : pièces dans l'ordre, regroupées tant que le total reste sous le seuil.
export function planifier(pdfs, seuilOctets) {
  const plan = [];
  let courant = [];
  let taille = 0;
  for (const { abrev, contenu } of pdfs) {
    if (courant.length && taille + contenu.length > seuilOctets) {
      plan.push(courant);
      courant = [];
      taille = 0;
    }
    courant.push(abrev);
    taille += contenu.length;
  }
  if (courant.length) plan.push(courant);
  return plan;
}

export function creerEnvoi({ db, config, emails, depot, notificateur, reglagesEnvoi }) {
  const requetes = {
    parDemande: db.prepare('SELECT * FROM envois WHERE demande_id = ?'),
    parId: db.prepare('SELECT * FROM envois WHERE id = ?'),
    inserer: db.prepare('INSERT INTO envois (id, demande_id, plan, prochaine_tentative, cree_le) VALUES (?, ?, ?, ?, ?)'),
    notifie: db.prepare("UPDATE envois SET statut = 'notifie', notifie_le = ?, alerte_le = NULL WHERE id = ?"),
    reessayer: db.prepare("UPDATE envois SET statut = 'a_notifier', tentatives = ?, prochaine_tentative = ? WHERE id = ?"),
    abandonner: db.prepare("UPDATE envois SET statut = 'echec', tentatives = ?, alerte_le = ? WHERE id = ?"),
    confirmes: db.prepare('UPDATE envois SET confirmes = ? WHERE id = ?'),
    termine: db.prepare("UPDATE envois SET statut = 'termine' WHERE id = ?"),
    alerte: db.prepare('UPDATE envois SET alerte_le = ? WHERE id = ?'),
    dus: db.prepare("SELECT * FROM envois WHERE statut = 'a_notifier' AND prochaine_tentative <= ?"),
    silencieux: db.prepare("SELECT * FROM envois WHERE statut = 'notifie' AND alerte_le IS NULL AND notifie_le <= ?"),
    // Dossiers complets sans envoi : l'application s'est arrêtée (redéploiement…) juste après le clic du salarié.
    orphelins: db.prepare("SELECT d.id FROM demandes d LEFT JOIN envois e ON e.demande_id = d.id WHERE d.statut = 'complete' AND e.id IS NULL AND d.complete_le <= ?"),
    enEchec: db.prepare("SELECT id, demande_id, tentatives, alerte_le FROM envois WHERE statut = 'echec' ORDER BY alerte_le DESC"),
    demande: db.prepare('SELECT * FROM demandes WHERE id = ?'),
    assistante: db.prepare('SELECT email, nom FROM utilisateurs WHERE id = ?'),
    supprimerPieces: db.prepare('DELETE FROM pieces WHERE demande_id = ?'),
    transmise: db.prepare(`
      UPDATE demandes SET statut = 'transmise', transmise_le = ?, jeton_empreinte = NULL, email_salarie = ''
      WHERE id = ? AND statut = 'complete'`),
  };
  const enCours = new Set(); // envois en train d'être transmis à n8n : jamais deux fois en même temps

  const urlInterne = (envoiId, suite) => `${config.internalUrl}/interne/envois/${envoiId}/${suite}`;

  async function alerter(titre, detail, reference) {
    try {
      await notificateur.envoyer('email', emails.alerte({ titre, detail, reference }));
    } catch (erreur) {
      // n8n lui-même est injoignable : l'alerte reste au moins dans le journal du conteneur.
      console.error(`ALERTE (non envoyée par e-mail, ${erreur.message}) : ${titre} – ${reference}`);
    }
  }

  // Les e-mails de l'envoi qui n'ont pas encore été confirmés par n8n.
  function messages(envoi) {
    const demande = requetes.demande.get(envoi.demande_id);
    const assistante = requetes.assistante.get(demande.utilisateur_id);
    const description = new Map(depot.pdfs(demande, { avecContenu: false }).map((p) => [p.abrev, p]));
    const plan = JSON.parse(envoi.plan);
    const confirmes = JSON.parse(envoi.confirmes);
    return plan.map((abrevs, i) => {
      const pieces = abrevs.map((a) => description.get(a)).filter(Boolean);
      return {
        numero: i + 1,
        ...emails.envoiFinal({ demande, assistante, pieces, numero: i + 1, total: plan.length }),
        pieces_jointes: pieces.map((p) => ({ nom: p.nom, url: urlInterne(envoi.id, `pieces/${p.abrev}`) })),
      };
    }).filter((m) => !confirmes.includes(m.numero));
  }

  // Échec (n8n injoignable, ou envoi refusé signalé par n8n) : nouvelle tentative plus tard, ou abandon et alerte.
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
      'un dossier complet n\'a pas pu être envoyé',
      `Après ${tentatives} tentatives, les pièces d'un dossier complet n'ont pas pu être envoyées à la personne qui les a demandées (${raison}). `
      + 'Les pièces sont conservées, chiffrées, jusqu\'à la purge automatique à 15 jours après la demande. '
      + 'Vérifiez n8n et le compte Brevo, puis relancez l\'envoi.',
      envoi.demande_id,
    );
  }

  // Transmet l'envoi à n8n (première fois ou nouvelle tentative).
  async function transmettre(envoi) {
    if (enCours.has(envoi.id)) return;
    enCours.add(envoi.id);
    try {
      const aEnvoyer = messages(envoi);
      await notificateur.envoyer('envoi_dossier', {
        envoi_id: envoi.id,
        messages: aEnvoyer,
        confirmation: urlInterne(envoi.id, 'confirmation'),
        echec: urlInterne(envoi.id, 'echec'),
      });
      requetes.notifie.run(Date.now(), envoi.id);
      journaliser(db, 'envoi_transmis_a_n8n', { demandeId: envoi.demande_id });
    } catch (erreur) {
      console.error('Envoi non transmis à n8n :', erreur.message);
      await echouer(envoi, 'n8n injoignable');
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
      const plan = planifier(depot.pdfs(demande), reglagesEnvoi.seuilDecoupageOctets);
      const id = crypto.randomBytes(24).toString('base64url');
      requetes.inserer.run(id, demandeId, JSON.stringify(plan), Date.now(), Date.now());
      envoi = requetes.parId.get(id);
    }
    if (envoi.statut === 'a_notifier') await transmettre(envoi);
  }

  // Tout est parti : on efface les pièces et tout ce qui permettait d'y accéder.
  function terminer(envoi) {
    depot.supprimerFichiers(envoi.demande_id);
    db.exec('BEGIN');
    try {
      requetes.supprimerPieces.run(envoi.demande_id); // les pages suivent (ON DELETE CASCADE)
      requetes.transmise.run(Date.now(), envoi.demande_id);
      requetes.termine.run(envoi.id);
      db.exec('COMMIT');
    } catch (erreur) {
      db.exec('ROLLBACK');
      throw erreur;
    }
    journaliser(db, 'dossier_transmis_et_purge', { demandeId: envoi.demande_id });
  }

  // ── Appels de n8n (port interne) ──

  const envoiActif = (id) => {
    const envoi = requetes.parId.get(String(id));
    return envoi && envoi.statut === 'notifie' ? envoi : null;
  };

  // PDF d'une pièce, fabriqué en mémoire. null si l'envoi n'attend pas de pièces (déjà terminé, inconnu…).
  function pdfPourN8n(envoiId, abrev) {
    const envoi = envoiActif(envoiId);
    if (!envoi || !JSON.parse(envoi.plan).flat().includes(abrev)) return null;
    const [pdf] = depot.pdfs(requetes.demande.get(envoi.demande_id), { seulement: abrev });
    return pdf || null;
  }

  // n8n confirme qu'un e-mail est parti. Renvoie { termine } ou null si l'envoi est inconnu ou déjà terminé.
  function confirmer(envoiId, numero) {
    const envoi = envoiActif(envoiId);
    if (!envoi) return null;
    const plan = JSON.parse(envoi.plan);
    const n = Number(numero);
    if (!Number.isInteger(n) || n < 1 || n > plan.length) return null;
    const confirmes = [...new Set([...JSON.parse(envoi.confirmes), n])].sort((a, b) => a - b);
    requetes.confirmes.run(JSON.stringify(confirmes), envoi.id);
    if (confirmes.length === plan.length) {
      terminer(envoi);
      return { termine: true };
    }
    return { termine: false };
  }

  // n8n signale qu'un e-mail n'a pas pu partir (après ses propres essais).
  async function signalerEchec(envoiId) {
    const envoi = envoiActif(envoiId);
    if (!envoi) return null;
    await echouer(envoi, 'envoi refusé par le service d\'e-mail');
    return { ok: true };
  }

  // Appelé régulièrement : nouvelles tentatives arrivées à échéance, envois restés sans nouvelles de n8n.
  async function tic() {
    for (const { id } of requetes.orphelins.all(Date.now() - 60e3)) await lancer(id);
    for (const envoi of requetes.dus.all(Date.now())) await transmettre(envoi);
    for (const envoi of requetes.silencieux.all(Date.now() - reglagesEnvoi.silenceMs)) {
      requetes.alerte.run(Date.now(), envoi.id);
      await alerter(
        'n8n ne donne pas de nouvelles d\'un envoi',
        `n8n a reçu un dossier complet il y a plus de ${Math.round(reglagesEnvoi.silenceMs / 3600e3)} h mais n'a ni confirmé ni signalé d'échec. `
        + 'Vérifiez le workflow « SCD – Événements de l\'application » dans n8n, et demandez à la personne qui a fait la demande si elle a reçu les pièces, avant de relancer quoi que ce soit (risque de doublon).',
        envoi.demande_id,
      );
    }
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

  return { lancer, tic, pdfPourN8n, confirmer, signalerEchec, etat, messages, enEchec, relancer };
}
