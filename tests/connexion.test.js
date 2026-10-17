// Tests d'intégration du parcours de connexion (voir tests/aide.js : base temporaire, comptes fictifs, aucun e-mail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lireConfig } from '../src/config.js';
import { ouvrirBase } from '../src/db.js';
import { cookieSession } from '../src/http.js';
import { demarrer, attendre, lienDans, jetonDuLien, cookieDe, seConnecter } from './aide.js';

test('sans session, la page d\'accueil renvoie vers la connexion', async () => {
  const app = await demarrer();
  try {
    const r = await app.envoyer('/');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${app.base}/connexion`);
  } finally { await app.fermer(); }
});

test('la réponse est identique pour une adresse autorisée, inconnue ou désactivée', async () => {
  const app = await demarrer();
  try {
    const textes = [];
    for (const email of ['assistante@exemple.test', 'inconnue@exemple.test', 'ancienne@exemple.test']) {
      const r = await app.envoyer('/connexion', { methode: 'POST', formulaire: { email } });
      assert.equal(r.status, 200);
      textes.push(await r.text());
    }
    assert.equal(textes[0], textes[1]);
    assert.equal(textes[0], textes[2]);
    await attendre();
    assert.equal(app.boite.length, 1, 'seule l\'adresse autorisée et active reçoit un lien');
    assert.equal(app.boite[0].donnees.categorie, 'lien_connexion');
    assert.equal(app.boite[0].donnees.destinataire, 'assistante@exemple.test');
  } finally { await app.fermer(); }
});

test('le lien n\'est stocké que sous forme d\'empreinte', async () => {
  const app = await demarrer();
  try {
    await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: 'assistante@exemple.test' } });
    await attendre();
    const jeton = jetonDuLien(lienDans(app.boite[0].donnees.texte));
    const lignes = app.db.prepare('SELECT empreinte FROM jetons_connexion').all();
    assert.equal(lignes.length, 1);
    assert.notEqual(lignes[0].empreinte, jeton);
    assert.ok(!JSON.stringify(lignes).includes(jeton));
  } finally { await app.fermer(); }
});

test('ouvrir le lien ne le consomme pas ; le bouton ouvre une session de 8 h', async () => {
  const app = await demarrer();
  try {
    await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: 'assistante@exemple.test' } });
    await attendre();
    const lien = new URL(lienDans(app.boite[0].donnees.texte));
    // Un antivirus de messagerie qui « visite » le lien deux fois ne doit rien casser.
    for (let i = 0; i < 2; i++) assert.equal((await app.envoyer(lien.pathname + lien.search)).status, 200);

    const r = await app.envoyer('/connexion/lien', { methode: 'POST', formulaire: { jeton: lien.searchParams.get('jeton') } });
    assert.equal(r.status, 303);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=28800/);

    const accueil = await app.envoyer('/', { cookie: cookieDe(r) });
    assert.equal(accueil.status, 200);
    assert.match(await accueil.text(), /Mes demandes/);
  } finally { await app.fermer(); }
});

test('le lien est à usage unique', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await seConnecter(app);
    const r = await app.envoyer('/connexion/lien', { methode: 'POST', formulaire: { jeton } });
    assert.equal(r.status, 410);
    assert.equal((await app.envoyer(`/connexion/lien?jeton=${jeton}`)).status, 410);
  } finally { await app.fermer(); }
});

test('un lien expiré est refusé', async () => {
  const app = await demarrer();
  try {
    await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: 'assistante@exemple.test' } });
    await attendre();
    app.db.prepare('UPDATE jetons_connexion SET expire_le = ?').run(Date.now() - 1);
    const jeton = jetonDuLien(lienDans(app.boite[0].donnees.texte));
    assert.equal((await app.envoyer('/connexion/lien', { methode: 'POST', formulaire: { jeton } })).status, 410);
  } finally { await app.fermer(); }
});

test('une session expirée ou d\'un compte désactivé ne donne plus accès', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    app.db.prepare("UPDATE utilisateurs SET actif = 0 WHERE email = 'assistante@exemple.test'").run();
    assert.equal((await app.envoyer('/', { cookie })).status, 303);

    app.db.prepare("UPDATE utilisateurs SET actif = 1 WHERE email = 'assistante@exemple.test'").run();
    assert.equal((await app.envoyer('/', { cookie })).status, 200);
    app.db.prepare('UPDATE sessions SET expire_le = ?').run(Date.now() - 1);
    assert.equal((await app.envoyer('/', { cookie })).status, 303);
  } finally { await app.fermer(); }
});

test('la déconnexion exige le jeton CSRF et supprime la session', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    assert.equal((await app.envoyer('/deconnexion', { methode: 'POST', formulaire: { csrf: 'faux' }, cookie })).status, 403);
    assert.equal((await app.envoyer('/', { cookie })).status, 200, 'toujours connectée après un CSRF refusé');

    const csrf = (await (await app.envoyer('/', { cookie })).text()).match(/name="csrf" value="([^"]+)"/)[1];
    const r = await app.envoyer('/deconnexion', { methode: 'POST', formulaire: { csrf }, cookie });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await app.envoyer('/', { cookie })).status, 303);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  } finally { await app.fermer(); }
});

test('une requête venant d\'un autre site est refusée', async () => {
  const app = await demarrer();
  try {
    const r = await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: 'assistante@exemple.test' }, origine: 'https://pirate.example' });
    assert.equal(r.status, 403);
    await attendre();
    assert.equal(app.boite.length, 0);
  } finally { await app.fermer(); }
});

test('le contrôle d\'origine accepte « Origin: null » seulement si le navigateur indique la même origine', async () => {
  const { origineAutorisee } = await import('../src/http.js');
  const config = { appUrl: 'https://pieces.expertform.fr' };
  const req = (headers) => ({ headers });
  assert.equal(origineAutorisee(req({ origin: 'https://pieces.expertform.fr' }), config), true);
  assert.equal(origineAutorisee(req({ origin: 'https://pirate.example' }), config), false);
  assert.equal(origineAutorisee(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }), config), true);
  assert.equal(origineAutorisee(req({ origin: 'null', 'sec-fetch-site': 'cross-site' }), config), false);
  assert.equal(origineAutorisee(req({ origin: 'null' }), config), false);
  assert.equal(origineAutorisee(req({ 'sec-fetch-site': 'cross-site' }), config), false);
});

test('les demandes de lien répétées sont limitées', async () => {
  const app = await demarrer();
  try {
    const statuts = [];
    for (let i = 0; i < 6; i++) statuts.push((await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: 'assistante@exemple.test' } })).status);
    assert.deepEqual(statuts, [200, 200, 200, 200, 200, 429]);
  } finally { await app.fermer(); }
});

test('les en-têtes de sécurité sont présents', async () => {
  const app = await demarrer();
  try {
    const r = await app.envoyer('/connexion');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally { await app.fermer(); }
});

test('en HTTPS, le cookie est Secure, préfixé __Host- et HSTS est envoyé', async () => {
  const { config } = lireConfig({ APP_URL: 'https://pieces.expertform.fr', ADMIN_EMAIL: 'a@b.fr', DEV_LOG_LINKS: '1', FILE_ENCRYPTION_KEY: 'ab'.repeat(32) });
  const cookie = cookieSession(config, 'valeur', config.dureeSessionMs);
  assert.match(cookie, /^__Host-scd_session=valeur;/);
  assert.match(cookie, /; Secure/);
  const { enTetesSecurite } = await import('../src/http.js');
  assert.match(enTetesSecurite(config)['Strict-Transport-Security'], /max-age=31536000/);
});

test('les migrations s\'appliquent une seule fois et activent les clés étrangères', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-test-'));
  try {
    const db1 = ouvrirBase(dataDir);
    const version = db1.prepare('PRAGMA user_version').get().user_version;
    db1.close();
    const db2 = ouvrirBase(dataDir);
    assert.equal(db2.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(db2.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db2.prepare('PRAGMA secure_delete').get().secure_delete, 1);
    assert.throws(() => db2.prepare("INSERT INTO pieces (id, demande_id, abrev) VALUES ('p', 'inexistante', 'CNI')").run());
    db2.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
