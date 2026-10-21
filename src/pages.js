// Pages HTML rendues côté serveur. Tout texte variable passe par echapper().
// Vocabulaire simple, gros boutons, une seule action principale par écran. Tout marche par formulaires ;
// seule la page de dépôt ajoute un script (public/depot.js), qui améliore les photos sans être indispensable.
import { dateCourte, dateHeure, dateLongue, dateJour } from './dates.js';
import { TYPES, STATUTS } from './demandes.js';
import { ACTIONS } from './utilisateurs.js';
import { prochaineRelance } from './relances.js';
import { LIGNES } from './tableau.js';

export function echapper(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const csrf = (session) => `<input type="hidden" name="csrf" value="${echapper(session.csrf)}">`;
const message = (texte, erreur = false) => (texte
  ? `<p class="message${erreur ? ' erreur' : ''}" role="${erreur ? 'alert' : 'status'}">${echapper(texte)}</p>` : '');

function gabarit({ titre, contenu, session = null, agence, large = false, script = null }) {
  const barre = session
    ? `<nav class="navigation" aria-label="Menu">
         <a href="/">Mes demandes</a>
         <a href="/aide">Aide</a>
         ${session.role === 'admin' ? '<a href="/admin/utilisateurs">Administration</a>' : ''}
         <form method="post" action="/deconnexion">
           ${csrf(session)}
           <button type="submit" class="lien">Se déconnecter</button>
         </form>
       </nav>`
    : '';
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${echapper(titre)} – ${echapper(agence)}</title>
  <link rel="stylesheet" href="/styles.css">
  ${script ? `<script src="${script}" defer></script>` : ''}
</head>
<body>
  <a class="evitement" href="#contenu">Aller au contenu</a>
  <header class="entete">
    <p class="agence">
      <img class="logo" src="/logo.jpg" alt="Essentiel &amp; Domicile" width="56" height="56">
      <span class="lieu"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 21s-6.5-6.6-6.5-11.5a6.5 6.5 0 0 1 13 0C18.5 14.4 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.3" fill="none" stroke="currentColor" stroke-width="2"/></svg>${echapper(agence.replace(/^Essentiel\s*&\s*Domicile\s*/i, '') || agence)}</span>
    </p>
    ${barre}
  </header>
  <main id="contenu"${large ? ' class="large"' : ''}>
    ${contenu}
  </main>
</body>
</html>`;
}

// ── Connexion ─────────────────────────────────────────────────────

export function pageConnexion({ agence, email = '', erreur = '' }) {
  return gabarit({
    agence,
    titre: 'Connexion',
    contenu: `
    <h1>Connexion</h1>
    <p>Saisissez votre adresse e-mail professionnelle. Vous recevrez un lien pour vous connecter, sans mot de passe.</p>
    ${message(erreur, true)}
    <form method="post" action="/connexion" class="formulaire">
      <label for="email">Adresse e-mail</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="254" value="${echapper(email)}">
      <button type="submit" class="bouton">Recevoir mon lien de connexion</button>
    </form>`,
  });
}

export function pageLienEnvoye({ agence, minutes }) {
  return gabarit({
    agence,
    titre: 'Vérifiez votre messagerie',
    contenu: `
    <h1>Vérifiez votre messagerie</h1>
    ${message('Si cette adresse est autorisée, un lien de connexion vient de lui être envoyé.')}
    <p>Le lien est valable ${minutes} minutes et ne sert qu'une seule fois. Pensez à regarder dans les courriers indésirables.</p>
    <p><a href="/connexion">Revenir à la connexion</a></p>`,
  });
}

export function pageConfirmerConnexion({ agence, jeton }) {
  return gabarit({
    agence,
    titre: 'Se connecter',
    contenu: `
    <h1>Se connecter</h1>
    <p>Touchez le bouton pour ouvrir votre session.</p>
    <form method="post" action="/connexion/lien" class="formulaire">
      <input type="hidden" name="jeton" value="${echapper(jeton)}">
      <button type="submit" class="bouton">Me connecter</button>
    </form>`,
  });
}

export function pageLienInvalide({ agence }) {
  return gabarit({
    agence,
    titre: 'Lien expiré',
    contenu: `
    <h1>Ce lien ne fonctionne plus</h1>
    ${message('Le lien a déjà servi ou il a expiré.', true)}
    <p><a class="bouton" href="/connexion">Demander un nouveau lien</a></p>`,
  });
}

// ── Demandes (assistante) ─────────────────────────────────────────

export function pageAccueil({ agence, session, demandes, filtre = null, info = '' }) {
  const filtres = [[null, 'Toutes'], ['embauche', 'Embauches'], ['mise_a_jour', 'Mises à jour']]
    .map(([valeur, libelle]) => (valeur === filtre
      ? `<span class="filtre actif" aria-current="page">${libelle}</span>`
      : `<a class="filtre" href="/${valeur ? `?type=${valeur}` : ''}">${libelle}</a>`)).join('');
  // Boutons de suivi (étape 6) : relancer le salarié (au plus une fois par 24 h) et annuler la demande.
  const suivi = (d) => {
    const enCours = ['envoyee', 'en_cours'].includes(d.statut);
    if (!enCours && d.statut !== 'complete') return '';
    const prochaine = prochaineRelance(d);
    const derniere = Math.max(d.relance_le || 0, d.relance_manuelle_le || 0);
    let relance = '';
    if (enCours && d.relancable && d.date_limite > Date.now()) {
      relance = prochaine && prochaine > Date.now()
        ? `<p class="discret">Relancé le ${dateHeure(derniere)}. Nouvelle relance possible à partir du ${dateHeure(prochaine)}.</p>`
        : `${derniere ? `<p class="discret">Dernière relance : ${dateHeure(derniere)}.</p>` : ''}
          <form method="post" action="/demandes/${echapper(d.id)}/relancer">${csrf(session)}
            <button type="submit" class="bouton petit secondaire">Relancer le salarié</button></form>`;
    }
    return `<div class="suivi">${relance}
          <form method="post" action="/demandes/${echapper(d.id)}/annuler">${csrf(session)}
            <button type="submit" class="lien danger">Annuler la demande</button></form></div>`;
  };
  const lignes = demandes.map((d) => `
      <li class="carte">
        <p class="carte-titre">${echapper(d.civilite)} ${echapper(d.nom)}</p>
        <p>${echapper(TYPES[d.type])} · demandée le ${dateCourte(d.cree_le)}</p>
        <p><span class="statut statut-${d.statut}">${echapper(STATUTS[d.statut])}</span>
           ${['envoyee', 'en_cours'].includes(d.statut) ? ` · pièces déposées : ${d.deposees || 0} sur ${d.total}` : ''}</p>
        ${d.statut === 'complete' ? `<p><a class="bouton petit" href="/demandes/${echapper(d.id)}/pieces">Télécharger les pièces</a></p>` : ''}
        ${d.statut === 'transmise' ? `<p class="discret">Pièces récupérées, puis supprimées de l'outil le ${dateCourte(d.transmise_le)}.</p>` : ''}
        ${['envoyee', 'en_cours'].includes(d.statut) ? `<p class="discret">Date limite : ${dateCourte(d.date_limite)}</p>` : ''}
        ${d.statut === 'annulee' ? `<p class="discret">Annulée le ${dateCourte(d.annulee_le)} : pièces déposées et lien du salarié supprimés.</p>` : ''}
        ${suivi(d)}
      </li>`).join('');
  return gabarit({
    agence,
    session,
    titre: 'Mes demandes',
    contenu: `
    <h1>Mes demandes</h1>
    ${message(info)}
    <div class="actions">
      <a class="bouton" href="/demandes/nouvelle?type=embauche">Nouvelle embauche</a>
      <a class="bouton secondaire" href="/demandes/nouvelle?type=mise_a_jour">Mettre à jour le dossier d'un salarié</a>
    </div>
    <h2>Suivi</h2>
    <div class="filtres">${filtres}</div>
    ${demandes.length ? `<ul class="cartes">${lignes}</ul>` : '<p>Aucune demande pour le moment.</p>'}`,
  });
}

export function pageNouvelleDemande({ agence, session, catalogue, type, saisie = null, erreurs = {} }) {
  const coches = new Set(saisie ? saisie.pieces : catalogue.modeles[type]);
  const erreur = (champ) => (erreurs[champ] ? `<p class="erreur-champ" id="erreur-${champ}">${echapper(erreurs[champ])}</p>` : '');
  const decrit = (champ) => (erreurs[champ] ? ` aria-describedby="erreur-${champ}" aria-invalid="true"` : '');
  const cases = catalogue.liste.filter((p) => p.dans_formulaire).map((p) => `
        <li>
          <input type="checkbox" id="piece-${p.abrev}" name="pieces" value="${p.abrev}"${coches.has(p.abrev) ? ' checked' : ''}>
          <label for="piece-${p.abrev}">${echapper(p.libelle)}${p.controle_seulement ? ' <span class="discret">(contrôle seulement)</span>' : ''}</label>
        </li>`).join('');
  const civilites = ['M.', 'Mme'].map((c) => `
        <span class="choix">
          <input type="radio" id="civ-${c}" name="civilite" value="${c}" required${saisie?.civilite === c ? ' checked' : ''}>
          <label for="civ-${c}">${c}</label>
        </span>`).join('');
  return gabarit({
    agence,
    session,
    titre: TYPES[type],
    contenu: `
    <h1>${type === 'embauche' ? 'Nouvelle embauche' : 'Mise à jour du dossier d\'un salarié'}</h1>
    <p>${type === 'embauche'
    ? 'Les pièces habituelles d\'une embauche sont déjà cochées : ajustez-les si besoin.'
    : 'Cochez uniquement les pièces à renouveler (titre de séjour, justificatif de domicile, RIB…).'}
      <a href="/demandes/nouvelle?type=${type === 'embauche' ? 'mise_a_jour' : 'embauche'}">Changer de type de demande</a></p>
    ${erreurs.envoi ? message(erreurs.envoi, true)
    : Object.keys(erreurs).length ? message('Le formulaire contient des erreurs : corrigez les champs signalés.', true) : ''}
    <form method="post" action="/demandes" class="formulaire" novalidate>
      ${csrf(session)}
      <input type="hidden" name="type" value="${type}">
      <fieldset${decrit('civilite')}>
        <legend>Civilité du salarié</legend>
        ${civilites}
        ${erreur('civilite')}
      </fieldset>
      <label for="nom">Nom de famille du salarié</label>
      <input id="nom" name="nom" type="text" autocomplete="off" required maxlength="80" value="${echapper(saisie?.nom || '')}"${decrit('nom')}>
      ${erreur('nom')}
      <label for="email">Adresse e-mail du salarié</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="off" required maxlength="254" value="${echapper(saisie?.email || '')}"${decrit('email')}>
      ${erreur('email')}
      <fieldset${decrit('pieces')}>
        <legend>Pièces demandées</legend>
        ${erreur('pieces')}
        <ul class="cases">${cases}</ul>
      </fieldset>
      <button type="submit" class="bouton">Envoyer l'invitation au salarié</button>
    </form>`,
  });
}

// ── Dépôt des pièces (salarié, sur téléphone) ─────────────────────

const ETATS_PIECE = { a_faire: 'À faire', deposee: 'Déposée ✓', a_refaire: 'À refaire' };
const ETIQUETTES = { recto_verso: ['Recto', 'Verso'], une: ['Photo'], plusieurs: ['Page 1'] };

// Un emplacement = une page : deux boutons (appareil photo, fichier) et un aperçu rempli par le script.
function emplacement(abrev, numero, etiquette) {
  const id = `${abrev}-${numero}`;
  return `
          <div class="emplacement" data-numero="${numero}">
            <p class="etiquette">${echapper(etiquette)}</p>
            <div class="boutons-capture">
              <label class="bouton secondaire" for="${id}-photo">Prendre une photo</label>
              <input class="cache" id="${id}-photo" type="file" name="fichier" accept="image/*" capture="environment">
              <label class="bouton secondaire" for="${id}-fichier">Choisir un fichier</label>
              <input class="cache" id="${id}-fichier" type="file" name="fichier" accept="image/*,application/pdf,.heic,.heif">
            </div>
            <img class="apercu" alt="Aperçu : ${echapper(etiquette)}" hidden>
            <p class="nom-fichier" hidden></p>
          </div>`;
}

function blocPiece({ piece, jeton, ouverte, erreur, premiereAFaire }) {
  const pages = piece.choix ? 'recto_verso' : piece.pages; // pour un choix, on prévoit le cas le plus long
  const choix = piece.choix ? `
        <fieldset class="choix-piece">
          <legend>Quelle pièce fournissez-vous ?</legend>
          ${piece.choix.map((c) => `
          <span class="choix">
            <input type="radio" id="${piece.abrev}-choix-${c.abrev}" name="choix" value="${c.abrev}" data-pages="${c.pages}" required${piece.abrevFournie === c.abrev ? ' checked' : ''}>
            <label for="${piece.abrev}-choix-${c.abrev}">${echapper(c.libelle)}</label>
          </span>`).join('')}
        </fieldset>` : '';
  const emplacements = ETIQUETTES[pages].map((e, i) => emplacement(piece.abrev, i + 1, e)).join('');
  const formulaire = ouverte ? `
      <details${erreur || (premiereAFaire && piece.statut !== 'deposee') ? ' open' : ''}>
        <summary class="bouton${piece.statut === 'deposee' ? ' secondaire' : ''}">${piece.statut === 'deposee' ? 'Remplacer cette pièce' : 'Déposer cette pièce'}</summary>
        <form method="post" action="/d/${echapper(jeton)}/pieces/${piece.abrev}" enctype="multipart/form-data" class="depot" data-pages="${pages}" novalidate>
          ${choix}
          <div class="cadre-guide">
            <span class="cadre-dessin" aria-hidden="true"><span class="cadre-document"></span></span>
            <p>Posez le document à plat, près d'une fenêtre. Il doit remplir presque tout l'écran, sans reflet ni doigt dessus.</p>
          </div>
          <div class="emplacements">${emplacements}</div>
          ${pages === 'plusieurs' ? '<button type="button" class="bouton secondaire ajouter-page" hidden>Ajouter une page</button>' : ''}
          ${erreur ? message(erreur, true) : ''}
          <p class="etat-envoi" role="status" aria-live="polite"></p>
          <button type="submit" class="bouton">Valider cette pièce</button>
        </form>
      </details>` : '';
  return `
    <li class="carte piece" id="piece-${piece.abrev}">
      <h2 class="carte-titre">${echapper(piece.fournie || piece.libelle)}</h2>
      <p><span class="statut statut-piece-${piece.statut}">${ETATS_PIECE[piece.statut]}</span>
         ${piece.statut === 'deposee' ? ` · ${piece.nbPages} page${piece.nbPages > 1 ? 's' : ''}` : ''}</p>
      ${piece.statut === 'deposee' && piece.aVerifier ? '<p class="discret">Photo peu lisible envoyée quand même : l\'agence la vérifiera et vous recontactera si besoin.</p>' : ''}
      <p class="discret">${echapper(piece.consigne)}</p>
      ${formulaire}
    </li>`;
}

export function pageDepot({ agence, demande, jeton, etat, textes, controles, erreur = null }) {
  const deposees = etat.pieces.filter((p) => p.statut === 'deposee').length;
  const premiere = etat.pieces.find((p) => p.statut !== 'deposee')?.abrev;
  const rgpd = (textes.mention_rgpd || []).map((b) => `<h3>${echapper(b.titre)}</h3><p>${echapper(b.texte)}</p>`).join('');
  const aide = (textes.aide_depot || []).map((t) => `<li>${echapper(t)}</li>`).join('');
  return gabarit({
    agence,
    titre: 'Vos documents',
    script: '/depot.js',
    contenu: `
    <h1>Bonjour ${echapper(demande.civilite)} ${echapper(demande.nom)}</h1>
    <details class="rgpd">
      <summary>Vos données personnelles : qui les reçoit, combien de temps</summary>
      ${rgpd}
    </details>
    ${etat.ouverte
    ? `<p>L'agence ${echapper(agence)} vous demande les documents ci-dessous. Déposez-les avant le <strong>${echapper(dateJour(demande.date_limite))}</strong>.</p>`
    : message('Le délai de dépôt est dépassé : vous ne pouvez plus déposer de pièce. Contactez l\'agence.', true)}
    <p class="progression" aria-live="polite">Pièces déposées : <strong>${deposees} sur ${etat.pieces.length}</strong></p>
    <details class="aide">
      <summary>Besoin d'aide ? Conseils pour une bonne photo</summary>
      <ul>${aide}</ul>
    </details>
    <noscript>${message('Votre navigateur bloque les scripts : vous pouvez quand même envoyer des photos (JPEG ou PNG), mais pas de PDF.')}</noscript>
    <ul class="cartes" data-controles="${echapper(JSON.stringify({ ...controles, messages: textes.lisibilite }))}">
      ${etat.pieces.map((piece) => blocPiece({
    piece, jeton, ouverte: etat.ouverte, premiereAFaire: piece.abrev === premiere, erreur: erreur?.abrev === piece.abrev ? erreur.texte : null,
  })).join('')}
    </ul>
    ${etat.ouverte ? `
    <form method="post" action="/d/${echapper(jeton)}/envoyer" class="formulaire envoi-final">
      ${erreur?.abrev === null ? message(erreur.texte, true) : ''}
      <button type="submit" class="bouton"${etat.complet ? '' : ' disabled aria-disabled="true"'}>Envoyer mon dossier</button>
      <p class="discret">${etat.complet ? 'Toutes les pièces sont déposées : vous pouvez envoyer votre dossier à l\'agence.' : 'Ce bouton s\'activera quand toutes les pièces seront déposées.'}</p>
    </form>` : ''}`,
  });
}

export function pageDepotTermine({ agence, demande }) {
  return gabarit({
    agence,
    titre: 'Dossier envoyé',
    contenu: `
    <h1>Merci ${echapper(demande.civilite)} ${echapper(demande.nom)}</h1>
    ${message('Votre dossier est complet : il est transmis automatiquement à l\'agence. Vous n\'avez plus rien à faire.')}
    <p>Vos documents seront supprimés de cet outil dès que l'agence les aura reçus. Vous pouvez fermer cette page.</p>`,
  });
}

