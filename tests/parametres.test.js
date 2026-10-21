// Étape 6 : écran « Réglages » de l'administration (durées, quotas, seuils, textes). Données fictives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { demarrer, seConnecter, poster, lienDans, ADMIN } from './aide.js';
import { creerParametres, verifierTexte } from '../src/parametres.js';
import { creerReglages } from '../src/reglages.js';
import { chargerCatalogue, chargerTextes, chargerControles, chargerReglagesEnvoi } from '../src/catalogue.js';

const JOUR = 24 * 3600e3;
const sansBase = (app, reponse) => reponse.headers.get('location')?.replace(app.base, '');

test('réglages et textes : réservés à l\'administratrice', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    for (const chemin of ['/admin/reglages', '/admin/textes']) assert.equal((await app.envoyer(chemin, { cookie })).status, 403, chemin);
    assert.equal((await poster(app, cookie, '/admin/reglages/envoi', { relance_salarie_jours: '1' })).status, 403);
    assert.equal((await poster(app, cookie, '/admin/textes', { action: 'enregistrer' })).status, 403);
  } finally { await app.fermer(); }
});

test('durées : la relance suit le nouveau délai aussitôt ; valeur hors bornes refusée ; retour à l\'origine', async () => {
  const app = await demarrer();
  try {
    const admin = await seConnecter(app, ADMIN);
    let page = await (await app.envoyer('/admin/reglages', { cookie: admin.cookie })).text();
    assert.match(page, /Relance automatique du salarié/);
    assert.match(page, /value="7"/);

    const champs = { relance_salarie_jours: '3', quota_journalier: '150', alerte_quota_pourcent: '80', bilan_quotidien_heure: '8', nouvelles_tentatives_minutes: '15, 60, 240' };
    const refus = await poster(app, admin.cookie, '/admin/reglages/envoi', { ...champs, relance_salarie_jours: '20' });
    assert.equal(refus.status, 400);
    assert.match(await refus.text(), /entre 0 et 13/);
    const mauvaiseListe = await poster(app, admin.cookie, '/admin/reglages/envoi', { ...champs, nouvelles_tentatives_minutes: 'quinze' });
    assert.equal(mauvaiseListe.status, 400);

    assert.equal(sansBase(app, await poster(app, admin.cookie, '/admin/reglages/envoi', champs)), '/admin/reglages?ok=reglages#envoi');
    page = await (await app.envoyer('/admin/reglages', { cookie: admin.cookie })).text();
    assert.match(page, /modifié/);

    // Une demande vieille de 3 jours est relancée tout de suite, sans redémarrage.
    const { cookie } = await seConnecter(app);
    await poster(app, cookie, '/demandes', { type: 'mise_a_jour', civilite: 'M.', nom: 'ZZ TEST Reglage', email: 'zz-test-reglage@exemple.test', pieces: ['RIB'] });
    app.db.prepare('UPDATE demandes SET cree_le = cree_le - ?').run(3 * JOUR);
    assert.equal(await app.relances.relancer(), 1);

    assert.equal(sansBase(app, await poster(app, admin.cookie, '/admin/reglages/envoi/retablir', {})), '/admin/reglages?ok=reglages_retablis#envoi');
    page = await (await app.envoyer('/admin/reglages', { cookie: admin.cookie })).text();
    assert.match(page, /id="r-relance_salarie_jours"[^>]*value="7"/);
    const journal = JSON.stringify(app.db.prepare('SELECT action FROM journal').all());
    assert.match(journal, /reglages_envoi_modifies/);
    assert.match(journal, /reglages_envoi_retablis/);
  } finally { await app.fermer(); }
});

