// Étape 3 : chiffrement, contrôle des fichiers, dépôt en brouillon, remplacement, envoi du dossier.
// Tous les fichiers sont fabriqués ici : aucun document réel, même fictif, n'est utilisé.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chiffrer, dechiffrer, lireCle } from '../src/securite/chiffrement.js';
import { detecterType, nettoyerJpeg, nettoyerPng, preparerFichier } from '../src/fichiers.js';
import { demarrer, seConnecter, poster, lienDans, CLE_TEST } from './aide.js';

// ── Fabriques de fichiers fictifs ─────────────────────────────────

const segment = (marqueur, contenu) => {
  const corps = Buffer.from(contenu, 'latin1');
  const entete = Buffer.from([0xff, marqueur, 0, 0]);
  entete.writeUInt16BE(corps.length + 2, 2);
  return Buffer.concat([entete, corps]);
};
// JPEG minimal (non décodable, mais à la structure correcte) avec EXIF « GPS » et commentaire.
function jpegFictif({ metadonnees = true, image = 'PIXELS-FICTIFS' } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
    ...(metadonnees ? [segment(0xe1, 'Exif\0\0GPSLatitude=44.8;GPSLongitude=-0.6'), segment(0xfe, 'Commentaire secret')] : []),
    segment(0xdb, 'TABLE-QUANTIF'),
    segment(0xda, 'SOS'),
    Buffer.from(image, 'latin1'),
    Buffer.from([0xff, 0xd9]),
  ]);
}
const bloc = (type, contenu) => {
  const donnees = Buffer.from(contenu, 'latin1');
  const longueur = Buffer.alloc(4);
  longueur.writeUInt32BE(donnees.length);
  return Buffer.concat([longueur, Buffer.from(type, 'latin1'), donnees, Buffer.alloc(4)]);
};
const pngFictif = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  bloc('IHDR', 'X'.repeat(13)), bloc('tEXt', 'Author\0Personne Secrete'), bloc('eXIf', 'GPS'), bloc('IDAT', 'PIXELS'), bloc('IEND', ''),
]);
const pdfFictif = () => Buffer.from('%PDF-1.4\n% document fictif\n%%EOF\n', 'latin1');
const heicFictif = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]);

// ── Unitaires : chiffrement ───────────────────────────────────────

test('le chiffrement AES-256-GCM restitue le contenu et ne le laisse pas lisible', () => {
  const cle = lireCle(CLE_TEST);
  const contenu = Buffer.from('CONTENU-TRES-CONFIDENTIEL');
  const chiffre = chiffrer(cle, contenu, 'fichier-1');
  assert.ok(!chiffre.includes(contenu));
  assert.deepEqual(dechiffrer(cle, chiffre, 'fichier-1'), contenu);
  assert.notDeepEqual(chiffrer(cle, contenu, 'fichier-1'), chiffre, 'un IV neuf à chaque chiffrement');
});

test('un fichier modifié, une mauvaise clé ou un autre nom de fichier sont refusés', () => {
  const cle = lireCle(CLE_TEST);
  const chiffre = chiffrer(cle, Buffer.from('abc'), 'fichier-1');
  const modifie = Buffer.from(chiffre);
  modifie[modifie.length - 1] ^= 1;
  assert.throws(() => dechiffrer(cle, modifie, 'fichier-1'));
  assert.throws(() => dechiffrer(lireCle('cd'.repeat(32)), chiffre, 'fichier-1'));
  assert.throws(() => dechiffrer(cle, chiffre, 'fichier-2'));
  assert.throws(() => dechiffrer(cle, Buffer.from('court'), 'fichier-1'));
});

test('la clé doit faire exactement 64 caractères hexadécimaux', () => {
  assert.equal(lireCle('ab'.repeat(32)).length, 32);
  assert.equal(lireCle('ab'.repeat(31)), null);
  assert.equal(lireCle('zz'.repeat(32)), null);
  assert.equal(lireCle(''), null);
});

// ── Unitaires : types et métadonnées ──────────────────────────────

test('le type réel est reconnu par les octets de signature, pas par le nom', () => {
  assert.equal(detecterType(jpegFictif()), 'image/jpeg');
  assert.equal(detecterType(pngFictif()), 'image/png');
  assert.equal(detecterType(pdfFictif()), 'application/pdf');
  assert.equal(detecterType(heicFictif()), 'image/heic');
  assert.equal(detecterType(Buffer.from('<html>pas une image</html>')), null);
  assert.equal(detecterType(Buffer.from('MZ\x90\0exécutable', 'latin1')), null);
});

