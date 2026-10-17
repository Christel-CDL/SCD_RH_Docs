// Stockage temporaire des pièces : un fichier chiffré par page, au nom aléatoire, dans DATA_DIR/pieces.
// Les fichiers ne sont jamais servis par HTTP : seule l'application les lit (aperçu à l'étape 4, PDF, envoi).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chiffrer, dechiffrer } from './securite/chiffrement.js';

const NOM = /^[A-Za-z0-9_-]{32}$/;

export function creerStockage({ dataDir, cle }) {
  const dossier = path.join(dataDir, 'pieces');
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const chemin = (nom) => {
    if (!NOM.test(nom)) throw new Error('Nom de fichier invalide');
    return path.join(dossier, `${nom}.bin`);
  };

  // Écriture atomique : un fichier à moitié écrit (coupure, plantage) n'est jamais pris pour une pièce.
  function ecrire(contenu) {
    const nom = crypto.randomBytes(24).toString('base64url');
    const temporaire = `${chemin(nom)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporaire, chiffrer(cle, contenu, nom), { mode: 0o600 });
    fs.renameSync(temporaire, chemin(nom));
    return nom;
  }

  const lire = (nom) => dechiffrer(cle, fs.readFileSync(chemin(nom)), nom);

  function supprimer(nom) {
    try { fs.unlinkSync(chemin(nom)); } catch (erreur) { if (erreur.code !== 'ENOENT') throw erreur; }
  }

  // Pour la purge de sécurité et les vérifications : fichiers présents sur le disque.
  const lister = () => fs.readdirSync(dossier).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4));

  // Purge de sécurité : efface tout fichier qui n'appartient plus à aucune page (connus : noms encore en base),
  // et les écritures interrompues (.tmp), s'ils ont plus de ageMs (pour ne pas toucher une écriture en cours).
  function purgerOrphelins(connus, ageMs) {
    const limite = Date.now() - ageMs;
    let n = 0;
    for (const f of fs.readdirSync(dossier)) {
      const chemin = path.join(dossier, f);
      const orphelin = f.endsWith('.tmp') || (f.endsWith('.bin') && !connus.has(f.slice(0, -4)));
      if (orphelin && fs.statSync(chemin).mtimeMs < limite) {
        fs.rmSync(chemin, { force: true });
        n += 1;
      }
    }
    return n;
  }

  return { ecrire, lire, supprimer, lister, purgerOrphelins, dossier };
}
