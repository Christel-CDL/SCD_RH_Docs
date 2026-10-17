// Dépôt des pièces par le salarié, en brouillon : chaque pièce validée est enregistrée tout de suite (chiffrée),
// le salarié peut partir et revenir par le même lien, remplacer une pièce, puis envoyer son dossier quand tout est déposé.
import crypto from 'node:crypto';
import { preparerFichier } from './fichiers.js';
import { journaliser } from './db.js';

export const LIMITES = {
  octetsParFichier: 10 * 1024 * 1024,
  octetsParDemande: 80 * 1024 * 1024,
  pagesMax: 10,
};

const identifiant = () => crypto.randomBytes(12).toString('base64url');

// Nombre de fichiers attendus selon la nature de la pièce. Un PDF vaut toujours la pièce entière.
function controlerPages(pages, fichiers) {
  const pdf = fichiers.some((f) => f.type === 'application/pdf');
  if (pdf) return fichiers.length === 1 ? null : 'Un PDF doit être envoyé seul : il remplace toutes les photos de la pièce.';
  if (pages === 'recto_verso' && fichiers.length !== 2) return 'Il faut deux photos : le recto, puis le verso.';
  if (pages === 'une' && fichiers.length !== 1) return 'Il faut une seule photo.';
  if (pages === 'plusieurs' && (fichiers.length < 1 || fichiers.length > LIMITES.pagesMax)) {
    return `Il faut entre 1 et ${LIMITES.pagesMax} pages.`;
  }
  return null;
}

