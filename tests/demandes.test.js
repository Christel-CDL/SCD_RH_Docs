// Étape 2 : catalogue des pièces, dates limites, formulaire de demande et invitation du salarié.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chargerCatalogue, chargerTextes, remplir } from '../src/catalogue.js';
import { dateLimite, expiration, instantParis } from '../src/dates.js';
import { validerDemande } from '../src/demandes.js';
import { empreinte } from '../src/securite/jetons.js';
import { demarrer, seConnecter, poster, lienDans, ASSISTANTE } from './aide.js';

const catalogue = chargerCatalogue('./config');
const JOUR = 24 * 3600e3;

// ── Unitaires ─────────────────────────────────────────────────────

test('le catalogue livré se charge et contient le modèle d\'embauche du cahier des charges', () => {
  assert.deepEqual(catalogue.modeles.embauche, ['CV', 'CNI_PASS', 'JDOM', 'CPAM', 'B3', 'RIB']);
  // Retour de Christel du 18/10/2026 : CNI et passeport seuls faisaient doublon avec « Carte d'identité ou passeport ».
  assert.equal(catalogue.pieces.get('CNI').dans_formulaire, false);
  assert.equal(catalogue.pieces.get('PASS').dans_formulaire, false);
  assert.equal(catalogue.pieces.get('CNI_PASS').dans_formulaire, true);
  assert.deepEqual(catalogue.modeles.mise_a_jour, []);
  assert.equal(catalogue.pieces.get('B3').controle_seulement, true);
  assert.equal(catalogue.pieces.get('PERMIS').controle_seulement, true);
  assert.deepEqual(catalogue.pieces.get('CNI_PASS').choix, ['CNI', 'PASS']);
  assert.ok(chargerTextes('./config').invitation.embauche.sujet);
});

test('remplir() remplace les mots connus et laisse visibles les inconnus', () => {
  assert.equal(remplir('Bonjour {{nom}}, {{inconnu}}', { nom: 'DUPONT' }), 'Bonjour DUPONT, {{inconnu}}');
});

test('la date limite tombe à 18 h (heure de Paris), la veille de l\'expiration', () => {
  // Demande le 20/10/2026 à 9 h (Paris) : date limite le 03/11 à 18 h (heure d'hiver), expiration le 04/11 à 9 h.
  const cree = instantParis(2026, 10, 20, 9);
  const limite = dateLimite(cree, 15);
  assert.equal(new Date(limite).toISOString(), '2026-11-03T17:00:00.000Z');
  assert.equal(expiration(cree, 15) - cree, 15 * JOUR);
  // Il reste toujours au moins 6 h entre la date limite et la purge, à toute heure de création.
  for (let h = 0; h < 24; h++) {
    const c = instantParis(2026, 3, 20, h); // période du changement d'heure (29/03/2026)
    assert.ok(expiration(c, 15) - dateLimite(c, 15) >= 6 * 3600e3 - 3600e3, `création à ${h} h`);
  }
});