// ── Téléchargement des pièces (personne qui a fait la demande) ─────

export function pagePieces({ agence, session, demande, pieces }) {
  const titre = `${demande.civilite} ${demande.nom}`;
  if (demande.statut !== 'complete') {
    const texte = demande.statut === 'transmise'
      ? `Les pièces ont été récupérées, puis supprimées de l'outil le ${dateCourte(demande.transmise_le)}.`
      : 'Le salarié n\'a pas encore envoyé son dossier complet : il n\'y a rien à télécharger pour le moment.';
    return gabarit({
      agence, session, titre: 'Pièces', contenu: `<h1>Pièces de ${echapper(titre)}</h1>${message(texte)}<p><a href="/">Revenir à mes demandes</a></p>`,
    });
  }
  const lignes = pieces.map((p) => `
      <li class="carte">
        <p class="carte-titre">${echapper(p.libelle)}</p>
        ${p.aVerifier ? '<p class="erreur-champ">À vérifier : photo peu lisible, envoyée par le salarié malgré le contrôle de lisibilité.</p>' : ''}
        ${p.controleSeulement ? '<p class="erreur-champ">Contrôle seulement : à consulter puis supprimer, ne pas archiver.</p>' : ''}
        <p><a class="bouton petit secondaire" href="/demandes/${echapper(demande.id)}/pieces/${echapper(p.abrev)}.pdf">Télécharger ${echapper(p.nom)}</a></p>
      </li>`).join('');
  return gabarit({
    agence,
    session,
    titre: 'Pièces',
    contenu: `
    <h1>Pièces de ${echapper(titre)}</h1>
    <p>${echapper(TYPES[demande.type])} · demandée le ${dateCourte(demande.cree_le)}</p>
    <p><a class="bouton" href="/demandes/${echapper(demande.id)}/pieces/tout.zip">Tout télécharger (un seul fichier ZIP)</a></p>
    <ul class="cartes">${lignes}</ul>
    <h2>Une fois les pièces enregistrées</h2>
    <p>Classez-les dans le dossier du salarié, puis supprimez-les de l'outil. Sans action de votre part, elles le seront automatiquement 24 heures après le premier téléchargement, et au plus tard le ${echapper(dateLongue(demande.expire_le))}.</p>
    <form method="post" action="/demandes/${echapper(demande.id)}/pieces/effacer" class="formulaire">
      ${csrf(session)}
      <button type="submit" class="bouton danger">J'ai enregistré les pièces : les supprimer de l'outil</button>
    </form>
    <p><a href="/">Revenir à mes demandes</a></p>`,
  });
}