test('l\'EXIF (dont le GPS) et les commentaires sont retirés des JPEG, l\'image est conservée', () => {
  const propre = nettoyerJpeg(jpegFictif());
  const texte = propre.toString('latin1');
  assert.ok(!texte.includes('GPS') && !texte.includes('Exif') && !texte.includes('secret'));
  assert.ok(texte.includes('JFIF') && texte.includes('TABLE-QUANTIF') && texte.includes('PIXELS-FICTIFS'));
  assert.deepEqual(nettoyerJpeg(jpegFictif({ metadonnees: false })), jpegFictif({ metadonnees: false }), 'sans métadonnées, rien ne change');
});

test('les blocs de texte et d\'EXIF sont retirés des PNG', () => {
  const texte = nettoyerPng(pngFictif()).toString('latin1');
  assert.ok(!texte.includes('Personne Secrete') && !texte.includes('eXIf'));
  assert.ok(texte.includes('IHDR') && texte.includes('IDAT') && texte.includes('IEND'));
});

test('preparerFichier refuse le HEIC non converti, les autres formats et les JPEG abîmés', () => {
  assert.match(preparerFichier(heicFictif()).erreur, /HEIC/);
  assert.match(preparerFichier(Buffer.from('texte')).erreur, /ni une photo/);
  assert.match(preparerFichier(jpegFictif().subarray(0, 12)).erreur, /abîmé/);
  assert.equal(preparerFichier(pdfFictif()).type, 'application/pdf');
});

// ── Intégration ───────────────────────────────────────────────────

async function demandeFictive(app, pieces = ['CV', 'CNI_PASS', 'RIB']) {
  const { cookie } = await seConnecter(app);
  await poster(app, cookie, '/demandes', { type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST', email: 'zz-test@exemple.test', pieces });
  const lien = lienDans(app.boite.at(-1).donnees.texte);
  return { jeton: lien.split('/d/')[1], demandeId: app.db.prepare('SELECT id FROM demandes').get().id };
}

function deposer(app, jeton, abrev, fichiers, { choix, json = true } = {}) {
  const donnees = new FormData();
  if (choix) donnees.append('choix', choix);
  fichiers.forEach((f, i) => donnees.append('fichier', new Blob([f]), `f${i}`));
  return fetch(`${app.base}/d/${jeton}/pieces/${abrev}`, {
    method: 'POST', body: donnees, redirect: 'manual', headers: { Origin: app.base, ...(json ? { Accept: 'application/json' } : {}) },
  });
}

const etatPieces = (app) => Object.fromEntries(app.db.prepare('SELECT abrev, statut, abrev_fournie FROM pieces').all().map((p) => [p.abrev, p.statut + (p.abrev_fournie ? `/${p.abrev_fournie}` : '')]));

test('la page de dépôt affiche les pièces demandées, la mention RGPD et l\'aide', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const r = await app.envoyer(`/d/${jeton}`);
    assert.equal(r.status, 200);
    const page = await r.text();
    assert.match(page, /Curriculum vitae/);
    assert.match(page, /Quelle pièce fournissez-vous/);
    assert.doesNotMatch(page, /Diplômes/, 'seules les pièces demandées');
    assert.match(page, /Vos données personnelles/);
    assert.match(page, /Responsable du traitement/);
    assert.match(page, /Besoin d'aide/);
    assert.match(page, /Pièces déposées : <strong>0 sur 3/);
    assert.match(page, /disabled aria-disabled="true">Envoyer mon dossier/);
    assert.match(page, /<script src="\/depot.js" defer>/);
  } finally { await app.fermer(); }
});

test('une pièce validée est enregistrée chiffrée, sans métadonnées, et la demande passe « en cours »', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const r = await deposer(app, jeton, 'CV', [jpegFictif(), jpegFictif()]);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(etatPieces(app).CV, 'deposee/CV');
    assert.equal(app.db.prepare('SELECT statut FROM demandes').get().statut, 'en_cours');

    const pages = app.db.prepare('SELECT fichier, ordre, type FROM pages ORDER BY ordre').all();
    assert.equal(pages.length, 2);
    for (const { fichier } of pages) {
      const brut = fs.readFileSync(path.join(app.stockage.dossier, `${fichier}.bin`));
      assert.ok(!brut.includes(Buffer.from('PIXELS-FICTIFS')), 'illisible sur le disque');
      const clair = app.stockage.lire(fichier).toString('latin1');
      assert.ok(clair.includes('PIXELS-FICTIFS') && !clair.includes('GPS'), 'déchiffrable, sans GPS');
    }
    // Ni la base ni le journal ne contiennent le contenu.
    assert.ok(!fs.readFileSync(path.join(app.dataDir, 'app.db')).includes(Buffer.from('PIXELS-FICTIFS')));
  } finally { await app.fermer(); }
});