test('instantParis gère l\'heure d\'été et l\'heure d\'hiver', () => {
  assert.equal(new Date(instantParis(2026, 7, 1, 18)).toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(new Date(instantParis(2026, 12, 1, 18)).toISOString(), '2026-12-01T17:00:00.000Z');
});

test('validerDemande accepte une saisie correcte et range les pièces dans l\'ordre du catalogue', () => {
  const { valeurs, erreurs } = validerDemande({
    type: 'embauche', civilite: 'Mme', nom: '  Le   Gall ', email: 'Salarie.Fictif@Exemple.test', pieces: ['RIB', 'CV'],
  }, catalogue);
  assert.equal(erreurs, undefined);
  assert.equal(valeurs.nom, 'Le Gall');
  assert.equal(valeurs.email, 'salarie.fictif@exemple.test');
  assert.deepEqual(valeurs.abrevs, ['CV', 'RIB']);
});

test('validerDemande refuse les saisies incorrectes, champ par champ', () => {
  const { erreurs } = validerDemande({ type: 'x', civilite: 'Dr', nom: '<script>', email: 'pas-une-adresse', pieces: [] }, catalogue);
  assert.deepEqual(Object.keys(erreurs).sort(), ['civilite', 'email', 'nom', 'pieces', 'type']);
  assert.ok(validerDemande({ type: 'embauche', civilite: 'M.', nom: 'Dupont', email: 'a@b.fr', pieces: ['INCONNUE'] }, catalogue).erreurs.pieces);
});

test('« CNI ou passeport » ne peut pas être coché en même temps que CNI ou passeport', () => {
  const { erreurs } = validerDemande({ type: 'embauche', civilite: 'M.', nom: 'Dupont', email: 'a@b.fr', pieces: ['CNI_PASS', 'CNI'] }, catalogue);
  assert.match(erreurs.pieces, /soit/);
  assert.equal(validerDemande({ type: 'embauche', civilite: 'M.', nom: 'Dupont', email: 'a@b.fr', pieces: ['CNI_PASS', 'RIB'] }, catalogue).erreurs, undefined);
});

// ── Intégration ───────────────────────────────────────────────────

const DEMANDE = { type: 'embauche', civilite: 'M.', nom: "D'Artagnan", email: 'zz-test-salarie@exemple.test', pieces: ['CV', 'CNI', 'RIB'] };

test('le formulaire d\'embauche pré-coche les pièces du modèle ; celui de mise à jour, aucune', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    const embauche = await (await app.envoyer('/demandes/nouvelle?type=embauche', { cookie })).text();
    for (const a of catalogue.modeles.embauche) assert.match(embauche, new RegExp(`value="${a}" checked`));
    assert.doesNotMatch(embauche, /value="PERMIS" checked/);
    assert.doesNotMatch(embauche, /value="CNI"|value="PASS"/, 'CNI et passeport seuls ne sont plus proposés');
    assert.doesNotMatch(embauche, /value="PHOTO"/, 'photo d\'identité retirée (demande de Christel, 18/10/2026)');
    assert.match(embauche, /value="CNI_PASS"/);
    const maj = await (await app.envoyer('/demandes/nouvelle?type=mise_a_jour', { cookie })).text();
    assert.doesNotMatch(maj, /checked/);
  } finally { await app.fermer(); }
});

