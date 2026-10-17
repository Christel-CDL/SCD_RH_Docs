// Serveur HTTP de l'application (module node:http, sans framework).
// creerApp() ne démarre rien : les tests l'utilisent avec une base temporaire et un notificateur factice.
//
// Chaque route déclare son accès : « public », « session » (assistante ou admin) ou « admin ».
// Le contrôle est fait ici, pour toutes les routes, avant d'appeler la fonction de la route :
//  - sans session valide → retour à la connexion ; rôle insuffisant → 403 ;
//  - tout POST doit venir de l'application (origine) et, s'il est connecté, porter le jeton CSRF de la session.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creerAuth, EMAIL } from './auth.js';
import { creerLimiteur } from './securite/limiteur.js';
import { creerReglages, analyserDomaines } from './reglages.js';
import { chargerCatalogue, chargerTextes, chargerControles, chargerReglagesEnvoi } from './catalogue.js';
import { creerCompteur } from './compteur.js';
import { creerEnvoi } from './envoi.js';
import { creerPurge } from './purge.js';
import { creerServeurInterne } from './interne.js';
import { creerEmails } from './emails.js';
import { creerDemandes, validerDemande, TYPES } from './demandes.js';
import { creerUtilisateurs } from './utilisateurs.js';
import { creerStockage } from './stockage.js';
import { creerDepot, LIMITES } from './depot.js';
import { journaliser } from './db.js';
import { empreinte } from './securite/jetons.js';
import {
  enTetesSecurite, CSP_DEPOT, cookieSession, nomCookieSession, lireCookies, lireFormulaire, lireMultipart, origineAutorisee, adresseClient,
} from './http.js';
import * as pages from './pages.js';

const DOSSIER_PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FICHIERS_PUBLICS = { '/styles.css': 'text/css; charset=utf-8', '/depot.js': 'text/javascript; charset=utf-8' };
// Bibliothèques servies par l'application elle-même (jamais par un site tiers) : liste fermée de types,
// chemin sans « .. » ni caractère inattendu. Versions et empreintes dans public/vendor/EMPREINTES.json.
const VENDOR = /^\/vendor\/(?:pdfjs|libheif)(?:\/[A-Za-z0-9_-]+)*\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(mjs|wasm|pfb|ttf)$/;
const TYPES_VENDOR = { mjs: 'text/javascript; charset=utf-8', wasm: 'application/wasm', pfb: 'application/octet-stream', ttf: 'font/ttf' };
const etags = new Map(); // chemin → { mtime, etag } : ne recalcule pas l'empreinte d'un gros fichier à chaque visite
const QUINZE_MINUTES = 15 * 60e3;

// Messages affichés après une redirection : seul un code connu passe dans l'adresse, jamais un texte saisi.
const INFOS = {
  invitation: 'La demande est enregistrée et l\'invitation est partie chez le salarié.',
  ajoute: 'L\'adresse a été ajoutée. La personne peut maintenant demander son lien de connexion.',
  desactive: 'L\'adresse est désactivée et sa session est fermée.',
  reactive: 'L\'adresse est réactivée.',
  supprime: 'L\'adresse a été supprimée.',
  domaines: 'Les domaines autorisés sont enregistrés.',
  relance: 'L\'envoi est relancé. Vérifiez dans quelques minutes qu\'il a disparu de la liste des envois en échec.',
  relance_impossible: 'Cet envoi ne peut plus être relancé (déjà parti, ou purgé).',
};

// Le jeton du salarié est dans le chemin (/d/<jeton>) : il est masqué dans le journal d'accès.
const cheminJournal = (url) => url.split('?')[0].replace(/^\/d\/[^/]+/, '/d/***');

