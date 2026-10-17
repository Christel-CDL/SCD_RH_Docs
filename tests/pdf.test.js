// Étape 4 : nommage et génération des PDF, contrôles de taille, réglages, bibliothèques servies par l'application.
// Tous les fichiers sont fabriqués ici : aucun document réel, même fictif, n'est utilisé.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { creerPdf, nomPdf, analyserImage } from '../src/pdf.js';
import { preparerFichier } from '../src/fichiers.js';
import { chargerCatalogue, chargerControles } from '../src/catalogue.js';
import { creerDepot } from '../src/depot.js';
import { demarrer, seConnecter, poster, lienDans } from './aide.js';

// JPEG à la structure correcte (en-tête SOF avec ses dimensions), non décodable : suffisant pour la structure du PDF.
function jpeg({ largeur = 1200, hauteur = 1600, octets = 200, marque = 'PIXELS-FICTIFS' } = {}) {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(hauteur, 5);
  sof.writeUInt16BE(largeur, 7);
  const donnees = Buffer.alloc(Math.max(octets, marque.length), 0x20);
  donnees.write(marque, 'latin1');
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0, 2]), donnees, Buffer.from([0xff, 0xd9])]);
}
const bloc = (type, contenu) => {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(contenu.length);
  return Buffer.concat([l, Buffer.from(type, 'latin1'), contenu, Buffer.alloc(4)]);
};
// Vrai PNG (gris ou couleur, 8 bits), lisible par un lecteur PDF.
function png({ largeur = 4, hauteur = 3, couleur = 2, entrelace = 0 } = {}) {
  const ihdr = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 8, couleur, 0, 0, entrelace]);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  const canaux = { 0: 1, 2: 3, 6: 4 }[couleur];
  const brut = Buffer.alloc(hauteur * (1 + largeur * canaux), 0x80);
  for (let y = 0; y < hauteur; y += 1) brut[y * (1 + largeur * canaux)] = 0; // filtre « aucun »
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr), bloc('IDAT', zlib.deflateSync(brut)), bloc('IEND', Buffer.alloc(0)),
  ]);
}

