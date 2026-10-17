// Lecture et contrôle des réglages (variables d'environnement).
// Le démarrage échoue avec un message clair si un réglage indispensable manque ;
// le journal indique la présence de chaque réglage, jamais sa valeur.
import path from 'node:path';

const SECRETS = ['N8N_WEBHOOK_SECRET'];

export function lireConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const appUrl = String(env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const config = {
    production,
    port: Number(env.PORT) || 3000,
    appUrl,
    https: appUrl.startsWith('https:'),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    adminEmail: String(env.ADMIN_EMAIL || '').trim().toLowerCase(),
    agence: env.AGENCE_NOM || 'Essentiel & Domicile Pessac',
    // Derrière Traefik, la dernière adresse de X-Forwarded-For est celle qu'il ajoute.
    trustProxy: env.TRUST_PROXY === '1',
    dureeSessionMs: (Number(env.SESSION_HOURS) || 8) * 3600e3,
    dureeLienConnexionMs: (Number(env.LOGIN_LINK_MINUTES) || 15) * 60e3,
    n8n: {
      webhookUrl: String(env.N8N_WEBHOOK_URL || ''),
      secret: String(env.N8N_WEBHOOK_SECRET || ''),
    },
    // Développement uniquement : les liens sont affichés dans la console au lieu d'être envoyés.
    devAfficherLiens: env.DEV_LOG_LINKS === '1',
  };

  const problemes = [];
  if (production && config.devAfficherLiens) problemes.push('DEV_LOG_LINKS est interdit en production.');
  if (production && !config.https) problemes.push('APP_URL doit commencer par https:// en production.');
  if (!config.devAfficherLiens) {
    if (!config.n8n.webhookUrl) problemes.push('N8N_WEBHOOK_URL manquant : aucun e-mail ne pourrait partir.');
    if (config.n8n.secret.length < 32) problemes.push('N8N_WEBHOOK_SECRET manquant ou trop court (32 caractères minimum).');
  }
  if (!config.adminEmail) problemes.push('ADMIN_EMAIL manquant : personne ne pourrait administrer l\'application.');

  return { config, problemes };
}

export function resumeConfig(env = process.env) {
  const noms = ['NODE_ENV', 'APP_URL', 'DATA_DIR', 'ADMIN_EMAIL', 'TRUST_PROXY', 'N8N_WEBHOOK_URL', ...SECRETS];
  return noms.map((nom) => {
    const valeur = String(env[nom] || '').trim();
    return `  ${nom} : ${valeur ? `reçu (${valeur.length} caractères)` : 'absent'}`;
  }).join('\n');
}
