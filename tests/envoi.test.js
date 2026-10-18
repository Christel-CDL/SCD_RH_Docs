// Étape 5 (revue le 18/10/2026) : dossier complet annoncé par e-mail SANS pièce jointe (Brevo conservait les pièces
// jointes), téléchargement par la personne qui a fait la demande, effacement, nouvelles tentatives, purges, expiration.
// Données entièrement fictives ; n8n est remplacé par une boîte aux lettres en mémoire (tests/aide.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { creerCompteur, jourParis } from '../src/compteur.js';
import { creerEmails } from '../src/emails.js';
import { chargerCatalogue, chargerTextes } from '../src/catalogue.js';
import { ouvrirBase } from '../src/db.js';
import { demarrer, seConnecter, poster, lienDans, ASSISTANTE, ADMIN } from './aide.js';

function jpeg(marque = 'PIXELS-FICTIFS', octets = 200) {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(1600, 5);
  sof.writeUInt16BE(1200, 7);
  const donnees = Buffer.alloc(Math.max(octets, marque.length), 0x20);
  donnees.write(marque, 'latin1');
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0, 2]), donnees, Buffer.from([0xff, 0xd9])]);
}

function deposer(app, jeton, abrev, fichiers, champs = {}) {
  const donnees = new FormData();
  for (const [k, v] of Object.entries(champs)) donnees.append(k, v);
  fichiers.forEach((f, i) => donnees.append('fichier', new Blob([f]), `page-${i + 1}.jpg`));
  return fetch(`${app.base}/d/${jeton}/pieces/${abrev}`, { method: 'POST', body: donnees, headers: { Origin: app.base, Accept: 'application/json' } });
}