// Vérifie la table xref : chaque position doit tomber exactement sur le début de l'objet annoncé.
function verifierStructure(pdf) {
  const texte = pdf.toString('latin1');
  assert.ok(texte.startsWith('%PDF-1.4\n'));
  assert.ok(texte.endsWith('%%EOF\n'));
  const debutXref = Number(texte.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.equal(texte.slice(debutXref, debutXref + 4), 'xref');
  const [, total] = texte.slice(debutXref).match(/^xref\n0 (\d+)\n/).map(Number);
  const lignes = texte.slice(debutXref).split('\n').slice(3, 2 + Number(total));
  lignes.forEach((ligne, i) => {
    const position = Number(ligne.slice(0, 10));
    assert.equal(texte.slice(position, position + String(i + 1).length + 6), `${i + 1} 0 obj`, `objet ${i + 1}`);
  });
  return texte;
}

// ── Nommage ───────────────────────────────────────────────────────

test('nom du PDF : NOM-ABREV.pdf, majuscules sans accents, espaces et apostrophes remplacés par « _ »', () => {
  assert.equal(nomPdf('Dupont', 'CNI'), 'DUPONT-CNI.pdf');
  assert.equal(nomPdf('Le Gall', 'RIB'), 'LE_GALL-RIB.pdf');
  assert.equal(nomPdf("D'Artagnan", 'CV'), 'D_ARTAGNAN-CV.pdf');
  assert.equal(nomPdf('N’Diaye  Éloïse', 'PASS'), 'N_DIAYE_ELOISE-PASS.pdf');
  assert.equal(nomPdf('Martin-Lefèvre', 'JDOM'), 'MARTIN-LEFEVRE-JDOM.pdf');
  assert.equal(nomPdf('ZZ TEST / ../x', 'B3'), 'ZZ_TEST_X-B3.pdf', 'aucun caractère de chemin');
  assert.equal(nomPdf('   ', 'RIB'), 'SALARIE-RIB.pdf');
});

// ── Génération ────────────────────────────────────────────────────

test('le PDF contient une page A4 par image, dans l\'ordre, sans aucune métadonnée', () => {
  const pages = [
    { type: 'image/jpeg', contenu: jpeg({ marque: 'RECTO-FICTIF' }) },
    { type: 'image/jpeg', contenu: jpeg({ largeur: 1600, hauteur: 1000, marque: 'VERSO-FICTIF' }) },
  ];
  const texte = verifierStructure(creerPdf(pages));
  assert.match(texte, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2/);
  assert.match(texte, /\/MediaBox \[0 0 595\.28 841\.89\]/, 'portrait pour une image en hauteur');
  assert.match(texte, /\/MediaBox \[0 0 841\.89 595\.28\]/, 'paysage pour une image en largeur');
  assert.ok(texte.indexOf('RECTO-FICTIF') < texte.indexOf('VERSO-FICTIF'), 'ordre conservé');
  assert.ok(texte.includes(pages[0].contenu.toString('latin1')), 'le JPEG est inclus tel quel, sans recompression');
  assert.match(texte, /\/Filter \/DCTDecode/);
  assert.doesNotMatch(texte, /\/Info|\/Metadata|\/Author|\/Producer|\/Creator|\/CreationDate|\/JavaScript|\/OpenAction/);
});

test('l\'image tient dans la page avec une marge et reste centrée', () => {
  const texte = creerPdf([{ type: 'image/jpeg', contenu: jpeg({ largeur: 1000, hauteur: 2000 }) }]).toString('latin1');
  const [, l, h, x, y] = texte.match(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/).map(Number);
  assert.ok(h <= 841.89 - 2 * 28 + 0.01 && l <= 595.28 - 2 * 28 + 0.01);
  assert.ok(Math.abs(l / h - 0.5) < 0.001, 'proportions conservées');
  assert.ok(Math.abs(x - (595.28 - l) / 2) < 0.01 && Math.abs(y - (841.89 - h) / 2) < 0.01);
});

test('les PNG simples sont inclus avec leurs données compressées ; les autres sont refusés au dépôt', () => {
  const texte = verifierStructure(creerPdf([{ type: 'image/png', contenu: png() }])).toString('latin1');
  assert.match(texte, /\/Filter \/FlateDecode \/DecodeParms << \/Predictor 15 \/Colors 3 \/BitsPerComponent 8 \/Columns 4 >>/);
  assert.deepEqual([analyserImage('image/png', png({ couleur: 0 })).largeur, analyserImage('image/png', png()).hauteur], [4, 3]);
  // Transparence (capture d'écran) ou entrelacement : le PDF ne saurait pas l'afficher sans décompresser.
  assert.match(preparerFichier(png({ couleur: 6 })).erreur, /pas prise en charge/);
  assert.match(preparerFichier(png({ entrelace: 1 })).erreur, /pas prise en charge/);
  assert.equal(preparerFichier(png()).type, 'image/png');
});

// ── Réglages ──────────────────────────────────────────────────────

test('controles.json : les réglages livrés sont valides, une erreur de saisie bloque le démarrage', () => {
  const controles = chargerControles('config');
  assert.equal(controles.lisibilite.petit_cote_min_px, 1000);
  assert.equal(controles.lisibilite.echecs_avant_forcer, 2);
  assert.equal(controles.pdf.plafond_ko, 3500);
  assert.ok(!('_aide' in controles.lisibilite));

  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-controles-'));
  const ecrire = (modif) => {
    const brut = JSON.parse(fs.readFileSync('config/controles.json', 'utf8'));
    modif(brut);
    fs.writeFileSync(path.join(dossier, 'controles.json'), JSON.stringify(brut));
  };
  ecrire((b) => { b.lisibilite.nettete_min = 'beaucoup'; });
  assert.throws(() => chargerControles(dossier), /nettete_min/);
  ecrire((b) => { b.pdf.plafond_ko = 9000; });
  assert.throws(() => chargerControles(dossier), /plafond_ko/);
  ecrire((b) => { b.lisibilite.luminosite_min = 240; });
  assert.throws(() => chargerControles(dossier), /luminosite_min/);
  fs.rmSync(dossier, { recursive: true, force: true });
});

// ── Dépôt : drapeau « à vérifier », taille maximale, PDF de la demande ──

async function demandeFictive(app, pieces) {
  const { cookie } = await seConnecter(app);
  await poster(app, cookie, '/demandes', { type: 'embauche', civilite: 'M.', nom: "ZZ TEST Le Gall", email: 'zz-test@exemple.test', pieces });
  const lien = lienDans(app.boite.at(-1).donnees.texte);
  return { jeton: lien.split('/d/')[1], demande: app.db.prepare('SELECT * FROM demandes').get() };
}
function deposer(app, jeton, abrev, fichiers, champs = {}) {
  const donnees = new FormData();
  for (const [k, v] of Object.entries(champs)) donnees.append(k, v);
  fichiers.forEach((f, i) => donnees.append('fichier', new Blob([f]), `page-${i + 1}.jpg`));
  return fetch(`${app.base}/d/${jeton}/pieces/${abrev}`, {
    method: 'POST', body: donnees, headers: { Origin: app.base, Accept: 'application/json' },
  });
}

test('une photo envoyée malgré le contrôle de lisibilité est marquée « à vérifier »', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app, ['RIB', 'JDOM']);
    assert.equal((await deposer(app, jeton, 'RIB', [jpeg()], { a_verifier: '1' })).status, 200);
    assert.equal((await deposer(app, jeton, 'JDOM', [jpeg()])).status, 200);
    const drapeaux = Object.fromEntries(app.db.prepare('SELECT abrev, a_verifier FROM pieces').all().map((p) => [p.abrev, p.a_verifier]));
    assert.deepEqual(drapeaux, { RIB: 1, JDOM: 0 });
    assert.match(await (await app.envoyer(`/d/${jeton}`)).text(), /Photo peu lisible envoyée quand même/);
    // Remplacer la pièce par une photo lisible retire le drapeau.
    await deposer(app, jeton, 'RIB', [jpeg()]);
    assert.equal(app.db.prepare("SELECT a_verifier FROM pieces WHERE abrev = 'RIB'").get().a_verifier, 0);
  } finally { await app.fermer(); }
});

