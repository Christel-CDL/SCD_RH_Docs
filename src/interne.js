// Port interne, réservé à n8n : il n'est relié à aucun nom de domaine (Traefik ne l'expose pas) et n'est joignable
// que depuis le réseau Docker privé de l'application et de son n8n. Chaque appel doit en plus présenter le secret
// INTERNAL_API_SECRET (en-tête « Authorization: Bearer … »), comparé à temps constant.
//
//   GET  /interne/sante                               → « ok » (vérification depuis n8n)
//   GET  /interne/envois/<envoi>/pieces/<ABREV>       → le PDF de la pièce, fabriqué en mémoire
//   POST /interne/envois/<envoi>/confirmation         → { "message": 1 } : l'e-mail n° 1 est parti
//   POST /interne/envois/<envoi>/echec                → { "message": 1 } : l'e-mail n° 1 n'a pas pu partir
//
// Le journal d'accès ne montre jamais l'identifiant de l'envoi ni le nom des fichiers.
import http from 'node:http';
import { egaux } from './securite/jetons.js';
import { lireCorps } from './http.js';

const ROUTE = /^\/interne\/envois\/([A-Za-z0-9_-]{32})\/(pieces\/([A-Z][A-Z0-9_]{0,11})|confirmation|echec)$/;

export function creerServeurInterne({ config, envoi }) {
  const attendu = `Bearer ${config.internalSecret}`;

  function repondre(res, statut, corps) {
    res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(corps));
  }

  async function traiter(req, res) {
    if (!config.internalSecret || !egaux(String(req.headers.authorization || ''), attendu)) return repondre(res, 401, { erreur: 'non autorisé' });
    const chemin = new URL(req.url, 'http://interne').pathname;
    if (req.method === 'GET' && chemin === '/interne/sante') return repondre(res, 200, { ok: true });
    const m = chemin.match(ROUTE);
    if (!m) return repondre(res, 404, { erreur: 'introuvable' });
    const [, envoiId, action, abrev] = m;

    if (abrev && req.method === 'GET') {
      const pdf = envoi.pdfPourN8n(envoiId, abrev);
      if (!pdf) return repondre(res, 404, { erreur: 'introuvable' });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdf.nom}"`,
        'Content-Length': pdf.contenu.length,
        'Cache-Control': 'no-store',
      });
      return res.end(pdf.contenu);
    }
    if (!abrev && req.method === 'POST') {
      let numero;
      try {
        numero = JSON.parse((await lireCorps(req, 1024)).toString('utf8') || '{}').message;
      } catch {
        return repondre(res, 400, { erreur: 'corps invalide' });
      }
      const resultat = action === 'confirmation' ? envoi.confirmer(envoiId, numero) : await envoi.signalerEchec(envoiId, numero);
      return resultat ? repondre(res, 200, resultat) : repondre(res, 404, { erreur: 'introuvable' });
    }
    return repondre(res, 405, { erreur: 'méthode refusée' });
  }

  const serveur = http.createServer((req, res) => {
    const debut = Date.now();
    res.on('finish', () => {
      const chemin = new URL(req.url, 'http://interne').pathname.replace(/\/envois\/[^/]+/, '/envois/***').replace(/\/pieces\/[^/]+/, '/pieces/***');
      if (chemin !== '/interne/sante') console.log(`[interne] ${req.method} ${chemin} ${res.statusCode} ${Date.now() - debut} ms`);
    });
    traiter(req, res).catch((erreur) => {
      console.error('Erreur interne (port n8n) :', erreur.message);
      if (!res.headersSent) repondre(res, 500, { erreur: 'erreur interne' });
    });
  });
  return serveur;
}