// ── Administration ────────────────────────────────────────────────

export function pageAdminUtilisateurs({
  agence, session, utilisateurs, domaines, envoisEnEchec = [], emailsDuJour = 0, quota = 0, info = '', erreur = '', saisie = {},
}) {
  const echecs = envoisEnEchec.map((e) => `
      <li class="carte">
        <p class="carte-titre">Demande <code>${echapper(e.demande_id.slice(0, 8))}</code></p>
        <p>Abandonné le ${dateHeure(e.alerte_le)} après ${e.tentatives} tentatives. Les pièces restent chiffrées jusqu'à la purge à 15 jours.</p>
        <form method="post" action="/admin/envois/${echapper(e.id)}/relancer">
          ${csrf(session)}
          <button type="submit" class="bouton petit">Relancer l'envoi</button>
        </form>
      </li>`).join('');
  const blocEnvois = `
    <h2>Envois des pièces</h2>
    <p>E-mails envoyés aujourd'hui par l'outil : <strong>${emailsDuJour}</strong> sur une part de ${quota} par jour (compte Brevo partagé).</p>
    ${echecs ? `<p class="erreur-champ">Envois en échec : réparez d'abord n8n ou Brevo, puis relancez.</p><ul class="cartes">${echecs}</ul>` : '<p>Aucun envoi en échec.</p>'}`;
  const hors = (u) => u.role !== 'admin' && domaines.length && !domaines.includes(u.email.split('@')[1]);
  const lignes = utilisateurs.map((u) => `
      <li class="carte">
        <p class="carte-titre">${echapper(u.nom || u.email)}</p>
        <p>${echapper(u.email)}</p>
        <p>${u.role === 'admin' ? 'Administratrice' : 'Peut faire des demandes'} ·
           <span class="statut statut-${u.actif ? 'actif' : 'inactif'}">${u.actif ? 'Active' : 'Désactivée'}</span>
           · ${u.demandes} demande${u.demandes > 1 ? 's' : ''}</p>
        ${hors(u) ? '<p class="erreur-champ">Domaine hors de la liste autorisée : cette adresse ne peut plus se connecter.</p>' : ''}
        ${u.role === 'admin' ? '' : `
        <div class="actions-ligne">
          <form method="post" action="/admin/utilisateurs/${u.id}/${u.actif ? 'desactiver' : 'reactiver'}">
            ${csrf(session)}
            <button type="submit" class="bouton petit secondaire">${u.actif ? 'Désactiver' : 'Réactiver'}</button>
          </form>
          <form method="post" action="/admin/utilisateurs/${u.id}/supprimer">
            ${csrf(session)}
            <button type="submit" class="bouton petit danger">Supprimer</button>
          </form>
        </div>`}
      </li>`).join('');
  return gabarit({
    agence,
    session,
    titre: 'Administration',
    contenu: `
    <h1>Administration</h1>
    <p class="liens-admin"><a href="/admin/tableau-de-bord">Tableau de bord</a> · <a href="/admin/reglages">Réglages (durées, quotas, lisibilité)</a> · <a href="/admin/textes">Textes des e-mails et de la page de dépôt</a>
      · <a href="/admin/journal">Journal d'activité</a></p>
    ${message(info)}${message(erreur, true)}
    <h2>Ajouter une adresse autorisée</h2>
    <form method="post" action="/admin/utilisateurs" class="formulaire">
      ${csrf(session)}
      <label for="nom">Prénom et nom (cités dans les e-mails envoyés aux salariés)</label>
      <input id="nom" name="nom" type="text" required maxlength="80" value="${echapper(saisie.nom || '')}">
      <label for="email">Adresse e-mail professionnelle</label>
      <input id="email" name="email" type="email" inputmode="email" required maxlength="254" value="${echapper(saisie.email || '')}">
      <button type="submit" class="bouton">Ajouter</button>
    </form>
    <h2>Domaines autorisés</h2>
    <form method="post" action="/admin/domaines" class="formulaire">
      ${csrf(session)}
      <label for="domaines">Domaines, séparés par des virgules (laisser vide pour accepter tous les domaines)</label>
      <input id="domaines" name="domaines" type="text" value="${echapper(domaines.join(', '))}" placeholder="exemple.fr, autre-exemple.fr">
      <button type="submit" class="bouton secondaire">Enregistrer les domaines</button>
    </form>
    ${blocEnvois}
    <h2>Adresses autorisées</h2>
    <ul class="cartes">${lignes}</ul>`,
  });
}

