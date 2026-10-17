// Page de dépôt du salarié : amélioration progressive des formulaires (sans ce script, l'envoi classique fonctionne).
// - chaque photo est relue et réencodée en JPEG dans le téléphone : orientation corrigée, taille réduite,
//   et toutes les métadonnées (EXIF, position GPS) disparaissent avant même l'envoi ;
// - aperçu de chaque page, ajout de pages, choix CNI / passeport ;
// - envoi de la pièce sans recharger, puis actualisation de la page (l'état vient toujours du serveur).
// L'étape 4 ajoutera ici le recadrage automatique et le contrôle de lisibilité.
'use strict';

(function () {
  const COTE_MAX = 2400;      // pixels sur le grand côté : largement lisible, fichier léger
  const QUALITE_JPEG = 0.85;
  const PAGES_MAX = 10;

  // Décodage d'une image : createImageBitmap (orientation EXIF appliquée), sinon <img> (Safari lit le HEIC ainsi).
  async function decoder(fichier) {
    try {
      return await createImageBitmap(fichier, { imageOrientation: 'from-image' });
    } catch {
      const url = URL.createObjectURL(fichier);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  async function normaliser(fichier) {
    const image = await decoder(fichier);
    const largeur = image.width || image.naturalWidth;
    const hauteur = image.height || image.naturalHeight;
    const echelle = Math.min(1, COTE_MAX / Math.max(largeur, hauteur));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(largeur * echelle);
    canvas.height = Math.round(hauteur * echelle);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    if (image.close) image.close();
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', QUALITE_JPEG));
    if (!blob) throw new Error('encodage');
    return blob;
  }

  const estPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  function preparerFormulaire(form) {
    const choisis = new Map(); // emplacement → { blob, pdf, nom }
    let enPreparation = 0;     // photos en cours de réencodage : valider maintenant enverrait une pièce incomplète
    const etatEnvoi = form.querySelector('.etat-envoi');
    const boutonValider = form.querySelector('button[type="submit"]');
    const conteneur = form.querySelector('.emplacements');
    const ajouter = form.querySelector('.ajouter-page');

    const pagesAttendues = () => {
      const choix = form.querySelector('input[name="choix"]:checked');
      return choix ? choix.dataset.pages : form.dataset.pages;
    };
    const emplacements = () => [...conteneur.querySelectorAll('.emplacement')].filter((e) => !e.hidden);
    const dire = (texte, erreur = false) => { etatEnvoi.textContent = texte; etatEnvoi.classList.toggle('erreur-champ', erreur); };

    function vider(emplacement) {
      choisis.delete(emplacement);
      const apercu = emplacement.querySelector('.apercu');
      if (apercu.src) URL.revokeObjectURL(apercu.src);
      apercu.hidden = true;
      apercu.removeAttribute('src');
      emplacement.querySelector('.nom-fichier').hidden = true;
      emplacement.classList.remove('rempli');
    }

    async function surFichier(entree) {
      const emplacement = entree.closest('.emplacement');
      const fichier = entree.files[0];
      entree.value = ''; // on garde notre version traitée, pas le fichier brut
      if (!fichier) return;
      vider(emplacement);
      dire('Préparation de la photo…');
      enPreparation += 1;
      try {
        if (estPdf(fichier)) {
          choisis.set(emplacement, { blob: fichier, pdf: true, nom: fichier.name });
          const nom = emplacement.querySelector('.nom-fichier');
          nom.textContent = `PDF : ${fichier.name}`;
          nom.hidden = false;
        } else {
          const blob = await normaliser(fichier);
          choisis.set(emplacement, { blob, pdf: false });
          const apercu = emplacement.querySelector('.apercu');
          apercu.src = URL.createObjectURL(blob);
          apercu.hidden = false;
        }
        emplacement.classList.add('rempli');
        dire('');
      } catch {
        dire('Cette photo n\'a pas pu être lue. Reprenez-la avec le bouton « Prendre une photo ».', true);
      } finally {
        enPreparation -= 1;
      }
    }

    function numeroter() {
      emplacements().forEach((e, i) => {
        const pages = pagesAttendues();
        const etiquette = pages === 'recto_verso' ? ['Recto', 'Verso'][i] : pages === 'une' ? 'Photo' : `Page ${i + 1}`;
        e.querySelector('.etiquette').textContent = etiquette;
        e.querySelector('.apercu').alt = `Aperçu : ${etiquette}`;
      });
    }

    // CNI ou passeport : le passeport n'a qu'une page, on masque le verso.
    form.querySelectorAll('input[name="choix"]').forEach((radio) => radio.addEventListener('change', () => {
      const tous = [...conteneur.querySelectorAll('.emplacement')];
      tous.forEach((e, i) => {
        e.hidden = radio.dataset.pages === 'une' && i > 0;
        if (e.hidden) vider(e);
      });
      numeroter();
    }));
    const dejaChoisi = form.querySelector('input[name="choix"]:checked');
    if (dejaChoisi) dejaChoisi.dispatchEvent(new Event('change'));

    if (ajouter) {
      ajouter.hidden = false;
      ajouter.addEventListener('click', () => {
        const n = conteneur.querySelectorAll('.emplacement').length + 1;
        if (n > PAGES_MAX) return;
        const modele = conteneur.querySelector('.emplacement');
        const copie = modele.cloneNode(true);
        copie.dataset.numero = String(n);
        copie.querySelectorAll('input').forEach((entree) => { entree.id = entree.id.replace(/-\d+-/, `-${n}-`); entree.value = ''; });
        copie.querySelectorAll('label').forEach((l) => { l.htmlFor = l.htmlFor.replace(/-\d+-/, `-${n}-`); });
        conteneur.appendChild(copie);
        vider(copie);
        numeroter();
        if (n >= PAGES_MAX) ajouter.hidden = true;
        copie.querySelector('label').focus();
      });
    }

    conteneur.addEventListener('change', (ev) => { if (ev.target.type === 'file') surFichier(ev.target); });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (enPreparation > 0) return dire('Une photo est encore en préparation : patientez quelques secondes, puis validez.', true);
      const pages = pagesAttendues();
      if (form.querySelector('input[name="choix"]') && !form.querySelector('input[name="choix"]:checked')) {
        return dire('Choisissez d\'abord la pièce que vous fournissez.', true);
      }
      const remplis = emplacements().filter((e) => choisis.has(e)).map((e) => choisis.get(e));
      const pdf = remplis.some((r) => r.pdf);
      if (!remplis.length) return dire('Ajoutez une photo ou un fichier.', true);
      if (pdf && remplis.length > 1) return dire('Un PDF doit être envoyé seul : retirez les photos ou le PDF.', true);
      if (!pdf && pages === 'recto_verso' && remplis.length < 2) return dire('Il manque une photo : il faut le recto et le verso.', true);

      const donnees = new FormData();
      const choix = form.querySelector('input[name="choix"]:checked');
      if (choix) donnees.append('choix', choix.value);
      remplis.forEach((r, i) => donnees.append('fichier', r.blob, r.pdf ? 'piece.pdf' : `page-${i + 1}.jpg`));

      boutonValider.disabled = true;
      dire('Envoi en cours… Gardez cette page ouverte.');
      try {
        const reponse = await fetch(form.action, { method: 'POST', body: donnees, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        const corps = await reponse.json().catch(() => ({}));
        if (!reponse.ok) throw new Error(corps.erreur || 'L\'envoi a échoué. Vérifiez votre connexion et réessayez.');
        dire('Pièce enregistrée.');
        location.replace(`${location.pathname}?ok=${Date.now()}#${form.closest('.piece').id}`);
      } catch (erreur) {
        dire(erreur.message.startsWith('Failed') || erreur.message === 'Load failed'
          ? 'Pas de connexion internet. Réessayez quand le réseau revient : rien n\'est perdu.' : erreur.message, true);
        boutonValider.disabled = false;
      }
    });
  }

  document.querySelectorAll('form.depot').forEach(preparerFormulaire);
}());
