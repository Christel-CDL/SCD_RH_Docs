// Génération des PDF envoyés à l'assistante : une pièce = un PDF A4, une image par page.
// Écrit à la main (format PDF 1.4) pour n'ajouter aucune dépendance : les photos JPEG sont incluses telles quelles
// (filtre DCTDecode), les PNG avec leurs données compressées d'origine (FlateDecode + prédicteur PNG).
// Le PDF ne contient ni dictionnaire /Info ni métadonnées XMP : ni auteur, ni logiciel, ni date.

const A4 = { petit: 595.28, grand: 841.89 }; // points PDF (1/72 de pouce)
const MARGE = 28;                              // environ 1 cm

// Nom du fichier joint : NOM-ABREV.pdf, NOM en majuscules sans accents, espaces et apostrophes remplacés par « _ ».
export function nomPdf(nom, abrev) {
  const propre = String(nom)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[\s'’]+/g, '_')
    .replace(/[^A-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return `${propre || 'SALARIE'}-${abrev}.pdf`;
}

// Dimensions et couleurs d'un JPEG, lues dans son en-tête SOF.
function lireJpeg(octets) {
  let adobe = false;
  let i = 2;
  while (i + 4 <= octets.length) {
    if (octets[i] !== 0xff) throw new Error('JPEG mal formé');
    const marqueur = octets[i + 1];
    const longueur = octets.readUInt16BE(i + 2);
    if (marqueur === 0xee) adobe = true;
    const sof = marqueur >= 0xc0 && marqueur <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marqueur);
    if (sof) {
      if (i + 10 > octets.length) break;
      return {
        hauteur: octets.readUInt16BE(i + 5), largeur: octets.readUInt16BE(i + 7), composantes: octets[i + 9], adobe,
      };
    }
    i += 2 + longueur;
  }
  throw new Error('JPEG sans dimensions');
}

// PNG : seules les variantes que le PDF sait lire sans décompression sont acceptées
// (gris ou couleur 8 bits, ou palette ; sans transparence ni entrelacement).
function lirePng(octets) {
  let i = 8;
  let entete = null;
  let palette = null;
  const donnees = [];
  while (i + 8 <= octets.length) {
    const longueur = octets.readUInt32BE(i);
    const type = octets.toString('latin1', i + 4, i + 8);
    const contenu = octets.subarray(i + 8, i + 8 + longueur);
    if (type === 'IHDR') {
      entete = {
        largeur: contenu.readUInt32BE(0), hauteur: contenu.readUInt32BE(4), profondeur: contenu[8], couleur: contenu[9], entrelace: contenu[12],
      };
    } else if (type === 'PLTE') palette = contenu;
    else if (type === 'IDAT') donnees.push(contenu);
    else if (type === 'IEND') break;
    i += 12 + longueur;
  }
  if (!entete || !donnees.length) throw new Error('PNG incomplet');
  const { couleur, profondeur, entrelace } = entete;
  const pris = (couleur === 0 && profondeur === 8) || (couleur === 2 && profondeur === 8) || (couleur === 3 && palette);
  if (!pris || entrelace) throw new Error('PNG non pris en charge');
  return { ...entete, palette, donnees: Buffer.concat(donnees) };
}

// Vérifie qu'une page pourra entrer dans le PDF ; renvoie ses dimensions (lève une erreur sinon).
export function analyserImage(type, contenu) {
  if (type === 'image/jpeg') return lireJpeg(contenu);
  if (type === 'image/png') return lirePng(contenu);
  throw new Error('Type non pris en charge');
}

function objetImage(page) {
  if (page.type === 'image/jpeg') {
    const j = lireJpeg(page.contenu);
    const espace = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' }[j.composantes];
    if (!espace) throw new Error('JPEG non pris en charge');
    // Les JPEG CMJN d'Adobe sont stockés inversés.
    const decode = j.composantes === 4 && j.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    return {
      largeur: j.largeur,
      hauteur: j.hauteur,
      dico: `/Type /XObject /Subtype /Image /Width ${j.largeur} /Height ${j.hauteur} /ColorSpace ${espace} /BitsPerComponent 8${decode} /Filter /DCTDecode`,
      flux: page.contenu,
    };
  }
  const p = lirePng(page.contenu);
  const couleurs = p.couleur === 2 ? 3 : 1;
  const espace = p.couleur === 3
    ? `[/Indexed /DeviceRGB ${p.palette.length / 3 - 1} <${p.palette.toString('hex')}>]`
    : (p.couleur === 2 ? '/DeviceRGB' : '/DeviceGray');
  return {
    largeur: p.largeur,
    hauteur: p.hauteur,
    dico: `/Type /XObject /Subtype /Image /Width ${p.largeur} /Height ${p.hauteur} /ColorSpace ${espace} /BitsPerComponent ${p.profondeur}`
      + ` /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${couleurs} /BitsPerComponent ${p.profondeur} /Columns ${p.largeur} >>`,
    flux: p.donnees,
  };
}

const nombre = (x) => (Math.round(x * 100) / 100).toString();

// pages : [{ type, contenu }] dans l'ordre (recto, verso, page 3…). Renvoie le PDF (Buffer).
export function creerPdf(pages) {
  if (!pages.length) throw new Error('Aucune page');
  const objets = []; // contenu de chaque objet, numéroté à partir de 1
  const ajouter = (contenu) => { objets.push(contenu); return objets.length; };
  const reserver = () => ajouter(null);

  const catalogue = reserver();
  const arbre = reserver();
  const feuilles = [];
  for (const page of pages) {
    const image = objetImage(page);
    // Orientation de la feuille suivant celle de l'image ; l'image est centrée et tient dans les marges.
    const paysage = image.largeur > image.hauteur;
    const largeurPage = paysage ? A4.grand : A4.petit;
    const hauteurPage = paysage ? A4.petit : A4.grand;
    const echelle = Math.min((largeurPage - 2 * MARGE) / image.largeur, (hauteurPage - 2 * MARGE) / image.hauteur);
    const l = image.largeur * echelle;
    const h = image.hauteur * echelle;
    const x = (largeurPage - l) / 2;
    const y = (hauteurPage - h) / 2;

    const img = ajouter([`<< ${image.dico} /Length ${image.flux.length} >>\nstream\n`, image.flux, '\nendstream']);
    const dessin = Buffer.from(`q ${nombre(l)} 0 0 ${nombre(h)} ${nombre(x)} ${nombre(y)} cm /Im0 Do Q`, 'latin1');
    const contenu = ajouter([`<< /Length ${dessin.length} >>\nstream\n`, dessin, '\nendstream']);
    feuilles.push(ajouter([`<< /Type /Page /Parent ${arbre} 0 R /MediaBox [0 0 ${nombre(largeurPage)} ${nombre(hauteurPage)}]`
      + ` /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${contenu} 0 R >>`]));
  }
  objets[catalogue - 1] = [`<< /Type /Catalog /Pages ${arbre} 0 R >>`];
  objets[arbre - 1] = [`<< /Type /Pages /Kids [${feuilles.map((n) => `${n} 0 R`).join(' ')}] /Count ${feuilles.length} >>`];

  // Assemblage, avec la table des positions (xref) que les lecteurs PDF utilisent pour trouver chaque objet.
  const morceaux = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let position = morceaux[0].length;
  const positions = [];
  objets.forEach((parties, i) => {
    positions.push(position);
    for (const partie of [`${i + 1} 0 obj\n`, ...parties, '\nendobj\n']) {
      const b = Buffer.isBuffer(partie) ? partie : Buffer.from(partie, 'latin1');
      morceaux.push(b);
      position += b.length;
    }
  });
  const xref = [`xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`,
    ...positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objets.length + 1} /Root ${catalogue} 0 R >>\nstartxref\n${position}\n%%EOF\n`].join('');
  morceaux.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(morceaux);
}
