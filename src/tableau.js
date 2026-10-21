// Tableau de bord de l'administration et bilan quotidien (demande de Christel du 21/10/2026) : savoir si l'outil sert et
// s'il tourne bien, sans regarder Brevo (qui efface ses journaux). Tout est calculé à partir du journal d'activité et de
// l'état des demandes : seulement des nombres, jamais de nom ni d'adresse de salarié.
import { instantParis } from './dates.js';
import { jourParis } from './compteur.js';
import { STATUTS } from './demandes.js';

const JOUR = 864e5;
export const SEMAINES = 8;

// Lignes comptées, avec les actions du journal qui les alimentent.
export const LIGNES = [
  { cle: 'demandes', libelle: 'Demandes envoyées aux salariés', actions: ['invitation_envoyee'] },
  { cle: 'dossiers', libelle: 'Dossiers envoyés par les salariés', actions: ['dossier_complet'] },
  { cle: 'recuperes', libelle: 'Pièces récupérées par l\'agence', actions: ['pieces_effacees_apres_confirmation', 'pieces_effacees_24h_apres_telechargement', 'dossier_transmis_et_purge'] },
  { cle: 'relances', libelle: 'Relances du salarié (automatiques et à la main)', actions: ['relance_salarie', 'relance_manuelle'] },
  { cle: 'annulees', libelle: 'Demandes annulées', actions: ['demande_annulee'] },
  { cle: 'expirees', libelle: 'Demandes expirées sans aboutir', actions: ['expiree_dossier_non_envoye', 'expiree_pieces_non_telechargees'] },
  { cle: 'echecs', libelle: 'Envois abandonnés (administratrice prévenue)', actions: ['envoi_en_echec', 'invitation_echec'] },
];

// Lundi 0 h (heure de Paris) de la semaine qui contient cet instant.
export function debutSemaine(instant) {
  const [a, m, j] = jourParis(instant).split('-').map(Number);
  const decalage = (new Date(Date.UTC(a, m - 1, j)).getUTCDay() + 6) % 7;
  const lundi = new Date(Date.UTC(a, m - 1, j - decalage));
  return instantParis(lundi.getUTCFullYear(), lundi.getUTCMonth() + 1, lundi.getUTCDate(), 0);
}
// Minuit (heure de Paris) du jour qui contient cet instant.
export function debutJour(instant) {
  const [a, m, j] = jourParis(instant).split('-').map(Number);
  return instantParis(a, m, j, 0);
}

const mediane = (valeurs) => {
  if (!valeurs.length) return null;
  const tries = [...valeurs].sort((x, y) => x - y);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries.at(milieu) : (tries.at(milieu - 1) + tries.at(milieu)) / 2;
};

export function creerTableau({ db, envoi, notificateur }) {
  const actions = LIGNES.flatMap((l) => l.actions);
  const requetes = {
    entrees: db.prepare(`SELECT quand, demande_id, action FROM journal WHERE quand >= ? AND quand < ? AND action IN (${actions.map(() => '?').join(', ')})`),
    // Délai de dépôt : de l'invitation au dossier envoyé, pour une même demande (le journal garde l'identifiant technique).
    delais: db.prepare(`
      SELECT c.quand - i.quand AS delai FROM journal c JOIN journal i ON i.demande_id = c.demande_id AND i.action = 'invitation_envoyee'
      WHERE c.action = 'dossier_complet' AND c.quand >= ? AND c.quand < ?`),
    statuts: db.prepare('SELECT statut, COUNT(*) AS n FROM demandes GROUP BY statut'),
    emails: db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM compteur_emails WHERE jour >= ? AND jour <= ?'),
    parPersonne: db.prepare(`
      SELECT COALESCE(u.nom, u.email, 'Adresse supprimée') AS nom, COUNT(*) AS n FROM journal j LEFT JOIN utilisateurs u ON u.id = j.utilisateur_id
      WHERE j.action = 'invitation_envoyee' AND j.quand >= ? GROUP BY j.utilisateur_id ORDER BY n DESC`),
    derniere: db.prepare("SELECT MAX(quand) AS quand FROM journal WHERE action IN ('invitation_envoyee', 'piece_deposee', 'dossier_complet', 'connexion')"),
  };

  // Nombres d'une période [debut, fin[ : une valeur par ligne, le délai médian de dépôt (jours) et les e-mails envoyés.
  function compter(debut, fin) {
    const resultat = Object.fromEntries(LIGNES.map((l) => [l.cle, 0]));
    for (const e of requetes.entrees.all(debut, fin, ...actions)) {
      const ligne = LIGNES.find((l) => l.actions.includes(e.action));
      resultat[ligne.cle] += 1;
    }
    const delai = mediane(requetes.delais.all(debut, fin).map((d) => d.delai));
    resultat.delaiJours = delai == null ? null : delai / JOUR;
    resultat.emails = requetes.emails.get(jourParis(debut), jourParis(fin - 1)).n; // jours entiers de la période, dernier compris
    return resultat;
  }

  // Les SEMAINES dernières semaines, de la plus ancienne à la semaine en cours.
  function semaines(maintenant = Date.now()) {
    const courante = debutSemaine(maintenant);
    return Array.from({ length: SEMAINES }, (_, i) => {
      const debut = debutSemaine(courante - (SEMAINES - 1 - i) * 7 * JOUR + 12 * 3600e3);
      const fin = i === SEMAINES - 1 ? maintenant + 1 : debutSemaine(debut + 8 * JOUR);
      return { debut, enCours: i === SEMAINES - 1, ...compter(debut, fin) };
    });
  }

  // État du moment : demandes par statut, envois en échec, e-mails du jour, activité récente.
  function etat(maintenant = Date.now()) {
    const parStatut = Object.fromEntries(Object.keys(STATUTS).map((s) => [s, 0]));
    for (const { statut, n } of requetes.statuts.all()) parStatut[statut] = n;
    return {
      parStatut,
      enEchec: envoi.enEchec().length,
      emailsDuJour: notificateur.aujourdhui(),
      derniereActivite: requetes.derniere.get().quand,
      parPersonne: requetes.parPersonne.all(maintenant - 30 * JOUR),
    };
  }

  // Nombres de la veille (jour civil, heure de Paris), pour le bilan quotidien.
  function veille(maintenant = Date.now()) {
    const aujourdhui = debutJour(maintenant);
    const hier = debutJour(aujourdhui - 12 * 3600e3);
    return { debut: hier, ...compter(hier, aujourdhui) };
  }

  return { compter, semaines, etat, veille };
}
