// Envoi des événements à n8n, seul responsable des e-mails (Brevo puis Outlook, voir le sous-workflow d'envoi).
// Chaque appel est signé : HMAC-SHA256 du texte « horodatage.corps » avec N8N_WEBHOOK_SECRET.
// n8n refuse un appel dont la signature est fausse ou l'horodatage vieux de plus de 5 minutes.
import crypto from 'node:crypto';

export function signer(secret, horodatage, corps) {
  return crypto.createHmac('sha256', secret).update(`${horodatage}.${corps}`).digest('hex');
}

export function creerNotificateur(config) {
  async function envoyer(evenement, donnees) {
    if (config.devAfficherLiens && !config.n8n.webhookUrl) {
      // Développement uniquement (refusé en production par config.js).
      console.log(`[DEV] Événement « ${evenement} » :`, JSON.stringify(donnees));
      return;
    }
    const corps = JSON.stringify({ evenement, donnees });
    const horodatage = String(Date.now());
    const reponse = await fetch(config.n8n.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SCD-Horodatage': horodatage,
        'X-SCD-Signature': signer(config.n8n.secret, horodatage, corps),
      },
      body: corps,
      signal: AbortSignal.timeout(10_000),
    });
    if (!reponse.ok) throw new Error(`n8n a répondu ${reponse.status}`);
    // Réponse de n8n, par exemple { ok: true, journal_efface: true } (effacement du journal Brevo de l'e-mail).
    return reponse.json().catch(() => ({}));
  }
  return { envoyer };
}