// ── Tableau de bord (demande de Christel du 21/10/2026) : des nombres seulement, jamais de nom de salarié ──

export function pageTableauDeBord({ agence, session, etat, semaines, quota, heureBilan }) {
  const s = etat.parStatut;
  const tuile = (nombre, libelle, alerte = false) => `<li class="tuile${alerte ? ' alerte' : ''}"><span class="nombre">${nombre}</span> ${echapper(libelle)}</li>`;
  const jours = (d) => (d == null ? '–' : `${d.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} j`);
  const entete = semaines.map((w) => `<th scope="col">${w.enCours ? 'En cours' : dateCourte(w.debut).slice(0, 5)}</th>`).join('');
  const ligne = (libelle, valeurs) => `<tr><th scope="row">${echapper(libelle)}</th>${valeurs.map((v) => `<td>${v}</td>`).join('')}</tr>`;
  const corps = [
    ...LIGNES.map((l) => ligne(l.libelle, semaines.map((w) => w[l.cle] || '·'))),
    ligne('Délai médian entre l\'invitation et le dossier envoyé', semaines.map((w) => jours(w.delaiJours))),
    ligne('E-mails envoyés par l\'outil', semaines.map((w) => w.emails || '·')),
  ].join('');
  const personnes = etat.parPersonne.length
    ? `<table class="tableau etroit"><thead><tr><th scope="col">Personne</th><th scope="col">Demandes</th></tr></thead><tbody>${etat.parPersonne.map((p) => `<tr><th scope="row">${echapper(p.nom)}</th><td>${p.n}</td></tr>`).join('')}</tbody></table>`
    : '<p>Aucune demande depuis 30 jours.</p>';
  return gabarit({
    agence,
    session,
    titre: 'Tableau de bord',
    large: true,
    contenu: `
    <h1>Tableau de bord</h1>
    <p><a href="/admin/utilisateurs">Retour à l'administration</a> · <a href="/admin/journal">Journal d'activité</a></p>
    <h2>En ce moment</h2>
    <ul class="tuiles">
      ${tuile(s.envoyee, 'invitations sans dépôt')}
      ${tuile(s.en_cours, 'dossiers en cours de dépôt')}
      ${tuile(s.complete, 'dossiers complets, pièces à télécharger', s.complete > 0)}
      ${tuile(s.transmise, 'pièces récupérées (15 derniers jours)')}
      ${tuile(s.annulee, 'demandes annulées (15 derniers jours)')}
      ${tuile(etat.enEchec, 'envois en échec', etat.enEchec > 0)}
      ${tuile(`${etat.emailsDuJour}/${quota}`, 'e-mails envoyés aujourd\'hui')}
    </ul>
    <p>Dernière activité (demande, dépôt ou connexion) : <strong>${etat.derniereActivite ? dateHeure(etat.derniereActivite) : 'aucune'}</strong>.</p>
    <h2>Par semaine</h2>
    <p class="discret">Chaque colonne est une semaine, du lundi indiqué au dimanche ; « · » = aucun.</p>
    <div class="defilement"><table class="tableau"><thead><tr><th scope="col"></th>${entete}</tr></thead><tbody>${corps}</tbody></table></div>
    <h2>Demandes par personne (30 derniers jours)</h2>
    ${personnes}
    <h2>Être prévenue si l'outil s'arrête</h2>
    <p>Chaque matin ${heureBilan >= 0 ? `vers ${heureBilan} h` : ''}, l'outil vous envoie un <strong>bilan de la veille</strong>. <strong>Si vous ne le recevez pas</strong>, l'outil ou n8n est peut-être arrêté :
      ouvrez https://pieces.expertform.fr/sante (doit afficher « ok ») et regardez l'état des conteneurs dans hPanel.</p>`,
  });
}

