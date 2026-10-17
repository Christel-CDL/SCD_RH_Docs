// Serveur HTTP de l'application (module node:http, sans framework).
// creerApp() ne démarre rien : les tests l'utilisent avec une base temporaire et un notificateur factice.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creerAuth, EMAIL } from './auth.js';
import { creerLimiteur } from './securite/limiteur.js';
import {
  enTetesSecurite, cookieSession, nomCookieSession, lireCookies, lireFormulaire, origineAutorisee, adresseClient,
} from './http.js';
import * as pages from './pages.js';

const DOSSIER_PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FICHIERS_PUBLICS = { '/styles.css': 'text/css; charset=utf-8' };
const QUINZE_MINUTES = 15 * 60e3;

export function creerApp({ db, config, notificateur }) {
  const auth = creerAuth({ db, config });
  const limiteur = creerLimiteur();
  const entetes = enTetesSecurite(config);
  const agence = config.agence;

  const minuterie = setInterval(() => { auth.purger(); limiteur.nettoyer(); }, 10 * 60e3);
  minuterie.unref();

  function html(res, statut, contenu, extra = {}) {
    res.writeHead(statut, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(contenu);
  }
  function rediriger(res, chemin, extra = {}) {
    // Toujours vers une adresse construite depuis APP_URL, jamais depuis l'en-tête Host reçu.
    res.writeHead(303, { Location: config.appUrl + chemin, 'Cache-Control': 'no-store', ...extra });
    res.end();
  }
  function sessionDe(req) {
    return auth.lireSession(lireCookies(req)[nomCookieSession(config)]);
  }

  const routes = {
    'GET /sante': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); },

    'GET /': (req, res) => {
      const session = sessionDe(req);
      if (!session) return rediriger(res, '/connexion');
      html(res, 200, pages.pageAccueil({ agence, session }));
    },

    'GET /connexion': (req, res) => {
      if (sessionDe(req)) return rediriger(res, '/');
      html(res, 200, pages.pageConnexion({ agence }));
    },

    'POST /connexion': async (req, res) => {
      const formulaire = await lireFormulaire(req);
      const email = String(formulaire.get('email') || '').trim().toLowerCase();
      if (!EMAIL.test(email)) {
        return html(res, 400, pages.pageConnexion({ agence, email, erreur: 'Cette adresse e-mail n\'est pas valide.' }));
      }
      const ip = adresseClient(req, config);
      if (limiteur.depasse(`ip:${ip}`, 10, QUINZE_MINUTES) || limiteur.depasse(`email:${email}`, 5, QUINZE_MINUTES)) {
        return html(res, 429, pages.pageMessage({ agence, titre: 'Trop de demandes', message: 'Trop de demandes de lien. Réessayez dans un quart d\'heure.' }));
      }
      const prepare = auth.preparerLien(email);
      if (prepare) {
        // Envoi sans attendre : le temps de réponse ne révèle pas si l'adresse est autorisée.
        notificateur.envoyer('lien_connexion', {
          destinataire: prepare.utilisateur.email,
          nom: prepare.utilisateur.nom,
          lien: prepare.lien,
          validite_minutes: Math.round(config.dureeLienConnexionMs / 60e3),
        }).catch((erreur) => console.error('Envoi du lien de connexion impossible :', erreur.message));
      }
      html(res, 200, pages.pageLienEnvoye({ agence, minutes: Math.round(config.dureeLienConnexionMs / 60e3) }));
    },

    'GET /connexion/lien': (req, res, url) => {
      const jeton = url.searchParams.get('jeton') || '';
      if (!auth.lienValide(jeton)) return html(res, 410, pages.pageLienInvalide({ agence }));
      html(res, 200, pages.pageConfirmerConnexion({ agence, jeton }));
    },

    'POST /connexion/lien': async (req, res) => {
      if (limiteur.depasse(`lien:${adresseClient(req, config)}`, 30, QUINZE_MINUTES)) {
        return html(res, 429, pages.pageMessage({ agence, titre: 'Trop de tentatives', message: 'Trop de tentatives. Réessayez dans un quart d\'heure.' }));
      }
      const formulaire = await lireFormulaire(req);
      const session = auth.connecter(formulaire.get('jeton'));
      if (!session) return html(res, 410, pages.pageLienInvalide({ agence }));
      rediriger(res, '/', { 'Set-Cookie': cookieSession(config, session, config.dureeSessionMs) });
    },

    'POST /deconnexion': async (req, res) => {
      const jeton = lireCookies(req)[nomCookieSession(config)];
      const session = auth.lireSession(jeton);
      const formulaire = await lireFormulaire(req);
      if (session && !auth.csrfValide(session, formulaire.get('csrf'))) {
        return html(res, 403, pages.pageMessage({ agence, titre: 'Action refusée', message: 'La page a expiré. Rechargez-la et recommencez.' }));
      }
      auth.deconnecter(jeton);
      rediriger(res, '/connexion', { 'Set-Cookie': cookieSession(config, '', 0) });
    },
  };

  async function traiter(req, res) {
    for (const [nom, valeur] of Object.entries(entetes)) res.setHeader(nom, valeur);
    let url;
    try { url = new URL(req.url, 'http://interne'); } catch { return html(res, 400, 'Requête invalide'); }

    if (req.method === 'GET' && FICHIERS_PUBLICS[url.pathname]) {
      const contenu = fs.readFileSync(path.join(DOSSIER_PUBLIC, url.pathname));
      res.writeHead(200, { 'Content-Type': FICHIERS_PUBLICS[url.pathname], 'Cache-Control': 'public, max-age=3600' });
      return res.end(contenu);
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return html(res, 404, pages.pageMessage({ agence, titre: 'Page introuvable', message: 'Cette page n\'existe pas.' }));
    if (req.method === 'POST' && !origineAutorisee(req, config)) {
      return html(res, 403, pages.pageMessage({ agence, titre: 'Action refusée', message: 'Demande refusée : elle ne vient pas de l\'application.' }));
    }
    try {
      await route(req, res, url);
    } catch (erreur) {
      if (erreur.status === 413 || erreur.status === 415) return html(res, erreur.status, 'Requête refusée');
      console.error('Erreur interne :', erreur.message);
      if (!res.headersSent) html(res, 500, pages.pageMessage({ agence, titre: 'Erreur', message: 'Une erreur est survenue. Réessayez plus tard.' }));
    }
  }

  const serveur = http.createServer((req, res) => {
    const debut = Date.now();
    // Journal d'accès : méthode, chemin et statut seulement. Jamais la chaîne de requête (elle contient les jetons).
    res.on('finish', () => {
      const chemin = req.url.split('?')[0];
      if (chemin !== '/sante') console.log(`${req.method} ${chemin} ${res.statusCode} ${Date.now() - debut} ms`);
    });
    traiter(req, res);
  });
  serveur.on('close', () => clearInterval(minuterie));
  return { serveur, auth };
}
