// Étape 6 : suivi par la personne qui a fait la demande (relancer à la main, annuler). Données fictives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demarrer, seConnecter, poster, lienDans, ADMIN } from './aide.js';

const JOUR = 24 * 3600e3;

function jpeg() {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(1600, 5);
  sof.writeUInt16BE(1200, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(200, 0x20), Buffer.from([0xff, 0xd9])]);
}
function deposer(app, jeton, abrev) {
  const donnees = new FormData();
  donnees.append('fichier', new Blob([jpeg()]), 'p.jpg');
  return fetch(`${app.base}/d/${jeton}/pieces/${abrev}`, { method: 'POST', body: donnees, headers: { Origin: app.base, Accept: 'application/json' } });
}
async function demande(app) {
  const { cookie } = await seConnecter(app);
  await poster(app, cookie, '/demandes', { type: 'mise_a_jour', civilite: 'Mme', nom: 'ZZ TEST Suivi', email: 'zz-test-suivi@exemple.test', pieces: ['RIB', 'JDOM'] });
  const lien = lienDans(app.boite.at(-1).donnees.texte);
  const { id } = app.db.prepare('SELECT id FROM demandes').get();
  return { cookie, lien, jeton: lien.split('/d/')[1], id };
}
const relances = (app) => app.boite.filter((m) => m.donnees.categorie === 'relance_salarie').map((m) => m.donnees);
const ligne = (app) => app.db.prepare('SELECT * FROM demandes').get();