export function creerDepot({ db, catalogue, stockage }) {
  const requetes = {
    piece: db.prepare('SELECT * FROM pieces WHERE demande_id = ? AND abrev = ?'),
    pieces: db.prepare('SELECT * FROM pieces WHERE demande_id = ? ORDER BY rowid'),
    pagesPiece: db.prepare('SELECT fichier FROM pages WHERE piece_id = ?'),
    nbPages: db.prepare('SELECT COUNT(*) AS n FROM pages WHERE piece_id = ?'),
    tailleDemande: db.prepare(`
      SELECT COALESCE(SUM(pg.taille), 0) AS total FROM pages pg JOIN pieces p ON p.id = pg.piece_id
      WHERE p.demande_id = ? AND p.id <> ?`),
    supprimerPages: db.prepare('DELETE FROM pages WHERE piece_id = ?'),
    insererPage: db.prepare('INSERT INTO pages (id, piece_id, ordre, fichier, type, taille) VALUES (?, ?, ?, ?, ?, ?)'),
    marquerDeposee: db.prepare(`
      UPDATE pieces SET statut = 'deposee', abrev_fournie = ?, a_verifier = 0, depose_le = ? WHERE id = ?`),
    passerEnCours: db.prepare("UPDATE demandes SET statut = 'en_cours' WHERE id = ? AND statut = 'envoyee'"),
    marquerComplete: db.prepare("UPDATE demandes SET statut = 'complete', complete_le = ? WHERE id = ? AND statut IN ('envoyee', 'en_cours')"),
    fichiersDemande: db.prepare('SELECT pg.fichier FROM pages pg JOIN pieces p ON p.id = pg.piece_id WHERE p.demande_id = ?'),
  };

  const ouverte = (demande) => ['envoyee', 'en_cours'].includes(demande.statut) && Date.now() < demande.date_limite;

  // Vue de la demande pour la page du salarié : seulement les pièces demandées, avec leur état.
  function etat(demande) {
    const pieces = requetes.pieces.all(demande.id).map((p) => {
      const def = catalogue.pieces.get(p.abrev);
      const fournie = p.abrev_fournie ? catalogue.pieces.get(p.abrev_fournie) : null;
      return {
        abrev: p.abrev,
        libelle: def.libelle,
        consigne: def.consigne,
        choix: def.choix ? def.choix.map((c) => ({ abrev: c, libelle: catalogue.pieces.get(c).libelle, pages: catalogue.pieces.get(c).pages })) : null,
        pages: (fournie || def).pages || null,
        fournie: fournie ? fournie.libelle : null,
        abrevFournie: p.abrev_fournie,
        statut: p.statut,
        nbPages: requetes.nbPages.get(p.id).n,
      };
    });
    return { pieces, complet: pieces.every((p) => p.statut === 'deposee'), ouverte: ouverte(demande) };
  }

  // fichiers : tableau de Buffer, dans l'ordre (recto, verso, page 3…). Renvoie { ok } ou { erreur, statut }.
  function deposer(demande, abrev, { choix = null, fichiers }) {
    if (!ouverte(demande)) return { erreur: 'Le délai de dépôt est dépassé. Contactez l\'agence.', statut: 410 };
    const piece = requetes.piece.get(demande.id, abrev);
    if (!piece) return { erreur: 'Cette pièce ne fait pas partie de la demande.', statut: 404 };
    const def = catalogue.pieces.get(abrev);
    let fournie = abrev;
    if (def.choix) {
      if (!def.choix.includes(choix)) return { erreur: 'Choisissez la pièce que vous fournissez.', statut: 400 };
      fournie = choix;
    }
    if (!fichiers.length) return { erreur: 'Ajoutez au moins une photo ou un fichier.', statut: 400 };
    if (fichiers.length > LIMITES.pagesMax) return { erreur: `${LIMITES.pagesMax} fichiers au maximum par pièce.`, statut: 400 };

    const prepares = [];
    for (const octets of fichiers) {
      if (octets.length > LIMITES.octetsParFichier) return { erreur: 'Un fichier dépasse 10 Mo. Reprenez la photo ou réduisez le fichier.', statut: 413 };
      const resultat = preparerFichier(octets);
      if (resultat.erreur) return { erreur: resultat.erreur, statut: 415 };
      prepares.push(resultat);
    }
    const erreurPages = controlerPages(catalogue.pieces.get(fournie).pages, prepares);
    if (erreurPages) return { erreur: erreurPages, statut: 400 };
    const taille = prepares.reduce((t, f) => t + f.contenu.length, 0);
    if (requetes.tailleDemande.get(demande.id, piece.id).total + taille > LIMITES.octetsParDemande) {
      return { erreur: 'Le dossier est trop volumineux. Contactez l\'agence.', statut: 413 };
    }

    // Les nouveaux fichiers sont écrits d'abord ; la base ne bascule qu'une fois tout écrit.
    const nouveaux = [];
    try {
      for (const f of prepares) nouveaux.push({ ...f, fichier: stockage.ecrire(f.contenu) });
    } catch (erreur) {
      nouveaux.forEach((f) => stockage.supprimer(f.fichier));
      throw erreur;
    }
    const anciens = requetes.pagesPiece.all(piece.id).map((p) => p.fichier);
    db.exec('BEGIN');
    try {
      requetes.supprimerPages.run(piece.id);
      nouveaux.forEach((f, i) => requetes.insererPage.run(identifiant(), piece.id, i + 1, f.fichier, f.type, f.contenu.length));
      requetes.marquerDeposee.run(fournie, Date.now(), piece.id);
      requetes.passerEnCours.run(demande.id);
      db.exec('COMMIT');
    } catch (erreur) {
      db.exec('ROLLBACK');
      nouveaux.forEach((f) => stockage.supprimer(f.fichier));
      throw erreur;
    }
    anciens.forEach((f) => stockage.supprimer(f)); // une pièce remplacée ne laisse aucune trace
    journaliser(db, anciens.length ? 'piece_remplacee' : 'piece_deposee', { demandeId: demande.id });
    return { ok: true };
  }

  // « Envoyer mon dossier » : seulement quand toutes les pièces sont déposées. L'envoi à l'assistante arrive à l'étape 5.
  function envoyer(demande) {
    if (!ouverte(demande)) return { erreur: 'Le délai de dépôt est dépassé. Contactez l\'agence.', statut: 410 };
    if (!etat(demande).complet) return { erreur: 'Toutes les pièces ne sont pas encore déposées.', statut: 409 };
    requetes.marquerComplete.run(Date.now(), demande.id);
    journaliser(db, 'dossier_complet', { demandeId: demande.id });
    return { ok: true };
  }

  // Supprime tous les fichiers d'une demande (annulation, expiration, après envoi). Les lignes suivent la demande.
  function supprimerFichiers(demandeId) {
    for (const { fichier } of requetes.fichiersDemande.all(demandeId)) stockage.supprimer(fichier);
  }

  return { etat, deposer, envoyer, supprimerFichiers, ouverte };
}