// ── Réglages (étape 6) ────────────────────────────────────────────

// Un champ numérique, avec sa valeur d'origine et son éventuelle erreur.
function champNombre(c, erreurs, saisie) {
  const id = `r-${c.cle.replace(/\./g, '-')}`;
  const valeur = saisie ? saisie.get(c.cle) ?? '' : c.valeur;
  const erreur = erreurs[c.cle];
  return `
      <div class="reglage">
        <label for="${id}">${echapper(c.libelle)}${c.modifie ? ' <span class="modifie">modifié</span>' : ''}</label>
        <input id="${id}" name="${echapper(c.cle)}" type="text" inputmode="${c.liste ? 'text' : 'decimal'}" value="${echapper(valeur)}"
          ${erreur ? `aria-invalid="true" aria-describedby="${id}-erreur"` : `aria-describedby="${id}-aide"`}>
        ${erreur ? `<p class="erreur-champ" id="${id}-erreur">${echapper(erreur)}</p>` : ''}
        <p class="discret" id="${id}-aide">${c.aide ? `${echapper(c.aide)} ` : ''}${c.liste ? '' : `De ${echapper(String(c.min).replace('.', ','))} à ${echapper(String(c.max).replace('.', ','))}. `}Valeur d'origine : ${echapper(c.origine)}.</p>
      </div>`;
}

