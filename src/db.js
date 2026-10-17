// Base SQLite (module node:sqlite intégré à Node 24, aucune dépendance native).
// Les migrations sont numérotées et appliquées dans l'ordre ; PRAGMA user_version mémorise la dernière.
// Aucun contenu de pièce n'est jamais stocké en base : seulement l'état et le nom du fichier chiffré.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1 — schéma initial
  `
  CREATE TABLE utilisateurs (
    id        INTEGER PRIMARY KEY,
    email     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nom       TEXT NOT NULL DEFAULT '',
    role      TEXT NOT NULL CHECK (role IN ('admin', 'assistante')),
    actif     INTEGER NOT NULL DEFAULT 1 CHECK (actif IN (0, 1)),
    cree_le   INTEGER NOT NULL
  );

  -- Lien de connexion des assistantes : usage unique, 15 minutes. Seule l'empreinte SHA-256 est stockée.
  CREATE TABLE jetons_connexion (
    empreinte       TEXT PRIMARY KEY,
    utilisateur_id  INTEGER NOT NULL REFERENCES utilisateurs (id) ON DELETE CASCADE,
    expire_le       INTEGER NOT NULL,
    utilise_le      INTEGER
  );

  CREATE TABLE sessions (
    empreinte       TEXT PRIMARY KEY,
    utilisateur_id  INTEGER NOT NULL REFERENCES utilisateurs (id) ON DELETE CASCADE,
    csrf            TEXT NOT NULL,
    cree_le         INTEGER NOT NULL,
    expire_le       INTEGER NOT NULL
  );

  -- Demande de pièces. Le lien du salarié n'est connu que par son empreinte.
  CREATE TABLE demandes (
    id                TEXT PRIMARY KEY,
    utilisateur_id    INTEGER NOT NULL REFERENCES utilisateurs (id),
    type              TEXT NOT NULL CHECK (type IN ('embauche', 'mise_a_jour')),
    civilite          TEXT NOT NULL CHECK (civilite IN ('M.', 'Mme')),
    nom               TEXT NOT NULL,
    email_salarie     TEXT NOT NULL,
    statut            TEXT NOT NULL DEFAULT 'envoyee'
                      CHECK (statut IN ('envoyee', 'en_cours', 'complete', 'transmise', 'expiree', 'annulee')),
    jeton_empreinte   TEXT UNIQUE,
    cree_le           INTEGER NOT NULL,
    expire_le         INTEGER NOT NULL,
    transmise_le      INTEGER,
    relances          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX demandes_utilisateur ON demandes (utilisateur_id, cree_le);
  CREATE INDEX demandes_expiration ON demandes (statut, expire_le);

  CREATE TABLE pieces (
    id             TEXT PRIMARY KEY,
    demande_id     TEXT NOT NULL REFERENCES demandes (id) ON DELETE CASCADE,
    abrev          TEXT NOT NULL,            -- pièce demandée (ex. CNI, ou CNI_PASS pour « CNI ou passeport »)
    abrev_fournie  TEXT,                     -- pièce réellement fournie (CNI ou PASS)
    statut         TEXT NOT NULL DEFAULT 'a_faire' CHECK (statut IN ('a_faire', 'deposee', 'a_refaire')),
    a_verifier     INTEGER NOT NULL DEFAULT 0 CHECK (a_verifier IN (0, 1)),
    fichier        TEXT,                     -- nom aléatoire du fichier chiffré sur le disque
    taille         INTEGER,
    depose_le      INTEGER,
    UNIQUE (demande_id, abrev)
  );

  -- Journal d'activité minimal : qui, quoi, quand. Jamais de nom, d'e-mail de salarié ni de contenu.
  CREATE TABLE journal (
    id              INTEGER PRIMARY KEY,
    quand           INTEGER NOT NULL,
    utilisateur_id  INTEGER,
    demande_id      TEXT,
    action          TEXT NOT NULL
  );
  CREATE INDEX journal_quand ON journal (quand);

  CREATE TABLE reglages (
    cle     TEXT PRIMARY KEY,
    valeur  TEXT NOT NULL
  );
  `,
];

export function ouvrirBase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;   -- les lignes supprimées sont écrasées sur le disque, pas seulement marquées libres
    PRAGMA busy_timeout = 5000;
  `);
  migrer(db);
  return db;
}

function migrer(db) {
  const actuelle = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = actuelle; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (erreur) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${i + 1} impossible : ${erreur.message}`);
    }
  }
}

export function journaliser(db, action, { utilisateurId = null, demandeId = null } = {}) {
  db.prepare('INSERT INTO journal (quand, utilisateur_id, demande_id, action) VALUES (?, ?, ?, ?)')
    .run(Date.now(), utilisateurId, demandeId, action);
}

// L'administratrice déclarée dans ADMIN_EMAIL existe toujours, active et admin.
export function assurerAdmin(db, email) {
  db.prepare(`
    INSERT INTO utilisateurs (email, nom, role, actif, cree_le) VALUES (?, 'Administratrice', 'admin', 1, ?)
    ON CONFLICT (email) DO UPDATE SET role = 'admin', actif = 1
  `).run(email, Date.now());
}