test('contrôle des photos : nouveau seuil transmis à la page de dépôt ; incohérence refusée', async () => {
  const app = await demarrer();
  try {
    const admin = await seConnecter(app, ADMIN);
    const page = await (await app.envoyer('/admin/reglages', { cookie: admin.cookie })).text();
    const champs = Object.fromEntries([...page.matchAll(/name="((?:lisibilite|photo|pdf)\.[a-z_]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    assert.equal(Object.keys(champs).length, 10);

    const incoherent = await poster(app, admin.cookie, '/admin/reglages/controles', { ...champs, 'lisibilite.luminosite_min': '240' });
    assert.equal(incoherent.status, 400);
    assert.match(await incoherent.text(), /« Luminosité minimale » doit être inférieure à « Luminosité maximale »/);

    assert.equal((await poster(app, admin.cookie, '/admin/reglages/controles', { ...champs, 'lisibilite.nettete_min': '40', 'photo.qualite_jpeg': '0,8' })).status, 303);
    const { cookie } = await seConnecter(app);
    await poster(app, cookie, '/demandes', { type: 'mise_a_jour', civilite: 'M.', nom: 'ZZ TEST Seuil', email: 'zz-test-seuil@exemple.test', pieces: ['RIB'] });
    const depot = await (await app.envoyer(new URL(lienDans(app.boite.at(-1).donnees.texte)).pathname)).text();
    const controles = JSON.parse(depot.match(/data-controles="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    assert.equal(controles.lisibilite.nettete_min, 40);
    assert.equal(controles.photo.qualite_jpeg, 0.8);
  } finally { await app.fermer(); }
});

test('textes : contrôle des {{ }}, aperçu sans enregistrer, enregistrement, retour au texte d\'origine', async () => {
  const app = await demarrer();
  try {
    const admin = await seConnecter(app, ADMIN);
    const page = await (await app.envoyer('/admin/textes', { cookie: admin.cookie })).text();
    assert.match(page, /Invitation du salarié/);
    assert.match(page, /Page de dépôt : mention RGPD/);
    const origine = chargerTextes('config').invitation.texte;

    const inconnu = await poster(app, admin.cookie, '/admin/textes', { action: 'enregistrer', 'invitation.texte': origine.replace('{{nom}}', '{{prenom}}') });
    assert.equal(inconnu.status, 400);
    assert.match(await inconnu.text(), /Mot inconnu : \{\{prenom\}\}/);
    const sansLien = await poster(app, admin.cookie, '/admin/textes', { action: 'enregistrer', 'invitation.texte': origine.replace('\n{{lien}}\n', ' {{lien}}\n') });
    assert.match(await sansLien.text(), /doit rester seul sur sa ligne/);
    assert.equal((await poster(app, admin.cookie, '/admin/textes', { action: 'enregistrer', 'alerte.sujet': '  ' })).status, 400);

    const nouveau = origine.replace('Bonjour {{civilite}} {{nom}},', 'Bonjour {{civilite}} {{nom}}, (texte modifié)');
    const apercu = await poster(app, admin.cookie, '/admin/textes', { action: 'apercu', 'invitation.texte': nouveau });
    assert.equal(apercu.status, 200);
    assert.match(await apercu.text(), /Bonjour Mme ZZ EXEMPLE, \(texte modifié\)/);

    const { cookie } = await seConnecter(app);
    const invitation = async (nom) => {
      await poster(app, cookie, '/demandes', { type: 'mise_a_jour', civilite: 'M.', nom, email: 'zz-test-texte@exemple.test', pieces: ['RIB'] });
      return app.boite.at(-1).donnees.texte;
    };
    assert.doesNotMatch(await invitation('ZZ TEST Avant'), /texte modifié/, 'l\'aperçu n\'enregistre rien');

    assert.equal(sansBase(app, await poster(app, admin.cookie, '/admin/textes', { action: 'enregistrer', 'invitation.texte': nouveau })), '/admin/textes?ok=textes');
    assert.match(await invitation('ZZ TEST Apres'), /Bonjour M\. ZZ TEST Apres, \(texte modifié\)/);
    const journal = JSON.stringify(app.db.prepare('SELECT * FROM journal').all());
    assert.match(journal, /textes_modifies/);
    assert.ok(!journal.includes('texte modifié'), 'le journal ne garde pas le contenu');

    assert.equal(sansBase(app, await poster(app, admin.cookie, '/admin/textes/retablir', { cle: 'invitation.texte' })), '/admin/textes?ok=textes_retablis');
    assert.doesNotMatch(await invitation('ZZ TEST Retour'), /texte modifié/);
  } finally { await app.fermer(); }
});

test('au démarrage, les réglages enregistrés s\'appliquent ; une surcouche devenue invalide est ignorée', async () => {
  const app = await demarrer();
  try {
    const reglages = creerReglages(app.db);
    reglages.ecrire('parametres_envoi', { relance_salarie_jours: 4 });
    reglages.ecrire('parametres_textes', { 'relance.sujet': 'Rappel fictif – {{agence}}' });
    const objets = () => ({ textes: chargerTextes('config'), controles: chargerControles('config'), reglagesEnvoi: chargerReglagesEnvoi('config') });
    const neufs = objets();
    creerParametres({ db: app.db, config: app.config, catalogue: chargerCatalogue('config'), reglages, ...neufs });
    assert.equal(neufs.reglagesEnvoi.relanceJours, 4);
    assert.equal(neufs.textes.relance.sujet, 'Rappel fictif – {{agence}}');

    reglages.ecrire('parametres_controles', { 'lisibilite.luminosite_min': 250 }); // incohérent avec luminosite_max
    const autres = objets();
    creerParametres({ db: app.db, config: app.config, catalogue: chargerCatalogue('config'), reglages, ...autres });
    assert.equal(autres.controles.lisibilite.luminosite_min, chargerControles('config').lisibilite.luminosite_min);
  } finally { await app.fermer(); }
});

test('verifierTexte : règles des mots entre {{ }}', () => {
  assert.equal(verifierTexte('Bonjour {{nom}}', 'Salut {{nom}}'), null);
  assert.equal(verifierTexte('Bonjour {{nom}}', 'Salut'), null, 'un mot peut être retiré, sauf {{lien}}');
  assert.match(verifierTexte('Sans mot', 'Avec {{nom}}'), /aucun mot/);
  assert.equal(verifierTexte('A\n{{lien}}\nB', 'Autre\n  {{lien}}  \nB'), null);
  assert.match(verifierTexte('A\n{{lien}}', 'A'), /seul sur sa ligne/);
});