export function pageAdminReglages({ agence, session, envoi, controles, info = '', section = null, erreurs = {}, saisie = null }) {
  const bloc = (nom, titre, intro, champs) => `
    <section class="bloc-reglages" id="${nom}">
      <h2>${titre}</h2>
      <p>${intro}</p>
      ${section === nom && erreurs.general ? message(erreurs.general, true) : ''}
      <form method="post" action="/admin/reglages/${nom}" class="formulaire" novalidate>
        ${csrf(session)}
        ${champs.map((c) => champNombre(c, section === nom ? erreurs : {}, section === nom ? saisie : null)).join('')}
        <button type="submit" class="bouton">Enregistrer</button>
        ${champs.some((c) => c.modifie) ? `<button type="submit" class="lien" formaction="/admin/reglages/${nom}/retablir">Revenir aux valeurs d'origine</button>` : ''}
      </form>
    </section>`;
  return gabarit({
    agence,
    session,
    titre: 'Réglages',
    contenu: `
    <h1>Réglages</h1>
    <p><a href="/admin/utilisateurs">Retour à l'administration</a> · <a href="/admin/textes">Textes</a></p>
    ${message(info)}
    ${section && !erreurs.general ? message('Rien n\'est enregistré : corrigez les champs signalés.', true) : ''}
    <p>Les changements valent aussitôt. La purge à 15 jours et la date limite (14 jours) ne sont pas réglables.</p>
    ${bloc('envoi', 'Relance et e-mails', 'Relance automatique du salarié et part du compte Brevo réservée à l\'outil.', envoi)}
    ${bloc('controles', 'Contrôle des photos', 'Seuils appliqués dans le téléphone du salarié. Réglés le 17/10/2026 sur des photos fictives : à modifier avec prudence, après des retours concrets.', controles)}`,
  });
}

export function pageAdminTextes({ agence, session, champs, info = '', erreurs = {}, apercu = null }) {
  const groupes = [...new Set(champs.map((c) => c.groupe))];
  const champ = (c) => {
    const id = `t-${c.cle.replace(/\./g, '-')}`;
    const erreur = erreurs[c.cle];
    const decrit = erreur ? `aria-invalid="true" aria-describedby="${id}-erreur ${id}-aide"` : `aria-describedby="${id}-aide"`;
    const lignes = Math.min(14, Math.max(2, c.valeur.split('\n').length + Math.ceil(c.valeur.length / 70)));
    return `
        <div class="reglage">
          <label for="${id}">${echapper(c.libelle)}${c.modifie ? ' <span class="modifie">modifié</span>' : ''}</label>
          ${c.long
    ? `<textarea id="${id}" name="${echapper(c.cle)}" rows="${lignes}" ${decrit}>${echapper(c.valeur)}</textarea>`
    : `<input id="${id}" name="${echapper(c.cle)}" type="text" value="${echapper(c.valeur)}" ${decrit}>`}
          ${erreur ? `<p class="erreur-champ" id="${id}-erreur">${echapper(erreur)}</p>` : ''}
          <p class="discret" id="${id}-aide">${c.variables.length ? `Mots remplacés automatiquement : ${c.variables.map((v) => `<code>{{${echapper(v)}}}</code>`).join(' ')}` : 'Aucun mot remplacé automatiquement.'}</p>
          ${c.modifie ? `<button type="submit" class="lien" formaction="/admin/textes/retablir" name="cle" value="${echapper(c.cle)}">Revenir au texte d'origine</button>` : ''}
        </div>`;
  };
  const blocs = groupes.map((g) => `
      <fieldset class="bloc-reglages">
        <legend>${echapper(g)}</legend>
        ${champs.filter((c) => c.groupe === g).map(champ).join('')}
      </fieldset>`).join('');
  const apercus = apercu ? `
    <section id="apercu" class="apercu-emails">
      <h2>Aperçu des e-mails (exemple fictif)</h2>
      ${message('Aperçu seulement : rien n\'est encore enregistré. Cliquez sur « Enregistrer les textes » pour les mettre en service.')}
      ${apercu.map((e) => `
      <article class="carte">
        <h3>${echapper(e.titre)}</h3>
        <p><strong>De :</strong> ${echapper(e.expediteur)}<br><strong>Objet :</strong> ${echapper(e.sujet)}</p>
        <pre class="texte-email">${echapper(e.texte)}</pre>
      </article>`).join('')}
    </section>` : '';
  const nbErreurs = Object.keys(erreurs).length;
  return gabarit({
    agence,
    session,
    titre: 'Textes',
    large: true,
    contenu: `
    <h1>Textes des e-mails et de la page de dépôt</h1>
    <p><a href="/admin/utilisateurs">Retour à l'administration</a> · <a href="/admin/reglages">Réglages</a></p>
    ${message(info)}
    ${nbErreurs ? message(`Rien n'est enregistré : ${nbErreurs} texte${nbErreurs > 1 ? 's sont' : ' est'} à corriger (signalé${nbErreurs > 1 ? 's' : ''} en rouge).`, true) : ''}
    <p>Les mots entre <code>{{ }}</code> sont remplacés automatiquement (nom du salarié, lien…) : ne les modifiez pas.
      Ne demandez jamais de mot de passe ni de coordonnées bancaires dans un e-mail. Utilisez « Aperçu » pour relire avant d'enregistrer.</p>
    ${apercus}
    <form method="post" action="/admin/textes" class="formulaire" novalidate>
      ${csrf(session)}
      <div class="actions">
        <button type="submit" class="bouton secondaire" name="action" value="apercu">Aperçu</button>
        <button type="submit" class="bouton" name="action" value="enregistrer">Enregistrer les textes</button>
      </div>
      ${blocs}
      <div class="actions">
        <button type="submit" class="bouton secondaire" name="action" value="apercu">Aperçu</button>
        <button type="submit" class="bouton" name="action" value="enregistrer">Enregistrer les textes</button>
      </div>
      ${champs.some((c) => c.modifie) ? '<button type="submit" class="lien danger" formaction="/admin/textes/retablir" name="cle" value="*">Revenir aux textes d\'origine pour tous les textes</button>' : ''}
    </form>`,
  });
}

export function pageConfirmerAnnulation({ agence, session, demande }) {
  return gabarit({
    agence,
    session,
    titre: 'Annuler une demande',
    contenu: `
    <h1>Annuler cette demande ?</h1>
    <p>Demande de ${echapper(demande.civilite)} ${echapper(demande.nom)} (${echapper(TYPES[demande.type].toLowerCase())} du ${dateCourte(demande.cree_le)}).</p>
    <p>Les pièces déjà déposées et le lien du salarié seront <strong>supprimés aussitôt</strong>. Le salarié ne reçoit pas d'e-mail ;
      s'il ouvre son lien, il verra que la demande est annulée. Cette action est définitive.</p>
    <form method="post" action="/demandes/${echapper(demande.id)}/annuler" class="formulaire">
      ${csrf(session)}
      <input type="hidden" name="confirme" value="oui">
      <button type="submit" class="bouton danger">Oui, annuler la demande</button>
    </form>
    <p><a href="/">Non, revenir à mes demandes</a></p>`,
  });
}

export function pageConfirmerSuppression({ agence, session, utilisateur }) {
  return gabarit({
    agence,
    session,
    titre: 'Supprimer une adresse',
    contenu: `
    <h1>Supprimer cette adresse ?</h1>
    <p><strong>${echapper(utilisateur.nom || utilisateur.email)}</strong> (${echapper(utilisateur.email)}) ne pourra plus se connecter. Cette action est définitive.</p>
    <form method="post" action="/admin/utilisateurs/${utilisateur.id}/supprimer" class="formulaire">
      ${csrf(session)}
      <input type="hidden" name="confirme" value="oui">
      <button type="submit" class="bouton danger">Oui, supprimer</button>
    </form>
    <p><a href="/admin/utilisateurs">Non, revenir à l'administration</a></p>`,
  });
}