export function creerApp({ db, config, notificateur: notificateurBrut, catalogue, textes, controles, reglagesEnvoi, stockage }) {
  catalogue ??= chargerCatalogue(config.configDir);
  textes ??= chargerTextes(config.configDir);
  controles ??= chargerControles(config.configDir);
  reglagesEnvoi ??= chargerReglagesEnvoi(config.configDir);
  const reglages = creerReglages(db);
  const auth = creerAuth({ db, config, reglages });
  const limiteur = creerLimiteur();
  const emails = creerEmails({ textes, catalogue, config });
  // Tout passe par le compteur : chaque e-mail parti est compté (quota du compte Brevo partagé).
  const notificateur = creerCompteur({ db, notificateur: notificateurBrut, reglagesEnvoi, alerte: emails.alerte });
  const demandes = creerDemandes({ db, config });
  const utilisateurs = creerUtilisateurs({ db, reglages });
  stockage ??= creerStockage({ dataDir: config.dataDir, cle: config.cleFichiers });
  const depot = creerDepot({ db, catalogue, stockage, controles });
  const envoi = creerEnvoi({ db, config, emails, depot, notificateur, reglagesEnvoi });
  const purge = creerPurge({ db, stockage });
  purge.purger();
  const entetes = enTetesSecurite(config);
  const agence = config.agence;

  // Chaque minute : nouvelles tentatives d'envoi arrivées à échéance. Toutes les 10 minutes : sessions et limiteur.
  // Toutes les heures : purge de sécurité (demandes expirées, fichiers orphelins).
  let tours = 0;
  const minuterie = setInterval(() => {
    tours += 1;
    envoi.tic().catch((e) => console.error('Envois en attente :', e.message));
    if (tours % 10 === 0) { auth.purger(); limiteur.nettoyer(); }
    if (tours % 60 === 0) {
      try { purge.purger(); } catch (e) { console.error('Purge de sécurité :', e.message); }
    }
  }, 60e3);
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
  const refuser = (res, session, texte = 'Vous n\'avez pas accès à cette page.') => html(res, 403, pages.pageMessage({ agence, session, titre: 'Accès refusé', message: texte }));
  function envoyerJson(res, statut, corps) {
    res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(corps));
  }
  // Demande liée au lien du salarié, ou réponse « lien inactif » déjà envoyée (null).
  function demandeDuLien(req, res, jeton, json = false) {
    if (limiteur.depasse(`depot:${adresseClient(req, config)}`, 120, QUINZE_MINUTES)) {
      const trop = 'Trop de tentatives. Réessayez dans un quart d\'heure.';
      if (json) envoyerJson(res, 429, { erreur: trop });
      else html(res, 429, pages.pageMessage({ agence, titre: 'Trop de tentatives', message: trop }));
      return null;
    }
    const demande = demandes.parJeton(jeton);
    if (demande) return demande;
    const texte = 'Ce lien n\'est plus valable. Contactez l\'agence qui vous l\'a envoyé.';
    if (json) envoyerJson(res, 410, { erreur: texte });
    else html(res, 410, pages.pageMessage({ agence, titre: 'Lien inactif', message: texte }));
    return null;
  }
  function repondreDepot(res, json, demande, jeton, { statut, erreur, abrev }) {
    if (json) return envoyerJson(res, statut, { erreur });
    html(res, statut, pages.pageDepot({ agence, demande, jeton, etat: depot.etat(demande), textes, controles, erreur: { abrev, texte: erreur } }), { 'Content-Security-Policy': CSP_DEPOT });
  }
  const pageAdmin = (session, extra = {}) => pages.pageAdminUtilisateurs({
    agence, session, utilisateurs: utilisateurs.lister(), domaines: reglages.domaines(), envoisEnEchec: envoi.enEchec(), emailsDuJour: notificateur.aujourdhui(), quota: reglagesEnvoi.quotaJournalier, ...extra,
  });

  const routes = [
    { m: 'GET', c: '/sante', acces: 'public', f: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); } },
    { m: 'GET', c: '/favicon.ico', acces: 'public', f: (req, res) => { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); res.end(); } },

    // ── Connexion ──
    {
      m: 'GET', c: '/connexion', acces: 'public',
      f: (req, res, { session }) => (session ? rediriger(res, '/') : html(res, 200, pages.pageConnexion({ agence }))),
    },
    {
      m: 'POST', c: '/connexion', acces: 'public',
      f: (req, res, { formulaire }) => {
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
          notificateur.envoyer('email', emails.lienConnexion(prepare))
            .catch((erreur) => console.error('Envoi du lien de connexion impossible :', erreur.message));
        }
        html(res, 200, pages.pageLienEnvoye({ agence, minutes: Math.round(config.dureeLienConnexionMs / 60e3) }));
      },
    },
    {
      m: 'GET', c: '/connexion/lien', acces: 'public',
      f: (req, res, { url }) => {
        const jeton = url.searchParams.get('jeton') || '';
        if (!auth.lienValide(jeton)) return html(res, 410, pages.pageLienInvalide({ agence }));
        html(res, 200, pages.pageConfirmerConnexion({ agence, jeton }));
      },
    },
    {
      m: 'POST', c: '/connexion/lien', acces: 'public',
      f: (req, res, { formulaire }) => {
        if (limiteur.depasse(`lien:${adresseClient(req, config)}`, 30, QUINZE_MINUTES)) {
          return html(res, 429, pages.pageMessage({ agence, titre: 'Trop de tentatives', message: 'Trop de tentatives. Réessayez dans un quart d\'heure.' }));
        }
        const session = auth.connecter(formulaire.get('jeton'));
        if (!session) return html(res, 410, pages.pageLienInvalide({ agence }));
        rediriger(res, '/', { 'Set-Cookie': cookieSession(config, session, config.dureeSessionMs) });
      },
    },
    {
      m: 'POST', c: '/deconnexion', acces: 'session',
      f: (req, res, { jetonSession }) => {
        auth.deconnecter(jetonSession);
        rediriger(res, '/connexion', { 'Set-Cookie': cookieSession(config, '', 0) });
      },
    },

    // ── Demandes ──
    {
      m: 'GET', c: '/', acces: 'session',
      f: (req, res, { url, session }) => {
        const filtre = TYPES[url.searchParams.get('type')] ? url.searchParams.get('type') : null;
        html(res, 200, pages.pageAccueil({
          agence, session, filtre, demandes: demandes.lister(session.id, filtre), info: INFOS[url.searchParams.get('ok')] || '',
        }));
      },
    },
    {
      m: 'GET', c: '/demandes/nouvelle', acces: 'session',
      f: (req, res, { url, session }) => {
        const type = url.searchParams.get('type');
        if (!TYPES[type]) return rediriger(res, '/');
        html(res, 200, pages.pageNouvelleDemande({ agence, session, catalogue, type }));
      },
    },
    {
      m: 'POST', c: '/demandes', acces: 'session',
      f: async (req, res, { session, formulaire }) => {
        const saisie = {
          type: formulaire.get('type'), civilite: formulaire.get('civilite'), nom: formulaire.get('nom'),
          email: formulaire.get('email'), pieces: formulaire.getAll('pieces'),
        };
        if (!TYPES[saisie.type]) return rediriger(res, '/');
        const { valeurs, erreurs } = validerDemande(saisie, catalogue);
        if (erreurs) return html(res, 400, pages.pageNouvelleDemande({ agence, session, catalogue, type: saisie.type, saisie, erreurs }));

        const { demande, jeton } = demandes.creer(session, valeurs);
        try {
          // Ici on attend la réponse de n8n : si l'invitation ne part pas, la demande est supprimée aussitôt.
          await notificateur.envoyer('email', emails.invitation({
            demande, abrevs: valeurs.abrevs, assistante: session, lien: demandes.lienSalarie(jeton),
          }));
        } catch (erreur) {
          console.error('Envoi de l\'invitation impossible :', erreur.message);
          demandes.abandonner(demande.id);
          journaliser(db, 'invitation_echec', { utilisateurId: session.id, demandeId: demande.id });
          return html(res, 502, pages.pageNouvelleDemande({
            agence, session, catalogue, type: saisie.type, saisie,
            erreurs: { envoi: 'L\'invitation n\'a pas pu partir. Rien n\'a été enregistré : réessayez dans quelques minutes.' },
          }));
        }
        journaliser(db, 'invitation_envoyee', { utilisateurId: session.id, demandeId: demande.id });
        rediriger(res, '/?ok=invitation');
      },
    },

    // ── Dépôt des pièces par le salarié (lien personnel /d/<jeton>, sans compte) ──
    // Le jeton secret dans l'adresse tient lieu de jeton CSRF : un site tiers ne le connaît pas.
    {
      m: 'GET', c: /^\/d\/([A-Za-z0-9_-]{1,100})$/, acces: 'public',
      f: (req, res, { params: [jeton] }) => {
        const demande = demandeDuLien(req, res, jeton);
        if (!demande) return;
        if (demande.statut === 'complete') return html(res, 200, pages.pageDepotTermine({ agence, demande }));
        html(res, 200, pages.pageDepot({ agence, demande, jeton, etat: depot.etat(demande), textes, controles }), { 'Content-Security-Policy': CSP_DEPOT });
      },
    },
    {
      m: 'POST', c: /^\/d\/([A-Za-z0-9_-]{1,100})\/pieces\/([A-Z][A-Z0-9_]{0,11})$/, acces: 'public', corps: 'multipart',
      f: async (req, res, { params: [jeton, abrev] }) => {
        const json = String(req.headers.accept || '').includes('application/json');
        const demande = demandeDuLien(req, res, jeton, json);
        if (!demande) return;
        if (limiteur.depasse(`piece:${demande.id}`, 40, QUINZE_MINUTES)) {
          return repondreDepot(res, json, demande, jeton, { statut: 429, erreur: 'Trop d\'envois en peu de temps. Réessayez dans un quart d\'heure.', abrev });
        }
        const formulaire = await lireMultipart(req, LIMITES.octetsParFichier * LIMITES.pagesMax + 1024 * 1024);
        const fichiers = [];
        for (const f of formulaire.getAll('fichier')) {
          if (typeof f === 'object' && f.size > 0) fichiers.push(Buffer.from(await f.arrayBuffer()));
        }
        const resultat = depot.deposer(demande, abrev, {
          choix: formulaire.get('choix'), fichiers, aVerifier: formulaire.get('a_verifier') === '1', depuisPdf: formulaire.get('source') === 'pdf',
        });
        if (resultat.erreur) return repondreDepot(res, json, demande, jeton, { ...resultat, abrev });
        if (json) return envoyerJson(res, 200, { ok: true });
        rediriger(res, `/d/${jeton}#piece-${abrev}`);
      },
    },
    {
      m: 'POST', c: /^\/d\/([A-Za-z0-9_-]{1,100})\/envoyer$/, acces: 'public',
      f: (req, res, { params: [jeton] }) => {
        const demande = demandeDuLien(req, res, jeton);
        if (!demande) return;
        const resultat = depot.envoyer(demande);
        if (resultat.erreur) return repondreDepot(res, false, demande, jeton, { ...resultat, abrev: null });
        // L'envoi à l'assistante part en arrière-plan : le salarié n'attend pas n8n (nouvelles tentatives si besoin).
        envoi.lancer(demande.id).catch((e) => console.error('Lancement de l\'envoi :', e.message));
        rediriger(res, `/d/${jeton}`);
      },
    },

    // ── Administration ──
    { m: 'GET', c: '/admin', acces: 'admin', f: (req, res) => rediriger(res, '/admin/utilisateurs') },
    {
      // Relance d'un envoi abandonné après toutes les tentatives (n8n ou Brevo réparé entre-temps).
      m: 'POST', c: /^\/admin\/envois\/([A-Za-z0-9_-]{32})\/relancer$/, acces: 'admin',
      f: async (req, res, { params: [id], session }) => {
        const ok = await envoi.relancer(id);
        journaliser(db, 'envoi_relance_par_admin', { utilisateurId: session.id });
        rediriger(res, `/admin/utilisateurs?ok=${ok ? 'relance' : 'relance_impossible'}`);
      },
    },
    {
      m: 'GET', c: '/admin/utilisateurs', acces: 'admin',
      f: (req, res, { url, session }) => html(res, 200, pageAdmin(session, { info: INFOS[url.searchParams.get('ok')] || '' })),
    },
    {
      m: 'POST', c: '/admin/utilisateurs', acces: 'admin',
      f: (req, res, { session, formulaire }) => {
        const saisie = { email: formulaire.get('email'), nom: formulaire.get('nom') };
        const erreur = utilisateurs.ajouter(session, saisie);
        if (erreur) return html(res, 400, pageAdmin(session, { erreur, saisie }));
        rediriger(res, '/admin/utilisateurs?ok=ajoute');
      },
    },
    {
      m: 'POST', c: /^\/admin\/utilisateurs\/(\d{1,9})\/(desactiver|reactiver|supprimer)$/, acces: 'admin',
      f: (req, res, { session, params: [id, action], formulaire }) => {
        if (action === 'supprimer' && formulaire.get('confirme') !== 'oui') {
          const cible = utilisateurs.lister().find((u) => u.id === Number(id) && u.role !== 'admin');
          if (!cible) return html(res, 404, pageAdmin(session, { erreur: 'Adresse introuvable.' }));
          return html(res, 200, pages.pageConfirmerSuppression({ agence, session, utilisateur: cible }));
        }
        const erreur = action === 'supprimer' ? utilisateurs.supprimer(session, id) : utilisateurs.changerActif(session, id, action === 'reactiver');
        if (erreur) return html(res, 400, pageAdmin(session, { erreur }));
        rediriger(res, `/admin/utilisateurs?ok=${{ desactiver: 'desactive', reactiver: 'reactive', supprimer: 'supprime' }[action]}`);
      },
    },
    {
      m: 'POST', c: '/admin/domaines', acces: 'admin',
      f: (req, res, { session, formulaire }) => {
        const liste = analyserDomaines(formulaire.get('domaines'));
        if (!liste) return html(res, 400, pageAdmin(session, { erreur: 'Un des domaines saisis n\'est pas valide (exemple attendu : exemple.fr).' }));
        utilisateurs.modifierDomaines(session, liste);
        rediriger(res, '/admin/utilisateurs?ok=domaines');
      },
    },
    {
      m: 'GET', c: '/admin/journal', acces: 'admin',
      f: (req, res, { session }) => html(res, 200, pages.pageAdminJournal({ agence, session, entrees: utilisateurs.journal() })),
    },
  ];

  function trouverRoute(methode, chemin) {
    for (const route of routes) {
      if (route.m !== methode) continue;
      if (typeof route.c === 'string') { if (route.c === chemin) return { route, params: [] }; continue; }
      const m = route.c.exec(chemin);
      if (m) return { route, params: m.slice(1) };
    }
    return null;
  }

  async function traiter(req, res) {
    for (const [nom, valeur] of Object.entries(entetes)) res.setHeader(nom, valeur);
    let url;
    try { url = new URL(req.url, 'http://interne'); } catch { return html(res, 400, 'Requête invalide'); }

    const vendor = req.method === 'GET' && url.pathname.match(VENDOR);
    if (req.method === 'GET' && (FICHIERS_PUBLICS[url.pathname] || vendor)) {
      // Revalidation à chaque affichage (304 si rien n'a changé) : après une mise à jour,
      // aucun téléphone ne garde l'ancien script face au nouveau serveur.
      const chemin = path.join(DOSSIER_PUBLIC, url.pathname);
      let infos;
      try { infos = fs.statSync(chemin); } catch { return html(res, 404, pages.pageMessage({ agence, titre: 'Page introuvable', message: 'Cette page n\'existe pas.' })); }
      let connu = etags.get(chemin);
      if (!connu || connu.mtime !== infos.mtimeMs) {
        connu = { mtime: infos.mtimeMs, etag: `"${empreinte(fs.readFileSync(chemin).toString('latin1')).slice(0, 16)}"` };
        etags.set(chemin, connu);
      }
      const cache = { 'Cache-Control': 'no-cache', ETag: connu.etag };
      if (req.headers['if-none-match'] === connu.etag) { res.writeHead(304, cache); return res.end(); }
      res.writeHead(200, { 'Content-Type': vendor ? TYPES_VENDOR[vendor[1]] : FICHIERS_PUBLICS[url.pathname], ...cache });
      return res.end(fs.readFileSync(chemin));
    }
    const trouve = trouverRoute(req.method, url.pathname);
    if (!trouve) return html(res, 404, pages.pageMessage({ agence, titre: 'Page introuvable', message: 'Cette page n\'existe pas.' }));
    const { route, params } = trouve;

    try {
      if (req.method === 'POST' && !origineAutorisee(req, config)) {
        return html(res, 403, pages.pageMessage({ agence, titre: 'Action refusée', message: 'Demande refusée : elle ne vient pas de l\'application.' }));
      }
      const jetonSession = lireCookies(req)[nomCookieSession(config)];
      const session = auth.lireSession(jetonSession);
      if (route.acces !== 'public') {
        if (!session) return rediriger(res, '/connexion');
        if (route.acces === 'admin' && session.role !== 'admin') return refuser(res, session);
      }
      const formulaire = req.method === 'POST' && route.corps !== 'multipart' ? await lireFormulaire(req) : null;
      if (formulaire && route.acces !== 'public' && !auth.csrfValide(session, formulaire.get('csrf'))) {
        return refuser(res, session, 'La page a expiré. Rechargez-la et recommencez.');
      }
      await route.f(req, res, { url, params, session, jetonSession, formulaire });
    } catch (erreur) {
      if ([400, 413, 415].includes(erreur.status)) {
        const texte = erreur.status === 413 ? 'Envoi trop volumineux : 10 Mo au plus par fichier.' : 'Requête refusée.';
        if (String(req.headers.accept || '').includes('application/json')) return envoyerJson(res, erreur.status, { erreur: texte });
        return html(res, erreur.status, pages.pageMessage({ agence, titre: 'Envoi refusé', message: texte }));
      }
      console.error('Erreur interne :', erreur.message);
      if (!res.headersSent) html(res, 500, pages.pageMessage({ agence, titre: 'Erreur', message: 'Une erreur est survenue. Réessayez plus tard.' }));
    }
  }

  const serveur = http.createServer((req, res) => {
    const debut = Date.now();
    // Journal d'accès : méthode, chemin (jeton masqué) et statut. Jamais la chaîne de requête.
    res.on('finish', () => {
      const chemin = cheminJournal(req.url);
      if (chemin !== '/sante') console.log(`${req.method} ${chemin} ${res.statusCode} ${Date.now() - debut} ms`);
    });
    traiter(req, res);
  });
  serveur.on('close', () => clearInterval(minuterie));
  const serveurInterne = creerServeurInterne({ config, envoi });
  return { serveur, serveurInterne, auth, demandes, depot, stockage, envoi, purge, notificateur };
}
