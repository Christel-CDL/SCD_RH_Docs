// Fabrique, dans le navigateur, des photos de documents ENTIÈREMENT FICTIFS (aucune donnée réelle) pour calibrer
// et tester le contrôle de lisibilité : document A4 ou carte, net ou flou, sombre, surexposé, avec reflet, grain du capteur.
// Injecté tel quel dans la page (Playwright, ou console du navigateur) : définit window.fictifs.
window.fictifs = (() => {
  // Flou de mise au point, calculé pixel par pixel (trois passes de moyenne glissante ≈ flou gaussien de rayon « flou ») :
  // le résultat est identique dans tous les navigateurs. (Le filtre « blur » du canvas n'existe pas dans Safari, et les
  // réductions-agrandissements y laissent des bords en escalier : la photo « floue » y restait nette.)
  function flouter(c, flou) {
    if (!flou) return;
    const w = c.width;
    const h = c.height;
    const x = c.getContext('2d');
    const image = x.getImageData(0, 0, w, h);
    const p = image.data;
    const tampon = new Float32Array(Math.max(w, h));
    const r = Math.max(1, Math.round(flou));
    const passe = (debut, pas, n) => {
      for (let canal = 0; canal < 3; canal += 1) {
        for (let i = 0; i < n; i += 1) tampon[i] = p[debut + i * pas + canal];
        let somme = 0;
        for (let i = -r; i <= r; i += 1) somme += tampon[Math.min(n - 1, Math.max(0, i))];
        for (let i = 0; i < n; i += 1) {
          p[debut + i * pas + canal] = somme / (2 * r + 1);
          somme += tampon[Math.min(n - 1, i + r + 1)] - tampon[Math.max(0, i - r)];
        }
      }
    };
    for (let tour = 0; tour < 3; tour += 1) {
      for (let y = 0; y < h; y += 1) passe(y * w * 4, 4, w);
      for (let xx = 0; xx < w; xx += 1) passe(xx * 4, w * 4, h);
    }
    x.putImageData(image, 0, 0);
  }

  function grain(x, largeur, hauteur, { lumiere = 1, reflet = 0, bruit = 6 }) {
    const d = x.getImageData(0, 0, largeur, hauteur);
    const p = d.data;
    const cx = largeur * 0.55;
    const cy = hauteur * 0.4;
    const r = Math.sqrt(reflet) * largeur * 0.5;
    for (let i = 0, k = 0; i < p.length; i += 4, k += 1) {
      let boost = 0;
      if (reflet) {
        const dd = Math.hypot((k % largeur) - cx, ((k / largeur) | 0) - cy) / r;
        if (dd < 1) boost = 400 * (1 - dd * dd);
      }
      const n = (Math.random() - 0.5) * 2 * bruit;
      for (let j = 0; j < 3; j += 1) p[i + j] = Math.max(0, Math.min(255, p[i + j] * lumiere + boost + n));
    }
    x.putImageData(d, 0, 0);
  }

  // Page A4 posée sur une table, légèrement tournée, couverte de texte.
  function page({ flou = 0, lumiere = 1, reflet = 0, largeur = 3024, hauteur = 4032, bruit = 6, echelleDoc = 0.8 } = {}) {
    const c = document.createElement('canvas');
    c.width = largeur;
    c.height = hauteur;
    const x = c.getContext('2d');
    x.fillStyle = '#7a5c3e';
    x.fillRect(0, 0, largeur, hauteur);
    const dw = largeur * echelleDoc;
    const dh = dw * 1.414;
    x.save();
    x.translate(largeur / 2, hauteur / 2);
    x.rotate(0.03);
    x.fillStyle = '#f4f2ec';
    x.fillRect(-dw / 2, -dh / 2, dw, dh);
    x.fillStyle = '#222';
    const t = Math.round(dw / 45);
    x.font = `bold ${t * 2}px sans-serif`;
    x.fillText('DOCUMENT FICTIF', -dw / 2 + t * 2, -dh / 2 + t * 4);
    x.font = `${t}px sans-serif`;
    for (let i = 0; i < 40; i += 1) {
      x.fillText(`Ligne fictive ${i} : texte de démonstration sans donnée réelle 0123456789`, -dw / 2 + t * 2, -dh / 2 + t * 8 + i * t * 1.6);
    }
    x.restore();
    flouter(c, flou);
    grain(x, largeur, hauteur, { lumiere, reflet, bruit });
    return c;
  }

  // Carte au format carte d'identité (peu de texte), en paysage.
  function carte({ flou = 0, lumiere = 1, reflet = 0, bruit = 6 } = {}) {
    const L = 4032;
    const H = 3024;
    const c = document.createElement('canvas');
    c.width = L;
    c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#9a9a96';
    x.fillRect(0, 0, L, H);
    const w = L * 0.75;
    const h = w / 1.586;
    x.save();
    x.translate(L / 2, H / 2);
    x.fillStyle = '#dfe8ef';
    x.fillRect(-w / 2, -h / 2, w, h);
    x.fillStyle = '#c9b8a6';
    x.fillRect(-w / 2 + 80, -h / 2 + 300, 700, 900);
    x.fillStyle = '#223';
    x.font = 'bold 110px sans-serif';
    x.fillText('CARTE FICTIVE', -w / 2 + 900, -h / 2 + 200);
    x.font = '80px sans-serif';
    ['NOM : ZZ TEST', 'Prénom : Fictif', 'Né le : 01.01.1990', 'à : Nullepart'].forEach((ligne, i) => x.fillText(ligne, -w / 2 + 900, -h / 2 + 420 + i * 150));
    x.restore();
    flouter(c, flou);
    grain(x, L, H, { lumiere, reflet, bruit });
    return c;
  }

  // PDF fictif de plusieurs pages avec du texte (police standard non incluse), des métadonnées (/Info)
  // et une action JavaScript à l'ouverture : rien de tout cela ne doit survivre au « désarmement ».
  function pdf(nbPages = 2) {
    const objets = [
      '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
      `<< /Type /Pages /Kids [${Array.from({ length: nbPages }, (_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${nbPages} >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    for (let i = 1; i <= nbPages; i += 1) {
      const texte = `BT /F1 28 Tf 60 760 Td (DOCUMENT FICTIF page ${i}) Tj 0 -40 Td /F1 14 Tf (Attestation fictive - aucune donnee reelle) Tj ET`;
      objets.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * (i - 1)} 0 R >>`);
      objets.push(`<< /Length ${texte.length} >>\nstream\n${texte}\nendstream`);
    }
    objets.push('<< /Author (Personne Secrete) /Producer (Logiciel Fictif) >>');
    let s = '%PDF-1.4\n';
    const positions = [];
    objets.forEach((o, i) => { positions.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = s.length;
    s += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
    s += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R /Info ${objets.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new File([s], 'attestation-fictive.pdf', { type: 'application/pdf' });
  }

  // Canvas → fichier JPEG, comme celui que renverrait l'appareil photo.
  async function fichier(canvas, nom = 'photo.jpg') {
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.92));
    return new File([blob], nom, { type: 'image/jpeg' });
  }

  // Place un fichier dans un champ <input type="file"> et déclenche « change », comme un choix du salarié.
  function choisir(input, f) {
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return { page, carte, pdf, fichier, choisir };
})();