export function pageAdminJournal({ agence, session, entrees }) {
  const lignes = entrees.map((e) => `
        <tr>
          <td>${dateHeure(e.quand)}</td>
          <td>${echapper(e.email || '—')}</td>
          <td>${echapper(ACTIONS[e.action] || e.action)}</td>
          <td>${e.demande_id ? `<code>${echapper(e.demande_id.slice(0, 8))}</code>` : ''}</td>
        </tr>`).join('');
  return gabarit({
    agence,
    session,
    large: true,
    titre: 'Journal d\'activité',
    contenu: `
    <h1>Journal d'activité</h1>
    <p>Les 300 derniers événements. Le journal ne contient jamais le nom ni l'adresse d'un salarié, ni le contenu d'une pièce.</p>
    <p><a href="/admin/utilisateurs">Retour à l'administration</a></p>
    <div class="defilement">
      <table>
        <thead><tr><th scope="col">Date</th><th scope="col">Compte</th><th scope="col">Action</th><th scope="col">Demande</th></tr></thead>
        <tbody>${lignes}</tbody>
      </table>
    </div>`,
  });
}

export function pageMessage({ agence, titre, message: texte, session = null }) {
  return gabarit({
    agence,
    session,
    titre,
    contenu: `
    <h1>${echapper(titre)}</h1>
    ${message(texte, true)}
    <p><a href="/">Revenir à l'accueil</a></p>`,
  });
}

