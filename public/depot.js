// Page de dépôt du salarié : amélioration progressive des formulaires (sans ce script, l'envoi classique de photos fonctionne).
// - chaque photo est relue et réencodée en JPEG dans le téléphone : orientation corrigée, taille réduite,
//   et toutes les métadonnées (EXIF, position GPS) disparaissent avant même l'envoi ;
// - contrôle de lisibilité (résolution, netteté, luminosité, reflets) avec un message qui dit quoi faire ;
//   après plusieurs échecs, le salarié peut envoyer quand même, et la pièce est marquée « à vérifier » ;
// - photos HEIC (iPhone) décodées dans le téléphone quand le navigateur ne sait pas les lire (libheif) ;
// - PDF « désarmés » : chaque page est dessinée en image (pdf.js), l'application refera un PDF propre,
//   sans métadonnées ni contenu actif ;
// - recompression si la pièce dépasse la taille visée, aperçus, ajout de pages, choix CNI / passeport ;
// - envoi de la pièce sans recharger, puis actualisation de la page (l'état vient toujours du serveur).
// Les seuils et les messages viennent du serveur (config/controles.json, config/textes.json).
'use strict';

(function () {
  const liste = document.querySelector('.cartes[data-controles]');
  if (!liste) return;
  const REGLAGES = JSON.parse(liste.dataset.controles);
  const L = REGLAGES.lisibilite;
  const MSG = REGLAGES.messages;
  const PAGES_MAX = 10;
  const COTE_ANALYSE = 1000; // l'analyse se fait sur une copie réduite : mêmes seuils quelle que soit la taille de la photo

  // ── Chargement à la demande des bibliothèques (servies par l'application, jamais par un site tiers) ──

  let heif = null;
  function chargerHeif() {
    heif ??= import('/vendor/libheif/libheif-bundle.mjs').then(async (m) => {
      const lib = m.default();
      if (lib.ready) await lib.ready;
      return lib;
    });
    return heif;
  }
  let pdfjs = null;
  function chargerPdfjs() {
    pdfjs ??= import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return m;
    });
    return pdfjs;
  }

  // ── Décodage ──

  async function enTete(fichier, n) {
    return new Uint8Array(await fichier.slice(0, n).arrayBuffer());
  }
  const estPdf = async (f) => {
    const o = await enTete(f, 5);
    return String.fromCharCode(...o) === '%PDF-';
  };
  const estHeic = async (f) => {
    const o = await enTete(f, 12);
    return String.fromCharCode(...o.slice(4, 8)) === 'ftyp'
      && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'].includes(String.fromCharCode(...o.slice(8, 12)));
  };

  // HEIC : libheif rend l'image en pixels, que l'on pose sur un canvas.
  async function decoderHeic(fichier) {
    const lib = await chargerHeif();
    const decodeur = new lib.HeifDecoder();
    const images = decodeur.decode(new Uint8Array(await fichier.arrayBuffer()));
    if (!images || !images.length) throw new Error('heic');
    const image = images[0];
    const largeur = image.get_width();
    const hauteur = image.get_height();
    const canvas = document.createElement('canvas');
    canvas.width = largeur;
    canvas.height = hauteur;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(largeur, hauteur);
    await new Promise((ok, ko) => image.display(pixels, (r) => (r ? ok() : ko(new Error('heic')))));
    ctx.putImageData(pixels, 0, 0);
    images.forEach((i) => i.free && i.free());
    return canvas;
  }

  // Image décodée (ImageBitmap, <img> ou canvas), orientation EXIF appliquée.
  async function decoder(fichier) {
    try {
      return await createImageBitmap(fichier, { imageOrientation: 'from-image' });
    } catch { /* format inconnu du navigateur : on essaie autrement */ }
    if (await estHeic(fichier)) return decoderHeic(fichier);
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
  const dimensions = (image) => ({ largeur: image.naturalWidth || image.width, hauteur: image.naturalHeight || image.height });

  function redessiner(image, coteMax) {
    const { largeur, hauteur } = dimensions(image);
    const echelle = Math.min(1, coteMax / Math.max(largeur, hauteur));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(largeur * echelle));
    canvas.height = Math.max(1, Math.round(hauteur * echelle));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; // une image transparente (capture d'écran PNG) devient blanche, pas noire
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  async function encoder(canvas, qualite) {
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', qualite));
    if (!blob) throw new Error('encodage');
    return blob;
  }

  // ── Contrôle de lisibilité ──
  // L'analyse porte sur une copie réduite à ~1 000 px, obtenue par moitiés successives (vraie moyenne des pixels).
  // Netteté : force des contours les plus francs = 99,9e centile du laplacien, mesuré après un léger lissage.
  //   (La « variance du laplacien » classique a été écartée au calibrage : elle confondait le grain de l'appareil
  //   photo avec de la netteté, et jugeait floue une carte d'identité nette mais peu remplie.)
  // Luminosité : moyenne des gris. Reflet : part des pixels « brûlés » (blanc pur sur les trois couleurs).
  function reduire(image, cote) {
    let source = image;
    let { largeur, hauteur } = dimensions(image);
    while (Math.max(largeur, hauteur) > 2 * cote) {
      largeur = Math.round(largeur / 2);
      hauteur = Math.round(hauteur / 2);
      const moitie = document.createElement('canvas');
      moitie.width = largeur;
      moitie.height = hauteur;
      const ctx = moitie.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, largeur, hauteur);
      source = moitie;
    }
    return redessiner(source, cote);
  }
  function analyser(image) {
    const { largeur, hauteur } = dimensions(image);
    const petit = reduire(image, COTE_ANALYSE);
    const w = petit.width;
    const h = petit.height;
    const rgba = petit.getContext('2d').getImageData(0, 0, w, h).data;
    const gris = new Float32Array(w * h);
    let somme = 0;
    let brules = 0;
    for (let i = 0, p = 0; p < gris.length; i += 4, p += 1) {
      const g = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      gris[p] = g;
      somme += g;
      if (rgba[i] >= 250 && rgba[i + 1] >= 250 && rgba[i + 2] >= 250) brules += 1;
    }
    // Lissage 3 × 3 : atténue le grain du capteur sans effacer les bords des lettres.
    const lisse = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        let t = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) t += gris[(y + dy) * w + x + dx];
        lisse[y * w + x] = t / 9;
      }
    }
    // Histogramme du laplacien (par quarts d'unité) pour trouver le 99,9e centile sans trier.
    const histo = new Uint32Array(1024);
    let n = 0;
    for (let y = 2; y < h - 2; y += 1) {
      for (let x = 2; x < w - 2; x += 1) {
        const p = y * w + x;
        const lap = Math.abs(lisse[p - 1] + lisse[p + 1] + lisse[p - w] + lisse[p + w] - 4 * lisse[p]);
        histo[Math.min(1023, Math.round(lap * 4))] += 1;
        n += 1;
      }
    }
    let contours = 0;
    for (let i = 0, cumul = 0; i < 1024; i += 1) {
      cumul += histo[i];
      if (cumul >= n * 0.999) { contours = i / 4; break; }
    }
    // Ramené au contraste de la photo (écart entre gris foncés et gris clairs) : une photo sombre mais nette
    // n'est pas jugée floue ; c'est la luminosité qui le signale.
    const histoGris = new Uint32Array(256);
    for (let p = 0; p < gris.length; p += 1) histoGris[Math.min(255, Math.round(gris[p]))] += 1;
    const centile = (q) => {
      for (let i = 0, cumul = 0; i < 256; i += 1) { cumul += histoGris[i]; if (cumul >= gris.length * q) return i; }
      return 255;
    };
    const contraste = Math.max(20, centile(0.99) - centile(0.01));
    return {
      petitCote: Math.min(largeur, hauteur),
      nettete: Math.min(255, (contours * 255) / contraste),
      luminosite: somme / gris.length,
      reflet: (100 * brules) / gris.length,
    };
  }
  // Premier défaut trouvé, dans l'ordre où il faut le corriger ; null si la photo est lisible.
  // Une image presque entièrement « brûlée » est surexposée dans son ensemble, pas victime d'un reflet localisé.
  function verdict(m) {
    if (m.petitCote < L.petit_cote_min_px) return 'petite';
    if (m.luminosite < L.luminosite_min) return 'sombre';
    if (m.luminosite > L.luminosite_max) return 'claire';
    if (m.nettete < L.nettete_min) return 'floue';
    if (m.reflet > L.reflet_max_pourcent) return m.reflet > 40 ? 'claire' : 'reflet';
    return null;
  }
  window.controleLisibilite = { analyser, verdict }; // pour les tests de bout en bout et la calibration

  // Une préparation ne doit jamais rester bloquée : au-delà du délai, on abandonne avec un message clair.
  function avecDelai(promesse, secondes, message) {
    let minuteur;
    const limite = new Promise((ok, ko) => { minuteur = setTimeout(() => ko(new Error(message)), secondes * 1000); });
    return Promise.race([promesse, limite]).finally(() => clearTimeout(minuteur));
  }

  // ── PDF « désarmé » : chaque page devient une image JPEG ──
  async function pagesDuPdf(fichier) {
    const lib = await chargerPdfjs();
    // Aucun script du PDF n'est exécuté : le moteur correspondant (quickjs) n'est même pas servi par l'application.
    const chargement = lib.getDocument({
      data: new Uint8Array(await fichier.arrayBuffer()),
      wasmUrl: '/vendor/pdfjs/wasm/',
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      enableXfa: false,
      stopAtErrors: false,
    });
    let doc;
    try {
      doc = await chargement.promise;
    } catch {
      chargement.destroy();
      throw new Error(MSG.pdf_lecture);
    }
    try {
      if (doc.numPages > PAGES_MAX) throw new Error(MSG.pdf_pages);
      const blobs = [];
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        // Environ 150 points par pouce pour une page A4 (petit côté ≈ 1 240 pixels), grand côté plafonné.
        const echelle = Math.min(1240 / Math.min(base.width, base.height), REGLAGES.photo.cote_max_px / Math.max(base.width, base.height));
        const vue = page.getViewport({ scale: echelle });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vue.width);
        canvas.height = Math.floor(vue.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // intent « print » : rendu d'une traite, sans attendre l'affichage de l'écran (requestAnimationFrame),
        // qui peut ne jamais venir si le salarié change d'application pendant la préparation (vu le 17/10/2026).
        await page.render({ canvas, canvasContext: ctx, viewport: vue, intent: 'print' }).promise;
        blobs.push(await encoder(canvas, REGLAGES.photo.qualite_jpeg));
        page.cleanup();
      }
      return blobs;
    } finally {
      chargement.destroy(); // libère le « worker » et la mémoire du document
    }
  }

  // ── Taille de la pièce : recompression progressive jusqu'à l'objectif (le serveur refuse au-delà du plafond) ──
  async function alleger(blobs) {
    const objectif = REGLAGES.pdf.objectif_ko * 1024;
    const total = (liste) => liste.reduce((t, b) => t + b.size, 0);
    if (total(blobs) <= objectif) return blobs;
    let meilleur = blobs;
    for (const [qualite, reduction] of [[0.75, 1], [0.65, 0.85], [0.55, 0.7], [0.5, 0.6]]) {
      const essai = [];
      for (const blob of blobs) {
        const image = await createImageBitmap(blob);
        const { largeur, hauteur } = dimensions(image);
        // On ne descend pas sous la résolution minimale exigée pour la lisibilité (sauf si la photo l'était déjà).
        const plancher = Math.min(1, L.petit_cote_min_px / Math.min(largeur, hauteur));
        const facteur = Math.min(1, Math.max(reduction, plancher));
        essai.push(await encoder(redessiner(image, Math.max(largeur, hauteur) * facteur), qualite));
        if (image.close) image.close();
      }
      meilleur = essai;
      if (total(essai) <= objectif) break;
    }
    return meilleur;
  }

  // ── Formulaire d'une pièce ──

  function preparerFormulaire(form) {
    const choisis = new Map(); // emplacement → { blobs, pdf, nom, force }
    const echecs = new Map();  // emplacement → nombre de photos refusées
    let enPreparation = 0;     // photos en cours de traitement : valider maintenant enverrait une pièce incomplète
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

    // Message propre à un emplacement (défaut de la photo, bouton « envoyer quand même »).
    function controle(emplacement) {
      let zone = emplacement.querySelector('.controle');
      if (!zone) {
        zone = document.createElement('div');
        zone.className = 'controle';
        zone.setAttribute('role', 'alert');
        emplacement.appendChild(zone);
      }
      return zone;
    }
    function effacerControle(emplacement) {
      const zone = emplacement.querySelector('.controle');
      if (zone) zone.remove();
    }

    function vider(emplacement) {
      choisis.delete(emplacement);
      const apercu = emplacement.querySelector('.apercu');
      if (apercu.src) URL.revokeObjectURL(apercu.src);
      apercu.hidden = true;
      apercu.removeAttribute('src');
      emplacement.querySelector('.nom-fichier').hidden = true;
      emplacement.classList.remove('rempli', 'a-verifier');
      effacerControle(emplacement);
    }

    function accepter(emplacement, entree) {
      choisis.set(emplacement, entree);
      const apercu = emplacement.querySelector('.apercu');
      apercu.src = URL.createObjectURL(entree.blobs[0]);
      apercu.hidden = false;
      if (entree.pdf) {
        const nom = emplacement.querySelector('.nom-fichier');
        nom.textContent = `PDF : ${entree.nom} (${entree.blobs.length} page${entree.blobs.length > 1 ? 's' : ''})`;
        nom.hidden = false;
      }
      emplacement.classList.add('rempli');
      emplacement.classList.toggle('a-verifier', Boolean(entree.force));
    }

    // Photo refusée : message, puis au bout de N échecs, possibilité de l'envoyer quand même.
    function refuser(emplacement, defaut, blob) {
      const n = (echecs.get(emplacement) || 0) + 1;
      echecs.set(emplacement, n);
      const zone = controle(emplacement);
      zone.textContent = '';
      const p = document.createElement('p');
      p.className = 'erreur-champ';
      p.textContent = MSG[defaut];
      zone.appendChild(p);
      if (n >= L.echecs_avant_forcer) {
        const aide = document.createElement('p');
        aide.textContent = MSG.forcer;
        const bouton = document.createElement('button');
        bouton.type = 'button';
        bouton.className = 'bouton secondaire forcer';
        bouton.textContent = MSG.bouton_forcer;
        bouton.addEventListener('click', () => {
          effacerControle(emplacement);
          accepter(emplacement, { blobs: [blob], pdf: false, force: true });
        });
        zone.append(aide, bouton);
      }
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
        if (await estPdf(fichier)) {
          dire('Préparation du PDF…');
          const blobs = await avecDelai(pagesDuPdf(fichier), 60, MSG.pdf_lecture);
          accepter(emplacement, { blobs, pdf: true, nom: fichier.name });
        } else {
          let image;
          try {
            image = await avecDelai(decoder(fichier), 60, MSG.heic);
          } catch {
            throw new Error((await estHeic(fichier)) ? MSG.heic : 'Cette photo n\'a pas pu être lue. Reprenez-la avec le bouton « Prendre une photo ».');
          }
          const mesure = analyser(image);
          const blob = await encoder(redessiner(image, REGLAGES.photo.cote_max_px), REGLAGES.photo.qualite_jpeg);
          if (image.close) image.close();
          const defaut = verdict(mesure);
          if (defaut) refuser(emplacement, defaut, blob);
          else {
            echecs.delete(emplacement);
            accepter(emplacement, { blobs: [blob], pdf: false });
          }
        }
        dire('');
      } catch (erreur) {
        dire(erreur.message || 'Ce fichier n\'a pas pu être lu.', true);
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
        // La copie ne doit rien garder de la page 1 : surtout pas l'adresse de son aperçu, que vider() libérerait
        // (l'aperçu de la page 1 deviendrait alors une image cassée).
        copie.querySelector('.apercu').removeAttribute('src');
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

      boutonValider.disabled = true;
      try {
        dire('Préparation de l\'envoi…');
        const blobs = await alleger(remplis.flatMap((r) => r.blobs));
        const donnees = new FormData();
        const choix = form.querySelector('input[name="choix"]:checked');
        if (choix) donnees.append('choix', choix.value);
        if (pdf) donnees.append('source', 'pdf');
        if (remplis.some((r) => r.force)) donnees.append('a_verifier', '1');
        blobs.forEach((b, i) => donnees.append('fichier', b, `page-${i + 1}.jpg`));

        dire('Envoi en cours… Gardez cette page ouverte.');
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