test('recto-verso exige deux photos ; un PDF seul suffit ; le choix CNI / passeport est obligatoire', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app, ['PERMIS', 'CNI_PASS', 'RIB']);
    assert.equal((await deposer(app, jeton, 'PERMIS', [jpegFictif()])).status, 400);
    assert.equal((await deposer(app, jeton, 'PERMIS', [pdfFictif()])).status, 200);
    assert.equal((await deposer(app, jeton, 'RIB', [jpegFictif(), jpegFictif()])).status, 400, 'une seule page pour un RIB');
    assert.equal((await deposer(app, jeton, 'RIB', [pdfFictif(), jpegFictif()])).status, 400, 'un PDF doit être seul');

    assert.equal((await deposer(app, jeton, 'CNI_PASS', [jpegFictif()])).status, 400, 'choix manquant');
    assert.equal((await deposer(app, jeton, 'CNI_PASS', [jpegFictif()], { choix: 'RIB' })).status, 400, 'choix hors liste');
    assert.equal((await deposer(app, jeton, 'CNI_PASS', [jpegFictif()], { choix: 'PASS' })).status, 200, 'passeport : une page');
    assert.equal(etatPieces(app).CNI_PASS, 'deposee/PASS', 'le fichier portera l\'abréviation de la pièce fournie');
  } finally { await app.fermer(); }
});

test('les formats refusés le sont avec un message clair, sans rien enregistrer', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const heic = await deposer(app, jeton, 'RIB', [heicFictif()]);
    assert.equal(heic.status, 415);
    assert.match((await heic.json()).erreur, /HEIC/);
    assert.equal((await deposer(app, jeton, 'RIB', [Buffer.from('<script>alert(1)</script>')])).status, 415);
    assert.equal((await deposer(app, jeton, 'RIB', [])).status, 400);
    assert.equal((await deposer(app, jeton, 'DIPL', [jpegFictif()])).status, 404, 'pièce non demandée');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM pages').get().n, 0);
    assert.equal(app.stockage.lister().length, 0);
  } finally { await app.fermer(); }
});

test('un fichier de plus de 10 Mo est refusé', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const r = await deposer(app, jeton, 'RIB', [jpegFictif({ image: 'x'.repeat(10 * 1024 * 1024 + 10) })]);
    assert.equal(r.status, 413);
    assert.equal(app.stockage.lister().length, 0);
  } finally { await app.fermer(); }
});

test('remplacer une pièce supprime les anciens fichiers du disque', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    await deposer(app, jeton, 'CV', [jpegFictif(), jpegFictif(), jpegFictif()]);
    const anciens = app.stockage.lister();
    assert.equal(anciens.length, 3);
    assert.equal((await deposer(app, jeton, 'CV', [pdfFictif()])).status, 200);
    const nouveaux = app.stockage.lister();
    assert.equal(nouveaux.length, 1);
    assert.ok(anciens.every((f) => !nouveaux.includes(f)));
    assert.equal(app.db.prepare('SELECT type FROM pages').get().type, 'application/pdf');
  } finally { await app.fermer(); }
});

test('l\'attribut hidden masque toujours (aperçus vides, bouton d\'ajout de page sans script)', async () => {
  // Défaut vu dans le navigateur le 17/10/2026 : .apercu { display: block } affichait une image cassée.
  const app = await demarrer();
  try {
    const css = await (await app.envoyer('/styles.css')).text();
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  } finally { await app.fermer(); }
});

