// Outils communs aux tests d'intégration : vrai serveur HTTP, base SQLite temporaire, comptes fictifs.
// Le notificateur est remplacé par une boîte aux lettres en mémoire : aucun e-mail ne part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lireConfig } from '../src/config.js';
import { ouvrirBase, assurerAdmin } from '../src/db.js';
import { creerApp } from '../src/app.js';

export const ASSISTANTE = 'assistante@exemple.test';
export const ADMIN = 'admin@exemple.test';
export const CLE_TEST = 'ab'.repeat(32); // clé fictive, réservée aux tests

export async function demarrer({ envoiEnEchec = false, env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-test-'));
  const { config } = lireConfig({
    DATA_DIR: dataDir, ADMIN_EMAIL: ADMIN, DEV_LOG_LINKS: '1', FILE_ENCRYPTION_KEY: CLE_TEST,
    ...env, // par exemple pour le PDF du guide (tests/e2e/guide-pdf.mjs)
  });
  const db = ouvrirBase(dataDir);
  assurerAdmin(db, config.adminEmail);
  db.prepare("INSERT INTO utilisateurs (email, nom, role, actif, cree_le) VALUES (?, 'Assistante Fictive', 'assistante', 1, 0)").run(ASSISTANTE);
  db.prepare("INSERT INTO utilisateurs (email, nom, role, actif, cree_le) VALUES ('ancienne@exemple.test', 'Compte Désactivé', 'assistante', 0, 0)").run();
  const boite = [];
  // n8n simulé : envoiEnEchec fait échouer tout sauf les liens de connexion ; n8n.enPanne, les seuls e-mails
  // « pièces prêtes » ; n8n.reponse : ce que n8n répond (par exemple { journal_efface: false }).
  const n8n = { enPanne: false, categoriesEnPanne: new Set(), reponse: { ok: true, journal_efface: true } };
  const notificateur = {
    envoyer: async (evenement, donnees) => {
      if (envoiEnEchec && donnees.categorie !== 'lien_connexion') throw new Error('n8n injoignable (simulé)');
      if (n8n.enPanne && donnees.categorie === 'envoi_final') throw new Error('n8n injoignable (simulé)');
      if (n8n.categoriesEnPanne.has(donnees.categorie)) throw new Error('n8n injoignable (simulé)');
      boite.push({ evenement, donnees });
      return n8n.reponse;
    },
  };
  const { serveur, stockage, envoi, purge, relances, tableau, bilan } = creerApp({ db, config, notificateur });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  config.appUrl = `http://127.0.0.1:${serveur.address().port}`;
  const base = config.appUrl;

  const envoyer = (chemin, { methode = 'GET', formulaire, cookie, origine = base } = {}) => fetch(base + chemin, {
    method: methode,
    redirect: 'manual',
    headers: {
      ...(formulaire ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(methode === 'POST' && origine ? { Origin: origine } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: formulaire ? new URLSearchParams(formulaire).toString() : undefined,
  });

  async function fermer() {
    // Le navigateur des tests de bout en bout garde ses connexions ouvertes : sans les couper, close() attend
    // indéfiniment (vu le 18/10/2026, après l'ajout du logo qui ouvre une connexion de plus).
    serveur.closeAllConnections();
    await new Promise((ok) => serveur.close(ok));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { db, boite, envoyer, fermer, base, config, stockage, dataDir, envoi, purge, relances, tableau, bilan, n8n };
}

export const attendre = () => new Promise((ok) => setImmediate(ok));
export const lienDans = (texte) => texte.match(/https?:\/\/\S+/)[0];
export const jetonDuLien = (lien) => new URL(lien).searchParams.get('jeton');
export const cookieDe = (reponse) => reponse.headers.get('set-cookie').split(';')[0];

export async function seConnecter(app, email = ASSISTANTE) {
  await app.envoyer('/connexion', { methode: 'POST', formulaire: { email } });
  await attendre();
  const jeton = jetonDuLien(lienDans(app.boite.at(-1).donnees.texte));
  const reponse = await app.envoyer('/connexion/lien', { methode: 'POST', formulaire: { jeton } });
  return { reponse, jeton, cookie: cookieDe(reponse) };
}

// Jeton CSRF de la session, lu dans une page connectée.
export async function csrfDe(app, cookie, chemin = '/') {
  const page = await (await app.envoyer(chemin, { cookie })).text();
  return page.match(/name="csrf" value="([^"]+)"/)[1];
}

// Envoie un formulaire en ajoutant le jeton CSRF. Les valeurs tableau deviennent des champs répétés.
export async function poster(app, cookie, chemin, champs) {
  const csrf = await csrfDe(app, cookie);
  const formulaire = new URLSearchParams({ csrf });
  for (const [cle, valeur] of Object.entries(champs)) {
    for (const v of [].concat(valeur)) formulaire.append(cle, v);
  }
  return app.envoyer(chemin, { methode: 'POST', formulaire, cookie });
}