test('relancer à la main : même lien, pièces manquantes, au plus une fois par 24 h', async () => {
  const app = await demarrer();
  try {
    const { cookie, lien, jeton, id } = await demande(app);
    await deposer(app, jeton, 'RIB');
    let accueil = await (await app.envoyer('/', { cookie })).text();
    assert.match(accueil, /Relancer le salarié/);
    assert.match(accueil, /Annuler la demande/);

    const reponse = await poster(app, cookie, `/demandes/${id}/relancer`, {});
    assert.equal(reponse.headers.get('location').replace(app.base, ''), '/?ok=salarie_relance');
    const [message] = relances(app);
    assert.equal(message.destinataire, 'zz-test-suivi@exemple.test');
    assert.ok(message.texte.includes(lien), 'le même lien');
    assert.match(message.texte, /Justificatif de domicile/);
    assert.doesNotMatch(message.texte, /Relevé d'identité bancaire/, 'pièce déjà déposée');
    assert.equal((await app.envoyer(`/d/${jeton}`)).status, 200, 'le lien reste valable');

    assert.equal((await poster(app, cookie, `/demandes/${id}/relancer`, {})).headers.get('location').replace(app.base, ''), '/?ok=relance_trop_tot');
    assert.equal(relances(app).length, 1, 'pas de seconde relance dans les 24 h');
    accueil = await (await app.envoyer('/', { cookie })).text();
    assert.match(accueil, /Nouvelle relance possible à partir du/);
    assert.doesNotMatch(accueil, /Relancer le salarié<\/button>/);

    // 7 jours plus tard (relance manuelle ancienne de plus de 24 h) : la relance automatique part normalement.
    app.db.prepare('UPDATE demandes SET cree_le = cree_le - ?, relance_manuelle_le = relance_manuelle_le - ?').run(7 * JOUR, 7 * JOUR);
    assert.equal(await app.relances.relancer(), 1);
    assert.equal((await poster(app, cookie, `/demandes/${id}/relancer`, {})).headers.get('location').replace(app.base, ''), '/?ok=relance_trop_tot',
      'la relance automatique compte aussi');
    assert.equal(ligne(app).relances, 2);
    const journal = JSON.stringify(app.db.prepare('SELECT * FROM journal').all());
    assert.match(journal, /relance_manuelle/);
    assert.ok(!journal.includes('ZZ TEST'));
  } finally { await app.fermer(); }
});

test('relancer à la main : refusé à une autre personne, après la date limite, ou si l\'e-mail ne part pas', async () => {
  const app = await demarrer();
  try {
    const { id } = await demande(app);
    const admin = await seConnecter(app, ADMIN);
    assert.equal((await poster(app, admin.cookie, `/demandes/${id}/relancer`, {})).headers.get('location').replace(app.base, ''), '/?ok=relance_salarie_impossible',
      'même l\'administratrice ne relance pas la demande d\'une autre personne');

    const { cookie } = await seConnecter(app);
    app.n8n.categoriesEnPanne.add('relance_salarie');
    assert.equal((await poster(app, cookie, `/demandes/${id}/relancer`, {})).headers.get('location').replace(app.base, ''), '/?ok=relance_echec');
    assert.equal(ligne(app).relance_manuelle_le, null, 'non comptée si l\'e-mail n\'est pas parti');
    assert.equal(ligne(app).relances, 0);
    app.n8n.categoriesEnPanne.clear();

    app.db.prepare('UPDATE demandes SET date_limite = ?').run(Date.now() - 1);
    assert.equal((await poster(app, cookie, `/demandes/${id}/relancer`, {})).headers.get('location').replace(app.base, ''), '/?ok=relance_salarie_impossible');
    assert.equal(relances(app).length, 0);
  } finally { await app.fermer(); }
});

test('double clic sur « Relancer » : un seul e-mail', async () => {
  const app = await demarrer();
  try {
    const { id } = await demande(app);
    const utilisateurId = ligne(app).utilisateur_id;
    const resultats = await Promise.all([app.relances.relancerALaMain(id, utilisateurId), app.relances.relancerALaMain(id, utilisateurId)]);
    assert.deepEqual(resultats.sort(), ['ok', 'trop_tot']);
    assert.equal(relances(app).length, 1);
  } finally { await app.fermer(); }
});

test('annuler : confirmation, puis pièces, fichiers, lien et e-mail du salarié supprimés ; ligne « Annulée »', async () => {
  const app = await demarrer();
  try {
    const { cookie, jeton, id } = await demande(app);
    await deposer(app, jeton, 'RIB');
    assert.ok(app.stockage.lister().length > 0);

    const confirmation = await poster(app, cookie, `/demandes/${id}/annuler`, {});
    assert.equal(confirmation.status, 200);
    assert.match(await confirmation.text(), /Oui, annuler la demande/);
    assert.equal(ligne(app).statut, 'en_cours', 'rien n\'est fait avant la confirmation');

    const reponse = await poster(app, cookie, `/demandes/${id}/annuler`, { confirme: 'oui' });
    assert.equal(reponse.headers.get('location').replace(app.base, ''), '/?ok=demande_annulee');
    const d = ligne(app);
    assert.equal(d.statut, 'annulee');
    assert.equal(d.email_salarie, '');
    assert.equal(d.jeton_chiffre, null);
    assert.ok(d.annulee_le);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM pieces').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
    assert.deepEqual(app.stockage.lister(), [], 'plus aucun fichier chiffré');
    assert.deepEqual(fs.readdirSync(app.stockage.dossier), []);

    const page = await app.envoyer(`/d/${jeton}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /annulée par l&#39;agence/);
    assert.equal((await deposer(app, jeton, 'JDOM')).status, 410, 'plus aucun dépôt');
    assert.equal(app.boite.filter((m) => m.donnees.destinataire === 'zz-test-suivi@exemple.test').length, 1, 'pas d\'e-mail au salarié');

    const accueil = await (await app.envoyer('/', { cookie })).text();
    assert.match(accueil, /Annulée le .* : pièces déposées et lien du salarié supprimés/);
    assert.doesNotMatch(accueil, /Relancer le salarié|Annuler la demande/);
    assert.equal((await poster(app, cookie, `/demandes/${id}/relancer`, {})).headers.get('location').replace(app.base, ''), '/?ok=relance_salarie_impossible');
    const journal = JSON.stringify(app.db.prepare('SELECT * FROM journal').all());
    assert.match(journal, /demande_annulee/);
    assert.ok(!journal.includes('ZZ TEST'));

    // La ligne « Annulée » disparaît elle aussi à la purge de J+15.
    app.db.prepare('UPDATE demandes SET expire_le = ?').run(Date.now() - 1);
    app.purge.purger();
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM demandes').get().n, 0);
    assert.equal(app.boite.filter((m) => m.donnees.categorie === 'expiration').length, 0, 'pas d\'e-mail d\'expiration pour une demande annulée');
  } finally { await app.fermer(); }
});

test('annuler un dossier complet : l\'envoi en attente disparaît ; une autre personne ne peut pas annuler', async () => {
  const app = await demarrer();
  try {
    const { jeton, id } = await demande(app);
    await deposer(app, jeton, 'RIB');
    await deposer(app, jeton, 'JDOM');
    await app.envoyer(`/d/${jeton}/envoyer`, { methode: 'POST', formulaire: {} });
    assert.equal(ligne(app).statut, 'complete');

    const admin = await seConnecter(app, ADMIN);
    assert.equal((await poster(app, admin.cookie, `/demandes/${id}/annuler`, { confirme: 'oui' })).status, 404);
    assert.equal(ligne(app).statut, 'complete');

    const { cookie } = await seConnecter(app);
    await poster(app, cookie, `/demandes/${id}/annuler`, { confirme: 'oui' });
    assert.equal(ligne(app).statut, 'annulee');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM envois').get().n, 0);
    assert.deepEqual(app.stockage.lister(), []);
    assert.equal((await app.envoyer(`/demandes/${id}/pieces/tout.zip`, { cookie })).status, 404, 'plus rien à télécharger');
  } finally { await app.fermer(); }
});
