// Relance automatique du salarié à J+7 avec le même lien (demande de M. Domingo, 18/10/2026). Données fictives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { demarrer, seConnecter, poster, lienDans, ASSISTANTE } from './aide.js';

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
  await poster(app, cookie, '/demandes', { type: 'mise_a_jour', civilite: 'M.', nom: 'ZZ TEST Relance', email: 'zz-test-salarie@exemple.test', pieces: ['RIB', 'JDOM'] });
  const lien = lienDans(app.boite.at(-1).donnees.texte);
  return { lien, jeton: lien.split('/d/')[1] };
}
const relances = (app) => app.boite.filter((m) => m.donnees.categorie === 'relance_salarie').map((m) => m.donnees);
const vieillir = (app, jours) => app.db.prepare('UPDATE demandes SET cree_le = cree_le - ?').run(jours * JOUR);

test('relance à J+7 : une seule, au salarié, avec le même lien et la liste des pièces manquantes', async () => {
  const app = await demarrer();
  try {
    const { lien, jeton } = await demande(app);
    await deposer(app, jeton, 'RIB');
    assert.equal(await app.relances.relancer(), 0);
    vieillir(app, 6);
    assert.equal(await app.relances.relancer(), 0, 'pas avant 7 jours');
    vieillir(app, 1);
    assert.equal(await app.relances.relancer(), 1);
    const [message] = relances(app);
    assert.equal(message.destinataire, 'zz-test-salarie@exemple.test');
    assert.equal(message.repondre_a, ASSISTANTE);
    assert.ok(message.texte.includes(lien), 'le même lien que l\'invitation');
    assert.match(message.html, /Déposer mes documents<\/a>/);
    assert.match(message.texte, /Il manque encore :\n\n {2}• Justificatif de domicile de moins de 3 mois\n/);
    assert.doesNotMatch(message.texte, /Relevé d'identité bancaire/, 'pièce déjà déposée');
    assert.doesNotMatch(message.sujet + message.texte, / h \d\d|à 18 h/, 'date limite sans l\'heure');
    assert.equal((await app.envoyer(`/d/${jeton}`)).status, 200, 'le lien reste valable');
    assert.equal(await app.relances.relancer(), 0, 'une seule relance');
    const journal = JSON.stringify(app.db.prepare('SELECT * FROM journal').all());
    assert.match(journal, /relance_salarie/);
    assert.ok(!journal.includes('ZZ TEST Relance'));
  } finally { await app.fermer(); }
});

test('pas de relance si le dossier est envoyé ou la date limite passée ; lien chiffré effacé à l\'envoi', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demande(app);
    const stocke = app.db.prepare('SELECT jeton_chiffre FROM demandes').get().jeton_chiffre;
    assert.ok(stocke && !Buffer.from(stocke, 'base64').toString('latin1').includes(jeton), 'gardé chiffré, jamais en clair');
    await deposer(app, jeton, 'RIB');
    await deposer(app, jeton, 'JDOM');
    await app.envoyer(`/d/${jeton}/envoyer`, { methode: 'POST', formulaire: {} });
    assert.equal(app.db.prepare('SELECT jeton_chiffre FROM demandes').get().jeton_chiffre, null, 'effacé dès l\'envoi du dossier');
    vieillir(app, 8);
    assert.equal(await app.relances.relancer(), 0);
  } finally { await app.fermer(); }

  const app2 = await demarrer();
  try {
    await demande(app2);
    vieillir(app2, 8);
    app2.db.prepare('UPDATE demandes SET date_limite = ?').run(Date.now() - 1);
    assert.equal(await app2.relances.relancer(), 0, 'date limite dépassée');
  } finally { await app2.fermer(); }
});

test('toutes les pièces déposées mais dossier pas envoyé : la relance invite à cliquer sur « Envoyer mon dossier »', async () => {
  const app = await demarrer();
  try {
    const { jeton } = await demande(app);
    await deposer(app, jeton, 'RIB');
    await deposer(app, jeton, 'JDOM');
    vieillir(app, 7);
    await app.relances.relancer();
    assert.match(relances(app)[0].texte, /il ne reste plus qu'à ouvrir le lien et à cliquer sur « Envoyer mon dossier »/);
  } finally { await app.fermer(); }
});

test('si l\'e-mail de relance ne part pas, nouvel essai au passage suivant', async () => {
  const app = await demarrer();
  try {
    await demande(app);
    vieillir(app, 7);
    app.n8n.categoriesEnPanne.add('relance_salarie');
    assert.equal(await app.relances.relancer(), 0);
    assert.equal(app.db.prepare('SELECT relance_le FROM demandes').get().relance_le, null, 'pas notée comme faite');
    app.n8n.categoriesEnPanne.clear();
    assert.equal(await app.relances.relancer(), 1, 'réussie au passage suivant');
    assert.equal(app.db.prepare('SELECT relances FROM demandes').get().relances, 1);
  } finally { await app.fermer(); }
});

