// Outils HTTP communs : en-têtes de sécurité, cookies, lecture des formulaires, contrôle d'origine.

export function enTetesSecurite(config) {
  const entetes = {
    // Étape 1 : aucune page n'exécute de script. Les étapes suivantes ouvriront script-src 'self' (et wasm pour OpenCV).
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // same-origin : le jeton présent dans l'adresse d'un lien magique ne fuit jamais vers un autre site.
    // (Pas « no-referrer » : Chrome enverrait alors « Origin: null » sur nos propres formulaires.)
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (config.https) entetes['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return entetes;
}

export function nomCookieSession(config) {
  // Le préfixe __Host- impose Secure, Path=/ et l'absence de Domain : le cookie ne peut être ni posé ni lu par un autre sous-domaine.
  return config.https ? '__Host-scd_session' : 'scd_session';
}

export function cookieSession(config, valeur, dureeMs) {
  const attributs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${valeur ? Math.floor(dureeMs / 1000) : 0}`];
  if (config.https) attributs.push('Secure');
  return `${nomCookieSession(config)}=${valeur || ''}; ${attributs.join('; ')}`;
}

export function lireCookies(req) {
  const resultat = {};
  for (const morceau of String(req.headers.cookie || '').split(/;\s*/)) {
    const i = morceau.indexOf('=');
    if (i > 0) resultat[morceau.slice(0, i)] = morceau.slice(i + 1);
  }
  return resultat;
}

export async function lireFormulaire(req, max = 8192) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/x-www-form-urlencoded') throw Object.assign(new Error('type'), { status: 415 });
  let taille = 0;
  const morceaux = [];
  for await (const morceau of req) {
    taille += morceau.length;
    if (taille > max) throw Object.assign(new Error('trop gros'), { status: 413 });
    morceaux.push(morceau);
  }
  return new URLSearchParams(Buffer.concat(morceaux).toString('utf8'));
}

// Une requête qui modifie quelque chose doit venir de l'application elle-même.
export function origineAutorisee(req, config) {
  const origine = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  // « null » : certains navigateurs masquent l'origine (politique de référent, redirection) ; on se fie alors à Sec-Fetch-Site.
  if (origine && origine !== 'null') return origine === new URL(config.appUrl).origin;
  if (origine === 'null') return site === 'same-origin';
  return !site || site === 'same-origin' || site === 'none';
}

export function adresseClient(req, config) {
  if (config.trustProxy) {
    const derniere = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (derniere) return derniere;
  }
  return req.socket.remoteAddress || '';
}