// Demande fictive (CV, CNI_PASS → passeport « à vérifier », B3 « contrôle seulement »). envoyer : le salarié envoie le dossier.
async function dossier(app, { pieces = ['CV', 'CNI_PASS', 'B3'], envoyer = true } = {}) {
  const { cookie } = await seConnecter(app);
  await poster(app, cookie, '/demandes', { type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST Le Gall', email: 'zz-test-salarie@exemple.test', pieces });
  const jeton = lienDans(app.boite.at(-1).donnees.texte).split('/d/')[1];
  if (pieces.includes('CV')) await deposer(app, jeton, 'CV', [jpeg('CV-P1'), jpeg('CV-P2')]);
  if (pieces.includes('CNI_PASS')) await deposer(app, jeton, 'CNI_PASS', [jpeg('PASSEPORT')], { choix: 'PASS', a_verifier: '1' });
  if (pieces.includes('B3')) await deposer(app, jeton, 'B3', [jpeg('CASIER')]);
  if (envoyer) {
    assert.equal((await app.envoyer(`/d/${jeton}/envoyer`, { methode: 'POST', formulaire: {} })).status, 303);
    // L'e-mail part en arrière-plan : on attend qu'il soit confié à n8n (ou mis en attente).
    for (let i = 0; i < 50 && !app.db.prepare("SELECT 1 FROM envois WHERE statut <> 'a_notifier' OR tentatives > 0").get(); i += 1) {
      await new Promise((ok) => setTimeout(ok, 10));
    }
  }
  return { jeton, cookie, demande: app.db.prepare('SELECT * FROM demandes').get() };
}

const emailsDe = (app, categorie) => app.boite.filter((m) => m.donnees.categorie === categorie).map((m) => m.donnees);

// ── Composition ───────────────────────────────────────────────────

test('e-mail « pièces prêtes » : objet normalisé, mentions, bouton de téléchargement, AUCUNE pièce jointe', () => {
  const emails = creerEmails({ textes: chargerTextes('config'), catalogue: chargerCatalogue('config'), config: { agence: 'Agence fictive', adminEmail: 'admin@exemple.test' } });
  const demande = { type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST Le Gall', cree_le: Date.UTC(2026, 9, 17, 10), expire_le: Date.UTC(2026, 9, 31, 22) };
  const message = emails.envoiFinal({
    demande,
    assistante: { email: 'assistante@exemple.test', nom: 'Sébastien FICTIF' },
    pieces: [
      { nom: 'ZZ_TEST_LE_GALL-PASS.pdf', libelle: 'Passeport (page photo)', aVerifier: true, controleSeulement: false },
      { nom: 'ZZ_TEST_LE_GALL-B3.pdf', libelle: 'Extrait de casier judiciaire (bulletin n°3)', aVerifier: false, controleSeulement: true },
    ],
    lien: 'https://pieces.exemple.test/demandes/ABCDEFGHIJKLMNOP/pieces',
  });
  assert.equal(message.sujet, '[Embauche] Pièces reçues – Mme ZZ TEST Le Gall – demande du 17/10/2026');
  assert.equal(message.destinataire, 'assistante@exemple.test');
  assert.match(message.texte, /^Bonjour Sébastien FICTIF,/);
  assert.match(message.texte, /Passeport \(page photo\)\n {4}À VÉRIFIER/);
  assert.match(message.texte, /bulletin n°3\)\n {4}CONTRÔLE SEULEMENT : à consulter puis supprimer, ne pas archiver/);
  assert.match(message.texte, /les pièces ne sont jamais jointes aux e-mails/);
  assert.match(message.html, /<a href="https:\/\/pieces\.exemple\.test\/demandes\/ABCDEFGHIJKLMNOP\/pieces"[^>]*>Télécharger les pièces<\/a>/);
  assert.equal(message.pieces_jointes, undefined);

  const expiration = emails.expiration({ demande, demandeur: { email: 'assistante@exemple.test', nom: 'Sébastien FICTIF' }, piecesPretes: false });
  assert.equal(expiration.sujet, '[Embauche] Lien expiré – Mme ZZ TEST Le Gall – demande du 17/10/2026');
  assert.match(expiration.texte, /a expiré sans que le dossier soit envoyé/);
  assert.match(expiration.texte, /courriers indésirables/);
  assert.match(emails.expiration({ demande, demandeur: { email: 'a@exemple.test' }, piecesPretes: true }).texte, /n'ont pas été téléchargées/);
});

// ── Parcours ──────────────────────────────────────────────────────

test('dossier complet : un e-mail sans pièce, avec le lien de téléchargement, part à la personne qui a fait la demande', async () => {
  const app = await demarrer();
  try {
    const { demande } = await dossier(app);
    const [message] = emailsDe(app, 'envoi_final');
    assert.ok(message, 'e-mail envoyé');
    assert.equal(message.destinataire, ASSISTANTE);
    assert.ok(message.texte.includes(`${app.config.appUrl}/demandes/${demande.id}/pieces`));
    const brut = JSON.stringify(message);
    assert.ok(!brut.includes('%PDF') && !brut.includes('CV-P1') && !brut.includes('zz-test-salarie'), 'ni pièce, ni e-mail du salarié');
    assert.equal(app.boite.filter((m) => m.evenement !== 'email').length, 0, 'plus aucun envoi de pièces à n8n');
    assert.equal(app.db.prepare('SELECT statut FROM envois').get().statut, 'notifie');
    assert.equal(app.stockage.lister().length, 4, 'les pièces attendent le téléchargement');
  } finally { await app.fermer(); }
});

test('téléchargement : réservé à la personne qui a fait la demande ; PDF un par un ou en ZIP', async () => {
  const app = await demarrer();
  try {
    const { cookie, demande } = await dossier(app);
    const base = `/demandes/${demande.id}/pieces`;
    const page = await (await app.envoyer(base, { cookie })).text();
    assert.match(page, /Pièces de Mme ZZ TEST Le Gall/);
    assert.match(page, /À vérifier/);
    assert.match(page, /Contrôle seulement/);
    assert.match(page, /tout\.zip/);
    assert.match(await (await app.envoyer('/', { cookie })).text(), new RegExp(`href="${base}">Télécharger les pièces`));

    // Une autre personne, même administratrice, n'y a pas accès.
    const admin = await seConnecter(app, ADMIN);
    assert.equal((await app.envoyer(base, { cookie: admin.cookie })).status, 404);
    assert.equal((await app.envoyer(`${base}/CV.pdf`, { cookie: admin.cookie })).status, 404);
    // Sans session : renvoi vers la connexion.
    assert.equal((await app.envoyer(`${base}/CV.pdf`)).status, 303);

    const pdf = await app.envoyer(`${base}/CV.pdf`, { cookie });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('cache-control'), 'no-store');
    assert.match(pdf.headers.get('content-disposition'), /filename="ZZ_TEST_LE_GALL-CV\.pdf"/);
    const texte = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    assert.ok(texte.startsWith('%PDF-1.4') && texte.indexOf('CV-P1') < texte.indexOf('CV-P2'));
    assert.ok(app.db.prepare('SELECT telecharge_le FROM envois').get().telecharge_le, 'premier téléchargement noté');

    const zip = await app.envoyer(`${base}/tout.zip`, { cookie });
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.match(zip.headers.get('content-disposition'), /filename="ZZ_TEST_LE_GALL-pieces\.zip"/);
    const octets = Buffer.from(await zip.arrayBuffer());
    assert.equal(octets.readUInt32LE(0), 0x04034b50, 'signature ZIP');
    const contenu = octets.toString('latin1');
    for (const nom of ['ZZ_TEST_LE_GALL-CV.pdf', 'ZZ_TEST_LE_GALL-PASS.pdf', 'ZZ_TEST_LE_GALL-B3.pdf']) assert.ok(contenu.includes(nom), nom);
    assert.equal((await app.envoyer(`${base}/RIB.pdf`, { cookie })).status, 404, 'pièce absente de la demande');
  } finally { await app.fermer(); }
});

test('« J\'ai enregistré les pièces » : tout est effacé (fichiers, pièces, lien et e-mail du salarié)', async () => {
  const app = await demarrer();
  try {
    const { cookie, jeton, demande } = await dossier(app);
    const r = await poster(app, cookie, `/demandes/${demande.id}/pieces/effacer`, {});
    assert.match(r.headers.get('location'), /ok=pieces_effacees$/);
    assert.equal(fs.readdirSync(app.stockage.dossier).length, 0, 'aucun fichier sur le disque');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM pieces').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
    const apres = app.db.prepare('SELECT * FROM demandes').get();
    assert.equal(apres.statut, 'transmise');
    assert.equal(apres.jeton_empreinte, null);
    assert.equal(apres.email_salarie, '');
    assert.equal((await app.envoyer(`/d/${jeton}`)).status, 410, 'le lien du salarié ne mène plus à rien');
    assert.equal((await app.envoyer(`/demandes/${demande.id}/pieces/CV.pdf`, { cookie })).status, 404);
    assert.match(await (await app.envoyer(`/demandes/${demande.id}/pieces`, { cookie })).text(), /supprimées de l&#39;outil le/);
    const journal = JSON.stringify(app.db.prepare('SELECT * FROM journal').all());
    assert.match(journal, /pieces_effacees_apres_confirmation/);
    assert.ok(!journal.includes('Le Gall') && !journal.includes('zz-test-salarie'));
  } finally { await app.fermer(); }
});

test('sans confirmation, les pièces sont effacées 24 h après le premier téléchargement', async () => {
  const app = await demarrer();
  try {
    const { cookie, demande } = await dossier(app);
    await app.envoi.tic();
    assert.equal(app.stockage.lister().length, 4, 'pas avant un téléchargement');
    await (await app.envoyer(`/demandes/${demande.id}/pieces/CV.pdf`, { cookie })).arrayBuffer();
    await app.envoi.tic();
    assert.equal(app.stockage.lister().length, 4, 'pas avant 24 h');
    app.db.prepare('UPDATE envois SET telecharge_le = ?').run(Date.now() - 25 * 3600e3);
    await app.envoi.tic();
    assert.equal(app.stockage.lister().length, 0);
    assert.equal(app.db.prepare('SELECT statut FROM demandes').get().statut, 'transmise');
    assert.match(JSON.stringify(app.db.prepare('SELECT action FROM journal').all()), /pieces_effacees_24h_apres_telechargement/);
  } finally { await app.fermer(); }
});

test('n8n injoignable : nouvelles tentatives espacées, alerte, relance manuelle ; les pièces restent téléchargeables', async () => {
  const app = await demarrer();
  try {
    app.n8n.enPanne = true;
    const { cookie, demande } = await dossier(app);
    let envoi = app.db.prepare('SELECT * FROM envois').get();
    assert.equal(envoi.statut, 'a_notifier');
    assert.equal(envoi.tentatives, 1);
    const delai = envoi.prochaine_tentative - Date.now();
    assert.ok(delai > 14 * 60e3 && delai <= 15 * 60e3, 'première nouvelle tentative dans 15 minutes');
    for (let i = 0; i < 3; i += 1) {
      app.db.prepare('UPDATE envois SET prochaine_tentative = 0').run();
      await app.envoi.tic();
    }
    envoi = app.db.prepare('SELECT * FROM envois').get();
    assert.equal(envoi.statut, 'echec');
    const [alerte] = emailsDe(app, 'alerte');
    assert.equal(alerte.destinataire, ADMIN);
    assert.ok(!JSON.stringify(alerte).includes('Le Gall'), 'aucun nom de salarié dans l\'alerte');
    assert.equal((await app.envoyer(`/demandes/${demande.id}/pieces/CV.pdf`, { cookie })).status, 200, 'toujours téléchargeable');

    const admin = await seConnecter(app, ADMIN);
    assert.match(await (await app.envoyer('/admin/utilisateurs', { cookie: admin.cookie })).text(), /Relancer l'envoi/);
    app.n8n.enPanne = false;
    const r = await poster(app, admin.cookie, `/admin/envois/${envoi.id}/relancer`, {});
    assert.match(r.headers.get('location'), /ok=relance$/);
    assert.equal(app.db.prepare('SELECT statut FROM envois').get().statut, 'notifie');
    assert.equal(emailsDe(app, 'envoi_final').length, 1);
  } finally { await app.fermer(); }
});

test('dossier complet resté sans envoi (arrêt de l\'application au mauvais moment) : rattrapé à la minute suivante', async () => {
  const app = await demarrer();
  try {
    await dossier(app);
    app.db.prepare('DELETE FROM envois').run();
    const avant = emailsDe(app, 'envoi_final').length;
    await app.envoi.tic();
    assert.equal(emailsDe(app, 'envoi_final').length, avant, 'pas avant une minute (le clic est peut-être en cours)');
    app.db.prepare('UPDATE demandes SET complete_le = ?').run(Date.now() - 2 * 60e3);
    await app.envoi.tic();
    assert.equal(emailsDe(app, 'envoi_final').length, avant + 1);
  } finally { await app.fermer(); }
});

test('journal Brevo non effacé par n8n : noté dans le journal d\'activité', async () => {
  const app = await demarrer();
  try {
    app.n8n.reponse = { ok: true, journal_efface: false };
    await dossier(app);
    assert.match(JSON.stringify(app.db.prepare('SELECT action FROM journal').all()), /journal_brevo_non_efface/);
  } finally { await app.fermer(); }
});

// ── Purges et expiration ──────────────────────────────────────────

test('expiration sans dossier envoyé : tout est effacé et la personne qui a fait la demande est prévenue', async () => {
  const app = await demarrer();
  try {
    await dossier(app, { envoyer: false });
    assert.equal(app.stockage.lister().length, 4);
    assert.deepEqual(app.purge.purger(), { demandes: 0, orphelins: 0 }, 'rien avant l\'échéance');
    app.db.prepare('UPDATE demandes SET expire_le = ?').run(Date.now() - 1);
    assert.deepEqual(app.purge.purger(), { demandes: 1, orphelins: 0 });
    for (const table of ['demandes', 'pieces', 'pages', 'envois']) {
      assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(fs.readdirSync(app.stockage.dossier).length, 0);
    await new Promise((ok) => setImmediate(ok));
    const [message] = emailsDe(app, 'expiration');
    assert.equal(message.destinataire, ASSISTANTE);
    assert.match(message.sujet, /^\[Embauche\] Lien expiré – Mme ZZ TEST Le Gall/);
    assert.match(message.texte, /a expiré sans que le dossier soit envoyé/);
  } finally { await app.fermer(); }
});

test('expiration d\'un dossier complet jamais téléchargé : e-mail adapté ; pièces déjà récupérées : aucun e-mail', async () => {
  const app = await demarrer();
  try {
    await dossier(app);
    app.db.prepare('UPDATE demandes SET expire_le = ?').run(Date.now() - 1);
    app.purge.purger();
    await new Promise((ok) => setImmediate(ok));
    assert.match(emailsDe(app, 'expiration')[0].texte, /n'ont pas été téléchargées dans le délai de 15 jours/);
  } finally { await app.fermer(); }

  const app2 = await demarrer();
  try {
    const { cookie, demande } = await dossier(app2);
    await poster(app2, cookie, `/demandes/${demande.id}/pieces/effacer`, {});
    app2.db.prepare('UPDATE demandes SET expire_le = ?').run(Date.now() - 1);
    app2.purge.purger();
    await new Promise((ok) => setImmediate(ok));
    assert.equal(emailsDe(app2, 'expiration').length, 0);
    assert.equal(app2.db.prepare('SELECT COUNT(*) AS n FROM demandes').get().n, 0);
  } finally { await app2.fermer(); }
});

test('purge des fichiers orphelins : seulement ceux de plus d\'une heure', async () => {
  const app = await demarrer();
  try {
    const vieux = app.stockage.ecrire(Buffer.from('ORPHELIN-FICTIF'));
    const recent = app.stockage.ecrire(Buffer.from('ECRITURE-EN-COURS'));
    const tmp = path.join(app.stockage.dossier, 'abc.bin.1234.tmp');
    fs.writeFileSync(tmp, 'interrompu');
    const ilYaDeuxHeures = (Date.now() - 2 * 3600e3) / 1000;
    fs.utimesSync(path.join(app.stockage.dossier, `${vieux}.bin`), ilYaDeuxHeures, ilYaDeuxHeures);
    fs.utimesSync(tmp, ilYaDeuxHeures, ilYaDeuxHeures);
    assert.deepEqual(app.purge.purger(), { demandes: 0, orphelins: 2 });
    assert.deepEqual(app.stockage.lister(), [recent]);
  } finally { await app.fermer(); }
});

// ── Compteur d'e-mails (Brevo partagé) ────────────────────────────

test('compteur : chaque e-mail parti est compté ; alerte unique à 80 % de la part du jour', async () => {
  const dossierTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-compteur-'));
  const db = ouvrirBase(dossierTemp);
  try {
    const recus = [];
    const compteur = creerCompteur({
      db,
      notificateur: { envoyer: async (evenement, donnees) => { recus.push({ evenement, donnees }); return { ok: true }; } },
      reglagesEnvoi: { quotaJournalier: 10, alerteQuotaPourcent: 80 },
      alerte: ({ titre }) => ({ categorie: 'alerte', destinataire: 'admin@exemple.test', sujet: titre }),
    });
    for (let i = 0; i < 8; i += 1) await compteur.envoyer('email', { categorie: 'invitation' }); // 8 = 80 %
    await new Promise((ok) => setImmediate(ok));
    assert.equal(recus.filter((r) => r.donnees.categorie === 'alerte').length, 1);
    assert.equal(compteur.aujourdhui(), 9, '8 e-mails + l\'alerte elle-même');
    await compteur.envoyer('email', { categorie: 'invitation' });
    await new Promise((ok) => setImmediate(ok));
    assert.equal(recus.filter((r) => r.donnees.categorie === 'alerte').length, 1, 'une seule alerte par jour');
    assert.match(jourParis(Date.UTC(2026, 9, 17, 23, 30)), /^2026-10-18$/, 'jour à l\'heure de Paris');

    // Un échec de n8n n'est pas compté.
    const enPanne = creerCompteur({ db, notificateur: { envoyer: async () => { throw new Error('panne'); } }, reglagesEnvoi: { quotaJournalier: 10, alerteQuotaPourcent: 80 }, alerte: () => ({}) });
    await assert.rejects(enPanne.envoyer('email', {}));
    assert.equal(compteur.aujourdhui(), 10);
  } finally {
    db.close();
    fs.rmSync(dossierTemp, { recursive: true, force: true });
  }
});

// ── Version mise en forme des e-mails (bouton) ────────────────────

test('e-mails en double format : bouton cliquable, lien en clair en secours, texte échappé', async () => {
  const { versHtml } = await import('../src/emails.js');
  const emails = creerEmails({ textes: chargerTextes('config'), catalogue: chargerCatalogue('config'), config: { agence: 'Agence fictive', adminEmail: 'admin@exemple.test', dureeLienConnexionMs: 15 * 60e3 } });
  const lien = 'https://pieces.exemple.test/connexion/lien?jeton=JETON_FICTIF_123';
  const connexion = emails.lienConnexion({ utilisateur: { email: 'a@exemple.test' }, lien });
  assert.ok(connexion.texte.includes(lien), 'la version texte garde le lien');
  const bouton = connexion.html.match(/<a href="([^"]+)"[^>]*>Me connecter<\/a>/);
  assert.ok(bouton, 'un bouton « Me connecter »');
  assert.equal(bouton[1], lien);
  assert.match(connexion.html, /Si le bouton ne fonctionne pas, copiez ce lien/);
  assert.equal(connexion.html.split(lien).length - 1, 3, 'bouton + lien de secours (adresse et texte affiché)');

  const invitation = emails.invitation({
    demande: { type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST', email_salarie: 'zz@exemple.test', date_limite: Date.UTC(2026, 9, 31, 17) },
    abrevs: ['CV', 'RIB'],
    assistante: { email: 'assistante@exemple.test', nom: 'Personne Fictive' },
    lien: 'https://pieces.exemple.test/d/LIEN_FICTIF',
  });
  assert.match(invitation.html, /<a href="https:\/\/pieces\.exemple\.test\/d\/LIEN_FICTIF"[^>]*>Déposer mes documents<\/a>/);
  assert.match(invitation.texte, /Personne Fictive, de l'agence Agence fictive, vous demande/);
  assert.doesNotMatch(invitation.texte, /assistante/i);

  const alerte = emails.alerte({ titre: 'essai', detail: 'détail fictif' });
  assert.ok(alerte.html.includes('détail fictif') && !alerte.html.includes('<a '));

  // Tout est échappé : un texte piégé ne devient jamais du HTML actif.
  const piege = versHtml('Bonjour <script>alert(1)</script> & "x"\nhttps://e.test/?a=1&b=<2>', { lien: 'https://e.test/?a=1&b=<2>', bouton: '<b>Go</b>', secours: 'secours' });
  assert.ok(!/<script|<b>/.test(piege));
  assert.match(piege, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
  assert.match(piege, /href="https:\/\/e\.test\/\?a=1&amp;b=&lt;2&gt;"/);
});
