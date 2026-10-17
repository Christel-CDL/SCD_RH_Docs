// Pages HTML rendues côté serveur. Tout texte variable passe par echapper().
// Vocabulaire simple, gros boutons, une seule action principale par écran.

export function echapper(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gabarit({ titre, contenu, session = null, agence }) {
  const barre = session
    ? `<form method="post" action="/deconnexion" class="deconnexion">
         <input type="hidden" name="csrf" value="${echapper(session.csrf)}">
         <span>${echapper(session.email)}</span>
         <button type="submit" class="lien">Se déconnecter</button>
       </form>`
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
  <header class="entete">
    <p class="agence">${echapper(agence)}</p>
    ${barre}
  </header>
  <main id="contenu">
    ${contenu}
  </main>
</body>
</html>`;
}

export function pageConnexion({ agence, email = '', erreur = '' }) {
  return gabarit({
    agence,
    titre: 'Connexion',
    contenu: `
    <h1>Connexion</h1>
    <p>Saisissez votre adresse e-mail professionnelle. Vous recevrez un lien pour vous connecter, sans mot de passe.</p>
    ${erreur ? `<p class="message erreur" role="alert">${echapper(erreur)}</p>` : ''}
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
    <p class="message" role="status">Si cette adresse est autorisée, un lien de connexion vient de lui être envoyé.</p>
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
    <p class="message erreur" role="alert">Le lien a déjà servi ou il a expiré.</p>
    <p><a class="bouton" href="/connexion">Demander un nouveau lien</a></p>`,
  });
}

export function pageAccueil({ agence, session }) {
  const admin = session.role === 'admin'
    ? '<li>Administration : adresses autorisées, journal et réglages (étape 2).</li>'
    : '';
  return gabarit({
    agence,
    session,
    titre: 'Mes demandes',
    contenu: `
    <h1>Mes demandes</h1>
    <p>Session ouverte pour ${echapper(session.nom || session.email)}.</p>
    <ul>
      <li>Créer une demande de pièces et suivre les demandes en cours (étape 2).</li>
      ${admin}
    </ul>`,
  });
}

export function pageMessage({ agence, titre, message }) {
  return gabarit({
    agence,
    titre,
    contenu: `
    <h1>${echapper(titre)}</h1>
    <p class="message erreur" role="alert">${echapper(message)}</p>
    <p><a href="/">Revenir à l'accueil</a></p>`,
  });
}
