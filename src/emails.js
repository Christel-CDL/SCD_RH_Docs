// Composition des e-mails. L'application écrit le message ; n8n se contente de l'envoyer (Brevo, puis Outlook).
// Ainsi, changer de fournisseur ne touche jamais aux textes, et les textes restent dans config/textes.json.
import { remplir } from './catalogue.js';
import { dateLongue } from './dates.js';

export function creerEmails({ textes, catalogue, config }) {
  const base = { nom_expediteur: textes.nom_expediteur };

  function lienConnexion({ utilisateur, lien }) {
    const valeurs = { agence: config.agence, lien, minutes: Math.round(config.dureeLienConnexionMs / 60e3) };
    return {
      ...base,
      categorie: 'lien_connexion',
      destinataire: utilisateur.email,
      sujet: remplir(textes.lien_connexion.sujet, valeurs),
      texte: remplir(textes.lien_connexion.texte, valeurs),
    };
  }

  // Aucune donnée sensible : civilité, nom, liste des pièces, date limite, agence et nom de l'assistante.
  function invitation({ demande, abrevs, assistante, lien }) {
    const modele = textes.invitation[demande.type];
    const valeurs = {
      agence: config.agence,
      assistante: assistante.nom || assistante.email,
      civilite: demande.civilite,
      nom: demande.nom,
      date_limite: dateLongue(demande.date_limite),
      lien,
    };
    valeurs.intro = remplir(modele.intro, valeurs);
    valeurs.pieces = abrevs.map((a) => `  • ${catalogue.pieces.get(a).libelle}`).join('\n');
    return {
      ...base,
      categorie: `invitation_${demande.type}`,
      destinataire: demande.email_salarie,
      repondre_a: assistante.email,
      sujet: remplir(modele.sujet, valeurs),
      texte: remplir(textes.invitation.texte, valeurs),
    };
  }

  return { lienConnexion, invitation };
}