test('une pièce dont le PDF dépasserait le plafond (3,5 Mo) est refusée sans rien enregistrer', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app, ['CV']);
    const lourde = jpeg({ octets: 1.3 * 1024 * 1024 });
    const r = await deposer(app, jeton, 'CV', [lourde, lourde, lourde]);
    assert.equal(r.status, 413);
    assert.match((await r.json()).erreur, /trop lourde \(plus de 3,5 Mo\)/);
    assert.equal(app.stockage.lister().length, 0);
    assert.equal((await deposer(app, jeton, 'CV', [lourde, lourde])).status, 200, '2,6 Mo : accepté');
  } finally { await app.fermer(); }
});

test('un PDF transformé en images vaut la pièce entière, dans la limite de 10 pages', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app, ['CNI_PASS', 'RIB']);
    const petite = jpeg({ octets: 100 });
    assert.equal((await deposer(app, jeton, 'CNI_PASS', [petite], { choix: 'CNI', source: 'pdf' })).status, 200, 'scan recto-verso sur une page');
    assert.equal((await deposer(app, jeton, 'RIB', Array(11).fill(petite), { source: 'pdf' })).status, 400);
    assert.equal((await deposer(app, jeton, 'RIB', [petite, petite], { source: 'pdf' })).status, 200);
  } finally { await app.fermer(); }
});