test('le style et le script sont revalidés à chaque affichage : une mise à jour arrive tout de suite', async () => {
  // Défaut vu le 17/10/2026 : « max-age=3600 » gardait l'ancien CSS une heure après la correction.
  const app = await demarrer();
  try {
    for (const fichier of ['/styles.css', '/depot.js']) {
      const r = await app.envoyer(fichier);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      const etag = r.headers.get('etag');
      assert.ok(etag);
      const r2 = await fetch(app.base + fichier, { headers: { 'If-None-Match': etag } });
      assert.equal(r2.status, 304, 'inchangé : pas de nouveau téléchargement');
    }
  } finally { await app.fermer(); }
});

test('le brouillon est retrouvé en revenant par le même lien', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    await deposer(app, jeton, 'RIB', [jpegFictif()]);
    const page = await (await app.envoyer(`/d/${jeton}`)).text();
    assert.match(page, /Pièces déposées : <strong>1 sur 3/);
    assert.match(page, /Déposée ✓/);
    assert.match(page, /Remplacer cette pièce/);
  } finally { await app.fermer(); }
});

test('sans script, l\'envoi classique fonctionne et les erreurs s\'affichent dans la page', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const ok = await deposer(app, jeton, 'RIB', [jpegFictif()], { json: false });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), new RegExp(`/d/${jeton}#piece-RIB$`));
    const ko = await deposer(app, jeton, 'CV', [heicFictif()], { json: false });
    assert.equal(ko.status, 415);
    assert.match(await ko.text(), /format HEIC/);
  } finally { await app.fermer(); }
});

test('« Envoyer mon dossier » n\'est possible que lorsque tout est déposé', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const envoyer = () => app.envoyer(`/d/${jeton}/envoyer`, { methode: 'POST', formulaire: {} });
    await deposer(app, jeton, 'CV', [jpegFictif()]);
    assert.equal((await envoyer()).status, 409);
    await deposer(app, jeton, 'CNI_PASS', [jpegFictif(), jpegFictif()], { choix: 'CNI' });
    await deposer(app, jeton, 'RIB', [pdfFictif()]);
    assert.match(await (await app.envoyer(`/d/${jeton}`)).text(), /<button type="submit" class="bouton">Envoyer mon dossier/);

    assert.equal((await envoyer()).status, 303);
    assert.equal(app.db.prepare('SELECT statut FROM demandes').get().statut, 'complete');
    assert.match(await (await app.envoyer(`/d/${jeton}`)).text(), /Votre dossier est complet/);
    assert.equal((await deposer(app, jeton, 'RIB', [jpegFictif()])).status, 410, 'plus aucun dépôt après l\'envoi');
  } finally { await app.fermer(); }
});

test('après la date limite, le dépôt est fermé ; après l\'expiration, le lien ne mène plus à rien', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    app.db.prepare('UPDATE demandes SET date_limite = ?').run(Date.now() - 1);
    assert.match(await (await app.envoyer(`/d/${jeton}`)).text(), /délai de dépôt est dépassé/);
    assert.equal((await deposer(app, jeton, 'RIB', [jpegFictif()])).status, 410);
    app.db.prepare('UPDATE demandes SET expire_le = ?').run(Date.now() - 1);
    assert.equal((await app.envoyer(`/d/${jeton}`)).status, 410);
  } finally { await app.fermer(); }
});

test('une requête de dépôt venant d\'un autre site est refusée', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app);
    const donnees = new FormData();
    donnees.append('fichier', new Blob([jpegFictif()]), 'f');
    const r = await fetch(`${app.base}/d/${jeton}/pieces/RIB`, { method: 'POST', body: donnees, headers: { Origin: 'https://pirate.example' } });
    assert.equal(r.status, 403);
    assert.equal(app.stockage.lister().length, 0);
  } finally { await app.fermer(); }
});

test('supprimerFichiers efface du disque toutes les pages d\'une demande', async () => {
  const app = await demarrer();
  try {
    const { jeton, demandeId } = await demandeFictive(app);
    await deposer(app, jeton, 'CV', [jpegFictif(), jpegFictif()]);
    await deposer(app, jeton, 'RIB', [pdfFictif()]);
    assert.equal(app.stockage.lister().length, 3);
    const { creerDepot } = await import('../src/depot.js');
    creerDepot({ db: app.db, catalogue: null, stockage: app.stockage }).supprimerFichiers(demandeId);
    assert.equal(app.stockage.lister().length, 0);
  } finally { await app.fermer(); }
});
