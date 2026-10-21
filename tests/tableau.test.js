// Tableau de bord de l'administration et bilan quotidien (demande de Christel du 21/10/2026). Données fictives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { demarrer, seConnecter, poster, lienDans, ADMIN } from './aide.js';
import { debutSemaine, debutJour } from '../src/tableau.js';
import { instantParis } from '../src/dates.js';

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
async function demande(app, cookie, nom) {
  await poster(app, cookie, '/demandes', { type: 'embauche', civilite: 'Mme', nom, email: 'zz-test-tableau@exemple.test', pieces: ['RIB', 'JDOM'] });
  const jeton = lienDans(app.boite.at(-1).donnees.texte).split('/d/')[1];
  const { id } = app.db.prepare('SELECT id FROM demandes ORDER BY rowid DESC LIMIT 1').get();
  return { jeton, id };
}

test('semaines et jours à l\'heure de Paris, changement d\'heure compris', () => {
  assert.equal(debutSemaine(instantParis(2026, 10, 28, 10)), instantParis(2026, 10, 26, 0), 'mercredi → lundi 26');
  assert.equal(debutSemaine(instantParis(2026, 10, 25, 23)), instantParis(2026, 10, 19, 0), 'dimanche du passage à l\'heure d\'hiver');
  assert.equal(debutSemaine(instantParis(2026, 10, 26, 0)), instantParis(2026, 10, 26, 0), 'lundi minuit');
  assert.equal(debutJour(instantParis(2026, 10, 21, 0) + 60e3), instantParis(2026, 10, 21, 0));
});

test('tableau de bord : réservé à l\'administratrice, des nombres et aucun nom de salarié', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    assert.equal((await app.envoyer('/admin/tableau-de-bord', { cookie })).status, 403);

    const a = await demande(app, cookie, 'ZZ TEST Tableau Un');
    await deposer(app, a.jeton, 'RIB');
    await deposer(app, a.jeton, 'JDOM');
    await app.envoyer(`/d/${a.jeton}/envoyer`, { methode: 'POST', formulaire: {} });
    const b = await demande(app, cookie, 'ZZ TEST Tableau Deux');
    await poster(app, cookie, `/demandes/${b.id}/relancer`, {});
    await poster(app, cookie, `/demandes/${b.id}/annuler`, { confirme: 'oui' });
    const c = await demande(app, cookie, 'ZZ TEST Tableau Trois');
    app.db.prepare('UPDATE demandes SET expire_le = ? WHERE id = ?').run(Date.now() - 1, c.id);
    app.purge.purger();

    const semaine = app.tableau.semaines().at(-1);
    assert.equal(semaine.demandes, 3);
    assert.equal(semaine.dossiers, 1);
    assert.equal(semaine.relances, 1);
    assert.equal(semaine.annulees, 1);
    assert.equal(semaine.expirees, 1);
    assert.ok(semaine.delaiJours >= 0 && semaine.delaiJours < 1);
    assert.ok(semaine.emails >= 4);
    assert.equal(app.tableau.semaines().length, 8);

    const admin = await seConnecter(app, ADMIN);
    const page = await (await app.envoyer('/admin/tableau-de-bord', { cookie: admin.cookie })).text();
    assert.match(page, /Demandes envoyées aux salariés<\/th>(?:<td>·<\/td>){7}<td>3<\/td>/);
    assert.match(page, /dossiers complets, pièces à télécharger/);
    assert.match(page, /Assistante Fictive<\/th><td>3<\/td>/, 'demandes par personne de l\'agence');
    assert.ok(!page.includes('ZZ TEST'), 'aucun nom de salarié');
    assert.ok(!page.includes('zz-test-tableau@'), 'aucune adresse de salarié');
    assert.match(await (await app.envoyer('/admin/utilisateurs', { cookie: admin.cookie })).text(), /href="\/admin\/tableau-de-bord"/);
  } finally { await app.fermer(); }
});

test('bilan quotidien : une fois par jour à l\'heure réglée, chiffres de la veille, aucun nom ; nouvel essai si l\'envoi échoue', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    await demande(app, cookie, 'ZZ TEST Bilan');
    // Ces événements datent de la veille du jour simulé.
    const aujourdhui = debutJour(Date.now());
    const [a, m, j] = new Date(aujourdhui + JOUR + 12 * 3600e3).toISOString().slice(0, 10).split('-').map(Number);
    const demain = (heure) => instantParis(a, m, j, heure);
    const bilans = () => app.boite.filter((x) => x.donnees.categorie === 'bilan').map((x) => x.donnees);

    assert.equal(await app.bilan.envoyerSiDu(demain(7)), false, 'avant 8 h');
    app.n8n.categoriesEnPanne.add('bilan');
    await assert.rejects(app.bilan.envoyerSiDu(demain(8)));
    app.n8n.categoriesEnPanne.clear();
    assert.equal(await app.bilan.envoyerSiDu(demain(8) + 600e3), true, 'nouvel essai réussi');
    assert.equal(await app.bilan.envoyerSiDu(demain(15)), false, 'une seule fois par jour');

    const [bilan] = bilans();
    assert.equal(bilan.destinataire, ADMIN);
    assert.match(bilan.sujet, /^\[Collecte de pièces\] Bilan du /);
    assert.match(bilan.texte, /Demandes envoyées aux salariés : 1/);
    assert.match(bilan.texte, /\/admin\/tableau-de-bord/);
    assert.match(bilan.html, /Ouvrir le tableau de bord<\/a>/);
    assert.ok(!(bilan.sujet + bilan.texte).includes('ZZ TEST'), 'aucun nom de salarié');

    app.db.prepare("UPDATE reglages SET valeur = '\"2000-01-01\"' WHERE cle = 'bilan_dernier_jour'").run();
    const admin = await seConnecter(app, ADMIN);
    const champs = { relance_salarie_jours: '7', quota_journalier: '150', alerte_quota_pourcent: '80', bilan_quotidien_heure: '-1', nouvelles_tentatives_minutes: '15, 60, 240' };
    await poster(app, admin.cookie, '/admin/reglages/envoi', champs);
    assert.equal(await app.bilan.envoyerSiDu(demain(9)), false, '-1 : plus de bilan');
    assert.match(JSON.stringify(app.db.prepare('SELECT action FROM journal').all()), /bilan_envoye/);
  } finally { await app.fermer(); }
});
