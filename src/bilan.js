// Bilan quotidien à l'administratrice (demande de Christel du 21/10/2026 : « être prévenue si le site tombe, un contrôle
// par jour suffit »). Chaque matin, à l'heure réglée (config/envoi.json « bilan_quotidien_heure », 8 h par défaut,
// -1 pour l'arrêter), l'outil envoie les chiffres de la veille et l'état du moment. Son absence un matin est le signal :
// l'outil, n8n ou Brevo ne fonctionne plus. Que des nombres : jamais de nom ni d'adresse de salarié.
import { journaliser } from './db.js';
import { jourParis } from './compteur.js';
import { LIGNES } from './tableau.js';
import { dateHeure, dateJour } from './dates.js';

// L'heure seule, en nombre (le format français écrirait « 07 h »).
const formatHeure = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' });
const heureParis = (instant) => Number(formatHeure.formatToParts(new Date(instant)).find((p) => p.type === 'hour').value);

export function creerBilan({ db, config, emails, notificateur, tableau, reglagesEnvoi, reglages }) {
  // Compose le bilan (sans l'envoyer) : utile aussi aux tests.
  function composer(maintenant = Date.now()) {
    const veille = tableau.veille(maintenant);
    const etat = tableau.etat(maintenant);
    const ligne = (libelle, valeur) => `  • ${libelle} : ${valeur}`;
    const chiffres = [
      ...LIGNES.map((l) => ligne(l.libelle, veille[l.cle])),
      ligne('E-mails envoyés par l\'outil', veille.emails),
    ].join('\n');
    const maintenantTexte = [
      ligne('Invitations sans dépôt', etat.parStatut.envoyee),
      ligne('Dossiers en cours de dépôt', etat.parStatut.en_cours),
      ligne('Dossiers complets, pièces à télécharger', etat.parStatut.complete),
      ligne('Envois en échec', etat.enEchec),
      ligne('Dernière activité (demande, dépôt ou connexion)', etat.derniereActivite ? dateHeure(etat.derniereActivite) : 'aucune'),
    ].join('\n');
    return emails.bilan({
      date: dateJour(veille.debut),
      chiffres,
      etat: maintenantTexte,
      lien: `${config.appUrl}/admin/tableau-de-bord`,
      sante: `${config.appUrl}/sante`,
    });
  }

  // Envoie le bilan s'il est l'heure et qu'il n'est pas encore parti aujourd'hui. En cas d'échec, nouvel essai au
  // passage suivant (toutes les 10 minutes). Renvoie true si un bilan est parti.
  async function envoyerSiDu(maintenant = Date.now()) {
    const heure = reglagesEnvoi.bilanHeure;
    if (heure == null || heure < 0 || !config.adminEmail) return false;
    const jour = jourParis(maintenant);
    if (heureParis(maintenant) < heure || reglages.lire('bilan_dernier_jour', null) === jour) return false;
    await notificateur.envoyer('email', composer(maintenant));
    reglages.ecrire('bilan_dernier_jour', jour);
    journaliser(db, 'bilan_envoye');
    return true;
  }

  return { composer, envoyerSiDu };
}
