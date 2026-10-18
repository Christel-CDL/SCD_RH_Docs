// Pages HTML rendues côté serveur. Tout texte variable passe par echapper().
// Vocabulaire simple, gros boutons, une seule action principale par écran. Tout marche par formulaires ;
// seule la page de dépôt ajoute un script (public/depot.js), qui améliore les photos sans être indispensable.
import { dateCourte, dateHeure, dateLongue } from './dates.js';
import { TYPES, STATUTS } from './demandes.js';
import { ACTIONS } from './utilisateurs.js';

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
    <p class="agence">${echapper(agence)}</p>
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
  const lignes = demandes.map((d) => `
      <li class="carte">
        <p class="carte-titre">${echapper(d.civilite)} ${echapper(d.nom)}</p>
        <p>${echapper(TYPES[d.type])} · demandée le ${dateCourte(d.cree_le)}</p>
        <p><span class="statut statut-${d.statut}">${echapper(STATUTS[d.statut])}</span>
           ${['envoyee', 'en_cours'].includes(d.statut) ? ` · pièces déposées : ${d.deposees || 0} sur ${d.total}` : ''}</p>
        ${d.statut === 'complete' && d.envoi === 'echec' ? '<p class="erreur-champ">L\'envoi des pièces a échoué : l\'administratrice est prévenue.</p>' : ''}
        ${d.statut === 'transmise' ? `<p class="discret">Pièces envoyées par e-mail le ${dateCourte(d.transmise_le)}, puis supprimées de l'outil.</p>` : ''}
        ${['envoyee', 'en_cours'].includes(d.statut) ? `<p class="discret">Date limite : ${dateCourte(d.date_limite)}</p>` : ''}
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
  const cases = catalogue.liste.map((p) => `
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
    ? `<p>L'agence ${echapper(agence)} vous demande les documents ci-dessous. Déposez-les avant le <strong>${echapper(dateLongue(demande.date_limite))}</strong>.</p>`
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
    <h2>Envois à l'assistante</h2>
    <p>E-mails envoyés aujourd'hui par l'outil : <strong>${emailsDuJour}</strong> sur une part de ${quota} par jour (compte Brevo partagé).</p>
    ${echecs ? `<p class="erreur-champ">Envois en échec : réparez d'abord n8n ou Brevo, puis relancez.</p><ul class="cartes">${echecs}</ul>` : '<p>Aucun envoi en échec.</p>'}`;
  const hors = (u) => u.role !== 'admin' && domaines.length && !domaines.includes(u.email.split('@')[1]);
  const lignes = utilisateurs.map((u) => `
      <li class="carte">
        <p class="carte-titre">${echapper(u.nom || u.email)}</p>
        <p>${echapper(u.email)}</p>
        <p>${u.role === 'admin' ? 'Administratrice' : 'Assistante'} ·
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
    <p><a href="/admin/journal">Voir le journal d'activité</a></p>
    ${message(info)}${message(erreur, true)}
    <h2>Ajouter une adresse autorisée</h2>
    <form method="post" action="/admin/utilisateurs" class="formulaire">
      ${csrf(session)}
      <label for="nom">Prénom et nom de l'assistante</label>
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
