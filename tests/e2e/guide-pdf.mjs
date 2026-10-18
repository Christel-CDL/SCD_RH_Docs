// Fabrique le PDF du guide d'une page (livrable 6) à partir de la page /aide, sur un serveur de test.
// Usage : node tests/e2e/guide-pdf.mjs <fichier.pdf> [capture.png]. Données fictives uniquement.
import { chromium } from '@playwright/test';
import { demarrer, seConnecter } from '../aide.js';

const [sortie, capture] = process.argv.slice(2);
if (!sortie) throw new Error('Indiquer le fichier PDF à écrire.');
const app = await demarrer({
  // Le guide affiche l'adresse et le contact de la production.
  env: { ADMIN_NOM: 'Christel LACOME', ADMIN_EMAIL: 'christel.lacome@cdl-expertises.com' },
});
const navigateur = await chromium.launch();
try {
  const { cookie } = await seConnecter(app);
  app.config.appUrl = 'https://pieces.expertform.fr'; // adresse affichée dans le guide (après la connexion de test)
  // Le cookie de session est « Secure » : sur le serveur de test (http), on le passe en en-tête.
  const contexte = await navigateur.newContext({ extraHTTPHeaders: { Cookie: cookie.split(';')[0] } });
  const page = await contexte.newPage();
  await page.goto(`${app.base}/aide`);
  await page.emulateMedia({ media: 'print' });
  // Capture facultative de la version imprimée (largeur A4), pour relire la mise en page.
  if (capture) { await page.setViewportSize({ width: 794, height: 1123 }); await page.screenshot({ path: capture, fullPage: true }); }
  await page.pdf({ path: sortie, format: 'A4', printBackground: true, preferCSSPageSize: true });
  console.log('PDF écrit :', sortie);
} finally {
  await navigateur.close();
  await app.fermer();
}