test('les PDF de la demande : un par pièce, bien nommés, avec les mentions « à vérifier » et « contrôle seulement »', async () => {
  const app = await demarrer();
  try {
    const { jeton, demande } = await demandeFictive(app, ['CV', 'CNI_PASS', 'B3']);
    await deposer(app, jeton, 'CV', [jpeg({ marque: 'CV-P1' }), jpeg({ marque: 'CV-P2' })]);
    await deposer(app, jeton, 'CNI_PASS', [jpeg({ marque: 'PASSEPORT' })], { choix: 'PASS', a_verifier: '1' });
    await deposer(app, jeton, 'B3', [jpeg({ marque: 'CASIER' })]);
    const depot = creerDepot({
      db: app.db, catalogue: chargerCatalogue('config'), stockage: app.stockage, controles: chargerControles('config'),
    });
    const pdfs = depot.pdfs(demande);
    assert.deepEqual(pdfs.map((p) => [p.nom, p.aVerifier, p.controleSeulement]), [
      ['ZZ_TEST_LE_GALL-CV.pdf', false, false],
      ['ZZ_TEST_LE_GALL-PASS.pdf', true, false],
      ['ZZ_TEST_LE_GALL-B3.pdf', false, true],
    ]);
    const cv = verifierStructure(pdfs[0].contenu);
    assert.match(cv, /\/Count 2/);
    assert.ok(cv.indexOf('CV-P1') < cv.indexOf('CV-P2'));
    assert.ok(pdfs.every((p) => p.contenu.length < 3.5 * 1024 * 1024));
    // Fabriqués en mémoire : aucun fichier en clair n'apparaît sur le disque.
    assert.equal(app.stockage.lister().length, 4);
    for (const f of fs.readdirSync(app.stockage.dossier)) {
      assert.ok(!fs.readFileSync(path.join(app.stockage.dossier, f)).toString('latin1').includes('%PDF'));
    }
  } finally { await app.fermer(); }
});

// ── Page de dépôt et bibliothèques ────────────────────────────────

test('seule la page de dépôt autorise WebAssembly et les workers ; elle reçoit seuils et messages', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demandeFictive(app, ['RIB']);
    const r = await app.envoyer(`/d/${jeton}`);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(csp, /worker-src 'self'/);
    // Défaut vu le 17/10/2026 : sans font-src, les polices de pdf.js étaient bloquées et la préparation du PDF restait figée.
    assert.match(csp, /font-src 'self'/);
    assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'|https?:/, 'ni script en ligne, ni eval, ni site tiers');
    const page = await r.text();
    const brut = page.match(/data-controles="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const reglages = JSON.parse(brut);
    assert.equal(reglages.lisibilite.nettete_min, chargerControles('config').lisibilite.nettete_min);
    assert.match(reglages.messages.floue, /floue/);
    assert.match(page, /class="cadre-guide"/);

    const accueil = await app.envoyer('/connexion');
    assert.doesNotMatch(accueil.headers.get('content-security-policy'), /wasm|worker/);
  } finally { await app.fermer(); }
});

test('les bibliothèques sont servies par l\'application, intactes, avec le bon type ; rien d\'autre n\'est servi', async () => {
  const empreintes = JSON.parse(fs.readFileSync('public/vendor/EMPREINTES.json', 'utf8'));
  for (const [fichier, attendu] of Object.entries(empreintes.fichiers)) {
    const reel = crypto.createHash('sha256').update(fs.readFileSync(path.join('public/vendor', fichier))).digest('hex');
    assert.equal(reel, attendu, `${fichier} a été modifié`);
  }
  assert.ok(!Object.keys(empreintes.fichiers).some((f) => /quickjs|sandbox/.test(f)), 'aucun moteur d\'exécution des scripts de PDF');

  const app = await demarrer();
  try {
    const types = {
      '/vendor/pdfjs/pdf.min.mjs': 'text/javascript; charset=utf-8',
      '/vendor/pdfjs/pdf.worker.min.mjs': 'text/javascript; charset=utf-8',
      '/vendor/pdfjs/wasm/openjpeg.wasm': 'application/wasm',
      '/vendor/libheif/libheif-bundle.mjs': 'text/javascript; charset=utf-8',
    };
    for (const [chemin, type] of Object.entries(types)) {
      const r = await app.envoyer(chemin);
      assert.equal(r.status, 200, chemin);
      assert.equal(r.headers.get('content-type'), type);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      await r.arrayBuffer();
    }
    for (const chemin of ['/vendor/pdfjs/LICENSE', '/vendor/EMPREINTES.json', '/vendor/pdfjs/../../src/app.js', '/vendor/pdfjs/%2e%2e/x.mjs', '/vendor/autre/x.mjs', '/vendor/pdfjs/absent.mjs']) {
      const r = await app.envoyer(chemin);
      assert.equal(r.status, 404, chemin);
      await r.text();
    }
  } finally { await app.fermer(); }
});
