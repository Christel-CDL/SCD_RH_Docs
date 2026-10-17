// Contrôle des fichiers reçus : type réel (octets de signature, jamais l'extension ni le type annoncé)
// et suppression des métadonnées (EXIF, dont la géolocalisation, XMP, commentaires, textes PNG).
// Le navigateur réencode déjà les photos (ce qui retire l'EXIF) : ce nettoyage serveur est une seconde barrière.

export const TYPES_ACCEPTES = ['image/jpeg', 'image/png', 'application/pdf'];
const MARQUES_HEIF = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif', 'avif', 'avis']);

export function detecterType(octets) {
  if (octets.length >= 3 && octets[0] === 0xff && octets[1] === 0xd8 && octets[2] === 0xff) return 'image/jpeg';
  if (octets.length >= 8 && octets.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (octets.length >= 5 && octets.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (octets.length >= 12 && octets.subarray(4, 8).toString('latin1') === 'ftyp' && MARQUES_HEIF.has(octets.subarray(8, 12).toString('latin1'))) {
    return 'image/heic';
  }
  return null;
}

// JPEG : on garde APP0 (JFIF), APP2 (profil de couleur) et APP14 (Adobe, nécessaire au décodage de certaines images).
// On retire APP1 (EXIF, XMP), les autres APPn et les commentaires. Tout ce qui suit le début de l'image (SOS) est copié tel quel.
const SEGMENTS_GARDES = new Set([0xe0, 0xe2, 0xee]);

export function nettoyerJpeg(octets) {
  const morceaux = [octets.subarray(0, 2)];
  let i = 2;
  while (i < octets.length) {
    if (octets[i] !== 0xff) throw new Error('JPEG mal formé');
    let marqueur = octets[i + 1];
    while (marqueur === 0xff) { i += 1; marqueur = octets[i + 1]; } // octets de remplissage
    if (marqueur === 0xd9) { morceaux.push(octets.subarray(i, i + 2)); break; }
    if (marqueur === 0xda) { morceaux.push(octets.subarray(i)); break; }
    if ((marqueur >= 0xd0 && marqueur <= 0xd7) || marqueur === 0x01) { morceaux.push(octets.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > octets.length) throw new Error('JPEG tronqué');
    const fin = i + 2 + octets.readUInt16BE(i + 2);
    if (fin > octets.length) throw new Error('JPEG tronqué');
    const metadonnee = (marqueur >= 0xe1 && marqueur <= 0xef && !SEGMENTS_GARDES.has(marqueur)) || marqueur === 0xfe;
    if (!metadonnee) morceaux.push(octets.subarray(i, fin));
    i = fin;
  }
  return Buffer.concat(morceaux);
}

// PNG : on retire les blocs de texte, d'EXIF et de date.
const BLOCS_RETIRES = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

export function nettoyerPng(octets) {
  const morceaux = [octets.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= octets.length) {
    const longueur = octets.readUInt32BE(i);
    const type = octets.subarray(i + 4, i + 8).toString('latin1');
    const fin = i + 12 + longueur;
    if (fin > octets.length) throw new Error('PNG tronqué');
    if (!BLOCS_RETIRES.has(type)) morceaux.push(octets.subarray(i, fin));
    i = fin;
    if (type === 'IEND') break;
  }
  return Buffer.concat(morceaux);
}

// Renvoie { type, contenu } prêt à stocker, ou { erreur } avec un message compréhensible par le salarié.
export function preparerFichier(octets) {
  const type = detecterType(octets);
  if (type === 'image/heic') {
    return { erreur: 'Cette photo est au format HEIC. Reprenez-la avec le bouton « Prendre une photo », ou réglez l\'appareil photo sur « Le plus compatible ».' };
  }
  if (!TYPES_ACCEPTES.includes(type)) return { erreur: 'Ce fichier n\'est ni une photo (JPEG, PNG) ni un PDF.' };
  try {
    if (type === 'image/jpeg') return { type, contenu: nettoyerJpeg(octets) };
    if (type === 'image/png') return { type, contenu: nettoyerPng(octets) };
  } catch {
    return { erreur: 'Ce fichier est abîmé ou incomplet. Reprenez la photo.' };
  }
  return { type, contenu: octets };
}
