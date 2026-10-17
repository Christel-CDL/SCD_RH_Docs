// Jetons aléatoires (liens magiques, sessions, CSRF) et comparaison à temps constant.
import crypto from 'node:crypto';

// 32 octets = 256 bits aléatoires (le cahier des charges en exige au moins 128).
export function nouveauJeton(octets = 32) {
  return crypto.randomBytes(octets).toString('base64url');
}

// Empreinte stockée en base : un vol de la base ne donne aucun lien utilisable.
// Un simple SHA-256 suffit ici (pas besoin d'un hachage lent) car le jeton a 256 bits d'entropie.
export function empreinte(jeton) {
  return crypto.createHash('sha256').update(String(jeton)).digest('hex');
}

export function egaux(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Forme attendue d'un jeton reçu (évite de hacher n'importe quoi de très long).
export const FORME_JETON = /^[A-Za-z0-9_-]{40,64}$/;