// ── Guide d'une page pour les personnes qui font les demandes (livrable 6) ──
// Imprimable tel quel (styles.css, @media print) ; le même texte sert à fabriquer le PDF remis à l'agence.
export function pageGuide({ agence, session = null, appUrl, contact, minutesLien, joursRelance }) {
  return gabarit({
    agence,
    session,
    titre: 'Aide',
    large: true,
    contenu: `
    <h1>Demander des pièces à un salarié : mode d'emploi</h1>
    <p class="guide-adresse">Adresse de l'outil : <strong>${echapper(appUrl)}</strong></p>
    <div class="guide">
      <div class="guide-colonne">
      <section>
        <h2>1. Se connecter</h2>
        <p>Saisissez votre adresse e-mail professionnelle, puis touchez « Recevoir mon lien de connexion ». Ouvrez l'e-mail reçu
          (regardez dans les courriers indésirables les premières fois) et touchez « Me connecter ». Le lien sert une seule fois
          et dure ${minutesLien} minutes. Aucun mot de passe.</p>
      </section>
      <section>
        <h2>2. Faire une demande</h2>
        <p>« Nouvelle embauche » : les pièces habituelles sont déjà cochées, ajustez si besoin. « Mettre à jour le dossier
          d'un salarié » : cochez seulement les pièces à renouveler. Saisissez la civilité, le nom de famille et l'adresse
          e-mail du salarié (vérifiez-la bien), puis « Envoyer l'invitation au salarié ».</p>
      </section>
      <section>
        <h2>3. Ce que fait le salarié</h2>
        <p>Il reçoit un e-mail avec un bouton « Déposer mes documents ». Depuis son téléphone, il photographie chaque pièce ;
          l'outil vérifie que la photo est lisible. Il a 14 jours.${joursRelance > 0 ? ` S'il n'a pas fini, il reçoit une relance automatique au bout
          de ${joursRelance} jours.` : ''} S'il répond à l'e-mail, sa réponse vous arrive directement.</p>
      </section>
      <section>
        <h2>4. Suivre vos demandes</h2>
        <ul>
          <li><strong>Invitation envoyée</strong> : le salarié n'a encore rien déposé.</li>
          <li><strong>En cours</strong> : le nombre de pièces déposées est indiqué.</li>
          <li><strong>Complète : pièces à télécharger</strong> : le dossier est arrivé.</li>
          <li><strong>Pièces récupérées</strong> : vous les avez enregistrées, elles sont supprimées de l'outil.</li>
          <li><strong>Annulée</strong> : vous avez annulé la demande.</li>
        </ul>
        <p>« Relancer le salarié » lui renvoie le même lien (une fois par 24 heures au plus). « Annuler la demande »
          supprime aussitôt les pièces déposées et le lien.</p>
      </section>
      </div>
      <div class="guide-colonne">
      <section>
        <h2>5. Récupérer les pièces</h2>
        <p>Vous recevez un e-mail « Pièces reçues », <strong>sans pièce jointe</strong>. Touchez « Télécharger les pièces »,
          connectez-vous, téléchargez les PDF (un par un ou en un seul fichier ZIP) et rangez-les dans le dossier du salarié.
          Touchez ensuite « J'ai enregistré les pièces : les supprimer de l'outil ». Sans ce geste, elles sont supprimées
          24 heures après le premier téléchargement.</p>
        <p>« À VÉRIFIER » : photo peu lisible envoyée quand même, à contrôler. « CONTRÔLE SEULEMENT » (casier judiciaire) :
          à consulter puis supprimer, ne pas archiver.</p>
      </section>
      <section>
        <h2>6. Bon à savoir</h2>
        <ul>
          <li>Tout est effacé <strong>15 jours</strong> après la demande. Si le salarié n'a pas fini, vous recevez un e-mail
            « lien expiré » : refaites une demande et demandez-lui de surveiller sa messagerie.</li>
          <li>Ne transférez pas les e-mails de l'outil : les liens sont personnels.</li>
          <li>Une question, un problème : ${echapper(contact.nom || 'l\'administratrice')}${contact.email ? `, <a href="mailto:${echapper(contact.email)}">${echapper(contact.email)}</a>` : ''}.</li>
        </ul>
      </section>
      <section>
        <h2>Astuce</h2>
        <p>Sur téléphone, ajoutez l'outil à l'écran d'accueil (Safari : bouton Partager, puis « Sur l'écran
        d'accueil » ; Chrome : menu ⋮, puis « Ajouter à l'écran d'accueil »).</p>
      </section>
      </div>
    </div>`,
  });
}
