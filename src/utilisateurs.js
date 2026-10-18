// Administration de la liste des adresses autorisées (assistantes) et lecture du journal d'activité.
import { EMAIL } from './auth.js';
import { journaliser } from './db.js';

export const ACTIONS = {
  lien_connexion_demande: 'Lien de connexion demandé',
  connexion: 'Connexion',
  demande_creee: 'Demande créée',
  invitation_envoyee: 'Invitation envoyée au salarié',
  invitation_echec: 'Échec d\'envoi de l\'invitation (demande supprimée)',
  utilisateur_ajoute: 'Adresse autorisée ajoutée',
  utilisateur_desactive: 'Adresse désactivée',
  utilisateur_reactive: 'Adresse réactivée',
  utilisateur_supprime: 'Adresse supprimée',
  domaines_modifies: 'Domaines autorisés modifiés',
  piece_deposee: 'Pièce déposée par le salarié',
  piece_remplacee: 'Pièce remplacée par le salarié',
  dossier_complet: 'Dossier complet envoyé par le salarié',
  envoi_transmis_a_n8n: 'Envoi des pièces confié à n8n',
  envoi_a_reessayer: 'Envoi des pièces en échec, nouvelle tentative prévue',
  envoi_en_echec: 'Envoi des pièces abandonné (administratrice prévenue)',
  envoi_relance: 'Envoi des pièces relancé',
  envoi_relance_par_admin: 'Relance d\'un envoi par l\'administratrice',
  journal_brevo_non_efface: 'Journal Brevo d\'un e-mail non effacé (à supprimer à la main dans Brevo)',
  pieces_annoncees: 'Dossier complet annoncé par e-mail à la personne qui l\'a demandé',
  piece_telechargee: 'Pièce téléchargée',
  pieces_telechargees_zip: 'Pièces téléchargées (ZIP)',
  pieces_effacees_apres_confirmation: 'Pièces enregistrées par la personne qui les a demandées, puis supprimées de l\'outil',
  pieces_effacees_24h_apres_telechargement: 'Pièces supprimées de l\'outil 24 h après leur téléchargement',
  dossier_transmis_et_purge: 'Pièces reçues par la personne qui les a demandées, puis supprimées de l\'outil',
  purge_securite: 'Demande expirée effacée (purge à 15 jours)',
  purge_fichiers_orphelins: 'Fichiers orphelins effacés',
};

export function creerUtilisateurs({ db, reglages }) {
  const requetes = {
    lister: db.prepare(`
      SELECT u.id, u.email, u.nom, u.role, u.actif, u.cree_le, COUNT(d.id) AS demandes
      FROM utilisateurs u LEFT JOIN demandes d ON d.utilisateur_id = u.id
      GROUP BY u.id ORDER BY u.role, u.email`),
    parId: db.prepare('SELECT id, email, role, actif FROM utilisateurs WHERE id = ?'),
    existe: db.prepare('SELECT id FROM utilisateurs WHERE email = ?'),
    ajouter: db.prepare("INSERT INTO utilisateurs (email, nom, role, actif, cree_le) VALUES (?, ?, 'assistante', 1, ?)"),
    actif: db.prepare('UPDATE utilisateurs SET actif = ? WHERE id = ?'),
    couperSessions: db.prepare('DELETE FROM sessions WHERE utilisateur_id = ?'),
    supprimer: db.prepare('DELETE FROM utilisateurs WHERE id = ?'),
    journal: db.prepare(`
      SELECT j.quand, j.action, j.demande_id, u.email FROM journal j LEFT JOIN utilisateurs u ON u.id = j.utilisateur_id
      ORDER BY j.id DESC LIMIT 300`),
  };

  const lister = () => requetes.lister.all();

  // Renvoie un message d'erreur, ou null si l'ajout a réussi.
  function ajouter(admin, saisie) {
    const email = String(saisie.email || '').trim().toLowerCase();
    const nom = String(saisie.nom || '').trim().replace(/\s+/g, ' ');
    if (!EMAIL.test(email)) return 'Cette adresse e-mail n\'est pas valide.';
    if (nom.length < 2 || nom.length > 80) return 'Saisissez le prénom et le nom (il apparaît dans l\'e-mail envoyé au salarié).';
    if (!reglages.domaineAutorise(email)) return `Le domaine « ${email.split('@')[1]} » ne fait pas partie des domaines autorisés.`;
    if (requetes.existe.get(email)) return 'Cette adresse figure déjà dans la liste.';
    const { lastInsertRowid } = requetes.ajouter.run(email, nom, Date.now());
    journaliser(db, 'utilisateur_ajoute', { utilisateurId: admin.id });
    return lastInsertRowid ? null : 'Ajout impossible.';
  }

  // L'administratrice (ADMIN_EMAIL) ne peut être ni désactivée ni supprimée depuis l'écran.
  function cible(id) {
    const u = requetes.parId.get(Number(id));
    return u && u.role !== 'admin' ? u : null;
  }

  function changerActif(admin, id, actif) {
    const u = cible(id);
    if (!u) return 'Adresse introuvable.';
    requetes.actif.run(actif ? 1 : 0, u.id);
    if (!actif) requetes.couperSessions.run(u.id);
    journaliser(db, actif ? 'utilisateur_reactive' : 'utilisateur_desactive', { utilisateurId: admin.id });
    return null;
  }

  function supprimer(admin, id) {
    const u = cible(id);
    if (!u) return 'Adresse introuvable.';
    try {
      requetes.supprimer.run(u.id);
    } catch {
      // Clé étrangère : la personne a encore des demandes enregistrées.
      return 'Cette personne a des demandes enregistrées : désactivez son adresse plutôt que de la supprimer.';
    }
    journaliser(db, 'utilisateur_supprime', { utilisateurId: admin.id });
    return null;
  }

  function modifierDomaines(admin, liste) {
    reglages.ecrire('domaines_autorises', liste);
    journaliser(db, 'domaines_modifies', { utilisateurId: admin.id });
  }

  const journal = () => requetes.journal.all();

  return { lister, ajouter, changerActif, supprimer, modifierDomaines, journal };
}
