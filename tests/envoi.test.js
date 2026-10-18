// Étape 5 : envoi final à l'assistante par n8n (simulé), port interne, confirmations, nouvelles tentatives, purges.
// Données entièrement fictives ; n8n est remplacé par une boîte aux lettres en mémoire (tests/aide.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planifier } from '../src/envoi.js';
import { creerCompteur, jourParis } from '../src/compteur.js';
import { creerEmails } from '../src/emails.js';
import { chargerCatalogue, chargerTextes } from '../src/catalogue.js';
import { ouvrirBase } from '../src/db.js';
import { demarrer, seConnecter, poster, lienDans, ASSISTANTE, ADMIN, SECRET_INTERNE } from './aide.js';

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

// Demande fictive complète (CV, CNI_PASS → passeport « à vérifier », B3 « contrôle seulement »), dossier envoyé par le salarié.
async function dossierEnvoye(app, { pieces = ['CV', 'CNI_PASS', 'B3'] } = {}) {
  const { cookie } = await seConnecter(app);
  await poster(app, cookie, '/demandes', { type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST Le Gall', email: 'zz-test-salarie@exemple.test', pieces });
  const lien = lienDans(app.boite.at(-1).donnees.texte);
  const jeton = lien.split('/d/')[1];
  if (pieces.includes('CV')) await deposer(app, jeton, 'CV', [jpeg('CV-P1'), jpeg('CV-P2')]);
  if (pieces.includes('CNI_PASS')) await deposer(app, jeton, 'CNI_PASS', [jpeg('PASSEPORT')], { choix: 'PASS', a_verifier: '1' });
  if (pieces.includes('B3')) await deposer(app, jeton, 'B3', [jpeg('CASIER')]);
  if (pieces.includes('RIB')) await deposer(app, jeton, 'RIB', [jpeg('RIB')]);
  const r = await app.envoyer(`/d/${jeton}/envoyer`, { methode: 'POST', formulaire: {} });
  assert.equal(r.status, 303);
  // L'envoi part en arrière-plan : on attend qu'il soit confié à n8n (ou mis en attente).
  for (let i = 0; i < 50 && !app.db.prepare("SELECT 1 FROM envois WHERE statut <> 'a_notifier' OR tentatives > 0").get(); i += 1) {
    await new Promise((ok) => setTimeout(ok, 10));
  }
  return { jeton, cookie, demande: app.db.prepare('SELECT * FROM demandes').get() };
}

const interne = (app, chemin, { methode = 'GET', secret = SECRET_INTERNE, corps } = {}) => fetch(`${app.config.internalUrl}${chemin}`, {
  method: methode,
  headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(corps ? { 'Content-Type': 'application/json' } : {}) },
  body: corps ? JSON.stringify(corps) : undefined,
});
const dernierEnvoi = (app) => app.boite.filter((m) => m.evenement === 'envoi_dossier').at(-1)?.donnees;
const alertes = (app) => app.boite.filter((m) => m.donnees.categorie === 'alerte').map((m) => m.donnees);

// ── Plan et composition ───────────────────────────────────────────

test('découpage : les pièces sont regroupées dans l\'ordre tant que le total reste sous le seuil', () => {
  const pdf = (abrev, mo) => ({ abrev, contenu: { length: mo * 1024 * 1024 } });
  const seuil = 15 * 1024 * 1024;
  assert.deepEqual(planifier([pdf('CV', 2), pdf('CNI', 1), pdf('RIB', 1)], seuil), [['CV', 'CNI', 'RIB']]);
  assert.deepEqual(planifier([pdf('A', 3.4), pdf('B', 3.4), pdf('C', 3.4), pdf('D', 3.4), pdf('E', 3.4), pdf('F', 1)], seuil),
    [['A', 'B', 'C', 'D'], ['E', 'F']]);
  assert.deepEqual(planifier([], seuil), []);
});

test('e-mail final : objet normalisé, mentions « à vérifier » et « contrôle seulement », numérotation (1/2)', () => {
  const emails = creerEmails({ textes: chargerTextes('config'), catalogue: chargerCatalogue('config'), config: { agence: 'Agence fictive', adminEmail: 'admin@exemple.test' } });
  const demande = { type: 'embauche', civilite: 'Mme', nom: 'ZZ TEST Le Gall', cree_le: Date.UTC(2026, 9, 17, 10) };
  const message = emails.envoiFinal({
    demande,
    assistante: { email: 'assistante@exemple.test', nom: 'Assistante Fictive' },
    pieces: [
      { nom: 'ZZ_TEST_LE_GALL-PASS.pdf', libelle: 'Passeport (page photo)', aVerifier: true, controleSeulement: false },
      { nom: 'ZZ_TEST_LE_GALL-B3.pdf', libelle: 'Extrait de casier judiciaire (bulletin n°3)', aVerifier: false, controleSeulement: true },
    ],
    numero: 1,
    total: 2,
  });
  assert.equal(message.sujet, '[Embauche] Pièces reçues – Mme ZZ TEST Le Gall – demande du 17/10/2026 (1/2)');
  assert.equal(message.destinataire, 'assistante@exemple.test');
  assert.match(message.texte, /ZZ_TEST_LE_GALL-PASS\.pdf – Passeport \(page photo\)\n {4}À VÉRIFIER/);
  assert.match(message.texte, /ZZ_TEST_LE_GALL-B3\.pdf.*\n {4}CONTRÔLE SEULEMENT : à consulter puis supprimer, ne pas archiver/);
  assert.match(message.texte, /arrivent dans un autre e-mail \(2\/2\)/);
  assert.match(message.texte, /La CNIL interdit d'en garder une copie/);
  const miseAJour = emails.envoiFinal({ demande: { ...demande, type: 'mise_a_jour' }, assistante: { email: 'a@exemple.test' }, pieces: [] });
  assert.match(miseAJour.sujet, /^\[Mise à jour\] .* demande du 17\/10\/2026$/, 'pas de numéro quand il n\'y a qu\'un e-mail');
});

// ── Parcours complet ──────────────────────────────────────────────

test('dossier complet : n8n reçoit le texte et les adresses internes des PDF, jamais les pièces elles-mêmes', async () => {
  const app = await demarrer();
  try {
    await dossierEnvoye(app);
    const evenement = dernierEnvoi(app);
    assert.ok(evenement, 'n8n a été prévenu');
    assert.equal(evenement.messages.length, 1);
    const [message] = evenement.messages;
    assert.equal(message.destinataire, ASSISTANTE);
    assert.match(message.sujet, /^\[Embauche\] Pièces reçues – Mme ZZ TEST Le Gall – demande du \d\d\/\d\d\/\d{4}$/);
    assert.deepEqual(message.pieces_jointes.map((p) => p.nom), ['ZZ_TEST_LE_GALL-CV.pdf', 'ZZ_TEST_LE_GALL-PASS.pdf', 'ZZ_TEST_LE_GALL-B3.pdf']);
    assert.ok(message.pieces_jointes.every((p) => p.url.startsWith(`${app.config.internalUrl}/interne/envois/${evenement.envoi_id}/pieces/`)));
    const brut = JSON.stringify(evenement);
    assert.ok(!brut.includes('%PDF') && !brut.includes('CV-P1') && !brut.includes('zz-test-salarie'), 'ni pièce, ni e-mail du salarié');
    assert.equal(app.db.prepare('SELECT statut FROM envois').get().statut, 'notifie');
  } finally { await app.fermer(); }
});

test('port interne : secret obligatoire, PDF servi seulement pour un envoi en cours', async () => {
  const app = await demarrer();
  try {
    await dossierEnvoye(app);
    const { envoi_id: id } = dernierEnvoi(app);
    assert.equal((await interne(app, '/interne/sante', { secret: null })).status, 401);
    assert.equal((await interne(app, '/interne/sante', { secret: 'faux' })).status, 401);
    assert.equal((await interne(app, `/interne/envois/${id}/pieces/CV`, { secret: `${SECRET_INTERNE}x` })).status, 401);
    assert.equal((await interne(app, '/interne/sante')).status, 200);

    const r = await interne(app, `/interne/envois/${id}/pieces/CV`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /filename="ZZ_TEST_LE_GALL-CV\.pdf"/);
    const pdf = Buffer.from(await r.arrayBuffer()).toString('latin1');
    assert.ok(pdf.startsWith('%PDF-1.4') && pdf.indexOf('CV-P1') < pdf.indexOf('CV-P2'));

    assert.equal((await interne(app, `/interne/envois/${id}/pieces/RIB`)).status, 404, 'pièce absente du plan');
    assert.equal((await interne(app, `/interne/envois/${'x'.repeat(32)}/pieces/CV`)).status, 404, 'envoi inconnu');
    assert.equal((await interne(app, `/interne/envois/${id}/pieces/CV`, { methode: 'POST' })).status, 405);
    // Le port public ne connaît pas ces adresses.
    assert.equal((await app.envoyer(`/interne/envois/${id}/pieces/CV`)).status, 404);
  } finally { await app.fermer(); }
});

test('après confirmation de n8n, tout est effacé : fichiers, pièces, lien et e-mail du salarié', async () => {
  const app = await demarrer();
  try {
    const { jeton, cookie } = await dossierEnvoye(app);
    const { envoi_id: id } = dernierEnvoi(app);
    assert.equal(app.stockage.lister().length, 4);

    const r = await interne(app, `/interne/envois/${id}/confirmation`, { methode: 'POST', corps: { message: 1 } });
    assert.deepEqual(await r.json(), { termine: true });

    assert.equal(app.stockage.lister().length, 0, 'aucun fichier sur le disque');
    assert.equal(fs.readdirSync(app.stockage.dossier).length, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM pieces').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
    const demande = app.db.prepare('SELECT * FROM demandes').get();
    assert.equal(demande.statut, 'transmise');
    assert.equal(demande.jeton_empreinte, null);
    assert.equal(demande.email_salarie, '');
    assert.ok(demande.transmise_le);
    assert.equal(app.db.prepare('SELECT statut FROM envois').get().statut, 'termine');

    assert.equal((await app.envoyer(`/d/${jeton}`)).status, 410, 'le lien du salarié ne mène plus à rien');
    assert.equal((await interne(app, `/interne/envois/${id}/pieces/CV`)).status, 404, 'plus rien à télécharger');
    assert.equal((await interne(app, `/interne/envois/${id}/confirmation`, { methode: 'POST', corps: { message: 1 } })).status, 404);
    assert.match(await (await app.envoyer('/', { cookie })).text(), /Pièces envoyées par e-mail le .*, puis supprimées de l'outil/);
    // Journal : jamais de nom ni d'e-mail de salarié.
    const journal = JSON.stringify(app.db.prepare('SELECT * FROM journal').all());
    assert.match(journal, /dossier_transmis_et_purge/);
    assert.ok(!journal.includes('Le Gall') && !journal.includes('zz-test-salarie'));
  } finally { await app.fermer(); }
});

test('envoi découpé : la purge attend la confirmation de chaque e-mail ; une nouvelle tentative ne renvoie que le reste', async () => {
  const app = await demarrer();
  try {
    await dossierEnvoye(app, { pieces: ['CV', 'RIB'] });
    const envoi = app.db.prepare('SELECT * FROM envois').get();
    // Plan forcé à deux e-mails (le découpage réel dépend de la taille, testée plus haut).
    app.db.prepare('UPDATE envois SET plan = ? WHERE id = ?').run(JSON.stringify([['CV'], ['RIB']]), envoi.id);

    const r = await interne(app, `/interne/envois/${envoi.id}/confirmation`, { methode: 'POST', corps: { message: 1 } });
    assert.deepEqual(await r.json(), { termine: false });
    assert.equal(app.stockage.lister().length, 3, 'rien n\'est effacé tant que tout n\'est pas parti');

    // n8n signale l'échec de l'e-mail 2 : nouvelle tentative, avec ce seul e-mail.
    assert.equal((await interne(app, `/interne/envois/${envoi.id}/echec`, { methode: 'POST', corps: { message: 2 } })).status, 200);
    assert.equal(app.db.prepare('SELECT statut, tentatives FROM envois').get().statut, 'a_notifier');
    app.db.prepare('UPDATE envois SET prochaine_tentative = 0').run();
    await app.envoi.tic();
    const relance = dernierEnvoi(app);
    assert.deepEqual(relance.messages.map((m) => [m.numero, m.sujet.slice(-6)]), [[2, ' (2/2)']]);

    await interne(app, `/interne/envois/${envoi.id}/confirmation`, { methode: 'POST', corps: { message: 2 } });
    assert.equal(app.stockage.lister().length, 0);
    assert.equal(app.db.prepare('SELECT statut FROM demandes').get().statut, 'transmise');
  } finally { await app.fermer(); }
});

test('n8n injoignable : nouvelles tentatives espacées, puis alerte à l\'administratrice et relance manuelle', async () => {
  const app = await demarrer();
  try {
    app.n8n.enPanne = true;
    await dossierEnvoye(app);
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
    assert.equal(envoi.tentatives, 4);
    const [alerte] = alertes(app);
    assert.equal(alerte.destinataire, ADMIN);
    assert.match(alerte.sujet, /n'a pas pu être envoyé/);
    assert.ok(!JSON.stringify(alerte).includes('Le Gall'), 'aucun nom de salarié dans l\'alerte');
    assert.equal(app.stockage.lister().length, 4, 'les pièces restent (chiffrées) jusqu\'à la purge à 15 jours');

    // Côté assistante et administratrice.
    const { cookie } = await seConnecter(app);
    assert.match(await (await app.envoyer('/', { cookie })).text(), /L'envoi des pièces a échoué : l'administratrice est prévenue/);
    const admin = await seConnecter(app, ADMIN);
    assert.match(await (await app.envoyer('/admin/utilisateurs', { cookie: admin.cookie })).text(), /Relancer l'envoi/);

    app.n8n.enPanne = false;
    const r = await poster(app, admin.cookie, `/admin/envois/${envoi.id}/relancer`, {});
    assert.match(r.headers.get('location'), /ok=relance$/);
    assert.equal(app.db.prepare('SELECT statut FROM envois').get().statut, 'notifie');
  } finally { await app.fermer(); }
});

test('n8n silencieux depuis 6 h : une seule alerte, sans renvoyer l\'e-mail (risque de doublon)', async () => {
  const app = await demarrer();
  try {
    await dossierEnvoye(app);
    app.db.prepare('UPDATE envois SET notifie_le = ?').run(Date.now() - 7 * 3600e3);
    const avant = app.boite.filter((m) => m.evenement === 'envoi_dossier').length;
    await app.envoi.tic();
    await app.envoi.tic();
    assert.equal(alertes(app).length, 1);
    assert.match(alertes(app)[0].sujet, /ne donne pas de nouvelles/);
    assert.equal(app.boite.filter((m) => m.evenement === 'envoi_dossier').length, avant);
  } finally { await app.fermer(); }
});

test('dossier complet resté sans envoi (arrêt de l\'application au mauvais moment) : rattrapé à la minute suivante', async () => {
  const app = await demarrer();
  try {
    await dossierEnvoye(app);
    // Simule un arrêt entre « dossier complet » et la création de l'envoi.
    app.db.prepare('DELETE FROM envois').run();
    const avant = app.boite.filter((m) => m.evenement === 'envoi_dossier').length;
    await app.envoi.tic();
    assert.equal(app.boite.filter((m) => m.evenement === 'envoi_dossier').length, avant, 'pas avant une minute (le clic est peut-être en cours)');
    app.db.prepare('UPDATE demandes SET complete_le = ?').run(Date.now() - 2 * 60e3);
    await app.envoi.tic();
    assert.equal(app.boite.filter((m) => m.evenement === 'envoi_dossier').length, avant + 1);
    assert.equal(app.db.prepare('SELECT statut FROM envois').get().statut, 'notifie');
  } finally { await app.fermer(); }
});

// ── Purges ────────────────────────────────────────────────────────

test('purge à 15 jours : la demande expirée est effacée entièrement, même si l\'envoi n\'a pas réussi', async () => {
  const app = await demarrer();
  try {
    app.n8n.enPanne = true;
    await dossierEnvoye(app);
    assert.equal(app.stockage.lister().length, 4);
    assert.deepEqual(app.purge.purger(), { demandes: 0, orphelins: 0 }, 'rien avant l\'échéance');
    app.db.prepare('UPDATE demandes SET expire_le = ?').run(Date.now() - 1);
    assert.deepEqual(app.purge.purger(), { demandes: 1, orphelins: 0 });
    for (const table of ['demandes', 'pieces', 'pages', 'envois']) {
      assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(fs.readdirSync(app.stockage.dossier).length, 0);
    assert.match(JSON.stringify(app.db.prepare('SELECT action FROM journal').all()), /purge_securite/);
  } finally { await app.fermer(); }
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
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-compteur-'));
  const db = ouvrirBase(dossier);
  try {
    const recus = [];
    const compteur = creerCompteur({
      db,
      notificateur: { envoyer: async (evenement, donnees) => { recus.push({ evenement, donnees }); } },
      reglagesEnvoi: { quotaJournalier: 10, alerteQuotaPourcent: 80 },
      alerte: ({ titre }) => ({ categorie: 'alerte', destinataire: 'admin@exemple.test', sujet: titre }),
    });
    for (let i = 0; i < 6; i += 1) await compteur.envoyer('email', { categorie: 'invitation' });
    await compteur.envoyer('envoi_dossier', { messages: [{}, {}] }); // 2 e-mails d'un coup → 8 = 80 %
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
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});
