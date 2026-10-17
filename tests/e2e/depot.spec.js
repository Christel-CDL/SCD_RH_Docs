// Parcours du salarié sur téléphone simulé : photos fictives fabriquées dans le navigateur (fictifs-navigateur.js),
// contrôle de lisibilité, envoi forcé « à vérifier », PDF désarmé, HEIC, envoi du dossier.
// Aucune donnée réelle : comptes, noms et documents sont fictifs.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demarrer, seConnecter, poster, lienDans } from '../aide.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
// Photo HEIC d'exemple (publique, sans donnée personnelle), non versionnée : le test HEIC est sauté si elle manque.
const HEIC = process.env.HEIC_EXEMPLE || path.join(ICI, 'locaux', 'exemple.heic');

let app;
let lien;
let erreursConsole;

test.beforeEach(async ({ page }) => {
  // Toute erreur affichée dans la console fait échouer le test (vu le 17/10/2026 : aperçu libéré par erreur
  // lors de l'ajout d'une page, police de pdf.js bloquée).
  erreursConsole = [];
  page.on('console', (m) => { if (m.type() === 'error') erreursConsole.push(m.text()); });
  page.on('pageerror', (e) => erreursConsole.push(e.message));
  app = await demarrer();
  const { cookie } = await seConnecter(app);
  await poster(app, cookie, '/demandes', {
    type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST Fictive', email: 'zz-test@exemple.test', pieces: ['CV', 'CNI_PASS', 'RIB'],
  });
  lien = lienDans(app.boite.at(-1).donnees.texte);
  // Générateurs de documents fictifs, et relevé de toute violation de la politique de sécurité (CSP).
  await page.addInitScript({ path: path.join(ICI, 'fictifs-navigateur.js') });
  await page.addInitScript(() => {
    window.violationsCsp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violationsCsp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
});

test.afterEach(async ({ page }) => {
  try {
    expect(await page.evaluate(() => window.violationsCsp ?? [])).toEqual([]); // page vide si le test a été sauté
    expect(erreursConsole).toEqual([]);
  } finally {
    await app.fermer(); // base et pièces temporaires supprimées même si le test échoue
  }
});

// Choisit un fichier fabriqué dans la page pour l'emplacement n° « rang » de la pièce.
async function deposerFictif(page, abrev, rang, fabrique) {
  await page.evaluate(async ({ abrev: a, rang: r, fabrique: f }) => {
    const emplacement = document.querySelectorAll(`#piece-${a} .emplacement`)[r];
    const fichier = f.genre === 'pdf' ? window.fictifs.pdf(f.pages) : await window.fictifs.fichier(window.fictifs[f.genre](f.options || {}));
    window.fictifs.choisir(emplacement.querySelector(f.genre === 'pdf' ? 'input[id$="-fichier"]' : 'input[id$="-photo"]'), fichier);
  }, { abrev, rang, fabrique });
}
// Ouvre le formulaire d'une pièce (la page ouvre déjà d'elle-même la première pièce à faire).
const ouvrir = (page, abrev) => page.evaluate((a) => { document.querySelector(`#piece-${a} details`).open = true; }, abrev);
const emplacement = (page, abrev, rang) => page.locator(`#piece-${abrev} .emplacement`).nth(rang);

test('photo floue refusée, envoyée quand même après deux essais, puis dossier complet envoyé', async ({ page }) => {
  await page.goto(lien);
  await expect(page.getByRole('heading', { name: 'Bonjour Mme ZZ TEST Fictive' })).toBeVisible();
  await expect(page.locator('.cadre-guide').first()).toBeVisible();

  // CV : une photo floue, deux fois, puis « Envoyer cette photo quand même ».
  await deposerFictif(page, 'CV', 0, { genre: 'page', options: { flou: 12 } });
  await expect(emplacement(page, 'CV', 0).locator('.controle')).toContainText('La photo est floue');
  await expect(emplacement(page, 'CV', 0).getByRole('button', { name: 'Envoyer cette photo quand même' })).toHaveCount(0);
  await deposerFictif(page, 'CV', 0, { genre: 'page', options: { flou: 12 } });
  await emplacement(page, 'CV', 0).getByRole('button', { name: 'Envoyer cette photo quand même' }).click();
  await expect(emplacement(page, 'CV', 0).locator('.apercu')).toBeVisible();
  // Deuxième page, nette.
  await page.locator('#piece-CV').getByRole('button', { name: 'Ajouter une page' }).click();
  // Défaut vu le 17/10/2026 : ajouter une page libérait l'adresse de l'aperçu de la page 1.
  expect(await emplacement(page, 'CV', 0).locator('.apercu').evaluate((img) => {
    const copie = new Image();
    copie.src = img.src;
    return copie.decode().then(() => true, () => false);
  })).toBe(true);
  await deposerFictif(page, 'CV', 1, { genre: 'page' });
  await expect(emplacement(page, 'CV', 1)).toHaveClass(/rempli/);
  await page.locator('#piece-CV').getByRole('button', { name: 'Valider cette pièce' }).click();
  await expect(page.locator('#piece-CV')).toContainText('Déposée ✓ · 2 pages');
  await expect(page.locator('#piece-CV')).toContainText('Photo peu lisible envoyée quand même');

  // Carte d'identité : recto et verso nets.
  await ouvrir(page, 'CNI_PASS');
  await page.locator('#piece-CNI_PASS').getByLabel('Carte nationale d\'identité').check();
  await deposerFictif(page, 'CNI_PASS', 0, { genre: 'carte' });
  await deposerFictif(page, 'CNI_PASS', 1, { genre: 'carte' });
  await expect(emplacement(page, 'CNI_PASS', 1)).toHaveClass(/rempli/);
  await page.locator('#piece-CNI_PASS').getByRole('button', { name: 'Valider cette pièce' }).click();
  await expect(page.locator('#piece-CNI_PASS')).toContainText('Déposée ✓ · 2 pages');

  // RIB : un PDF fictif de deux pages, transformé en images dans le téléphone.
  await ouvrir(page, 'RIB');
  await deposerFictif(page, 'RIB', 0, { genre: 'pdf', pages: 2 });
  await expect(page.locator('#piece-RIB .nom-fichier')).toHaveText('PDF : attestation-fictive.pdf (2 pages)');
  await page.locator('#piece-RIB').getByRole('button', { name: 'Valider cette pièce' }).click();
  await expect(page.locator('#piece-RIB')).toContainText('Déposée ✓ · 2 pages');

  // Côté serveur : que des JPEG, la pièce forcée marquée, aucun PDF brut stocké.
  expect(app.db.prepare('SELECT DISTINCT type FROM pages').all().map((p) => p.type)).toEqual(['image/jpeg']);
  expect(app.db.prepare("SELECT a_verifier FROM pieces WHERE abrev = 'CV'").get().a_verifier).toBe(1);

  await expect(page.locator('.progression')).toContainText('3 sur 3');
  await page.getByRole('button', { name: 'Envoyer mon dossier' }).click();
  await expect(page.getByRole('heading', { name: 'Merci Mme ZZ TEST Fictive' })).toBeVisible();
});

test('photos sombre, avec reflet ou trop petite : message adapté', async ({ page }) => {
  await page.goto(lien);
  const cas = [
    [{ genre: 'page', options: { lumiere: 0.2 } }, 'trop sombre'],
    [{ genre: 'page', options: { reflet: 0.1 } }, 'reflet'],
    [{ genre: 'page', options: { largeur: 900, hauteur: 1200 } }, 'trop petite'],
    [{ genre: 'page', options: { lumiere: 1.4 } }, 'trop claire'],
  ];
  for (const [fabrique, attendu] of cas) {
    await deposerFictif(page, 'CV', 0, fabrique);
    await expect(emplacement(page, 'CV', 0).locator('.controle')).toContainText(attendu);
  }
});

test('une pièce de 6 pages est recompressée dans le téléphone pour rester sous 1,5 Mo', async ({ page }) => {
  await page.goto(lien);
  for (let i = 0; i < 6; i += 1) {
    if (i > 0) await page.locator('#piece-CV').getByRole('button', { name: 'Ajouter une page' }).click();
    await deposerFictif(page, 'CV', i, { genre: 'page', options: { bruit: 14 } }); // le grain alourdit les JPEG
    await expect(emplacement(page, 'CV', i)).toHaveClass(/rempli/, { timeout: 20_000 });
  }
  await page.locator('#piece-CV').getByRole('button', { name: 'Valider cette pièce' }).click();
  await expect(page.locator('#piece-CV')).toContainText('Déposée ✓ · 6 pages', { timeout: 60_000 });
  const total = app.db.prepare('SELECT SUM(taille) AS t FROM pages').get().t;
  expect(total).toBeLessThanOrEqual(1500 * 1024);
});

test('photo HEIC décodée dans le téléphone', async ({ page }) => {
  test.skip(!fs.existsSync(HEIC), `photo HEIC d'exemple absente (${HEIC})`);
  await page.goto(lien);
  await page.locator('#piece-CV .emplacement input[id$="-fichier"]').first().setInputFiles(HEIC);
  // L'exemple fait 1 440 × 960 px : il est lu (le décodeur fonctionne), puis jugé trop petit.
  await expect(emplacement(page, 'CV', 0).locator('.controle')).toContainText('trop petite', { timeout: 60_000 });
});
