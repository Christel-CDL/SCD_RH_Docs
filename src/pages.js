// Pages HTML rendues côté serveur. Tout texte variable passe par echapper().
// Vocabulaire simple, gros boutons, une seule action principale par écran. Aucun script : tout marche par formulaires.
import { dateCourte, dateHeure, dateLongue } from './dates.js';
import { TYPES, STATUTS } from './demandes.js';
import { ACTIONS } from './utilisateurs.js';

export function echapper(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const csrf = (session) => `<input type="hidden" name="csrf" value="${echapper(session.csrf)}">`;
const message = (texte, erreur = false) => (texte
  ? `<p class="message${erreur ? ' erreur' : ''}" role="${erreur ? 'alert' : 'status'}">${echapper(texte)}</p>` : '');

function gabarit({ titre, contenu, session = null, agence, large = false }) {
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

// ── Lien du salarié (provisoire : le dépôt arrive à l'étape 3) ─────

export function pageDepotProvisoire({ agence, demande, pieces, catalogue }) {
  return gabarit({
    agence,
    titre: 'Vos documents',
    contenu: `
    <h1>Bonjour ${echapper(demande.civilite)} ${echapper(demande.nom)}</h1>
    <p>L'agence ${echapper(agence)} vous demande les documents suivants, à déposer avant le ${echapper(dateLongue(demande.date_limite))} :</p>
    <ul>${pieces.map((p) => `<li>${echapper(catalogue.pieces.get(p.abrev)?.libelle || p.abrev)}</li>`).join('')}</ul>
    ${message('Le dépôt en ligne sera disponible très bientôt sur cette même page.')}`,
  });
}

// ── Administration ────────────────────────────────────────────────

export function pageAdminUtilisateurs({ agence, session, utilisateurs, domaines, info = '', erreur = '', saisie = {} }) {
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
