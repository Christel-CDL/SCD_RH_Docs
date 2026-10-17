// Tests unitaires : jetons, signature des appels n8n, limitation de débit, réglages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nouveauJeton, empreinte, egaux, FORME_JETON } from '../src/securite/jetons.js';
import { signer } from '../src/notifications.js';
import { creerLimiteur } from '../src/securite/limiteur.js';
import { lireConfig } from '../src/config.js';

test('un jeton fait au moins 128 bits et respecte la forme attendue', () => {
  const jeton = nouveauJeton();
  assert.ok(Buffer.from(jeton, 'base64url').length * 8 >= 128);
  assert.match(jeton, FORME_JETON);
});

test('les jetons sont tous différents', () => {
  const lot = new Set(Array.from({ length: 1000 }, () => nouveauJeton()));
  assert.equal(lot.size, 1000);
});

test("l'empreinte est stable, différente du jeton et ne le contient pas", () => {
  const jeton = nouveauJeton();
  assert.equal(empreinte(jeton), empreinte(jeton));
  assert.match(empreinte(jeton), /^[a-f0-9]{64}$/);
  assert.ok(!empreinte(jeton).includes(jeton));
});

test('la comparaison à temps constant gère les longueurs différentes', () => {
  assert.equal(egaux('abc', 'abc'), true);
  assert.equal(egaux('abc', 'abd'), false);
  assert.equal(egaux('abc', 'abcd'), false);
});

test('la signature n8n change si le corps ou l\'horodatage change', () => {
  const secret = 'x'.repeat(32);
  const a = signer(secret, '1000', '{"a":1}');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, signer(secret, '1001', '{"a":1}'));
  assert.notEqual(a, signer(secret, '1000', '{"a":2}'));
  assert.notEqual(a, signer('y'.repeat(32), '1000', '{"a":1}'));
});

test('le limiteur bloque au-delà du maximum puis libère après la fenêtre', () => {
  const limiteur = creerLimiteur();
  for (let i = 0; i < 3; i++) assert.equal(limiteur.depasse('cle', 3, 1000, 0), false);
  assert.equal(limiteur.depasse('cle', 3, 1000, 10), true);
  assert.equal(limiteur.depasse('cle', 3, 1000, 2000), false);
  assert.equal(limiteur.depasse('autre', 3, 1000, 10), false);
});

test('la configuration de production refuse les réglages dangereux', () => {
  const { problemes } = lireConfig({ NODE_ENV: 'production', APP_URL: 'http://exemple.fr', DEV_LOG_LINKS: '1' });
  assert.ok(problemes.some((p) => p.includes('DEV_LOG_LINKS')));
  assert.ok(problemes.some((p) => p.includes('https')));
  assert.ok(problemes.some((p) => p.includes('ADMIN_EMAIL')));
});

test('une configuration de production complète est acceptée', () => {
  const { problemes, config } = lireConfig({
    NODE_ENV: 'production', APP_URL: 'https://pieces.expertform.fr/', ADMIN_EMAIL: 'Admin@Exemple.fr',
    N8N_WEBHOOK_URL: 'http://n8n:5678/webhook/x', N8N_WEBHOOK_SECRET: 's'.repeat(40), FILE_ENCRYPTION_KEY: 'cd'.repeat(32),
    INTERNAL_API_SECRET: 'i'.repeat(40),
  });
  assert.deepEqual(problemes, []);
  assert.equal(config.appUrl, 'https://pieces.expertform.fr');
  assert.equal(config.adminEmail, 'admin@exemple.fr');
  assert.equal(config.dureeSessionMs, 8 * 3600e3);
});

test('.env.example liste tous les réglages exigés au démarrage', async () => {
  // Défaut vu le 17/10/2026 : FILE_ENCRYPTION_KEY manquait, « npm run dev » échouait après la copie du modèle.
  const fs = await import('node:fs');
  const modele = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const nom of ['APP_URL', 'DATA_DIR', 'ADMIN_EMAIL', 'ADMIN_NOM', 'N8N_WEBHOOK_URL', 'N8N_WEBHOOK_SECRET', 'INTERNAL_API_SECRET', 'INTERNAL_URL', 'FILE_ENCRYPTION_KEY', 'DEV_LOG_LINKS']) {
    assert.match(modele, new RegExp(`^${nom}=`, 'm'), `${nom} absent de .env.example`);
  }
});
