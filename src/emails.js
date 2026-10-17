// Composition des e-mails. L'application écrit le message ; n8n se contente de l'envoyer (Brevo, puis Outlook).
// Ainsi, changer de fournisseur ne touche jamais aux textes, et les textes restent dans config/textes.json.
import { remplir } from './catalogue.js';
import { dateLongue, dateCourte } from './dates.js';

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

  // E-mail final à l'assistante, avec les PDF en pièces jointes (n8n les ajoute). Aucune donnée tirée des pièces :
  // seulement leur nom de fichier, leur libellé et les mentions « à vérifier » / « contrôle seulement ».
  // pieces : [{ nom, libelle, aVerifier, controleSeulement }] ; numero / total : découpage (1/2, 2/2…).
  function envoiFinal({ demande, assistante, pieces, numero = 1, total = 1 }) {
    const t = textes.envoi_final;
    const valeurs = {
      type: demande.type === 'embauche' ? 'Embauche' : 'Mise à jour',
      civilite: demande.civilite,
      nom: demande.nom,
      date_demande: dateCourte(demande.cree_le),
      assistante: assistante.nom || assistante.email,
      partie: total > 1 ? ` (${numero}/${total})` : '',
    };
    valeurs.liste = pieces.map((p) => [
      `  • ${p.nom} – ${p.libelle}`,
      ...(p.aVerifier ? [`    ${t.a_verifier}`] : []),
      ...(p.controleSeulement ? [`    ${t.controle_seulement}`] : []),
    ].join('\n')).join('\n');
    const autres = Array.from({ length: total }, (_, i) => i + 1).filter((n) => n !== numero).map((n) => `(${n}/${total})`).join(', ');
    valeurs.suite = total > 1 ? `\n${remplir(t.suite, { autres })}` : '';
    const mentions = [
      ...(pieces.some((p) => p.aVerifier) ? [t.mention_a_verifier] : []),
      ...(pieces.some((p) => p.controleSeulement) ? [t.mention_controle_seulement] : []),
    ];
    valeurs.mentions = mentions.length ? `\n${mentions.join('\n')}` : '';
    return {
      ...base,
      categorie: 'envoi_final',
      destinataire: assistante.email,
      sujet: remplir(t.sujet, valeurs),
      texte: remplir(t.texte, valeurs),
    };
  }

  // Alerte à l'administratrice : jamais de nom ni de donnée de salarié, seulement une référence technique.
  function alerte({ titre, detail, reference = '—' }) {
    const valeurs = { titre, detail, reference };
    return {
      ...base,
      categorie: 'alerte',
      destinataire: config.adminEmail,
      sujet: remplir(textes.alerte.sujet, valeurs),
      texte: remplir(textes.alerte.texte, valeurs),
    };
  }

  return { lienConnexion, invitation, envoiFinal, alerte };
}