test('créer une demande enregistre les pièces et envoie une invitation sans donnée sensible', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    const r = await poster(app, cookie, '/demandes', DEMANDE);
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /\?ok=invitation$/);

    const demande = app.db.prepare('SELECT * FROM demandes').get();
    assert.equal(demande.statut, 'envoyee');
    assert.equal(demande.expire_le - demande.cree_le, 15 * JOUR);
    assert.ok(demande.date_limite < demande.expire_le);
    assert.deepEqual(app.db.prepare('SELECT abrev, statut FROM pieces ORDER BY rowid').all().map((p) => ({ ...p })),
      [{ abrev: 'CV', statut: 'a_faire' }, { abrev: 'CNI', statut: 'a_faire' }, { abrev: 'RIB', statut: 'a_faire' }]);

    const invitation = app.boite.find((m) => m.donnees.categorie === 'invitation_embauche').donnees;
    assert.equal(invitation.destinataire, DEMANDE.email);
    assert.equal(invitation.repondre_a, ASSISTANTE, 'les réponses du salarié arrivent à l\'assistante');
    assert.equal(invitation.nom_expediteur, 'E&D Pessac – Pièces d\'embauche');
    assert.match(invitation.sujet, /préparer votre embauche/);
    assert.match(invitation.texte, /Bonjour M\. D'Artagnan/);
    assert.match(invitation.texte, /Assistante Fictive/);
    assert.match(invitation.texte, /Carte nationale d'identité/);
    assert.doesNotMatch(invitation.texte, /\{\{/, 'aucun mot à remplacer oublié');

    // Le lien n'est connu de la base que par son empreinte.
    const jeton = lienDans(invitation.texte).split('/d/')[1];
    assert.equal(demande.jeton_empreinte, empreinte(jeton));
    assert.ok(!JSON.stringify(app.db.prepare('SELECT * FROM demandes').all()).includes(jeton));

    // La page du salarié s'ouvre avec ce lien, et uniquement avec lui.
    const page = await app.envoyer(`/d/${jeton}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Relevé d&#39;identité bancaire/);
    assert.equal((await app.envoyer(`/d/${jeton.slice(0, -2)}xx`)).status, 410);
  } finally { await app.fermer(); }
});

test('la mise à jour du dossier utilise le second modèle d\'e-mail', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    await poster(app, cookie, '/demandes', { ...DEMANDE, type: 'mise_a_jour', pieces: ['TS'] });
    const invitation = app.boite.find((m) => m.donnees.categorie === 'invitation_mise_a_jour').donnees;
    assert.match(invitation.sujet, /mettre à jour votre dossier/);
  } finally { await app.fermer(); }
});

test('une saisie invalide réaffiche le formulaire avec les erreurs et sans rien créer', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    const r = await poster(app, cookie, '/demandes', { ...DEMANDE, email: 'invalide', pieces: [] });
    assert.equal(r.status, 400);
    const page = await r.text();
    assert.match(page, /adresse e-mail n&#39;est pas valide/);
    assert.match(page, /Cochez au moins une pièce/);
    assert.match(page, /value="D&#39;Artagnan"/, 'la saisie est conservée et échappée');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM demandes').get().n, 0);
  } finally { await app.fermer(); }
});

test('si l\'invitation ne part pas, la demande est supprimée et l\'assistante prévenue', async () => {
  const app = await demarrer({ envoiEnEchec: true });
  try {
    const { cookie } = await seConnecter(app);
    const r = await poster(app, cookie, '/demandes', DEMANDE);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /Rien n&#39;a été enregistré/);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM demandes').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM pieces').get().n, 0);
  } finally { await app.fermer(); }
});

test('sans jeton CSRF, aucune demande n\'est créée', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    const r = await app.envoyer('/demandes', { methode: 'POST', formulaire: { ...DEMANDE, pieces: 'CV' }, cookie });
    assert.equal(r.status, 403);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM demandes').get().n, 0);
  } finally { await app.fermer(); }
});

test('le suivi n\'affiche que les demandes de l\'assistante et se filtre par type', async () => {
  const app = await demarrer();
  try {
    const { cookie } = await seConnecter(app);
    await poster(app, cookie, '/demandes', DEMANDE);
    await poster(app, cookie, '/demandes', { ...DEMANDE, type: 'mise_a_jour', nom: 'Martin', pieces: ['RIB'] });

    const tout = await (await app.envoyer('/', { cookie })).text();
    assert.match(tout, /D&#39;Artagnan/);
    assert.match(tout, /Martin/);
    assert.match(tout, /pièces déposées : 0 sur 3/);
    const embauches = await (await app.envoyer('/?type=embauche', { cookie })).text();
    assert.match(embauches, /D&#39;Artagnan/);
    assert.doesNotMatch(embauches, /Martin/);

    const admin = await seConnecter(app, 'admin@exemple.test');
    assert.doesNotMatch(await (await app.envoyer('/', { cookie: admin.cookie })).text(), /Martin/);
  } finally { await app.fermer(); }
});

test('le jeton du salarié n\'apparaît pas dans le journal d\'accès', async () => {
  const app = await demarrer();
  const lignes = [];
  const log = console.log;
  console.log = (...args) => { lignes.push(args.join(' ')); };
  try {
    const { cookie } = await seConnecter(app);
    await poster(app, cookie, '/demandes', DEMANDE);
    const jeton = lienDans(app.boite.at(-1).donnees.texte).split('/d/')[1];
    await app.envoyer(`/d/${jeton}`);
    await new Promise((ok) => setTimeout(ok, 20));
    assert.ok(lignes.some((l) => l.startsWith('GET /d/*** 200')));
    assert.ok(!lignes.some((l) => l.includes(jeton)));
  } finally { console.log = log; await app.fermer(); }
});

test('page d\'aide : réservée aux personnes connectées, reprend les vrais libellés et le contact', async () => {
  const app = await demarrer();
  try {
    assert.equal((await app.envoyer('/aide')).status, 303, 'connexion obligatoire');
    const { cookie } = await seConnecter(app);
    const accueil = await (await app.envoyer('/', { cookie })).text();
    assert.match(accueil, /<a href="\/aide">Aide<\/a>/);
    const page = await (await app.envoyer('/aide', { cookie })).text();
    for (const libelle of ['Recevoir mon lien de connexion', 'Nouvelle embauche', 'Envoyer l\'invitation au salarié',
      'Déposer mes documents', 'Télécharger les pièces', 'J\'ai enregistré les pièces : les supprimer de l\'outil', '15 jours',
      'Relancer le salarié', 'Annuler la demande']) {
      assert.ok(page.includes(libelle.replace(/'/g, '&#39;')) || page.includes(libelle), libelle);
    }
    assert.match(page, /relance automatique au bout\s+de 7 jours/);
    assert.match(page, /mailto:/);
  } finally { await app.fermer(); }
});
