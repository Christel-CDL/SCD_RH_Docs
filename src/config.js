// Lecture et contrôle des réglages (variables d'environnement).
// Le démarrage échoue avec un message clair si un réglage indispensable manque ;
// le journal indique la présence de chaque réglage, jamais sa valeur.
import path from 'node:path';
import { lireCle } from './securite/chiffrement.js';

const SECRETS = ['N8N_WEBHOOK_SECRET', 'INTERNAL_API_SECRET', 'FILE_ENCRYPTION_KEY'];

export function lireConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const appUrl = String(env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const config = {
    production,
    port: Number(env.PORT) || 3000,
    appUrl,
    https: appUrl.startsWith('https:'),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    configDir: path.resolve(env.CONFIG_DIR || './config'),
    adminEmail: String(env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminNom: String(env.ADMIN_NOM || '').trim().slice(0, 80),
    agence: env.AGENCE_NOM || 'Essentiel & Domicile Pessac',
    // Derrière Traefik, la dernière adresse de X-Forwarded-For est celle qu'il ajoute.
    trustProxy: env.TRUST_PROXY === '1',
    dureeSessionMs: (Number(env.SESSION_HOURS) || 8) * 3600e3,
    dureeLienConnexionMs: (Number(env.LOGIN_LINK_MINUTES) || 15) * 60e3,
    // Lien du salarié : 15 jours au plus. C'est aussi le délai de purge absolue (décision du 17/10/2026).
    dureeLienSalarieJours: Math.min(15, Math.max(2, Math.round(Number(env.EMPLOYEE_LINK_DAYS) || 15))),
    n8n: {
      webhookUrl: String(env.N8N_WEBHOOK_URL || ''),
      secret: String(env.N8N_WEBHOOK_SECRET || ''),
    },
    // Port interne réservé à n8n (jamais exposé par Traefik) : n8n y télécharge les PDF et confirme les envois.
    // INTERNAL_HOST : 127.0.0.1 en local ; 0.0.0.0 dans Docker (joignable par le seul réseau privé de l'application).
    internalPort: Number(env.INTERNAL_PORT) || 3001,
    internalHost: String(env.INTERNAL_HOST || '127.0.0.1'),
    internalUrl: String(env.INTERNAL_URL || `http://127.0.0.1:${Number(env.INTERNAL_PORT) || 3001}`).replace(/\/+$/, ''),
    internalSecret: String(env.INTERNAL_API_SECRET || ''),
    // Clé AES-256 des pièces stockées : 64 caractères hexadécimaux. La perdre rend illisibles les pièces en cours.
    cleFichiers: lireCle(env.FILE_ENCRYPTION_KEY),
    // Développement uniquement : les liens sont affichés dans la console au lieu d'être envoyés.
    devAfficherLiens: env.DEV_LOG_LINKS === '1',
  };

  const problemes = [];
  if (production && config.devAfficherLiens) problemes.push('DEV_LOG_LINKS est interdit en production.');
  if (production && !config.https) problemes.push('APP_URL doit commencer par https:// en production.');
  if (!config.devAfficherLiens) {
    if (!config.n8n.webhookUrl) problemes.push('N8N_WEBHOOK_URL manquant : aucun e-mail ne pourrait partir.');
    if (config.n8n.secret.length < 32) problemes.push('N8N_WEBHOOK_SECRET manquant ou trop court (32 caractères minimum).');
    if (config.internalSecret.length < 32) problemes.push('INTERNAL_API_SECRET manquant ou trop court (32 caractères minimum) : n8n ne pourrait pas récupérer les pièces.');
  }
  if (!config.cleFichiers) problemes.push('FILE_ENCRYPTION_KEY manquant ou invalide (64 caractères hexadécimaux).');
  if (config.internalSecret && config.internalSecret === config.n8n.secret) problemes.push('INTERNAL_API_SECRET doit être différent de N8N_WEBHOOK_SECRET.');
  if (!config.adminEmail) problemes.push('ADMIN_EMAIL manquant : personne ne pourrait administrer l\'application.');

  return { config, problemes };
}

export function resumeConfig(env = process.env) {
  const noms = ['NODE_ENV', 'APP_URL', 'DATA_DIR', 'ADMIN_EMAIL', 'TRUST_PROXY', 'N8N_WEBHOOK_URL', 'INTERNAL_URL', ...SECRETS];
  return noms.map((nom) => {
    const valeur = String(env[nom] || '').trim();
    return `  ${nom} : ${valeur ? `reçu (${valeur.length} caractères)` : 'absent'}`;
  }).join('\n');
}
