// Lapilli: the Images tab, for lapilli.js. Qwen Image 2.1 is made by stable-diffusion.cpp's sd-server (leejet, MIT license), which
// this server runs as a second engine on the same GPUs (serve/images.py): an image takes the GPUs from the chat model, and the
// next chat message takes them back. Loaded just before lapilli.js; it only defines the Imagier object: lapilli.js calls
// Imagier.init() once its helpers ($, esc, nf, ic, annonce, memoire, entetes, refus...) exist, Imagier.montrer() when the tab
// opens and Imagier.mesures(m) with each /metrics reading. The images are kept in this browser (IndexedDB), like the
// conversations; nothing is sent anywhere but to this server.
"use strict";

const Imagier = (() => {
  // the model card's sizes, each side a multiple of 32: about 1 megapixel (Standard) and about 4 (Large)
  const FORMATS = [
    {v: "1:1", l: 1, h: 1, standard: [1024, 1024], grand: [2048, 2048]},
    {v: "4:3", l: 4, h: 3, standard: [1184, 896], grand: [2400, 1792]},
    {v: "3:2", l: 3, h: 2, standard: [1248, 832], grand: [2528, 1696]},
    {v: "16:9", l: 16, h: 9, standard: [1376, 768], grand: [2752, 1536]},
    {v: "3:4", l: 3, h: 4, standard: [896, 1184], grand: [1792, 2400]},
    {v: "2:3", l: 2, h: 3, standard: [832, 1248], grand: [1696, 2528]},
    {v: "9:16", l: 9, h: 16, standard: [768, 1376], grand: [1536, 2752]},
  ];
  // the server's limits (GET /api/images gives them; these until it answers)
  const LIMITES = {side_min: 256, side_max: 2816, area_max: 2400 * 1792, multiple: 32, refs_max: 4, count_max: 4, steps_max: 100, cfg_max: 20};
  // the models until the server answers: GET /api/images gives their list, in its order (a new model on the server shows here
  // by itself)
  const MODELES = {turbo: {label: "Qwen Image 2.1 Turbo", description: "Fast. Makes images, and edits them from reference images.",
                           available: true, steps: 8, cfg: 1, fixed: true, refs: "optional", edit: true},
                   base: {label: "Qwen Image 2.1", description: "Slower and finer, with guidance and a negative prompt.",
                          available: true, steps: 40, cfg: 6, fixed: false, refs: "optional", edit: true}};
  const INCONNU = {description: "", available: false, steps: 20, cfg: 4, fixed: false, refs: "optional", edit: false};
  // steps and guidance are kept per model: each one has its own (Qwen Image 2.1: 40 and 6; Edit 2511: 40 and 4)
  const DEFAUTS = {prompt: "", negatif: "", modele: "turbo", format: "1:1", taille: "standard", largeur: 1024, hauteur: 1024,
                   nombre: 1, etapesPar: {}, guidagePar: {}, graine: "", duree: 2};
  // a video model (Wan 2.2): its size by area for the chosen shape: Standard ~832×480, Large ~1280×704 (720p, the
  // model's own); its duration in seconds, as frames: 1 + step·k at the model's frame rate, frames_max at most
  const VIDEO_STD = 832 * 480, VIDEO_HD = 1280 * 704;
  const DUREES = [1, 2, 3, 5];
  const ACTIFS = ["queued", "waiting", "switching", "starting", "generating"];
  const REF_OCTETS = 12 * 1048576;                     // a reference image above this is made smaller before it is sent
  const PAR_PAGE = 48;

  let reglages = null;
  let etat = null;                 // GET /api/images: the models, the limits, the jobs
  let refs = [];                   // the reference images: {url (data: URL), nom, l, h, apercu (object URL)}
  let travail = null;              // this page's job: {id, vue (the server's view), decalage (server clock - ours, s), vu}
  let minuterie = null, enVol = false, dernierSuivi = 0;
  let galerie = [];                // the images kept in this browser, newest first
  let base = null, stockage = "attente";               // IndexedDB; "ok", or "absent" (private window, blocked storage)
  const vignettes = new Map();     // image id -> object URL of its thumbnail
  let montres = PAR_PAGE;
  let scene = {mode: "", cle: "", url: null, choix: 0};
  let resume = null;               // /metrics' "images": the job using the GPUs, whoever sent it
  const iv = {index: -1, url: null, retour: null};

  const lim = () => ({...LIMITES, ...((etat && etat.limits) || {})});
  const modele = (k) => ({label: k, ...INCONNU, ...(MODELES[k] || {}), ...(((etat && etat.models) || {})[k] || {})});
  const listeModeles = () => Object.keys((etat && etat.models) || MODELES);
  const actif = () => !!travail && ACTIFS.includes(travail.vue.state);
  const estVideo = (k = reglages.modele) => modele(k).kind === "video";
  function nbImages(m = modele(reglages.modele)) {     // a video's frames for the chosen duration
    const fps = m.fps || 24, pas = m.frames_step || 4, max = m.frames_max || 121;
    return Math.min(max, 1 + pas * Math.max(1, Math.round((reglages.duree || 2) * fps / pas)));
  }
  const maxRefs = (m = modele(reglages.modele)) => Math.min(lim().refs_max, m.refs_max || lim().refs_max);
  const motDe = (v) => v && (v.kind === "video" || modele((v.params || {}).model).kind === "video") ? "video" : "image";   // a job's
  const ratio = (l, h) => `${l} / ${h}`;
  const taillePx = (l, h) => `${l} × ${h}`;
  // a server's message as a sentence (its first letter capital, a final period); an excerpt cut at a word, with "..."
  const phrase = (t) => { const x = String(t || "").trim(); return x ? x[0].toUpperCase() + x.slice(1) + (/[.!?…]$/.test(x) ? "" : ".") : ""; };
  const extrait = (t, n = 80) => { const x = String(t || "").replace(/\s+/g, " ").trim(); if (x.length <= n) return x; const c = x.slice(0, n); const i = c.lastIndexOf(" "); return `${(i > n / 2 ? c.slice(0, i) : c).replace(/[,;:.\s]+$/, "")}…`; };
  function duree(s) {
    if (s == null || !Number.isFinite(s)) return "–";
    if (s < 60) return `${nf(s, s < 10 ? 1 : 0)} s`;
    const m = Math.floor(s / 60), r = Math.round(s - m * 60);
    return r ? `${m} min ${r} s` : `${m} min`;
  }

  // ------------------------------------------------------------------ the form
  // "Large" for a model that can make it (an edit model makes about 1 megapixel at most on this GPU: Standard then)
  const grandPossible = (m = modele(reglages.modele)) => m.kind === "video" || !m.area_max || m.area_max >= 2048 * 2048 * 0.9;
  function tailleAire(a, aire) {                       // a shape a = l/h at about this area, each side a multiple of 32
    const L = lim(), mo = modele(reglages.modele), m = L.multiple;
    const arr = (x) => Math.max(L.side_min, Math.min(L.side_max, Math.round(x / m) * m));
    let l = arr(Math.sqrt(aire * a)), h = arr(Math.sqrt(aire / a));
    return sousLeCap(l, h, a, Math.min(L.area_max, mo.area_max || Infinity), m, L.side_min);
  }
  function taille() {
    if (reglages.format === "libre") return [reglages.largeur, reglages.hauteur];
    if (estVideo()) {
      const aire = reglages.taille === "grand" ? VIDEO_HD : VIDEO_STD;
      if (reglages.format === "reference" && refs.length) return tailleAire(refs[0].l / refs[0].h, aire);
      const f = FORMATS.find((x) => x.v === reglages.format) || FORMATS[0];
      return tailleAire(f.l / f.h, aire);
    }
    const grand = reglages.taille === "grand" && grandPossible();
    if (reglages.format === "reference" && refs.length) return tailleRef(refs[0], grand);
    const f = FORMATS.find((x) => x.v === reglages.format) || FORMATS[0];
    return grand ? f.grand : f.standard;
  }
  // the shape of the first reference image (an edit keeps its photo's proportions), at about 1 megapixel (Standard) or 4
  // (Large), each side a multiple of 32
  // (seen in HIS test: "928 × 960" for a 1:1 video in Large) above the model's area, step down the side, or both sides,
  // that keep the chosen shape best (the larger area at an equal shape): one side only was shrunk, so a square was not one
  function sousLeCap(l, h, a, cap, m, min) {
    while (l * h > cap) {
      const choix = [[l - m, h], [l, h - m], [l - m, h - m]].filter(([x, y]) => x >= min && y >= min);
      if (!choix.length) break;
      const ecart = ([x, y]) => Math.abs(x / y / a - 1);
      choix.sort((p, q) => ecart(p) - ecart(q) || q[0] * q[1] - p[0] * p[1]);
      [l, h] = choix[0];
    }
    return [l, h];
  }
  function tailleRef(r, grand) {
    const L = lim(), mo = modele(reglages.modele);
    const aire = Math.min(grand ? Math.min(L.area_max, 2048 * 2048) : 1024 * 1024, mo.area_max || Infinity), a = r.l / r.h, m = L.multiple;
    const arr = (x) => Math.max(L.side_min, Math.min(L.side_max, Math.round(x / m) * m));
    let l = arr(Math.sqrt(aire * a)), h = arr(Math.sqrt(aire / a));
    return sousLeCap(l, h, a, Math.min(L.area_max, mo.area_max || Infinity), m, L.side_min);
  }
  function refusTaille(l, h) {
    const L = lim(), m = modele(reglages.modele);
    if (!(l >= L.side_min && l <= L.side_max && h >= L.side_min && h <= L.side_max)) return `Each side from ${L.side_min} to ${L.side_max} pixels.`;
    if (l * h > L.area_max) return `At most ${nf(L.area_max / 1e6, 1)} megapixels, ${taillePx(2400, 1792)} for example.`;
    if (m.area_max && l * h > m.area_max) return `The ${m.label} model makes ${m.kind === "video" ? "videos" : "images"} of ${nf(m.area_max / 1e6, 1)} megapixels at most here.`;
    return "";
  }
  // (measured) an edit model reads its references TOGETHER at up to "refs_area_max" pixels (the server publishes it:
  // beyond, the edits drift, whatever the GPU): when they are larger, all are made smaller by one factor when sent (each
  // keeps its shape, and its share: a small one stays small)
  function echelleRefs(m) {                            // the factor applied to every reference when sent (1: as they are)
    const somme = refs.reduce((a, r) => a + r.l * r.h, 0);
    return m.refs_area_max && somme > m.refs_area_max ? Math.sqrt(m.refs_area_max / somme) : 1;
  }
  const auMultiple = (v) => {
    const L = lim(), n = Math.round((+v || 0) / L.multiple) * L.multiple;
    return Math.min(L.side_max, Math.max(L.side_min, n));
  };
  const etapesDe = (k) => { const m = modele(k), v = (reglages.etapesPar || {})[k]; return m.fixed || v == null ? m.steps : v; };
  const guidageDe = (k) => { const m = modele(k), v = (reglages.guidagePar || {})[k]; return m.fixed || v == null ? m.cfg : v; };
  const etapes = () => etapesDe(reglages.modele);
  const guidage = () => guidageDe(reglages.modele);

  let minuterieGarde = null;
  function garder(tout = true) {
    clearTimeout(minuterieGarde);
    minuterieGarde = setTimeout(() => memoire.ecrire("images.reglages", reglages), tout ? 0 : 400);
  }
  function cocher(boite, v) { for (const b of boite.children) b.setAttribute("aria-checked", String(b.dataset.v === String(v))); }

  function construireFormats() {
    $("im-format").innerHTML = FORMATS.map((f) => {
      const k = 22 / Math.max(f.l, f.h);
      return `<button type="button" role="radio" class="im-format" data-v="${f.v}" title="${esc(`${f.v}: ${taillePx(...f.standard)} or ${taillePx(...f.grand)}`)}">` +
        `<span class="im-format__forme" style="width:${(f.l * k).toFixed(1)}px;height:${(f.h * k).toFixed(1)}px"></span><span>${f.v}</span></button>`;
    }).join("") + `<button type="button" role="radio" class="im-format" data-v="libre" title="Your own width and height">` +
      `<span class="im-format__forme" style="width:20px;height:15px"></span><span>Custom</span></button>` +
      `<button type="button" role="radio" class="im-format im-format--ref" data-v="reference" title="The proportions of the first reference image" hidden>` +
      `<span class="im-format__forme"></span><span class="im-format__ref">Same shape as the reference</span></button>`;
  }

  // the model list, built again only when the server's list changes (a click, a key or a reading keep their button)
  let modelesCle = "";
  function construireModeles() {
    const ks = listeModeles();
    const cle = JSON.stringify(ks.map((k) => [k, modele(k).label]));
    if (cle === modelesCle) return;
    modelesCle = cle;
    $("im-modele").innerHTML = ks.map((k) => `<button type="button" role="radio" class="im-modele" data-v="${esc(k)}">` +
      `<span class="im-modele__tete"><span class="im-modele__nom">${esc(modele(k).label)}</span><span class="im-modele__pas"></span></span>` +
      `<span class="im-modele__aide"></span></button>`).join("");
    for (const b of $("im-modele").children) b.onclick = () => { reglages.modele = b.dataset.v; garder(); dessinerForm(); };
  }

  function dessinerForm() {
    const L = lim();
    construireModeles();
    for (const b of $("im-modele").children) {
      const k = b.dataset.v, m = modele(k);
      b.disabled = !m.available;
      b.querySelector(".im-modele__pas").textContent = m.kind === "video" ? `video · ${nf(etapesDe(k))} steps` : `${nf(etapesDe(k))} steps`;
      b.querySelector(".im-modele__aide").textContent = m.available ? m.description : "Its files are not on the server.";
    }
    cocher($("im-modele"), reglages.modele);
    // "Same shape as the reference": offered once there is a reference image, its shape drawn from it
    const bRef = $("im-format").querySelector('[data-v="reference"]');
    if (!refs.length && reglages.format === "reference") { reglages.format = "1:1"; garder(); }
    bRef.hidden = !refs.length;
    if (refs.length) {
      const r = refs[0], k = 22 / Math.max(r.l, r.h), forme = bRef.querySelector(".im-format__forme");
      forme.style.width = `${(r.l * k).toFixed(1)}px`; forme.style.height = `${(r.h * k).toFixed(1)}px`;
    }
    bRef.title = estVideo() ? "The proportions of the start image" : "The proportions of the first reference image";
    bRef.querySelector(".im-format__ref").textContent = estVideo() ? "Same shape as the start image" : "Same shape as the reference";
    $("im-titre").textContent = estVideo() ? "Create a video" : "Create an image";
    cocher($("im-format"), reglages.format);
    const libre = reglages.format === "libre";
    $("im-taille-champ").hidden = libre;
    $("im-libre").hidden = !libre;
    // "Large": off for a model that makes about 1 megapixel at most (an edit model on this GPU)
    const bGrand = $("im-taille").querySelector('[data-v="grand"]');
    bGrand.disabled = !grandPossible();
    bGrand.title = bGrand.disabled ? `The ${modele(reglages.modele).label} model makes images of about 1 megapixel at most here` : "";
    cocher($("im-taille"), reglages.taille === "grand" && !grandPossible() ? "standard" : reglages.taille);
    const [l, h] = taille();
    $("o-im-format").textContent = libre ? "your own size" : reglages.format === "reference" ? (estVideo() ? "like the start image" : "like the reference") : reglages.format;
    $("o-im-taille").textContent = taillePx(l, h);
    if (libre) {
      if (document.activeElement !== $("im-largeur")) $("im-largeur").value = reglages.largeur;
      if (document.activeElement !== $("im-hauteur")) $("im-hauteur").value = reglages.hauteur;
      const non = refusTaille(l, h);
      $("im-libre-note").textContent = non || `${nf(l * h / 1e6, 1)} megapixels; each side is a multiple of ${L.multiple}.`;
      $("im-libre-note").classList.toggle("im-faux", !!non);
    }
    for (const b of $("im-nombre").children) b.disabled = +b.dataset.v > L.count_max;
    cocher($("im-nombre"), reglages.nombre);
    $("o-im-nombre").textContent = reglages.nombre > 1 ? "one after the other" : "";
    // a video: its duration (frames at the model's rate); one video at a time (no number of images)
    const video = estVideo(), mv = modele(reglages.modele);
    $("im-duree-champ").hidden = !video;
    $("im-nombre-champ").hidden = video;
    if (video) {
      if (!DUREES.includes(+reglages.duree)) reglages.duree = 2;
      cocher($("im-duree"), String(reglages.duree));
      $("o-im-duree").textContent = `${nf(nbImages(mv))} frames at ${nf(mv.fps || 24)} fps`;
    }
    const mc = modele(reglages.modele), fixe = !!mc.fixed;
    const et = $("im-etapes"), gu = $("im-guidage");
    et.max = String(L.steps_max); gu.max = String(L.cfg_max);
    et.disabled = fixe; gu.disabled = fixe; $("im-negatif").disabled = fixe;
    et.value = String(etapes());
    gu.value = String(guidage());
    $("o-im-etapes").textContent = fixe ? `${nf(etapes())}, set by the model` : nf(etapes());
    $("o-im-guidage").textContent = fixe ? "set by the model" : nf(guidage(), 1);
    $("im-turbo-note").hidden = !fixe;
    $("im-turbo-note").textContent = `The ${mc.label} model sets its own steps and guidance, and does not use a negative prompt: these settings are for the other models.`;
    if (document.activeElement !== $("im-graine")) $("im-graine").value = reglages.graine;
    if (document.activeElement !== $("im-negatif")) $("im-negatif").value = reglages.negatif;
    dessinerRefs();
    dessinerPied();
    if (scene.mode === "vide") dessinerScene();       // the empty frame takes the chosen shape
  }

  function dessinerRefs() {
    const L = lim(), m = modele(reglages.modele), requis = m.refs === "required";
    const boite = $("im-refs");
    boite.textContent = "";
    refs.forEach((r, i) => {
      const c = document.createElement("div");
      c.className = "im-ref"; c.setAttribute("role", "listitem");
      c.innerHTML = `<img alt=""><button type="button" class="btn btn--icone" title="Remove" aria-label="Remove ${esc(r.nom)}">${ic("croix")}</button>`;
      c.querySelector("img").src = r.apercu;
      c.querySelector("img").alt = r.nom;
      c.title = `${r.nom} · ${taillePx(r.l, r.h)}`;
      c.querySelector("button").onclick = () => { URL.revokeObjectURL(r.apercu); refs.splice(i, 1); dessinerForm(); };
      boite.appendChild(c);
    });
    const video = m.kind === "video", plafond = maxRefs(m);
    $("lib-im-refs").firstChild.textContent = video ? "Start image " : "Reference images ";
    if (refs.length < plafond) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "im-ref__ajouter"; b.id = "im-ajouter";
      b.innerHTML = `${ic("plus", "ic ic--p")}<span>Add</span>`;
      b.disabled = !m.edit;
      b.title = video ? "Add the image the video starts from (or drop it here, or paste it in the prompt)"
        : m.edit ? "Add a reference image (or drop it here, or paste it in the prompt)" : "The server has no vision projector: editing is off";
      b.classList.toggle("im-ref__ajouter--requis", requis && !refs.length && m.edit);
      b.onclick = () => $("im-fichiers").click();
      boite.appendChild(b);
    }
    $("o-im-refs").textContent = refs.length ? `${nf(refs.length)} of ${nf(plafond)}` : requis ? "required" : "optional";
    const reduite = echelleRefs(m) < 1;
    $("im-refs-note").textContent = video
      ? (refs.length > plafond ? "A video starts from one image: remove the others."
        : refs.length ? "The video starts from this image: say in the prompt what happens next."
        : "To bring an image to life, add it here: the video starts from it.")
      : !m.edit
      ? "Editing needs the vision projector (mmproj) in the server's text_encoders folder."
      : reduite ? `Say in the prompt what to change. This model reads its references together at up to ${nf(m.refs_area_max / 1e6, 2)} megapixels here: they are made smaller when sent.`
      : refs.length ? "Say in the prompt what to change, or how to combine them."
      : requis ? "This model edits an image you give it: add it here, then say in the prompt what to change."
      : "To change an image or combine several, add them here and say what to do in the prompt.";
  }

  function dessinerPied() {
    const occupe = actif();
    $("im-generer").hidden = occupe;
    $("im-arreter").hidden = !occupe;
    const m = modele(reglages.modele);
    const [l, h] = taille();
    const manque = m.available && m.refs === "required" && !refs.length;   // an editing model with nothing to edit
    const trop = refs.length > maxRefs(m);           // a video starts from one image
    const non = !m.available || !!refusTaille(l, h) || (refs.length > 0 && !m.edit) || manque || trop;
    $("im-generer").disabled = non || enVoi;
    const autre = resume && resume.job && (!travail || resume.job.id !== travail.id) ? resume.job : null;
    $("im-pied-note").innerHTML = occupe ? "" : manque ? esc("Add the image to edit first.")
      : trop ? esc("A video starts from one image: remove the others.") : autre
      ? esc(`The GPUs are making another ${motDe(autre)}${autre.source === "openai" ? " (API)" : ""}: yours will follow.`)
      : estTactile() ? "" : `<span class="im-raccourci">Ctrl+Enter: generate</span>`;
  }

  // ------------------------------------------------------------------ reference images
  const enDataUrl = (blob) => new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(r.result); r.onerror = () => ko(r.error); r.readAsDataURL(blob);
  });
  async function preparerRef(blob, nom) {
    const bmp = await createImageBitmap(blob);
    const L = lim();
    let l = bmp.width, h = bmp.height, envoi = blob;
    const k = Math.min(1, Math.sqrt(L.area_max / (l * h)), L.side_max / Math.max(l, h));
    if (k < 1 || blob.size > REF_OCTETS || !/^image\/(png|jpeg|webp)$/.test(blob.type)) {
      // too large for the server (or for the GPU): drawn smaller, as a JPEG for a photo, a PNG otherwise
      l = Math.max(1, Math.round(l * Math.min(k, 1))); h = Math.max(1, Math.round(h * Math.min(k, 1)));
      const c = document.createElement("canvas");
      c.width = l; c.height = h;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, l, h);
      envoi = await new Promise((ok) => c.toBlob(ok, blob.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.92));
      if (!envoi) throw new Error("the image could not be redrawn");
    }
    if (bmp.close) bmp.close();
    return {url: await enDataUrl(envoi), nom: nom || "image", l, h, blob: envoi, apercu: URL.createObjectURL(envoi)};
  }
  // the references as sent: within the model's share (an edit model), drawn smaller from their own picture when needed
  async function refsPour(m) {
    const k = echelleRefs(m);
    const out = [];
    for (const r of refs) {
      if (k >= 1) { out.push(r.url); continue; }
      const w = Math.max(16, Math.floor(r.l * k / 16) * 16), ht = Math.max(16, Math.floor(r.h * k / 16) * 16);
      const bmp = await createImageBitmap(r.blob);
      const c = document.createElement("canvas");
      c.width = w; c.height = ht;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, w, ht);
      if (bmp.close) bmp.close();
      const b = await new Promise((ok) => c.toBlob(ok, r.blob.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.92));
      out.push(await enDataUrl(b));
    }
    return out;
  }
  async function ajouterRefs(fichiers, quoi = "") {
    const L = lim();
    if (!modele(reglages.modele).edit) { annonce("alerte", "Editing is off", "The server has no vision projector (mmproj).", 6000); return false; }
    let ajoutees = 0;
    const plafond = maxRefs();
    for (const f of fichiers) {
      if (refs.length >= plafond) {
        if (plafond < L.refs_max) annonce("alerte", "One start image at most", "A video starts from one image: remove it to add another.", 5000);
        else annonce("alerte", `${nf(L.refs_max)} reference images at most`, "Remove one to add another.", 5000);
        break;
      }
      if (!/^image\//.test(f.type || "")) { annonce("alerte", "Not an image", `${f.name || "This file"}: PNG, JPEG or WebP.`, 6000); continue; }
      try {
        refs.push(await preparerRef(f, f.name || quoi));
        ajoutees++;
      } catch (e) {
        annonce("erreur", "This image could not be read", `${f.name || quoi || "image"}: ${e.message || e}`, 8000);
      }
    }
    dessinerForm();                                   // the "Same shape as the reference" tile follows the first one
    return ajoutees > 0;
  }

  // ------------------------------------------------------------------ a job: sent, followed, kept
  let enVoi = false;
  async function generer() {
    if (actif() || enVoi) return;
    const prompt = $("im-prompt").value.trim();
    if (!prompt) {
      $("im-prompt").focus();
      const q = estVideo() ? "video" : "image";
      annonce("alerte", `Describe the ${q} first`, `The prompt says what the ${q} shows.`, 4000);
      return;
    }
    const m = modele(reglages.modele);
    const [l, h] = taille();
    const video = m.kind === "video";
    const non = !m.available ? `${m.label}: its files are not on the server.` : m.refs === "required" && !refs.length
      ? `The ${m.label} model edits images: add the image to edit.` : refs.length > maxRefs(m)
      ? "A video starts from one image: remove the others." : refusTaille(l, h);
    if (non) { annonce("alerte", video ? "This video cannot be made" : "This image cannot be made", non, 6000); return; }
    // the seed comes from this page, so that "Use settings" makes the same image again
    const fixe = /^\d+$/.test(String(reglages.graine).trim()) ? +reglages.graine : null;
    const graine = fixe != null ? fixe : Math.floor(Math.random() * 2147483647);
    const req = {prompt, model: reglages.modele, width: l, height: h, seed: graine, ...(video ? {frames: nbImages(m)} : {count: reglages.nombre})};
    if (!m.fixed) {                                     // a model with its own schedule (the Turbo) gets neither
      req.steps = etapes(); req.cfg = guidage();
      if (reglages.negatif.trim()) req.negative_prompt = reglages.negatif.trim();
    }
    enVoi = true; dessinerPied();
    try {
      if (refs.length) req.refs = await refsPour(m);
      const r = await fetch("api/images/jobs", {method: "POST", headers: entetes(true), body: JSON.stringify(req), signal: delai(60000)});
      if (!r.ok) throw await refus(r);
      const v = await avecDelai(r.json(), 30000, "the server");
      travail = {id: v.id, vue: v, decalage: (v.now || Date.now() / 1000) - Date.now() / 1000, vu: false};
      memoire.ecrire("images.travail", {id: v.id});
      if (matchMedia("(max-width: 900px)").matches) $("im-scene").scrollIntoView({block: "start", behavior: "smooth"});
    } catch (e) {
      annonce("erreur", video ? "The video could not be started" : "The image could not be started", e.message || String(e), 8000);
    }
    enVoi = false;
    dessinerPied(); dessinerScene();
    if (travail && actif()) suivre();
  }

  // every wait of the follow-up has its limit: a real window once stayed on "Decoding" for 6 minutes after
  // a Turbo image the server had made in 15 s (a wait that never ended, not reproduced); now a reading that hangs is
  // abandoned and read again, a step of the end (the image, its thumbnail, the gallery) that hangs is passed by
  const delai = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  const avecDelai = (promesse, ms, quoi) => new Promise((ok, ko) => {
    const h = setTimeout(() => ko(new Error(`${quoi}: no answer in ${Math.round(ms / 1000)} s`)), ms);
    promesse.then((v) => { clearTimeout(h); ok(v); }, (e) => { clearTimeout(h); ko(e); });
  });
  // (21:10, seen twice by the real window, traced) the body of the image's answer (3.5 MB) stopped on its way for 100 s,
  // then for more than 120 s, while the other readings went on: the image is read as it comes, a transfer without a byte
  // for 15 s is abandoned and asked again (4 times at most). It also crawled (a few bytes now and then, 234 s and
  // more) between two machines just after an edit, while the same image read on the server's own machine took 0.012 s, and read
  // again 0.01 s: a transfer longer than 30 s (3.5 MB on a local network: less than 120 KB/s) is asked again too
  async function lireJson(url, quoi, calme = 15000, total = 30000, progres = null) {
    return JSON.parse(new TextDecoder().decode(await lireOctets(url, quoi, calme, total, progres)));
  }
  // the body's bytes, read as they come. By XMLHttpRequest: its "progress" events tell each piece that arrives (the
  // stall watch), and a body read whole is never reported as cancelled, where a fetch read piece by piece was, about one time
  // in two in Chromium although all its bytes came (measured on the bench: 9 reads of 20 of a 0.9 MB MP4, "(canceled)")
  // "total" Infinity: no limit while bytes come (15 s without one still stops it); "progres(received, size)" at each piece
  function lireOctets(url, quoi, calme = 15000, total = 30000, progres = null) {
    return new Promise((ok, ko) => {
      const x = new XMLHttpRequest();
      let h = null, fini = false;
      const clore = () => { fini = true; clearTimeout(h); clearTimeout(fin); };
      const lacher = () => { if (fini) return; clore(); x.abort(); ko(new Error(`${quoi}: the transfer stopped or crawled`)); };
      const fin = Number.isFinite(total) ? setTimeout(lacher, total) : null;
      const reveil = () => { clearTimeout(h); h = setTimeout(lacher, calme); };
      x.open("GET", url);
      x.responseType = "arraybuffer";
      for (const [k, v] of Object.entries(entetes())) x.setRequestHeader(k, v);
      x.setRequestHeader("Cache-Control", "no-cache");
      x.onprogress = (e) => { reveil(); if (progres) progres(e.loaded, e.lengthComputable ? e.total : 0); };
      x.onload = () => {
        if (fini) return;
        clore();
        if (x.status >= 200 && x.status < 300) ok(new Uint8Array(x.response));
        else refus(new Response(x.response, {status: x.status})).then(ko, ko);   // the server's refusal, its message
      };
      x.onerror = () => { if (!fini) { clore(); ko(new Error(`${quoi}: the transfer failed`)); } };
      reveil();
      x.send();
    });
  }
  async function suivre() {
    clearTimeout(minuterie);
    if (!travail || enVol) return;
    enVol = true;
    dernierSuivi = Date.now();
    const t = travail;
    let fini = null;
    try {
      const r = await fetch(`api/images/jobs/${encodeURIComponent(t.id)}?images=0`, {cache: "no-store", headers: entetes(), signal: delai(15000)});
      if (r.status === 404) {
        // the server restarted: its jobs are gone
        enVol = false;
        if (travail === t) {
          memoire.ecrire("images.travail", null);
          travail = null;
          annonce("alerte", `The ${motDe(t.vue)} was lost`, "The server restarted before it was finished.", 8000);
          dessinerPied(); dessinerScene();
        }
        return;
      }
      if (!r.ok) throw await refus(r);
      const v = await avecDelai(r.json(), 15000, "the job's state");
      const avant = `${t.vue.state}/${(t.vue.progress || {}).stage || ""}`;
      t.vue = v; t.decalage = (v.now || Date.now() / 1000) - Date.now() / 1000; t.echecs = 0;
      // the header's pill reads /metrics once a second: read now when the job changes state or stage, so that it says the
      // same thing as the scene (seen at 1 s behind on the bench: "Idle" while the GPUs switched)
      if (`${v.state}/${(v.progress || {}).stage || ""}` !== avant) relever();
      if (typeof mesures !== "undefined" && mesures) dessinerPastille(mesures);   // the pill follows each reading of the job
      if (!ACTIFS.includes(v.state)) fini = v;
    } catch (e) {
      t.echecs = (t.echecs || 0) + 1;
    }
    if (fini) {
      try { await terminer(t, fini); } catch (e) { annonce("erreur", `The ${motDe(fini)} could not be kept`, e.message || String(e), 8000); }
    }
    enVol = false;
    if (travail !== t) return;
    dessinerPied(); dessinerScene();
    if (actif()) minuterie = setTimeout(suivre, document.hidden ? 2000 : t.echecs > 2 ? 3000 : 500);
  }

  function arreter() {
    if (!travail || !actif()) return;
    const id = travail.id;
    $("im-arreter").disabled = true;
    fetch(`api/images/jobs/${encodeURIComponent(id)}/cancel`, {method: "POST", headers: entetes(true), body: "{}"})
      .then(async (r) => { if (!r.ok) throw await refus(r); })
      .catch((e) => annonce("erreur", `The ${motDe(travail && travail.vue)} could not be stopped`, e.message || String(e), 6000))
      .finally(() => { $("im-arreter").disabled = false; suivre(); });
  }

  const b64EnBlob = (b64, type) => {
    const s = atob(b64), o = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
    return new Blob([o], {type});
  };
  async function faireVignette(blob) {
    try {
      const bmp = await avecDelai(createImageBitmap(blob), 10000, "the thumbnail");
      const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return await avecDelai(new Promise((ok) => c.toBlob((b) => ok(b || blob), "image/webp", 0.86)), 10000, "the thumbnail");
    } catch (e) { console.warn("[images]", e && e.message); return blob; }
  }

  // a finished video's file: read as it comes (an MP4 of 5 s at 1280×704 is some 10 MB), asked again 4 times; the
  // last try has no total limit while bytes come (a slow link still brings it, the scene showing how far)
  async function lireFichier(t, quoi, type, total, progres = null) {
    for (let essai = 1; ; essai++) {
      try {
        return new Blob([await lireOctets(`api/images/jobs/${encodeURIComponent(t.id)}/${quoi}`, `the ${quoi}`, 15000,
                                          essai >= 4 ? Infinity : total, progres)], {type});
      } catch (e) {
        if (essai >= 4 || (e && e.statut)) throw e;     // a refusal of the server (404…) is not read again
        console.warn("[images]", e && e.message, `: asked again (${essai + 1} of 4)`);
      }
    }
  }
  // a finished job's file on its way: the scene says it, with the bytes received (the real window, through a link at
  // 4 KB/s, stayed minutes on "Decoding the frames · almost done" while the MP4 came)
  function montrerReception(t, quoi, recu, total) {
    if (travail !== t) return;
    const el = $("im-scene"), q = (r) => el.querySelector(`[data-r="${r}"]`);
    if (!q("etape") || !q("plein")) return;
    const mo = (o) => nf(o / 1048576, o < 10 * 1048576 ? 1 : 0);
    q("etape").textContent = total ? `Receiving the ${quoi} · ${mo(recu)} of ${mo(total)}\u00a0MB` : `Receiving the ${quoi}`;
    q("reste").textContent = "";
    q("barre").removeAttribute("data-attente");
    q("plein").style.width = `${((total ? Math.min(1, recu / total) : 1) * 100).toFixed(1)}%`;
  }
  async function terminer(t, v) {
    memoire.ecrire("images.travail", null);
    const p = v.params || {};
    const video = v.kind === "video" || modele(p.model).kind === "video";
    if (v.state === "completed" && video) {
      const info = v.video || {};
      const affiche = info.poster ? await lireFichier(t, "poster", "image/jpeg", 30000) : null;
      // at 100 KB/s at least (else asked again, a new connection being often fast again), 30 s at least
      const mp4 = await lireFichier(t, "video", "video/mp4", Math.max(30000, (info.bytes || 0) / 100),
                                    (recu, n) => montrerReception(t, "video", recu, n || info.bytes || 0));
      const m = modele(p.model);
      const fiche = {id: `${v.id}-0`, travail: v.id, index: 0, nombre: 1, cree: Date.now(), prompt: p.prompt || "",
                     negatif: p.negative_prompt || "", modele: p.model, largeur: p.width, hauteur: p.height,
                     etapes: p.steps != null ? p.steps : m.steps, guidage: p.cfg != null ? p.cfg : m.cfg,
                     graine: p.seed != null && p.seed >= 0 ? p.seed : null, refs: v.refs || 0,
                     duree: v.finished && v.created ? v.finished - v.created : null, png: null, video: mp4, affiche,
                     images: info.frames || p.frames, fps: info.fps || m.fps || 24, son: !!info.audio,
                     vignette: affiche ? await faireVignette(affiche) : null};
      const ecriture = garderImages([fiche]);
      t.vu = true;
      scene.choix = 0;
      dessinerGalerie();
      dessinerScene();
      relever();
      if (vue !== "images") annonce("succes", "Your video is ready", "", 8000, {libelle: "Show", faire: () => montrerVue("images")});
      await ecriture;
      return;
    }
    if (v.state === "completed") {
      let plein = null;
      for (let essai = 1; !plein; essai++) {
        try {
          plein = await lireJson(`api/images/jobs/${encodeURIComponent(t.id)}`, "the image", 15000, essai >= 4 ? Infinity : 30000,
                                 (recu, n) => montrerReception(t, "image", recu, n));
        } catch (e) {
          if (essai >= 4 || (e && e.statut)) throw e;    // a refusal of the server (404…) is not read again
          console.warn("[images]", e && e.message, `: asked again (${essai + 1} of 4)`);
        }
      }
      const moment = Date.now(), fiches = [];
      const m = modele(p.model || "turbo");
      for (let i = 0; i < (plein.images || []).length; i++) {
        const png = b64EnBlob(plein.images[i], "image/png");
        fiches.push({id: `${v.id}-${i}`, travail: v.id, index: i, nombre: plein.images.length, cree: moment,
                     prompt: p.prompt || "", negatif: p.negative_prompt || "", modele: p.model || "turbo",
                     largeur: p.width, hauteur: p.height, etapes: p.steps != null ? p.steps : m.steps,
                     guidage: p.cfg != null ? p.cfg : m.cfg, graine: p.seed != null && p.seed >= 0 ? p.seed + i : null,
                     refs: v.refs || 0, duree: v.finished && v.created ? v.finished - v.created : null,
                     png, vignette: await faireVignette(png)});
      }
      const ecriture = garderImages(fiches);           // in the gallery at once; in the browser's storage after
      t.vu = true;                                    // the scene shows the images now
      scene.choix = 0;
      dessinerGalerie();
      dessinerScene();
      relever();                                      // the pill: "Image model loaded" now, not at the next reading
      if (vue !== "images") {
        annonce("succes", fiches.length > 1 ? "Your images are ready" : "Your image is ready", "", 8000,
                {libelle: "Show", faire: () => montrerVue("images")});
      }
      await ecriture;
    } else if (vue !== "images") {
      const quoi = video ? "video" : "image";
      annonce(v.state === "failed" ? "erreur" : "info", v.state === "failed" ? `The ${quoi} could not be made` : `The ${quoi} was stopped`,
              v.state === "failed" ? v.error || "" : "", 8000, {libelle: "Show", faire: () => montrerVue("images")});
    }
  }

  async function reprendre() {
    const garde = memoire.lire("images.travail", null);
    if (!garde || !garde.id || travail) return;
    travail = {id: garde.id, vue: {state: "queued", params: {}, progress: {}}, decalage: 0, vu: false};
    dessinerPied(); dessinerScene();
    suivre();
  }

  // ------------------------------------------------------------------ the gallery (IndexedDB)
  function ouvrirBase() {
    return new Promise((ok) => {
      let r;
      try { r = indexedDB.open("lapilli-images", 1); } catch (e) { ok(null); return; }
      r.onupgradeneeded = () => { r.result.createObjectStore("images", {keyPath: "id"}); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
      r.onblocked = () => ok(null);
    });
  }
  const requete = (mode, faire) => new Promise((ok, ko) => {
    const tr = base.transaction("images", mode);
    let res;
    const q = faire(tr.objectStore("images"));
    if (q) q.onsuccess = () => { res = q.result; };
    tr.oncomplete = () => ok(res);
    tr.onerror = () => ko(tr.error);
    tr.onabort = () => ko(tr.error || new Error("aborted"));
  });
  const ordre = (a, b) => b.cree - a.cree || (a.travail < b.travail ? 1 : a.travail > b.travail ? -1 : 0) || a.index - b.index;
  async function chargerGalerie() {
    if (!base) return;
    try {
      const toutes = await requete("readonly", (s) => s.getAll());
      const connues = new Set((toutes || []).map((f) => f.id));
      for (const [id, url] of vignettes) if (!connues.has(id)) { URL.revokeObjectURL(url); vignettes.delete(id); }
      galerie = (toutes || []).sort(ordre);
    } catch (e) { /* kept as it was */ }
  }
  async function garderImages(fiches) {
    galerie = fiches.concat(galerie.filter((g) => !fiches.some((f) => f.id === g.id))).sort(ordre);
    if (!base) return;
    try {
      await avecDelai(requete("readwrite", (s) => { for (const f of fiches) s.put(f); }), 20000, "the browser's storage");
    } catch (e) {
      annonce("alerte", "Not kept in this browser", e && e.name === "QuotaExceededError"
        ? `The browser's storage is full: delete some ${galerie.some((g) => g.video) ? "images or videos" : "images"} from the gallery.`
        : `The gallery could not be written (${e && e.name || e}).`, 10000);
    }
  }
  async function supprimer(id) {
    const i = galerie.findIndex((g) => g.id === id);
    if (i < 0) return;
    const [f] = galerie.splice(i, 1);
    if (base) { try { await requete("readwrite", (s) => s.delete(id)); } catch (e) { /* stays in the base: it comes back at the next visit */ } }
    const url = vignettes.get(id);
    if (url) { URL.revokeObjectURL(url); vignettes.delete(id); }
    dessinerGalerie(); dessinerScene();
    annonce("info", f.video ? "Video deleted" : "Image deleted", extrait(f.prompt), 7000, {libelle: "Undo", faire: async () => {
      await garderImages([f]);
      dessinerGalerie(); dessinerScene();
    }});
  }
  const vignette = (f) => {
    let u = vignettes.get(f.id);
    const source = f.vignette || f.png || f.affiche;
    if (!u && source) { u = URL.createObjectURL(source); vignettes.set(f.id, u); }
    return u || "";
  };

  function dessinerGalerie() {
    const boite = $("im-galerie");
    const n = galerie.length;
    const nv = galerie.filter((g) => g.video).length, ni = n - nv;
    $("im-galerie-note").innerHTML = morceaux([ni ? `${nf(ni)} ${ni > 1 ? "images" : "image"}` : "", nv ? `${nf(nv)} ${nv > 1 ? "videos" : "video"}` : "",
      stockage === "absent" ? "not kept: this browser blocks storage for this page" : "kept in this browser"]);
    if (!n) {
      const videos = Object.values((etat && etat.models) || {}).some((m) => m.kind === "video" && m.available);
      boite.innerHTML = `<p class="im-galerie__vide doux">The ${videos ? "images and videos" : "images"} you make are kept here, in this browser.</p>`;
      $("im-plus").hidden = true;
      return;
    }
    const vues = galerie.slice(0, montres);
    boite.textContent = "";
    for (const f of vues) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "im-vignette"; b.dataset.id = f.id;
      b.title = f.prompt;
      b.setAttribute("aria-label", `${f.video ? "Open the video" : "Open"}: ${f.prompt.slice(0, 120)}`);
      const img = document.createElement("img");
      img.alt = ""; img.loading = "lazy"; img.decoding = "async";
      const src = vignette(f);
      if (src) img.src = src;
      b.appendChild(img);
      if (f.video) {
        b.classList.add("im-vignette--video");
        const badge = document.createElement("span");
        badge.className = "im-vignette__badge";
        badge.innerHTML = `${ic("jouer", "ic ic--p")}<span>${esc(nf(secondes(f), secondes(f) % 1 ? 1 : 0))}\u00a0s</span>${f.son ? ic("son", "ic ic--p") : ""}`;
        if (f.son) badge.title = "With sound";
        b.appendChild(badge);
      }
      b.onclick = () => ouvrir(galerie.indexOf(f));
      boite.appendChild(b);
    }
    $("im-plus").hidden = n <= montres;
    $("im-plus").textContent = `Show more (${nf(n - montres)})`;
  }

  // ------------------------------------------------------------------ the scene: the image being made, or the last one
  function etapeDe(v, autre) {
    const p = v.progress || {}, n = (v.params || {}).count || 1;
    switch (v.state) {
      case "queued": return autre ? `After the ${motDe(resume && resume.job)} being made` : "Queued";
      case "waiting": {                               // its turn on the GPUs: why it waits, as /metrics tells it
        const l = typeof mesures !== "undefined" && mesures && mesures.live ? mesures.live.state : "";
        return ["reading", "generating"].includes(l) ? "Waiting for the GPUs: a response is being written"
          : l === "loading" ? "Waiting for the GPUs: a model is loading" : "Waiting for the GPUs";
      }
      case "switching": return "Unloading the chat model";
      case "starting": return `Starting the ${motDe(v)} model`;
      case "generating": break;
      default: return "";
    }
    const lot = n > 1 && p.pass >= 1 ? `Image ${nf(Math.min(p.pass, n))} of ${nf(n)} · ` : "";
    if (charge(p)) return `${lot}Loading the model · ${go(p.read_bytes)} of ${go(p.files_bytes)}\u00a0GB`;
    if (modele((v.params || {}).model).kind === "video") {
      switch (p.stage) {
        case "vae_encode": return "Reading the start image";
        case "sampling": return p.total ? `Step ${nf(p.completed || 0)} of ${nf(p.total)}` : "Drawing";
        case "vae_decode": return "Decoding the frames";
        case "audio_decode": return "Decoding the sound";
        case "encoding": return "Saving the video";
        default: return "Preparing";
      }
    }
    switch (p.stage) {
      case "vae_encode": return "Reading the reference images";
      case "preparing": case "conditioning": return `${lot}Preparing`;
      case "sampling": return p.total ? `${lot}Step ${nf(p.completed || 0)} of ${nf(p.total)}` : `${lot}Drawing`;
      case "vae_decode": return `${lot}Decoding`;
      case "encoding": return "Saving";
      default: return `${lot}Preparing`;               // the half second before the image server gives its first stage
    }
  }
  // (soir) after a change of model, sd-server reads the other model's files under "preparing" (3 min 15 s for the
  // Turbo's from a hard disk): the server measures the bytes read for the job ("read_bytes" of "files_bytes")
  const charge = (p) => !!(p.read_bytes && p.files_bytes) && !["sampling", "vae_decode", "audio_decode", "encoding", "vae_encode"].includes(p.stage);
  // a video's decoding: as long as its pace (measured on a V100, published by the server) says; and its steps, as
  // long as the last ones took (kept from the sampling stage: the decoding stage gives only its own time)
  // (LTX-2.3) [the frames, the sound]: sd-server decodes the sound after the frames ("audio_decode")
  function decodagesDe(v) {
    const p = v.params || {}, m = modele(p.model);
    if (m.kind !== "video" || !p.frames) return [0, 0];
    return [m.decode_us_per_px && p.width && p.height ? m.decode_us_per_px * p.width * p.height * p.frames / 1e6 : 0,
            (m.decode_audio_s_per_frame || 0) * p.frames];
  }
  const decodageDe = (v) => decodagesDe(v)[0] + decodagesDe(v)[1];
  // (measured by the real window and in the recordings) the pace of the steps, on sd-server's own clock: its stage time
  // at the first reading of each new step count. That clock starts late (0.4 s at step 1 for a step of 1.2 s): dividing it by
  // the steps gave half the pace at step 2, then a time left that climbed within each step (1 min 9 s → 1 min 28 s); now the
  // pace runs from the first step change seen to the last, and the time already spent in the current step is counted down
  function rythme(v) {
    const p = v.progress || {}, t = travail && travail.id === v.id ? travail : null;
    if (!t || p.stage !== "sampling" || !p.total || !(p.completed >= 1) || p.stage_elapsed_ms == null) return null;
    const passe = p.pass || 1;
    let r = t.rythme;
    if (!r || r.passe !== passe) r = t.rythme = {passe, k0: p.completed, e0: p.stage_elapsed_ms, k: p.completed, e: p.stage_elapsed_ms};
    else if (p.completed > r.k) { r.k = p.completed; r.e = p.stage_elapsed_ms; }
    if (r.k <= r.k0) return null;                      // one step count seen: no pace yet
    const parEtape = (r.e - r.e0) / 1000 / (r.k - r.k0);
    const dans = Math.min(parEtape, Math.max(0, (p.stage_elapsed_ms - r.e) / 1000));   // the current step, already spent
    return {parEtape, reste: Math.max(0, (p.total - r.k) * parEtape - dans)};
  }
  const tempsRond = (s) => { const r = Math.max(1, Math.round(s)); return r < 60 ? `${nf(r)} s` : duree(r); };
  function partVideo(v) {
    const p = v.progress || {}, dec = decodageDe(v), t = travail && travail.id === v.id ? travail : null;
    const ry = p.stage === "sampling" ? rythme(v) : null;
    if (ry && t) t.echantillonnage = {secondes: ry.parEtape * p.total};
    const ech = t && t.echantillonnage ? t.echantillonnage.secondes : 0;
    if (p.stage === "sampling" && p.total) {
      const fait = (p.completed || 0) / p.total;
      return ech && dec ? Math.min(0.99, fait * ech / (ech + dec)) : fait * 0.6;
    }
    const [decV, decA] = decodagesDe(v), el = (p.stage_elapsed_ms || 0) / 1000;
    if (p.stage === "vae_decode") {
      if (!ech || !dec) return 0.6;
      return Math.min(0.99, (ech + Math.min(decV, el)) / (ech + dec));
    }
    if (p.stage === "audio_decode") {
      if (!ech || !dec) return 0.9;
      return Math.min(0.99, (ech + decV + Math.min(decA, el)) / (ech + dec));
    }
    if (p.stage === "encoding") return 0.99;
    return null;
  }
  function resteVideo(v) {
    const p = v.progress || {}, dec = decodageDe(v);
    if (p.stage === "sampling") {
      const r = rythme(v);
      return r ? `about ${tempsRond(r.reste + dec + 2)} left` : "";
    }
    const [decV, decA] = decodagesDe(v), el = (p.stage_elapsed_ms || 0) / 1000;
    if ((p.stage === "vae_decode" && dec) || (p.stage === "audio_decode" && decA)) {
      const s = p.stage === "vae_decode" ? decV - el + decA : decA - el;
      return s >= 5 ? `about ${tempsRond(s)} left` : "almost done";
    }
    return "";
  }
  function partDe(v) {                                  // the share done (the model's files read, then the steps), or null
    const p = v.progress || {}, n = (v.params || {}).count || 1;
    if (v.state !== "generating") return null;
    if (charge(p)) return Math.min(1, p.read_bytes / p.files_bytes);
    if (modele((v.params || {}).model).kind === "video") return partVideo(v);
    const fait = Math.max(0, Math.min(n, (p.pass || 1) - 1));
    if (p.stage === "sampling" && p.total) return Math.min(1, (fait + (p.completed || 0) / p.total) / n);
    if (p.stage === "vae_decode" || p.stage === "encoding") return Math.min(1, (fait + 1) / n);
    return fait ? fait / n : null;
  }
  function resteDe(v) {                                 // the steps left at the pace of the steps done (sampling only)
    const p = v.progress || {}, n = (v.params || {}).count || 1;
    if (v.state === "generating" && modele((v.params || {}).model).kind === "video") return resteVideo(v);
    if (v.state !== "generating" || p.stage !== "sampling") return "";
    const r = rythme(v);
    if (!r) return "";
    const passes = Math.max(0, n - (p.pass || 1));
    return `about ${tempsRond(r.reste + r.parEtape * passes * p.total + 1.5 * (passes + 1))} left`;
  }

  function dessinerScene() {
    const el = $("im-scene");
    const t = travail;
    const enTravail = t && !t.vu && (actif() || t.vue.state === "failed" || t.vue.state === "cancelled");
    if (enTravail) return sceneTravail(el, t);
    const premiere = galerie[0];
    if (premiere) return sceneImages(el, galerie.filter((g) => g.travail === premiere.travail));
    return sceneVide(el);
  }
  function lacher() {
    if (scene.url) { URL.revokeObjectURL(scene.url); scene.url = null; }
    if (scene.affiche) { URL.revokeObjectURL(scene.affiche); scene.affiche = null; }
  }

  function sceneVide(el) {
    const [l, h] = taille(), video = estVideo();
    if (scene.mode !== "vide" || scene.cle !== (video ? "video" : "image")) {
      lacher();
      scene.mode = "vide"; scene.cle = video ? "video" : "image";
      el.innerHTML = `<div class="im-cadre im-cadre--vide"><div class="im-vide">${ic(video ? "video" : "image", "ic im-vide__ic")}
        <p class="im-vide__titre">Your ${video ? "video" : "image"} will appear here</p>
        <p class="doux petit">Describe it, then press Generate. The GPUs leave the chat model for the ${video ? "video" : "image"} model, and take it back at your next message.</p></div></div>`;
    }
    el.querySelector(".im-cadre").style.setProperty("--ar", ratio(l, h));
  }

  function sceneTravail(el, t) {
    const v = t.vue, p = v.params || {};
    const fin = !ACTIFS.includes(v.state);
    const cle = `travail:${t.id}:${fin ? v.state : "actif"}`;
    if (scene.cle !== cle) {
      lacher();
      scene.mode = "travail"; scene.cle = cle;
      el.innerHTML = `<div class="carte__tete"><span class="carte__titre" data-r="titre" role="status"></span>
          <span class="im-scene__tete-droite"><span class="doux petit" data-r="temps"></span>${fin
            ? `<button type="button" class="btn btn--icone btn--mini" data-r="fermer" title="Close" aria-label="Close">${ic("croix")}</button>` : ""}</span></div>
        <div class="im-cadre${fin ? ` im-cadre--${v.state}` : ""}" data-r="cadre">
          <img class="im-apercu" data-r="apercu" alt="" hidden>
          <div class="im-attente" data-r="attente">${fin ? `<span class="im-fin-ic">${ic(v.state === "failed" ? "erreur" : "arreter")}</span>` : ""}</div></div>
        <div class="im-progres"${fin ? " hidden" : ""}>
          <div class="barre" data-r="barre"><div class="barre__plein" data-r="plein"></div></div>
          <div class="im-progres__ligne"><span data-r="etape"></span><span class="doux" data-r="reste"></span></div></div>
        <p class="im-scene__message" data-r="message"${fin ? "" : " hidden"}></p>
        <p class="im-scene__prompt" data-r="prompt"></p>`;
      const x = el.querySelector('[data-r="fermer"]');
      if (x) x.onclick = () => { t.vu = true; dessinerScene(); };
    }
    const q = (r) => el.querySelector(`[data-r="${r}"]`);
    if (p.width && p.height) q("cadre").style.setProperty("--ar", ratio(p.width, p.height));
    else q("cadre").style.setProperty("--ar", ratio(...taille()));
    const autre = resume && resume.job && resume.job.id !== t.id;
    const video = v.kind === "video" || modele(p.model).kind === "video";
    q("titre").textContent = fin ? (v.state === "failed" ? `The ${video ? "video" : "image"} could not be made` : "Stopped")
      : video ? "Making your video" : (p.count || 1) > 1 ? "Making your images" : "Making your image";
    const debut = v.created || null;
    const maintenant = Date.now() / 1000 + (t.decalage || 0);
    q("temps").textContent = debut ? duree(Math.max(0, (fin && v.finished ? v.finished : maintenant) - debut)) : "";
    q("prompt").textContent = p.prompt || "";
    if (fin) {
      q("message").textContent = v.state === "failed" ? phrase(v.error || "the image server gave no reason")
        : `The ${video ? "video" : "image"} was stopped before it was finished.`;
      const img = q("apercu");                        // the last preview, if sampling had begun, behind the icon
      if (v.preview && !img.dataset.src) { img.src = `data:image/png;base64,${v.preview}`; img.dataset.src = "fin"; img.hidden = false; }
      return;
    }
    q("etape").textContent = etapeDe(v, autre);
    q("reste").textContent = resteDe(v);
    const part = partDe(v);
    q("barre").toggleAttribute("data-attente", part == null);
    q("plein").style.width = part == null ? "" : `${(part * 100).toFixed(1)}%`;
    const img = q("apercu");
    if (v.preview) {
      const src = `data:image/png;base64,${v.preview}`;
      if (img.dataset.src !== v.preview.slice(-32)) { img.src = src; img.dataset.src = v.preview.slice(-32); }
      img.hidden = false; q("attente").hidden = true;
    } else {
      img.hidden = true; q("attente").hidden = false;
    }
  }

  function sceneVideo(el, f) {                         // the last video: it plays at once, muted, in a loop
    const cle = `video:${f.id}`;
    if (scene.cle === cle) return;
    lacher();
    scene.mode = "images"; scene.cle = cle;
    scene.url = URL.createObjectURL(f.video);
    scene.affiche = f.affiche ? URL.createObjectURL(f.affiche) : null;
    el.innerHTML = `<div class="carte__tete"><span class="carte__titre" role="status">Last video</span>
        <span class="doux petit">${esc(quand(f.cree))}</span></div>
      <div class="im-cadre im-cadre--video"><video controls loop muted playsinline autoplay preload="auto"></video></div>
      <p class="im-scene__prompt"></p>
      <p class="petit doux im-scene__infos">${morceaux(infos(f))}</p>
      <div class="carte__pied im-actions">${actions(true, f)}</div>`;
    el.querySelector(".im-cadre").style.setProperty("--ar", ratio(f.largeur, f.hauteur));
    const v = el.querySelector("video");
    if (scene.affiche) v.poster = scene.affiche;
    v.src = scene.url;
    v.setAttribute("aria-label", f.prompt);
    el.querySelector(".im-scene__prompt").textContent = f.prompt;
    brancherActions(el, () => f);
  }
  function sceneImages(el, fiches) {
    if (fiches[0] && fiches[0].video) return sceneVideo(el, fiches[0]);
    if (scene.choix >= fiches.length) scene.choix = 0;
    const f = fiches[scene.choix];
    const cle = `images:${fiches.map((x) => x.id).join(",")}:${scene.choix}`;
    if (scene.cle === cle) return;
    lacher();
    scene.mode = "images"; scene.cle = cle;
    scene.url = URL.createObjectURL(f.png);
    const plusieurs = fiches.length > 1;
    el.innerHTML = `<div class="carte__tete"><span class="carte__titre" role="status">${plusieurs ? "Last images" : "Last image"}</span>
        <span class="doux petit">${esc(quand(f.cree))}</span></div>
      <button type="button" class="im-cadre im-cadre--image" data-r="ouvrir" title="Open in full size"><img alt=""></button>
      ${plusieurs ? `<div class="im-bande" role="radiogroup" aria-label="Images of this run">${fiches.map((x, i) =>
        `<button type="button" role="radio" class="im-bande__img" aria-checked="${i === scene.choix}" data-i="${i}" aria-label="Image ${i + 1}"><img alt="" src="${vignette(x)}"></button>`).join("")}</div>` : ""}
      <p class="im-scene__prompt"></p>
      <p class="petit doux im-scene__infos">${morceaux(infos(f))}</p>
      <div class="carte__pied im-actions">${actions()}</div>`;
    el.querySelector(".im-cadre").style.setProperty("--ar", ratio(f.largeur, f.hauteur));
    const img = el.querySelector(".im-cadre img");
    img.src = scene.url; img.alt = f.prompt;
    el.querySelector(".im-scene__prompt").textContent = f.prompt;
    el.querySelector('[data-r="ouvrir"]').onclick = () => ouvrir(galerie.indexOf(f));
    for (const b of el.querySelectorAll(".im-bande__img")) b.onclick = () => { scene.choix = +b.dataset.i; dessinerScene(); };
    brancherActions(el, () => f);
  }
  const secondes = (f) => (f.images - 1) / (f.fps || 24);
  function infos(f) {
    const m = modele(f.modele), propre = !m.fixed;     // steps and guidance said for a model that takes them
    if (f.video) {
      return [m.label, taillePx(f.largeur, f.hauteur), `${nf(secondes(f), secondes(f) % 1 ? 1 : 0)} s at ${nf(f.fps)} fps`, f.son ? "with sound" : "",
              propre ? `${nf(f.etapes)} steps` : "", propre ? `guidance ${nf(f.guidage, 1)}` : "", f.graine != null ? `seed ${f.graine}` : "",
              f.refs ? "from a start image" : "", f.duree ? `made in ${duree(f.duree)}` : ""];
    }
    return [m.label, taillePx(f.largeur, f.hauteur), propre ? `${nf(f.etapes)} steps` : "",
            propre ? `guidance ${nf(f.guidage, 1)}` : "", f.graine != null ? `seed ${f.graine}` : "",
            f.refs ? `${nf(f.refs)} reference${f.refs > 1 ? "s" : ""}` : "", f.duree ? `made in ${duree(f.duree)}` : ""];
  }
  const actions = (texte = true, f = null) => [["telecharger", "exporter", "Download"], ...(f && f.video ? [] : [["reference", "joindre", "Use as reference"]]),
    ["reglages", "regenerer", "Use settings"], ["supprimer", "corbeille", "Delete"]].map(([a, i, l]) =>
    `<button type="button" class="btn btn--doux btn--petit" data-a="${a}" title="${l}" aria-label="${l}">${ic(i, "ic ic--p")}${texte ? `<span class="btn__texte">${l}</span>` : ""}</button>`).join("");
  function brancherActions(el, fiche) {
    for (const b of el.querySelectorAll("[data-a]")) {
      b.onclick = () => {
        const f = fiche();
        if (!f) return;
        if (b.dataset.a === "telecharger") telecharger(f);
        if (b.dataset.a === "reference") utiliserCommeRef(f);
        if (b.dataset.a === "reglages") reprendreReglages(f);
        if (b.dataset.a === "supprimer") { if (iv.index >= 0) fermer(); supprimer(f.id); }
      };
    }
  }

  // ------------------------------------------------------------------ what can be done with an image
  function telecharger(f) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f.video || f.png);
    const d = new Date(f.cree), z = (x) => String(x).padStart(2, "0");
    a.download = `lapilli-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}` +
      `${f.graine != null ? `-${f.graine}` : ""}${f.nombre > 1 ? `-${f.index + 1}` : ""}.${f.video ? "mp4" : "png"}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function utiliserCommeRef(f) {
    if (iv.index >= 0) fermer();
    const ok = await ajouterRefs([new File([f.png], `image ${f.graine != null ? f.graine : f.id}.png`, {type: "image/png"})]);
    if (ok) {
      annonce("succes", "Added as a reference image", "Say in the prompt what to change.", 4000);
      $("im-prompt").focus();
      if (matchMedia("(max-width: 900px)").matches) $("im-form").scrollIntoView({block: "start", behavior: "smooth"});
    }
  }
  function reprendreReglages(f) {
    if (iv.index >= 0) fermer();
    if (f.video) return reprendreVideo(f);
    const forme = FORMATS.find((x) => (x.standard[0] === f.largeur && x.standard[1] === f.hauteur) || (x.grand[0] === f.largeur && x.grand[1] === f.hauteur));
    reglages = {...reglages, prompt: f.prompt, negatif: f.negatif || "", modele: modele(f.modele).available ? f.modele : reglages.modele,
                format: forme ? forme.v : "libre", taille: forme && forme.grand[0] === f.largeur && forme.grand[1] === f.hauteur ? "grand" : "standard",
                largeur: f.largeur, hauteur: f.hauteur, nombre: 1, graine: f.graine != null ? String(f.graine) : ""};
    const m = modele(f.modele);
    if (!m.fixed) {
      reglages.etapesPar = {...(reglages.etapesPar || {}), [f.modele]: f.etapes};
      reglages.guidagePar = {...(reglages.guidagePar || {}), [f.modele]: f.guidage};
    }
    $("im-prompt").value = reglages.prompt;
    garder(); dessinerForm(); compter();
    if (!m.fixed || f.graine != null) $("im-avance").open = true;
    // its reference images are not kept with it: an edit needs them again
    annonce("info", "Settings applied", `Its prompt, model, size and seed are in the form.${f.refs ? " Add its reference image again." : ""}`, f.refs ? 7000 : 4000);
    if (matchMedia("(max-width: 900px)").matches) $("im-form").scrollIntoView({block: "start", behavior: "smooth"});
    $("im-prompt").focus();
  }

  function reprendreVideo(f) {
    const garde = reglages.modele;
    reglages = {...reglages, modele: modele(f.modele).available ? f.modele : reglages.modele};
    // its size: the shape and the class that make it, else its own width and height
    let forme = null;
    for (const t of ["standard", "grand"]) {
      for (const x of FORMATS) {
        reglages.taille = t;
        reglages.format = x.v;
        const [l, h] = taille();
        if (!forme && l === f.largeur && h === f.hauteur) forme = {format: x.v, taille: t};
      }
    }
    const d = DUREES.reduce((a, b) => Math.abs(b - secondes(f)) < Math.abs(a - secondes(f)) ? b : a, DUREES[0]);
    reglages = {...reglages, prompt: f.prompt, negatif: f.negatif || "", format: forme ? forme.format : "libre",
                taille: forme ? forme.taille : "standard", largeur: f.largeur, hauteur: f.hauteur, duree: d,
                graine: f.graine != null ? String(f.graine) : "",
                etapesPar: {...(reglages.etapesPar || {}), [f.modele]: f.etapes},
                guidagePar: {...(reglages.guidagePar || {}), [f.modele]: f.guidage}};
    if (!modele(f.modele).available) reglages.modele = garde;
    $("im-prompt").value = reglages.prompt;
    garder(); dessinerForm(); compter();
    $("im-avance").open = true;
    annonce("info", "Settings applied", `Its prompt, model, size, duration and seed are in the form.${f.refs ? " Add its start image again." : ""}`, f.refs ? 7000 : 4000);
    if (matchMedia("(max-width: 900px)").matches) $("im-form").scrollIntoView({block: "start", behavior: "smooth"});
    $("im-prompt").focus();
  }

  // ------------------------------------------------------------------ the viewer
  function ouvrir(i) {
    if (i < 0 || i >= galerie.length) return;
    if (iv.index < 0) iv.retour = document.activeElement;
    iv.index = i;
    dessinerVisionneuse();
    $("im-visionneuse").hidden = false;
    $("iv-fermer").focus();
  }
  function fermer() {
    if (iv.index < 0) return;
    iv.index = -1;
    $("im-visionneuse").hidden = true;
    lacherVisionneuse();
    if (iv.retour && iv.retour.isConnected) iv.retour.focus();
  }
  function lacherVisionneuse() {
    const v = $("iv-video");
    v.pause(); v.removeAttribute("src"); v.removeAttribute("poster"); v.load();
    $("iv-img").removeAttribute("src");
    if (iv.url) { URL.revokeObjectURL(iv.url); iv.url = null; }
    if (iv.affiche) { URL.revokeObjectURL(iv.affiche); iv.affiche = null; }
  }
  function dessinerVisionneuse() {
    const f = galerie[iv.index];
    if (!f) { fermer(); return; }
    lacherVisionneuse();
    iv.url = URL.createObjectURL(f.video || f.png);
    const v = $("iv-video"), video = !!f.video;
    $("iv-img").hidden = video; v.hidden = !video;
    if (video) {
      if (f.affiche) { iv.affiche = URL.createObjectURL(f.affiche); v.poster = iv.affiche; }
      v.src = iv.url;
      v.setAttribute("aria-label", f.prompt);
      v.play().catch(() => { /* the browser may wait for a click: its controls are there */ });
    } else {
      $("iv-img").src = iv.url;
    }
    $("iv-img").alt = f.prompt;
    const ref = $("iv-actions").querySelector('[data-a="reference"]');
    if (ref) ref.hidden = video;
    const voisin = (i) => galerie[i] && galerie[i].video ? "video" : "image";
    for (const [id, i, mot] of [["iv-avant", iv.index - 1, "Previous"], ["iv-apres", iv.index + 1, "Next"]]) {
      $(id).title = `${mot} ${voisin(i)}`; $(id).setAttribute("aria-label", `${mot} ${voisin(i)}`);
    }
    $("iv-titre").textContent = `${nf(iv.index + 1)} of ${nf(galerie.length)}`;
    $("iv-prompt").textContent = f.prompt;
    $("iv-infos").innerHTML = morceaux([quand(f.cree), ...infos(f)]);
    $("iv-avant").disabled = iv.index <= 0;
    $("iv-apres").disabled = iv.index >= galerie.length - 1;
  }
  const aller = (d) => { const i = iv.index + d; if (i >= 0 && i < galerie.length) { iv.index = i; dessinerVisionneuse(); } };

  // ------------------------------------------------------------------ the server's state
  async function lireEtat() {
    try {
      const r = await fetch("api/images", {cache: "no-store", headers: entetes()});
      if (!r.ok) throw await refus(r);
      etat = await r.json();
      if (!modele(reglages.modele).available) {           // the chosen model is not on the server: the first one that is
        const k = listeModeles().find((x) => modele(x).available);
        if (k) reglages.modele = k;
      }
      lireNote();
      // a job of this page that the server still runs (sent from another tab, or before a reload)
      if (!travail && Array.isArray(etat.jobs)) {
        const garde = memoire.lire("images.travail", null);
        if (garde && etat.jobs.some((j) => j.id === garde.id)) reprendre();
      }
    } catch (e) { /* the defaults stay; the next opening reads it again */ }
    dessinerForm();
  }

  function compter() {
    const n = $("im-prompt").value.length;
    $("o-im-prompt").textContent = n > 3000 ? `${nf(n)} of ${nf(4000)}` : "";
  }

  // ------------------------------------------------------------------ wiring
  function init() {
    reglages = {...DEFAUTS, ...memoire.lire("images.reglages", {})};
    if (typeof reglages.modele !== "string") reglages.modele = "turbo";
    // steps and guidance were one pair for the Base model; they are kept per model now
    if (reglages.etapes != null) reglages.etapesPar = {base: reglages.etapes, ...(reglages.etapesPar || {})};
    if (reglages.guidage != null) reglages.guidagePar = {base: reglages.guidage, ...(reglages.guidagePar || {})};
    delete reglages.etapes; delete reglages.guidage;
    construireFormats();
    $("im-prompt").value = reglages.prompt;
    compter();
    $("im-prompt").addEventListener("input", () => { reglages.prompt = $("im-prompt").value; garder(false); compter(); });
    $("im-prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generer(); }
    });
    $("im-prompt").addEventListener("paste", (e) => {      // a pasted image becomes a reference image
      const fs = [...((e.clipboardData || {}).files || [])].filter((f) => f.type.startsWith("image/"));
      if (!fs.length) return;
      e.preventDefault();
      ajouterRefs(fs, "pasted image");
    });
    $("im-negatif").addEventListener("input", () => { reglages.negatif = $("im-negatif").value; garder(false); });
    for (const b of $("im-format").children) b.onclick = () => { reglages.format = b.dataset.v; garder(); dessinerForm(); };
    for (const b of $("im-taille").children) b.onclick = () => { reglages.taille = b.dataset.v; garder(); dessinerForm(); };
    for (const b of $("im-nombre").children) b.onclick = () => { reglages.nombre = +b.dataset.v; garder(); dessinerForm(); };
    for (const b of $("im-duree").children) b.onclick = () => { reglages.duree = +b.dataset.v; garder(); dessinerForm(); };
    // arrow keys move between the options of a group of radio buttons
    for (const g of [$("im-modele"), $("im-format"), $("im-taille"), $("im-nombre"), $("im-duree")]) {
      g.addEventListener("keydown", (e) => {
        const d = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1}[e.key];
        if (!d) return;
        const bs = [...g.children].filter((b) => !b.disabled && !b.hidden);
        const i = bs.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const b = bs[(i + d + bs.length) % bs.length];
        b.focus(); b.click();
      });
    }
    const cote = (el, k) => {
      el.addEventListener("change", () => { reglages[k] = auMultiple(el.value); el.value = reglages[k]; garder(); dessinerForm(); });
      el.addEventListener("input", () => {
        const v = Math.round(+el.value);
        if (Number.isFinite(v) && v > 0) { reglages[k] = v; dessinerForm(); }
      });
    };
    cote($("im-largeur"), "largeur");
    cote($("im-hauteur"), "hauteur");
    $("im-etapes").oninput = () => { reglages.etapesPar = {...(reglages.etapesPar || {}), [reglages.modele]: +$("im-etapes").value}; garder(false); dessinerForm(); };
    $("im-guidage").oninput = () => { reglages.guidagePar = {...(reglages.guidagePar || {}), [reglages.modele]: +$("im-guidage").value}; garder(false); dessinerForm(); };
    $("im-graine").onchange = () => {
      const s = $("im-graine").value.trim();
      reglages.graine = /^\d+$/.test(s) ? s : "";
      $("im-graine").value = reglages.graine;
      garder();
    };
    $("im-retablir").onclick = () => {
      reglages = {...reglages, nombre: 1, etapesPar: {}, guidagePar: {}, graine: "", negatif: ""};
      garder(); dessinerForm();
      annonce("info", "Default settings restored", "The prompt and the size stay as they are.", 3000);
    };
    $("im-fichiers").onchange = () => { const fs = [...$("im-fichiers").files]; $("im-fichiers").value = ""; ajouterRefs(fs); };
    const form = $("im-form");
    let profondeur = 0;
    form.addEventListener("dragenter", (e) => { if ([...(e.dataTransfer || {}).types || []].includes("Files")) { profondeur++; form.dataset.depot = "1"; } });
    form.addEventListener("dragleave", () => { if (--profondeur <= 0) { profondeur = 0; delete form.dataset.depot; } });
    form.addEventListener("dragover", (e) => { if ([...(e.dataTransfer || {}).types || []].includes("Files")) e.preventDefault(); });
    form.addEventListener("drop", (e) => {
      profondeur = 0; delete form.dataset.depot;
      const fs = [...((e.dataTransfer || {}).files || [])];
      if (!fs.length) return;
      e.preventDefault();
      ajouterRefs(fs);
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); generer(); });
    $("im-arreter").onclick = arreter;
    $("im-plus").onclick = () => { montres += PAR_PAGE; dessinerGalerie(); };
    // the viewer
    $("iv-fermer").onclick = fermer;
    $("iv-avant").onclick = () => aller(-1);
    $("iv-apres").onclick = () => aller(1);
    $("iv-scene").onclick = (e) => { if (e.target === $("iv-scene")) fermer(); };
    $("iv-actions").innerHTML = actions();
    brancherActions($("iv-actions"), () => galerie[iv.index]);
    document.addEventListener("keydown", (e) => {
      if (iv.index < 0) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); fermer(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); aller(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); aller(1); }
      else if (e.key === "Tab") {                    // the focus stays in the viewer
        const bs = [...$("im-visionneuse").querySelectorAll("button:not([disabled])")];
        const i = bs.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); bs[bs.length - 1].focus(); }
        else if (!e.shiftKey && i === bs.length - 1) { e.preventDefault(); bs[0].focus(); }
      }
    }, true);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && actif()) suivre(); });
    dessinerForm();
    dessinerScene();
    dessinerGalerie();
    ouvrirBase().then(async (b) => {
      base = b;
      stockage = b ? "ok" : "absent";
      await chargerGalerie();
      dessinerGalerie(); dessinerScene();
      reprendre();
    });
  }
  function lireNote() {                                // the card the images are made on
    $("im-moteur-note").textContent = etat && etat.card != null ? `GPU ${etat.card}` : "";
  }

  // the tab is shown: the server's state again, and the gallery as other tabs may have left it
  async function montrer() {
    lireEtat();
    if (base) { await chargerGalerie(); }
    dessinerGalerie(); dessinerScene(); dessinerPied();
  }
  // each /metrics reading: what the GPUs do (another client's image, for the note under the form)
  let lectureEtat = false;
  function mesures(m) {
    resume = (m && m.images) || null;
    if (resume && !etat && !lectureEtat) { lectureEtat = true; lireEtat(); }    // once: the models and the limits
    // this page's job, if its own polling stopped (a lost timer): followed again
    if (actif() && !enVol && Date.now() - dernierSuivi > 3000) suivre();
    if (vue === "images") dessinerPied();
  }
  // the header's status pill while the GPUs make an image, or null (the chat model's state then)
  function pastille(m) {
    let j = m && m.images && m.images.job;
    // this page's own job, read twice as often as /metrics: the pill says the step the scene says
    if (actif() && (!j || j.id === travail.id) && !["queued", "waiting"].includes(travail.vue.state)) j = travail.vue;
    if (!j) return null;
    // every one begins with "Image" (or "Video"): on a phone the pill keeps its first word
    // and "Video" for a video
    const Q = j.kind === "video" || modele((j.params || {}).model).kind === "video" ? "Video" : "Image";
    if (j.state === "switching") return {etat: "chargement", texte: `${Q} · switching the GPUs`};
    if (j.state === "starting") return {etat: "chargement", texte: `${Q} · starting its model`};
    if (j.state !== "generating") return null;
    const p = j.progress || {};
    const phases = {preparing: "preparing", conditioning: "preparing", vae_encode: Q === "Video" ? "reading the start image" : "reading references",
                    vae_decode: Q === "Video" ? "decoding the frames" : "decoding", audio_decode: "decoding the sound", encoding: "saving"};
    return {etat: "ecriture", texte: p.stage === "sampling" && p.total ? `${Q} · step ${nf(p.completed || 0)} of ${nf(p.total)}`
      : charge(p) ? `${Q} · loading the model` : `${Q} · ${phases[p.stage] || "preparing"}`};
  }

  return {init, montrer, mesures, pastille};
})();
