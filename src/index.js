// Point d'entrée : contrôle des réglages, ouverture de la base, démarrage du serveur.
import { lireConfig, resumeConfig } from './config.js';
import { ouvrirBase, assurerAdmin } from './db.js';
import { creerNotificateur } from './notifications.js';
import { creerApp } from './app.js';

const { config, problemes } = lireConfig();
console.log(`Réglages reçus :\n${resumeConfig()}`);
if (problemes.length) {
  console.error(`DÉMARRAGE IMPOSSIBLE :\n- ${problemes.join('\n- ')}`);
  process.exit(1);
}

const db = ouvrirBase(config.dataDir);
assurerAdmin(db, config.adminEmail);
const { serveur } = creerApp({ db, config, notificateur: creerNotificateur(config) });

serveur.listen(config.port, () => console.log(`Collecte de pièces – serveur à l'écoute sur le port ${config.port} (${config.appUrl})`));

// Arrêt propre (redéploiement Docker) : on termine les requêtes en cours puis on ferme la base.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => serveur.close(() => { db.close(); process.exit(0); }));
}
