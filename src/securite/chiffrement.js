// Chiffrement des pièces au repos : AES-256-GCM, clé de 32 octets dans FILE_ENCRYPTION_KEY (jamais dans Git).
// Format d'un fichier chiffré : « SCD1 » (4 octets) | vecteur d'initialisation (12) | étiquette GCM (16) | contenu chiffré.
// Les données associées (AAD) sont l'identifiant du fichier : un fichier renommé ou échangé avec un autre est refusé.
import crypto from 'node:crypto';

const ENTETE = Buffer.from('SCD1');
const TAILLE_IV = 12;
const TAILLE_TAG = 16;

export function lireCle(texte) {
  const cle = /^[0-9a-f]{64}$/i.test(String(texte || '')) ? Buffer.from(texte, 'hex') : null;
  return cle && cle.length === 32 ? cle : null;
}

export function chiffrer(cle, contenu, identifiant) {
  const iv = crypto.randomBytes(TAILLE_IV); // jamais réutilisé : 96 bits aléatoires par fichier
  const chiffreur = crypto.createCipheriv('aes-256-gcm', cle, iv);
  chiffreur.setAAD(Buffer.from(identifiant));
  const chiffre = Buffer.concat([chiffreur.update(contenu), chiffreur.final()]);
  return Buffer.concat([ENTETE, iv, chiffreur.getAuthTag(), chiffre]);
}

// Lève une erreur si le fichier a été modifié, si la clé est fausse ou si l'identifiant ne correspond pas.
export function dechiffrer(cle, donnees, identifiant) {
  if (donnees.length < ENTETE.length + TAILLE_IV + TAILLE_TAG || !donnees.subarray(0, 4).equals(ENTETE)) {
    throw new Error('Fichier chiffré illisible');
  }
  const iv = donnees.subarray(4, 4 + TAILLE_IV);
  const tag = donnees.subarray(4 + TAILLE_IV, 4 + TAILLE_IV + TAILLE_TAG);
  const dechiffreur = crypto.createDecipheriv('aes-256-gcm', cle, iv);
  dechiffreur.setAAD(Buffer.from(identifiant));
  dechiffreur.setAuthTag(tag);
  return Buffer.concat([dechiffreur.update(donnees.subarray(4 + TAILLE_IV + TAILLE_TAG)), dechiffreur.final()]);
}
