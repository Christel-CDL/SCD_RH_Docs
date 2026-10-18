// Archive ZIP minimale (méthode « stockée », sans compression : les PDF sont déjà compressés), écrite à la main pour
// n'ajouter aucune dépendance. Sert au bouton « Tout télécharger » de la page des pièces.
// fichiers : [{ nom, contenu: Buffer }]. Noms ASCII (ceux de nomPdf), donc pas de drapeau UTF-8 à gérer.
import zlib from 'node:zlib';

// Date et heure au format MS-DOS (exigé par le format ZIP), heure locale du serveur.
function dateDos(d = new Date()) {
  const heure = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const jour = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { heure, jour };
}

export function creerZip(fichiers) {
  const { heure, jour } = dateDos();
  const locaux = [];
  const centraux = [];
  let position = 0;
  for (const { nom, contenu } of fichiers) {
    const n = Buffer.from(nom, 'latin1');
    const crc = zlib.crc32(contenu);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // signature d'en-tête local
    local.writeUInt16LE(20, 4);           // version nécessaire
    local.writeUInt16LE(0, 6);            // drapeaux
    local.writeUInt16LE(0, 8);            // méthode : stockée
    local.writeUInt16LE(heure, 10);
    local.writeUInt16LE(jour, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contenu.length, 18);
    local.writeUInt32LE(contenu.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(0, 28);
    locaux.push(local, n, contenu);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature du répertoire central
    central.writeUInt16LE(20, 4);         // version créée par
    central.writeUInt16LE(20, 6);         // version nécessaire
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(heure, 12);
    central.writeUInt16LE(jour, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contenu.length, 20);
    central.writeUInt32LE(contenu.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt16LE(0, 30);         // champ supplémentaire
    central.writeUInt16LE(0, 32);         // commentaire
    central.writeUInt16LE(0, 34);         // disque
    central.writeUInt16LE(0, 36);         // attributs internes
    central.writeUInt32LE(0, 38);         // attributs externes
    central.writeUInt32LE(position, 42);  // position de l'en-tête local
    centraux.push(central, n);
    position += 30 + n.length + contenu.length;
  }
  const repertoire = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);       // fin du répertoire central
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(fichiers.length, 8);
  fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(position, 16);
  fin.writeUInt16LE(0, 20);
  return Buffer.concat([...locaux, repertoire, fin]);
}
