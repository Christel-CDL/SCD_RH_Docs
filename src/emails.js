// Composition des e-mails. L'application écrit le message ; n8n se contente de l'envoyer (Brevo, puis Outlook).
// Ainsi, changer de fournisseur ne touche jamais aux textes, et les textes restent dans config/textes.json.
import { remplir } from './catalogue.js';
import { dateLongue, dateCourte, dateJour } from './dates.js';

const echapper = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Version mise en forme d'un e-mail, tirée de sa version texte (qui reste envoyée en parallèle) : tout le texte
// est échappé, et la ligne qui contient le lien devient un gros bouton suivi du lien en clair, en secours.
// Styles en ligne uniquement : les messageries ignorent les feuilles de style. Aucune image, aucun pisteur.
export function versHtml(texte, { lien = null, bouton = null, secours = '' } = {}) {
  const corps = String(texte).split('\n').map((ligne) => {
    if (lien && bouton && ligne.trim() === lien) {
      return `<p style="margin:24px 0"><a href="${echapper(lien)}" style="display:inline-block;background:#602075;color:#ffffff;`
        + 'font-size:18px;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:6px">'
        + `${echapper(bouton)}</a></p><p style="margin:0 0 16px;font-size:13px;color:#4a5565">${echapper(secours)}<br>`
        + `<a href="${echapper(lien)}" style="color:#602075;word-break:break-all">${echapper(lien)}</a></p>`;
    }
    return ligne.trim() ? `${echapper(ligne)}<br>` : '<br>';
  }).join('\n');
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"></head>'
    + '<body style="margin:0;padding:16px;background:#ffffff">'
    + `<div style="max-width:600px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1c2430">\n${corps}\n</div>`
    + '</body></html>';
}

export function creerEmails({ textes, catalogue, config }) {
  const base = { nom_expediteur: textes.nom_expediteur };
  // Ajoute la version mise en forme à un message déjà composé en texte.
  const avecHtml = (message, options = {}) => ({ ...message, html: versHtml(message.texte, { ...options, secours: textes.lien_secours }) });

  function lienConnexion({ utilisateur, lien }) {
    const valeurs = { agence: config.agence, lien, minutes: Math.round(config.dureeLienConnexionMs / 60e3) };
    return avecHtml({
      ...base,
      categorie: 'lien_connexion',
      destinataire: utilisateur.email,
      sujet: remplir(textes.lien_connexion.sujet, valeurs),
      texte: remplir(textes.lien_connexion.texte, valeurs),
    }, { lien, bouton: textes.lien_connexion.bouton });
  }

  // Aucune donnée sensible : civilité, nom, liste des pièces, date limite, agence et nom de l'assistante.
  function invitation({ demande, abrevs, assistante, lien }) {
    const modele = textes.invitation[demande.type];
    const valeurs = {
      agence: config.agence,
      demandeur: assistante.nom || assistante.email,
      civilite: demande.civilite,
      nom: demande.nom,
      date_limite: dateJour(demande.date_limite),
      lien,
    };
    valeurs.intro = remplir(modele.intro, valeurs);
    valeurs.pieces = abrevs.map((a) => `  • ${catalogue.pieces.get(a).libelle}`).join('\n');
    return avecHtml({
      ...base,
      categorie: `invitation_${demande.type}`,
      destinataire: demande.email_salarie,
      repondre_a: assistante.email,
      sujet: remplir(modele.sujet, valeurs),
      texte: remplir(textes.invitation.texte, valeurs),
    }, { lien, bouton: textes.invitation.bouton });
  }

  // Relance du salarié (une seule, à J+7 par défaut) avec LE MÊME lien. manquantes : libellés des pièces encore à déposer.
  function relance({ demande, manquantes, assistante, lien }) {
    const t = textes.relance;
    const valeurs = {
      agence: config.agence,
      demandeur: assistante.nom || assistante.email,
      civilite: demande.civilite,
      nom: demande.nom,
      date_demande: dateCourte(demande.cree_le),
      date_limite: dateJour(demande.date_limite),
      lien,
    };
    valeurs.reste = manquantes.length
      ? remplir(t.manquantes, { pieces: manquantes.map((l) => `  • ${l}`).join('\n') })
      : t.toutes_deposees;
    return avecHtml({
      ...base,
      categorie: 'relance_salarie',
      destinataire: demande.email_salarie,
      repondre_a: assistante.email,
      sujet: remplir(t.sujet, valeurs),
      texte: remplir(t.texte, valeurs),
    }, { lien, bouton: textes.invitation.bouton });
  }

  const valeursDemande = (demande, demandeur) => ({
    type: demande.type === 'embauche' ? 'Embauche' : 'Mise à jour',
    civilite: demande.civilite,
    nom: demande.nom,
    date_demande: dateCourte(demande.cree_le),
    demandeur: demandeur.nom || demandeur.email,
  });

  // E-mail « pièces prêtes » à la personne qui a fait la demande. Il ne contient AUCUNE pièce (Brevo conservait les
  // pièces jointes, constaté le 18/10/2026) : un bouton mène à la page de téléchargement de l'application.
  // pieces : [{ nom, libelle, aVerifier, controleSeulement }] ; lien : page de téléchargement.
  function envoiFinal({ demande, assistante, pieces, lien }) {
    const t = textes.envoi_final;
    const valeurs = { ...valeursDemande(demande, assistante), lien, date_purge: dateLongue(demande.expire_le) };
    valeurs.liste = pieces.map((p) => [
      `  • ${p.libelle}`,
      ...(p.aVerifier ? [`    ${t.a_verifier}`] : []),
      ...(p.controleSeulement ? [`    ${t.controle_seulement}`] : []),
    ].join('\n')).join('\n');
    const mentions = [
      ...(pieces.some((p) => p.aVerifier) ? [t.mention_a_verifier] : []),
      ...(pieces.some((p) => p.controleSeulement) ? [t.mention_controle_seulement] : []),
    ];
    valeurs.mentions = mentions.length ? `\n${mentions.join('\n')}` : '';
    return avecHtml({
      ...base,
      categorie: 'envoi_final',
      destinataire: assistante.email,
      sujet: remplir(t.sujet, valeurs),
      texte: remplir(t.texte, valeurs),
    }, { lien, bouton: t.bouton });
  }

  // Expiration du lien sans que les pièces aient été récupérées (demande de Christel du 18/10/2026).
  // piecesPretes : le dossier était complet mais les pièces n'ont pas été téléchargées.
  function expiration({ demande, demandeur, piecesPretes }) {
    const t = textes.expiration;
    const valeurs = valeursDemande(demande, demandeur);
    return avecHtml({
      ...base,
      categorie: 'expiration',
      destinataire: demandeur.email,
      sujet: remplir(t.sujet, valeurs),
      texte: remplir(piecesPretes ? t.non_telecharge : t.non_envoye, valeurs),
    });
  }

  // Alerte à l'administratrice : jamais de nom ni de donnée de salarié, seulement une référence technique.
  function alerte({ titre, detail, reference = '—' }) {
    const valeurs = { titre, detail, reference };
    return avecHtml({
      ...base,
      categorie: 'alerte',
      destinataire: config.adminEmail,
      sujet: remplir(textes.alerte.sujet, valeurs),
      texte: remplir(textes.alerte.texte, valeurs),
    });
  }

  return { lienConnexion, invitation, relance, envoiFinal, expiration, alerte };
}
