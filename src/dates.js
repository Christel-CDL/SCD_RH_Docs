// Dates à l'heure de Paris, quel que soit le fuseau du serveur (le conteneur Docker est en UTC).
const JOUR = 24 * 3600e3;
const FUSEAU = 'Europe/Paris';

const formatParties = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUSEAU, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function partiesParis(instant) {
  const p = Object.fromEntries(formatParties.formatToParts(new Date(instant)).map((x) => [x.type, Number(x.value)]));
  return p;
}

// Écart entre l'heure de Paris et UTC à un instant donné (1 h en hiver, 2 h en été).
function decalageParis(instant) {
  const p = partiesParis(instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

// Instant correspondant à une heure « murale » de Paris (ex. 18 h le 31/10).
export function instantParis(annee, mois, jour, heure = 0) {
  const approx = Date.UTC(annee, mois - 1, jour, heure);
  const essai = approx - decalageParis(approx);
  return approx - decalageParis(essai);
}

// Date limite affichée au salarié : (durée − 1) jours après la demande, à 18 h, heure de Paris.
// La purge absolue a lieu à cree_le + durée : il reste toujours au moins 6 h pour l'envoi final.
export function dateLimite(creeLe, dureeJours) {
  const p = partiesParis(creeLe + (dureeJours - 1) * JOUR);
  return instantParis(p.year, p.month, p.day, 18);
}

export function expiration(creeLe, dureeJours) {
  return creeLe + dureeJours * JOUR;
}

const formatLong = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatCourt = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, day: '2-digit', month: '2-digit', year: 'numeric' });
const formatHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const dateLongue = (instant) => formatLong.format(new Date(instant)).replace(':', ' h ');
// Jour seul, sans l'heure (« dimanche 1 novembre 2026 ») : en-tête de la page de dépôt (demande de Christel, 18/10/2026).
const formatJour = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const dateJour = (instant) => formatJour.format(new Date(instant));
export const dateCourte = (instant) => formatCourt.format(new Date(instant));
export const dateHeure = (instant) => formatHeure.format(new Date(instant));
