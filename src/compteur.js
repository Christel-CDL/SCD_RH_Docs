// Compte les e-mails envoyés chaque jour (heure de Paris). Le compte Brevo est partagé avec d'autres applications
// (300 e-mails par jour en tout) : cette application ne voit que ses propres envois et prévient l'administratrice,
// une fois par jour, quand elle atteint le pourcentage réglé de sa part (config/envoi.json).
// S'utilise comme une enveloppe du notificateur : chaque appel réussi à n8n est compté.

const formatJour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
export const jourParis = (instant = Date.now()) => formatJour.format(new Date(instant)); // AAAA-MM-JJ

export function creerCompteur({ db, notificateur, reglagesEnvoi, alerte }) {
  const requetes = {
    ajouter: db.prepare('INSERT INTO compteur_emails (jour, n) VALUES (?, ?) ON CONFLICT (jour) DO UPDATE SET n = n + excluded.n RETURNING n'),
    lire: db.prepare('SELECT n FROM compteur_emails WHERE jour = ?'),
    oublier: db.prepare('DELETE FROM compteur_emails WHERE jour < ?'),
    alerteDuJour: db.prepare("SELECT valeur FROM reglages WHERE cle = 'alerte_quota_jour'"),
    noterAlerte: db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('alerte_quota_jour', ?) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur"),
  };
  const seuil = Math.ceil((reglagesEnvoi.quotaJournalier * reglagesEnvoi.alerteQuotaPourcent) / 100);

  // Nombre d'e-mails que représente un événement envoyé à n8n.
  const nbEmails = (evenement, donnees) => (evenement === 'email' ? 1 : (donnees?.messages?.length || 0));

  async function envoyer(evenement, donnees) {
    await notificateur.envoyer(evenement, donnees);
    const n = nbEmails(evenement, donnees);
    if (!n) return;
    const jour = jourParis();
    const total = requetes.ajouter.get(jour, n).n;
    requetes.oublier.run(jourParis(Date.now() - 31 * 24 * 3600e3));
    if (total >= seuil && requetes.alerteDuJour.get()?.valeur !== jour) {
      requetes.noterAlerte.run(jour); // noté avant l'envoi : l'alerte elle-même ne relance pas d'alerte
      const message = alerte({
        titre: 'quota d\'e-mails du jour bientôt atteint',
        detail: `L'outil a envoyé ${total} e-mails aujourd'hui, pour une part de ${reglagesEnvoi.quotaJournalier} par jour sur le compte Brevo partagé (300 par jour en tout, avec les autres applications). Au-delà de 300, Brevo refuse les envois de toutes les applications jusqu'à demain.`,
        reference: jour,
      });
      envoyer('email', message).catch((e) => console.error('Alerte de quota non envoyée :', e.message));
    }
  }

  const aujourdhui = () => requetes.lire.get(jourParis())?.n || 0;
  return { envoyer, aujourdhui };
}
