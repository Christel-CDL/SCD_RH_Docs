// Étape 2 : administration de la liste autorisée, domaines, journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyserDomaines } from '../src/reglages.js';
import { demarrer, seConnecter, poster, attendre, ADMIN, ASSISTANTE } from './aide.js';

test('analyserDomaines nettoie la saisie et refuse un domaine invalide', () => {
  assert.deepEqual(analyserDomaines(' Exemple.fr, @autre.fr;exemple.fr '), ['exemple.fr', 'autre.fr']);
  assert.deepEqual(analyserDomaines(''), []);
  assert.equal(analyserDomaines('exemple.fr, pas un domaine'), null);
});

test('une assistante n\'a pas accès à l\'administration', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    assert.equal((await app.envoyer('/admin/utilisateurs', { cookie })).status, 403);
    assert.equal((await poster(app, cookie, '/admin/utilisateurs', { email: 'pirate@exemple.test', nom: 'Pirate' })).status, 403);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM utilisateurs WHERE email = 'pirate@exemple.test'").get().n, 0);
    assert.doesNotMatch(await (await app.envoyer('/', { cookie })).text(), /Administration/);
  } finally { await app.fermer(); }
});

test('l\'admin ajoute une adresse, qui peut ensuite se connecter', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app, ADMIN);
    const r = await poster(app, cookie, '/admin/utilisateurs', { email: 'Nouvelle@Exemple.test', nom: 'Nouvelle Assistante' });
    assert.equal(r.status, 303);
    assert.equal((await poster(app, cookie, '/admin/utilisateurs', { email: 'nouvelle@exemple.test', nom: 'Doublon' })).status, 400);
    const nouvelle = await seConnecter(app, 'nouvelle@exemple.test');
    assert.equal(nouvelle.reponse.status, 303);
  } finally { await app.fermer(); }
});

test('désactiver une adresse ferme sa session et bloque ses liens ; la réactiver rétablit l\'accès', async () => {
  const app = await demarrer();
  try {
    const assistante = await seConnecter(app);
    const admin = await seConnecter(app, ADMIN);
    const id = app.db.prepare('SELECT id FROM utilisateurs WHERE email = ?').get(ASSISTANTE).id;

    assert.equal((await poster(app, admin.cookie, `/admin/utilisateurs/${id}/desactiver`, {})).status, 303);
    assert.equal((await app.envoyer('/', { cookie: assistante.cookie })).status, 303, 'session coupée');
    const avant = app.boite.length;
    await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: ASSISTANTE } });
    await attendre();
    assert.equal(app.boite.length, avant, 'aucun lien envoyé à une adresse désactivée');

    await poster(app, admin.cookie, `/admin/utilisateurs/${id}/reactiver`, {});
    assert.equal((await seConnecter(app)).reponse.status, 303);
  } finally { await app.fermer(); }
});

test('la suppression demande confirmation et est refusée si la personne a des demandes', async () => {
  const app = await demarrer();
  try {
    const admin = await seConnecter(app, ADMIN);
    await poster(app, admin.cookie, '/admin/utilisateurs', { email: 'temporaire@exemple.test', nom: 'Compte Temporaire' });
    const id = app.db.prepare("SELECT id FROM utilisateurs WHERE email = 'temporaire@exemple.test'").get().id;

    const confirmation = await poster(app, admin.cookie, `/admin/utilisateurs/${id}/supprimer`, {});
    assert.equal(confirmation.status, 200);
    assert.match(await confirmation.text(), /Oui, supprimer/);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM utilisateurs WHERE id = ?').get(id).n, 1, 'rien n\'est supprimé sans confirmation');
    assert.equal((await poster(app, admin.cookie, `/admin/utilisateurs/${id}/supprimer`, { confirme: 'oui' })).status, 303);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM utilisateurs WHERE id = ?').get(id).n, 0);

    // Une assistante qui a des demandes ne peut pas être supprimée.
    const assistante = await seConnecter(app);
    await poster(app, assistante.cookie, '/demandes', { type: 'mise_a_jour', civilite: 'Mme', nom: 'Fictive', email: 'zz-test@exemple.test', pieces: ['RIB'] });
    const idA = app.db.prepare('SELECT id FROM utilisateurs WHERE email = ?').get(ASSISTANTE).id;
    const r = await poster(app, admin.cookie, `/admin/utilisateurs/${idA}/supprimer`, { confirme: 'oui' });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /désactivez son adresse/);
  } finally { await app.fermer(); }
});

test('l\'administratrice ne peut pas se désactiver ni se supprimer', async () => {
  const app = await demarrer();
  try {
    const admin = await seConnecter(app, ADMIN);
    const id = app.db.prepare('SELECT id FROM utilisateurs WHERE email = ?').get(ADMIN).id;
    assert.equal((await poster(app, admin.cookie, `/admin/utilisateurs/${id}/desactiver`, {})).status, 400);
    assert.equal((await app.envoyer('/', { cookie: admin.cookie })).status, 200);
  } finally { await app.fermer(); }
});

test('les domaines autorisés filtrent les ajouts et les connexions, sauf pour l\'admin', async () => {
  const app = await demarrer();
  try {
    const admin = await seConnecter(app, ADMIN);
    assert.equal((await poster(app, admin.cookie, '/admin/domaines', { domaines: 'agence.test' })).status, 303);
    assert.equal((await poster(app, admin.cookie, '/admin/utilisateurs', { email: 'x@ailleurs.test', nom: 'Hors Domaine' })).status, 400);
    assert.equal((await poster(app, admin.cookie, '/admin/utilisateurs', { email: 'y@agence.test', nom: 'Dans Le Domaine' })).status, 303);

    const avant = app.boite.length;
    await app.envoyer('/connexion', { methode: 'POST', formulaire: { email: ASSISTANTE } }); // exemple.test : hors liste
    await attendre();
    assert.equal(app.boite.length, avant);
    assert.match(await (await app.envoyer('/admin/utilisateurs', { cookie: admin.cookie })).text(), /ne peut plus se connecter/);
    assert.equal((await seConnecter(app, ADMIN)).reponse.status, 303, 'l\'admin se connecte toujours');
    assert.equal((await poster(app, admin.cookie, '/admin/domaines', { domaines: 'pas un domaine' })).status, 400);
  } finally { await app.fermer(); }
});

test('le journal liste les actions sans nom ni adresse de salarié', async () => {
  const app = await demarrer();
  try {
    const assistante = await seConnecter(app);
    await poster(app, assistante.cookie, '/demandes', { type: 'embauche', civilite: 'M.', nom: 'Confidentiel', email: 'zz-test-secret@exemple.test', pieces: ['CV'] });
    const admin = await seConnecter(app, ADMIN);
    const journal = await (await app.envoyer('/admin/journal', { cookie: admin.cookie })).text();
    assert.match(journal, /Demande créée/);
    assert.match(journal, /Invitation envoyée au salarié/);
    assert.doesNotMatch(journal, /Confidentiel/);
    assert.doesNotMatch(journal, /zz-test-secret/);
    assert.ok(!JSON.stringify(app.db.prepare('SELECT * FROM journal').all()).includes('Confidentiel'));
  } finally { await app.fermer(); }
});
