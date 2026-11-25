// Lapilli: the chat page of the Basalt port to NVIDIA V100 GPUs (Chat, Images, Monitor, Experts, About).
// No framework; nothing is sent anywhere but to this server. The layout follows that of Strata's page
// (Niko1221, MIT license); text is formatted by marked (MIT license, web/marked.umd.js).
"use strict";

const $ = (id) => document.getElementById(id);
const ICONES = "web/lapilli-icons.svg";
const ic = (nom, cls = "ic") => `<svg class="${cls}" aria-hidden="true"><use href="${ICONES}#i-${nom}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const nf = (n, d = 0) => (n == null || !Number.isFinite(+n) ? "–"
  : Number(n).toLocaleString("en-US", {maximumFractionDigits: d, minimumFractionDigits: d}));
const go = (octets, d = 1) => (octets == null ? "–" : nf(octets / 1073741824, d));      // binary GB (GiB), as Windows shows them
const kf = (n) => (n == null ? "–" : n >= 10000 ? `${nf(n / 1000)}k` : n >= 1000 ? `${nf(n / 1000, 1)}k` : nf(n));
// a line of info: unbreakable pieces separated by a middle dot (the dot comes from the CSS, between two pieces)
const morceaux = (liste) => liste.filter((x) => x != null && x !== "").map((x) => `<span class="morceau">${esc(x)}</span>`).join("");
const estTactile = () => matchMedia("(hover: none)").matches;

const memoire = {
  lire(k, d) { try { const v = localStorage.getItem("lapilli." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  ecrire(k, v) { try { localStorage.setItem("lapilli." + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};
const nouvelId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ------------------------------------------------------------------ toasts (closable, replaced when the state changes)
function annonce(genre, titre, texte = "", ms = 4000, action = null) {
  const el = document.createElement("div");
  el.className = `annonce annonce--${genre}`;
  el.setAttribute("role", genre === "erreur" ? "alert" : "status");
  el.innerHTML = `${ic({info: "info", succes: "succes", alerte: "alerte", erreur: "erreur"}[genre] || "info")}` +
    `<div class="annonce__corps"><div class="annonce__titre"></div><div class="annonce__texte"></div></div><div class="annonce__actions"></div>`;
  el.querySelector(".annonce__titre").textContent = titre;
  if (texte) el.querySelector(".annonce__texte").textContent = texte; else el.querySelector(".annonce__texte").remove();
  const actions = el.querySelector(".annonce__actions");
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn btn--doux btn--petit"; b.textContent = action.libelle;
    b.onclick = () => { action.faire(); el.remove(); };
    actions.appendChild(b);
  }
  const x = document.createElement("button");
  x.type = "button"; x.className = "btn btn--icone"; x.title = "Close"; x.setAttribute("aria-label", "Dismiss notification");
  x.innerHTML = ic("croix");
  x.onclick = () => el.remove();
  actions.appendChild(x);
  const boite = $("annonces");
  boite.appendChild(el);
  while (boite.children.length > 3) boite.firstElementChild.remove();
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

async function copier(texte, bouton) {
  let ok = true;
  try {
    await navigator.clipboard.writeText(texte);
  } catch (e) {                                   // over plain http to another machine there is no async clipboard
    const ta = document.createElement("textarea");
    ta.value = texte; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
    ta.remove();
  }
  if (!ok) { annonce("erreur", "Could not copy", "The browser denied access to the clipboard.", 6000); return; }
  const u = bouton && bouton.querySelector("use");
  if (u) { u.setAttribute("href", `${ICONES}#i-coche`); setTimeout(() => u.setAttribute("href", `${ICONES}#i-copier`), 1500); }
  annonce("succes", "Copied to the clipboard", "", 1800);
}

// ------------------------------------------------------------------ times and days (a time alone does not say which day)
const debutJour = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const heure = (t, secondes = false) => new Date(t).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", ...(secondes ? {second: "2-digit"} : {})});
function jourDe(t) {
  const j = Math.round((debutJour(Date.now()) - debutJour(t)) / 86400000);
  if (j <= 0) return "Today";
  if (j === 1) return "Yesterday";
  const d = new Date(t);
  return d.toLocaleDateString("en-US", {day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? {year: "numeric"} : {})});
}
function quand(t, secondes = false) {              // a past moment, with its day when it is not today
  const j = Math.round((debutJour(Date.now()) - debutJour(t)) / 86400000);
  const h = heure(t, secondes);
  return j <= 0 ? h : j === 1 ? `yesterday ${h}` : `${new Date(t).toLocaleDateString("en-US", {day: "numeric", month: "short"})}, ${h}`;
}
function ilYa(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 45 ? "just now" : s < 3600 ? `${nf(Math.max(1, Math.round(s / 60)))} min ago` : s < 86400 ? `${nf(s / 3600, 0)} h ago` : quand(t);
}

// ------------------------------------------------------------------ theme and views
function poserTheme(t, garder) {
  document.documentElement.dataset.theme = t;
  if (garder) { try { localStorage.setItem("lapilli.theme", t); } catch (e) { /* private browsing: for this visit only */ } }
  $("ic-theme").setAttribute("href", `${ICONES}#i-${t === "dark" ? "soleil" : "lune"}`);
  $("btn-theme").setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  $("bascule-sombre").setAttribute("aria-checked", String(t === "dark"));
}
const basculerTheme = () => poserTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
$("btn-theme").onclick = basculerTheme;
$("bascule-sombre").onclick = basculerTheme;
poserTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light", false);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let garde = null;
  try { garde = localStorage.getItem("lapilli.theme"); } catch (err) { /* nothing to do */ }
  if (garde !== "dark" && garde !== "light") poserTheme(e.matches ? "dark" : "light", false);
});

const VUES = ["discussion", "images", "moniteur", "experts", "apropos"];
let vue = "discussion";
function montrerVue(nom) {
  const [v, sous] = String(nom || "").split("/");     // #moniteur/requetes: the Monitor, on its Requests section
  vue = VUES.includes(v) ? v : "discussion";
  for (const b of document.querySelectorAll(".onglet")) b.setAttribute("aria-selected", String(b.dataset.vue === vue));
  for (const x of VUES) $(`vue-${x}`).hidden = x !== vue;
  $("btn-panneau").hidden = vue !== "discussion";
  Moniteur.cacherBulle();
  if (vue === "moniteur") Moniteur.montrerSousVue(sous || Moniteur.sousVue(), false);   // without one, the last section seen
  const so = Moniteur.sousVue();
  const h = vue === "discussion" ? "" : vue === "moniteur" && so !== "apercu" ? `#moniteur/${so}` : `#${vue}`;
  if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  if (vue === "discussion" && !estTactile()) $("saisie").focus();
  if (mesures) dessinerMesures(mesures);
  if (vue === "experts" && mesures && !mesures.experts_map) relever();   // its map now, not at the next reading
  if (vue === "apropos") lireReglagesMoteur();
  if (vue === "images") Imagier.montrer();
}
for (const b of document.querySelectorAll(".onglet")) b.onclick = () => montrerVue(b.dataset.vue);
window.addEventListener("hashchange", () => montrerVue(location.hash.slice(1)));
$("marque").onclick = (e) => { e.preventDefault(); montrerVue("discussion"); };

// ------------------------------------------------------------------ the server
function entetes(json = false) {
  const h = {};
  const cle = memoire.lire("cle", "");
  if (cle) h.Authorization = "Bearer " + cle;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
// the server's refusal, in plain words when it is a known one; otherwise its own message, as is
async function refus(r) {
  let code = "", message = "";
  try {
    const j = await r.json();
    const e = (j && j.error) || j || {};
    code = e.code || e.type || ""; message = e.message || e.detail || j.detail || "";
  } catch (e) { /* not JSON */ }
  const connus = {
    401: "This server requires an API key: add it under About.",
    403: "The server refuses requests coming from this page's address.",
    503: "The engine is starting or restarting: try again in a moment.",
  };
  let texte = connus[r.status] || "";
  if (code === "context_length_exceeded" || /context/i.test(message) && r.status === 400) texte = "The message is too long for the model's context.";
  if (code === "model_busy" || r.status === 409 && /busy/i.test(message)) texte = "The model is busy with another request.";
  if (code === "not_thinking") texte = "Thinking has already finished.";
  if (code === "unknown_request") texte = "The server no longer knows this response.";
  const err = new Error(texte || `The server returned ${r.status}${message ? `: ${message}` : ""}.`);
  err.code = code; err.statut = r.status; err.detail = message;
  return err;
}

let sante = {model: "flash-next", max_context: 0, api_key: false, loaded: true};
let defautsModele = {temperature: 1, top_p: 0.95, top_k: 20};
async function lireSante() {
  try {
    const r = await fetch("health", {cache: "no-store"});
    if (!r.ok) throw await refus(r);
    sante = await r.json();
    chargerTiroir();   // the length steps follow this server's context
    $("champ-cle").hidden = !sante.api_key && !memoire.lire("cle", "");
    // the button says what the server can read
    const joindre = sante.images ? "Attach a text file or an image (or drop them here, or paste a screenshot)" : "Attach a text file (or drop it here)";
    $("btn-joindre").title = joindre;
    $("btn-joindre").setAttribute("aria-label", sante.images ? "Attach a text file or an image" : "Attach a text file");
    mesurerGarde();    // whether this model keeps earlier thinking in its context
  } catch (e) {
    setTimeout(lireSante, 3000);
  }
}
async function lireProps() {
  try {
    const r = await fetch("props", {cache: "no-store", headers: entetes()});
    if (!r.ok) return;
    const p = await r.json();
    const g = (p.default_generation_settings || {}).params || {};
    for (const k of ["temperature", "top_p", "top_k"]) if (Number.isFinite(+g[k])) defautsModele[k] = +g[k];
    chargerTiroir();
  } catch (e) { /* the known values stay */ }
}
$("cle-api").value = memoire.lire("cle", "");
$("cle-api").onchange = () => {
  memoire.ecrire("cle", $("cle-api").value.trim());
  annonce("succes", "API key saved", "It stays in this browser.", 3000);
  relever();
  lireReglagesMoteur();
};

// ------------------------------------------------------------------ Engine settings
// The context length and the image input this server keeps for its model (GET/POST api/engine-settings): people run
// Lapilli with nothing around it, so this page is where they are set. Applying restarts the engine once the response being
// written has finished; settings that cannot start give way to the previous ones. The card's state line follows a change
// this page made or saw happen (waiting, restarting with the load's percent, then its result, closable), never an old one.
let reglagesMoteur = null, choixMoteur = null, minuterieMoteur = null, dernierEtatMoteur = "";
let suiviMoteur = false, resultatMoteur = "", resultatFerme = "", lectureMoteur = "", refusMoteur = "", hvConnu = 0;
const sansPoint = (t) => String(t || "").trim().replace(/[.\s]+$/, "");
async function lireReglagesMoteur() {
  clearTimeout(minuterieMoteur);
  minuterieMoteur = null;
  let r;
  try {
    r = await fetch("api/engine-settings", {cache: "no-store", headers: entetes()});
  } catch (e) {
    lectureMoteur = "the server cannot be reached";
    dessinerReglagesMoteur();
    minuterieMoteur = setTimeout(lireReglagesMoteur, 3000);
    return;
  }
  if (r.status === 404 || r.status === 401) {     // a server without them, or a key to enter first (read again once saved)
    reglagesMoteur = null;
    lectureMoteur = "";
    dessinerReglagesMoteur();
    return;
  }
  if (!r.ok) {
    lectureMoteur = sansPoint((await refus(r)).message);
    dessinerReglagesMoteur();
    minuterieMoteur = setTimeout(lireReglagesMoteur, 3000);
    return;
  }
  try {
    reglagesMoteur = await r.json();
  } catch (e) {
    lectureMoteur = "the server's answer could not be read";
    dessinerReglagesMoteur();
    minuterieMoteur = setTimeout(lireReglagesMoteur, 3000);
    return;
  }
  lectureMoteur = "";
  const st = reglagesMoteur.state || {};
  const enCoursM = st.status === "pending" || st.status === "applying";
  const marque = `${st.status}:${st.at || 0}`;
  if (marque !== dernierEtatMoteur) {
    if (suiviMoteur && !enCoursM) {                // the change this page followed has just ended
      suiviMoteur = false;
      resultatMoteur = marque;
      choixMoteur = null;
      lireSante();                                 // the new context and image input: the length steps, the attach button
      relever();                                   // the pastille says it at the same time, not a second later
      if (vue !== "apropos") {                     // the card says it; on another tab a toast does
        if (st.status === "ok") annonce("succes", "Engine restarted", `${resumeMoteur(st)}.`, 5000);
        else if (st.status === "failed") annonce("erreur", "Engine settings not applied", st.restored === false
          ? "The previous settings did not start either: see About." : "The engine is back on its previous settings.", 8000);
      }
    }
    dernierEtatMoteur = marque;
  }
  if (enCoursM) suiviMoteur = true;
  dessinerReglagesMoteur();
  // every half second while a change is on (a small answer): "Waiting…" gives way to the restart as the pastille goes Idle
  if (enCoursM) minuterieMoteur = setTimeout(lireReglagesMoteur, 500);
}
function resumeMoteur(o) {
  const morceaux = [];
  if (o.context) morceaux.push(`context ${nf(o.context)}\u00a0tokens`);
  if (o.vision) morceaux.push(`image input ${o.vision}`);
  const t = morceaux.join(", ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function dessinerReglagesMoteur() {
  const m = reglagesMoteur, carte = $("carte-reglages-moteur");
  carte.hidden = !(m && m.supported);
  ligneContexte();                                 // the drawer's link to this card follows it
  if (carte.hidden) return;
  const c = m.context || {}, v = m.vision || {}, st = m.state || {};
  const occupeM = st.status === "pending" || st.status === "applying";
  const voulu = {context: (choixMoteur && choixMoteur.context) || c.value, vision: (choixMoteur && choixMoteur.vision) || v.value};
  // the lengths: the model's own steps, the default one named; a length kept from before stays in its place
  const choix = [...(c.choices || [])];
  if (c.value && !choix.includes(c.value)) choix.push(c.value);
  choix.sort((a, b) => a - b);
  const sel = $("m-contexte");
  const cle = choix.join(",") + ":" + c.default;
  if (sel.dataset.cle !== cle) {
    sel.replaceChildren(...choix.map((n) => {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = `${nf(n)} tokens${n === c.default ? " (default)" : ""}`;
      return o;
    }));
    sel.dataset.cle = cle;
  }
  sel.value = String(voulu.context || "");
  const parLigne = c.source === "command line" || c.source === "slots";
  sel.disabled = parLigne || occupeM;
  $("o-m-contexte").textContent = c.serving && c.serving !== c.value ? `serving ${nf(c.serving)}` : "";
  if (c.source === "command line") phraseDrapeaux($("m-contexte-note"), "Set on the server's command line (", "--max-context", "): change it there.");
  else if (c.source === "slots") phraseDrapeaux($("m-contexte-note"), "Several slots share the context (", "--parallel", "): set ", "--max-context", " on the command line.");
  else $("m-contexte-note").textContent = `${c.model_max ? `The model reads up to ${nf(c.model_max)}\u00a0tokens. ` : ""}A longer context sets more memory aside when the engine starts.`;
  const bv = $("m-vision");
  bv.setAttribute("aria-checked", String(voulu.vision === "on"));
  bv.disabled = !v.available || v.source === "command line" || occupeM;
  // what is served now (the switch shows the choice, "Not applied yet." the difference); the encoder's size from the engine
  if (mesures && mesures.live && mesures.live.state !== "loading") hvConnu = +(mesures.engine || {}).host_vision_bytes || 0;
  const hv = hvConnu;                              // the last known while the engine loads (its facts are gone meanwhile)
  const encodeur = `the encoder waits in RAM${hv ? ` (${go(hv)}\u00a0GB)` : ""} and uses a card only while it reads an image.`;
  if (!v.available) $("m-vision-note").textContent = "This model file carries no image encoder.";
  else if (v.source === "command line") phraseDrapeaux($("m-vision-note"), "Set on the server's command line (", "--vision", "): change it there.");
  else $("m-vision-note").textContent = v.value === "on" ? `Images can be attached in the chat: ${encodeur}`
    : `Images cannot be attached in the chat. Turned on, ${encodeur}`;
  const change = (voulu.context !== c.value && !parLigne) || (voulu.vision !== v.value && v.available && v.source !== "command line");
  $("m-appliquer").disabled = !change || occupeM;
  // the state line: a reading problem, the change in progress, its result (closable), a refusal, or a choice not applied yet
  const marque = `${st.status}:${st.at || 0}`;
  let texte = "", fermable = false;
  if (lectureMoteur) texte = `Cannot read the engine settings: ${lectureMoteur}. Trying again…`;
  else if (st.status === "pending") texte = "Waiting for the current response to finish…";
  else if (st.status === "applying") {
    const l = mesures && mesures.live;
    const pct = l && l.state === "loading" && l.load && l.load.percent != null ? l.load.percent : null;
    texte = `Restarting the engine…${pct != null ? ` ${nf(pct)}%` : ""}`;
  } else if (refusMoteur) {
    texte = refusMoteur; fermable = true;
  } else if (marque === resultatMoteur && marque !== resultatFerme) {
    fermable = true;
    if (st.status === "ok") texte = `Applied: ${resumeMoteur(st).toLowerCase()}${st.note ? `, but ${sansPoint(st.note)}` : ""}.`;
    else texte = `Not applied: ${sansPoint(st.error) || "the engine did not start"}. ` + (st.restored === false
      ? `The previous settings did not start either: ${sansPoint(st.restore_error) || "no reason given"}.`
      : "The engine is back on its previous settings.");
  } else if (change) texte = "Not applied yet.";
  const genre = !fermable ? "" : refusMoteur || st.status === "failed" ? "echec" : "ok";
  const boite = $("m-etat-boite");
  $("m-etat").textContent = texte;
  boite.hidden = !texte;
  if (genre) boite.dataset.genre = genre; else delete boite.dataset.genre;
  $("m-etat-ic").toggleAttribute("hidden", !genre);     // an <svg> has no .hidden property: the attribute itself
  $("m-etat-ic").querySelector("use").setAttribute("href", `web/lapilli-icons.svg#i-${genre === "echec" ? "erreur" : "succes"}`);
  $("m-etat-fermer").hidden = !fermable;
}
// a sentence whose command-line flags keep their two hyphens: they go in a monospace span (the text font joins "--")
function phraseDrapeaux(el, ...morceaux) {
  el.replaceChildren(...morceaux.map((m) => {
    if (!m.startsWith("--")) return document.createTextNode(m);
    const d = document.createElement("span");
    d.className = "drapeau";
    d.textContent = m;
    return d;
  }));
}
$("m-etat-fermer").onclick = () => {
  if (refusMoteur) refusMoteur = "";
  else resultatFerme = resultatMoteur;
  dessinerReglagesMoteur();
};
// a new choice: the result or refusal of the change before is past, the state line says the choice is not applied yet
// (the real window: "Applied: context 65,536 tokens." stayed beside a new image-input choice)
function nouveauChoix(maj) {
  choixMoteur = {...(choixMoteur || {}), ...maj};
  refusMoteur = "";
  resultatFerme = resultatMoteur;
  dessinerReglagesMoteur();
}
$("m-contexte").onchange = () => nouveauChoix({context: +$("m-contexte").value});
$("m-vision").onclick = () => {
  const v = (reglagesMoteur && reglagesMoteur.vision) || {};
  const actuel = (choixMoteur && choixMoteur.vision) || v.value;
  nouveauChoix({vision: actuel === "on" ? "off" : "on"});
};
$("m-appliquer").onclick = async () => {
  const m = reglagesMoteur || {}, c = m.context || {}, v = m.vision || {}, corps = {};
  if (choixMoteur && choixMoteur.context && choixMoteur.context !== c.value) corps.context = choixMoteur.context;
  if (choixMoteur && choixMoteur.vision && choixMoteur.vision !== v.value) corps.vision = choixMoteur.vision;
  if (!Object.keys(corps).length) return;
  $("m-appliquer").disabled = true;
  try {
    const r = await fetch("api/engine-settings", {method: "POST", headers: entetes(true), body: JSON.stringify(corps)});
    if (!r.ok) throw await refus(r);
    suiviMoteur = true;
    refusMoteur = "";
    resultatFerme = "";
    relever();                                     // the pastille: waiting or loading at once
  } catch (e) {
    refusMoteur = e.detail ? `Not applied: ${sansPoint(e.detail)}.` : e.message;
  }
  lireReglagesMoteur();
};

// ------------------------------------------------------------------ a newer page on the server
// The server reads its page files at each request: a tab opened before an update keeps running the old code until it is
// reloaded (seen: a test made on the page from before a fix, the tab open since the night before). The page
// compares the files it was given with the ones the server gives now: once at start (the reference), every five
// minutes, when the tab comes back, and when the server restarts. When they differ, a notice offers to reload, never
// while a response or a compaction is being written. Closed, it comes back only for a newer change.
const FICHIERS_PAGE = ["./", "web/lapilli.js", "web/lapilli-monitor.js", "web/lapilli-images.js", "web/lapilli.css"];
let empreintePage = null, empreinteNeuve = null, empreinteFermee = null, verifPage = 0, verifEnVol = false, depuisServeur = null, avisPage = null;
function empreinte(texte) {                       // FNV-1a on 32 bits: enough to tell two versions of the page apart
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) { h ^= texte.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
async function verifierPage() {
  if (verifEnVol) return;
  verifEnVol = true;
  verifPage = Date.now();
  try {
    const textes = await Promise.all(FICHIERS_PAGE.map(async (f) => {
      const r = await fetch(f, {cache: "no-store"});
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r.text();
    }));
    const e = empreinte(textes.join("\n|\n"));
    if (empreintePage === null) empreintePage = e;
    else if (e !== empreintePage) { empreinteNeuve = e; montrerAvisPage(); }
  } catch (err) { /* the server is restarting or out of reach: the next check tells */ }
  verifEnVol = false;
}
function montrerAvisPage() {
  if (!empreinteNeuve || empreinteNeuve === empreinteFermee || (avisPage && avisPage.isConnected)) return;
  if (enCours || compactage) return;              // shown once the response is done (montrerAvisPage at its end)
  const vue = empreinteNeuve;
  avisPage = annonce("info", "This page was updated", "Reload to use the new version. Your conversations stay in this browser.", 0,
                     {libelle: "Reload", faire: () => location.reload()});
  // closed by its cross: it comes back only when the server gives yet another version
  avisPage.querySelector(".annonce__actions .btn--icone").addEventListener("click", () => { empreinteFermee = vue; });
}
setInterval(() => { if (!document.hidden) verifierPage(); }, 300000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - verifPage > 15000) verifierPage(); });

// ------------------------------------------------------------------ metrics (/metrics), every second
let mesures = null, echecs = 0, cleAvertie = false, minuterieReleve = null, releveEnVol = false, releverEncore = false;
async function relever() {
  if (releveEnVol) { releverEncore = true; return; }         // one poll at a time: this one runs again right after
  releveEnVol = true;
  clearTimeout(minuterieReleve);
  try {
    // the expert map's arrays only for the Experts tab (24,576 experts make hundreds of KB): a summary otherwise
    const r = await fetch(vue === "experts" ? "metrics?experts=full" : "metrics", {cache: "no-store", headers: entetes()});
    if (r.status === 401) {
      poserPastille("horsligne", "API key required");
      $("champ-cle").hidden = false;
      if (!cleAvertie) { cleAvertie = true; annonce("alerte", "API key required", "This server requires a key: add it under About.", 8000); }
    } else if (!r.ok) {
      throw await refus(r);
    } else {
      const avant = mesures;
      mesures = await r.json();
      // a server that restarted may serve a newer page
      const depuis = mesures.totals && mesures.totals.since;
      if (depuis && depuisServeur && depuis !== depuisServeur) verifierPage();
      if (depuis) depuisServeur = depuis;
      // the engine has just loaded again, or serves another context (Engine settings applied, from this page or
      // another): /health again, for the length steps and the attach button
      const chargeait = avant && avant.live && avant.live.state === "loading";
      const charge = mesures.live && mesures.live.state === "loading";
      if (avant && !charge && (chargeait || (mesures.engine || {}).max_context !== (avant.engine || {}).max_context)) lireSante();
      // the card on About follows each reading: the load's percent, and the encoder's size once the engine is back
      if (reglagesMoteur && (vue === "apropos" || (reglagesMoteur.state || {}).status === "applying")) dessinerReglagesMoteur();
      if (echecs >= 3) annonce("succes", "Server reachable again", "", 3000);
      echecs = 0;
      dessinerMesures(mesures);
      if (enCours) dessinerJauge();                  // the gauge follows the response being written
    }
  } catch (e) {
    if (++echecs === 3) { poserPastille("horsligne", "Server unreachable"); if (enCours) activite(); }
  }
  releveEnVol = false;
  if (releverEncore) { releverEncore = false; relever(); return; }
  minuterieReleve = setTimeout(relever, enCours ? 500 : document.hidden ? 5000 : 1000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) relever(); });

function poserPastille(etat, texte) {
  $("pastille").dataset.etat = etat;
  // its first word in a piece of its own that does not shrink: on a narrow header the rest gives way ("Thinking ·…"),
  // never the word ("Thinki…"); the text stays whole for whoever reads it (textContent)
  const el = $("pastille-texte"), t = String(texte), i = t.search(/[\s·]/);
  if (el.textContent === t) return;
  el.textContent = "";
  const mot = document.createElement("span");
  mot.className = "pastille__mot";
  mot.textContent = i < 0 ? t : t.slice(0, i);
  el.appendChild(mot);
  if (i >= 0) {
    const reste = document.createElement("span");
    reste.className = "pastille__reste";
    reste.textContent = t.slice(i);
    el.appendChild(reste);
  }
}
// the share of the message already read, estimated: elapsed time times the mean speed of this read
function partLue(live) {
  if (!live.prompt_tokens || !live.prefill_tok_s_mean || !live.elapsed_s) return null;
  return Math.max(0, Math.min(0.99, (live.elapsed_s * live.prefill_tok_s_mean) / live.prompt_tokens));
}
function etatDe(live) {
  if (!live) return "connexion";
  if (live.state === "loading") return "chargement";
  if (live.queued > 0 && live.state === "idle") return "attente";
  if (live.state === "reading") return "lecture";
  if (live.state === "generating") return live.phase === "thinking" ? "reflexion" : "ecriture";
  if (live.state === "unloaded" || live.state === "asleep") return "attente";
  return "repos";
}
function dessinerPastille(m) {
  const live = m.live || {};
  // the GPUs make an image (the image server holds them): the pill says so, from every tab
  const image = Imagier.pastille(m);
  if (image) { poserPastille(image.etat, image.texte); return; }
  const e = etatDe(live);
  const pct = (live.load || {}).percent;
  const lu = partLue(live);
  const textes = {
    chargement: `Loading${pct != null ? ` · ${nf(pct)}%` : ""}`,
    lecture: `Reading${lu != null ? ` · ${nf(lu * 100)}%` : ""}`,
    reflexion: `Thinking${live.tok_s ? ` · ${nf(live.tok_s, 1)} tokens/s` : ""}`,
    ecriture: `Writing${live.tok_s ? ` · ${nf(live.tok_s, 1)} tokens/s` : ""}`,
    attente: live.state === "unloaded" ? (m.images && m.images.server === "ready" ? "Image model loaded" : "Model unloaded")
      : live.state === "asleep" ? "Asleep" : `Waiting · ${nf(live.queued)}`,
    repos: "Idle",
  };
  let t = textes[e] || "Idle";
  if (live.queued > 0 && e !== "attente") t += ` · ${nf(live.queued)} waiting`;
  const im = m.images, enAttente = im ? (im.job ? 1 : 0) + (im.queued || 0) : 0;   // images waiting for the GPUs
  if (enAttente) t += ` · ${nf(enAttente)} ${enAttente > 1 ? "images" : "image"} waiting`;
  poserPastille(e, t);
}

// ------------------------------------------------------------------ Monitor and Experts (web/lapilli-monitor.js)
const nomProcesseur = (st) => {
  const n = String(st.cpu_name || "");
  if (/^Intel64 Family/i.test(n)) return "Intel";                       // the raw name Windows gives to Python
  if (/^AMD64 Family/i.test(n)) return "AMD";
  return n.replace(/\((R|TM)\)/gi, "").replace(/\s+\d+-Core Processor$/i, "").replace(/\s+CPU\s+@.*$/i, "").replace(/\s+/g, " ").trim();
};
Moniteur.init();
Imagier.init();

function faits(el, lignes) {
  el.innerHTML = lignes.filter((l) => l[1] != null && l[1] !== "").map(([k, v, copie]) => `<dt>${esc(k)}</dt><dd>${copie
    ? `<code>${esc(v)}</code><button type="button" class="btn btn--icone" data-copier="${esc(v)}" aria-label="Copy ${esc(k)}" title="Copy">${ic("copier")}</button>`
    : esc(v)}</dd>`).join("");
}
function dessinerApropos(m) {
  const eng = m.engine || {}, hw = m.hardware || {}, st = m.hardware_static || {};
  // the experts both cards hold, from the tiers the engine publishes (GPU 0's places, GPU 1's experts: 7,311 + 10,501
  // for the Flash-Next); GPU 0's places alone only from an engine that does not publish them
  const ti = m.experts && m.experts.tiers;
  const surCartes = ti ? (ti.main.experts || 0) + (ti.peer.experts || 0) : eng.expert_slots;
  const octetsCartes = ti ? (ti.main.bytes || 0) + (ti.peer.bytes || 0) : (eng.expert_cache_mib || 0) * 1048576;
  const tousExperts = m.experts && m.experts.layers ? m.experts.layers * m.experts.per_layer : eng.expert_total;
  const kv = {int8: "8-bit", q4_0: "4-bit", fp16: "16-bit", f16: "16-bit", bf16: "16-bit"}[eng.kv] || eng.kv;
  // while the engine loads (a restart from Engine settings), /metrics no longer has its facts: the last known stay
  // until it is back, so the cards below do not jump up 63 px and back down (measured at 1280 px)
  const chargeA = m.live && m.live.state === "loading" && $("faits-moteur").childElementCount > 0;
  if (!chargeA) faits($("faits-moteur"), [
    ["Model", `${eng.model || sante.model}${eng.quant ? ` · ${eng.quant}` : ""}`],
    ["Engine", `Lapilli, based on Basalt ${eng.version || eng.engine || ""}`.trim()],
    ["Context", eng.max_context ? `${nf(eng.max_context)} tokens` : null],
    ["Images", sante.images ? "supported (vision on)" : "no (vision off)"],
    ["Context memory", kv ? `${kv}, ${eng.kv_resident ? `${nf(eng.kv_resident)} positions per layer on the GPUs, the rest in RAM` : "all on the GPUs"}` : null],
    ["Experts on the GPUs", surCartes ? `${nf(surCartes)}${tousExperts ? ` of ${nf(tousExperts)}` : ""} (${go(octetsCartes)} GB)` : null],
    ["MTP drafts", eng.spec ? "enabled" : null],
  ]);
  const cartes = (st.gpus || []).map((g) => g.name).filter(Boolean);
  const memes = cartes.length > 1 && cartes.every((n) => n === cartes[0]);
  faits($("faits-machine"), [
    ["GPUs", cartes.length ? (memes ? `${cartes.length} × ${cartes[0]}` : cartes.join(", ")) : null],
    ["PCIe links", (hw.gpus || []).length ? (hw.gpus || []).map((g) => `GPU ${g.index}: PCIe ${g.pcie_gen_max || g.pcie_gen} x${g.pcie_width}`).join(" · ") : null],
    ["Driver", st.driver ? `${st.driver}${st.cuda ? `, CUDA ${st.cuda}` : ""}` : null],
    ["CPU", st.cpu_name ? `${nomProcesseur(st)}${st.cores ? `, ${nf(st.cores)} cores` : ""}${st.threads ? `, ${nf(st.threads)} threads` : ""}` : null],
    ["RAM", hw.ram_total ? `${go(hw.ram_total)} GB` : null],
  ]);
  const base = location.origin;
  faits($("faits-api"), [
    ["OpenAI URL", `${base}/v1`, true],
    ["Anthropic URL", base, true],
    ["Model name", eng.model || sante.model, true],
  ]);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copier]");
  if (b) copier(b.dataset.copier, b);
});

function dessinerMesures(m) {
  dessinerPastille(m);
  // the Experts tab: only for a model whose server says where its experts are (a mixture of experts)
  const experts = Moniteur.aDesExperts(m);
  $("onglet-experts").hidden = !experts;
  if (!experts && vue === "experts") { montrerVue("moniteur"); return; }
  // the Images tab: only for a server that makes images (--images-server)
  $("onglet-images").hidden = !m.images;
  if (!m.images && vue === "images") { montrerVue("discussion"); return; }
  Imagier.mesures(m);
  if (vue === "moniteur") Moniteur.dessiner(m);
  if (vue === "experts") Moniteur.dessinerExperts(m);
  if (vue === "apropos") dessinerApropos(m);
  if (enCours) activite();
}

// ------------------------------------------------------------------ formatting (marked; the model's HTML is escaped)
// a lone number (thousands separated by a space, a dot or a comma, decimals, a short unit); "2, 3, 5, 7" is not one
const estNombre = (s) => /^[-+−~≈<>]?\s?(\d{1,3}([\s\u00a0\u202f.,]\d{3})+|\d+)([.,]\d+)?\s?(%|€|\$|°C|°|GB|MB|KB|GiB|MiB|ms|s|min|h|W|V|A|Hz|MHz|GHz|x|×|tokens(\/s)?|t\/s)?$/i.test(s);
let rendu = null;
function preparerMarked() {
  if (rendu || !window.marked) return rendu;
  const base = new marked.Renderer();
  marked.use({
    gfm: true, breaks: false,
    renderer: {
      html(t) { const x = esc(t.text || t.raw || ""); return t.block ? `<p>${x}</p>\n` : x; },   // no HTML from the model in the page
      code(t) {
        const langue = String(t.lang || "").trim().split(/\s+/)[0] || "text";
        return `<div class="code-bloc"><div class="code-bloc__tete"><span>${esc(langue)}</span>` +
          `<button type="button" class="btn btn--icone" data-copier-code aria-label="Copy code" title="Copy code">${ic("copier")}</button></div>` +
          `<pre><code>${t.escaped ? t.text || "" : esc(t.text || "")}</code></pre></div>\n`;
      },
      link(t) {
        const texte = this.parser.parseInline(t.tokens);
        if (!/^(https?:|mailto:)/i.test(t.href || "")) return texte;          // neither javascript: nor a link to this server
        return `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer"${t.title ? ` title="${esc(t.title)}"` : ""}>${texte}</a>`;
      },
      image(t) {                                                             // no image loaded from elsewhere: a link instead
        return /^https?:/i.test(t.href || "") ? `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${esc(t.text || t.href)}</a>` : esc(t.text || "");
      },
      table(t) {
        const p = this.parser, n = t.header.length, num = [];
        for (let c = 0; c < n; c++) {
          const vals = t.rows.map((r) => String((r[c] && r[c].text) || "").replace(/\*\*/g, "").trim()).filter(Boolean);
          num[c] = vals.length > 0 && vals.every(estNombre);
        }
        const cel = (x, c, tag) => `<${tag}${num[c] ? ' class="md-num"' : ""}>${p.parseInline(x.tokens)}</${tag}>`;
        let h = `<div class="md-table-defile"><table><thead><tr>${t.header.map((x, c) => cel(x, c, "th")).join("")}</tr></thead>`;
        if (t.rows.length) h += `<tbody>${t.rows.map((r) => `<tr>${r.map((x, c) => cel(x, c, "td")).join("")}</tr>`).join("")}</tbody>`;
        return `${h}</table></div>\n`;
      },
      list(t) {
        let h = base.list.call(this, t);
        const debut = +t.start;
        if (t.ordered && Number.isFinite(debut) && debut !== 1) h = h.replace(/^<ol start="(\d+)">/, (x, s) => `<ol start="${s}" style="counter-reset: lp-ol ${+s - 1}">`);
        return h;
      },
      listitem(t) {
        const h = base.listitem.call(this, t);
        return t.task ? h.replace(/^<li>/, '<li class="tache">') : h;
      },
    },
  });
  rendu = (texte) => marked.parse(texte, {async: false});
  return rendu;
}
function enHtml(texte) {
  const r = preparerMarked();
  if (!r) return `<p>${esc(texte).replace(/\n/g, "<br>")}</p>`;          // marked not loaded yet: the raw text
  try { return r(texte); } catch (e) { return `<p>${esc(texte).replace(/\n/g, "<br>")}</p>`; }
}

// ------------------------------------------------------------------ conversations (kept in this browser)
const MAX_CONVS = 60;
let convs = memoire.lire("conversations", []);
if (!Array.isArray(convs)) convs = [];
// a compaction interrupted by a closed page left an empty node: it carries no summary, it goes
for (const c of convs) if (c && Array.isArray(c.messages)) c.messages = c.messages.filter((m) => !(m.role === "compaction" && m.genre !== "reflexion" && !String(m.texte || "").trim()));
let courante = memoire.lire("courante", null);
if (!convs.some((c) => c.id === courante)) courante = null;
const convCourante = () => convs.find((c) => c.id === courante) || null;
const titreDe = (texte, fichiers) => {
  const t = String(texte || "").replace(/\s+/g, " ").trim();
  return (t || (fichiers && fichiers[0] ? fichiers[0].nom : "Conversation")).slice(0, 80);
};
let averti = false, avertiImages = false;
// browser storage full: the images of the oldest conversations go first (their conversations stay, the model
// reads "no longer kept"); false when none is left
function allegerImages() {
  for (let k = convs.length - 1; k >= 0; k--) {
    for (const m of convs[k].messages) for (const i of m.images || []) if (i.image) { i.image = null; return true; }
  }
  return false;
}
function garderConvs() {
  convs.sort((a, b) => b.modifie - a.modifie);
  if (convs.length > MAX_CONVS) convs.length = MAX_CONVS;
  let retirees = 0, imagesRetirees = 0;
  while (!memoire.ecrire("conversations", convs)) {
    if (allegerImages()) { imagesRetirees++; continue; }
    if (convs.length <= 1) { annonce("alerte", "Browser storage full", "This conversation will not be kept after the page is closed.", 8000); break; }
    convs.pop(); retirees++;
  }
  if (retirees && !averti) { averti = true; annonce("alerte", "Made room in the browser", `Oldest conversations removed: ${nf(retirees)}.`, 8000); }
  if (imagesRetirees && !avertiImages) {
    avertiImages = true;
    annonce("alerte", "Images removed from the browser", `${imagesRetirees > 1 ? `The ${nf(imagesRetirees)} oldest images are no longer kept` : "The oldest image is no longer kept"}; their conversations remain.`, 8000);
  }
  memoire.ecrire("courante", courante);
}
function dessinerConvs() {
  const liste = $("convs-liste");
  if (!convs.length) { liste.innerHTML = `<div class="convs__vide">No conversations yet.</div>`; return; }
  let h = "", avant = null;
  for (const c of convs) {
    const j = jourDe(c.modifie);
    if (j !== avant) { h += `<div class="convs__jour">${esc(j)}</div>`; avant = j; }
    h += `<div class="conv${c.id === courante ? " conv--active" : ""}" data-id="${esc(c.id)}">` +
      `<button type="button" class="conv__ouvrir" data-ouvrir="${esc(c.id)}" title="${esc(c.titre)}"${c.id === courante ? ' aria-current="true"' : ""}>` +
      `<span class="conv__titre">${esc(c.titre)}</span><span class="conv__heure">${esc(heure(c.modifie))}</span></button>` +
      `<button type="button" class="conv__suppr" data-suppr="${esc(c.id)}" title="Delete conversation" aria-label="Delete conversation: ${esc(c.titre)}">${ic("corbeille", "ic ic--p")}</button></div>`;
  }
  liste.innerHTML = h;
}
$("convs-liste").addEventListener("click", (e) => {
  const s = e.target.closest("[data-suppr]");
  if (s) { supprimerConv(s.dataset.suppr); return; }
  const o = e.target.closest("[data-ouvrir]");
  if (o) choisirConv(o.dataset.ouvrir);
});
function choisirConv(id) {
  if (enCours) { annonce("alerte", "Lapilli is still writing", "Stop the response before switching conversations.", 4000); return; }
  courante = id;
  memoire.ecrire("courante", courante);
  dessinerConvs(); dessinerFil();
  compterPensees(convCourante());                   // a conversation from before the count: its thinking, in tokens
  if (etroit()) ouvrirConvs(false);
  if (!estTactile()) $("saisie").focus();
}
function nouvelleConv() {
  if (enCours) { annonce("alerte", "Lapilli is still writing", "Stop the response before starting a new conversation.", 4000); return; }
  courante = null;
  memoire.ecrire("courante", null);
  pieces = []; dessinerPieces();
  dessinerConvs(); dessinerFil();
  if (etroit()) ouvrirConvs(false);
  $("saisie").focus();
}
function supprimerConv(id) {
  if (enCours && enCours.c.id === id) { annonce("alerte", "Lapilli is still writing", "Stop the response before deleting this conversation.", 4000); return; }
  const i = convs.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [retiree] = convs.splice(i, 1);
  const etaitCourante = courante === id;
  if (etaitCourante) courante = null;
  garderConvs(); dessinerConvs();
  if (etaitCourante) dessinerFil();
  annonce("info", "Conversation deleted", retiree.titre, 7000, {libelle: "Undo", faire: () => {
    convs.push(retiree);
    if (etaitCourante) courante = retiree.id;
    garderConvs(); dessinerConvs(); if (etaitCourante) dessinerFil();
  }});
}
$("btn-nouvelle").onclick = nouvelleConv;
$("btn-nouvelle-2").onclick = nouvelleConv;

// the conversation panel: beside the thread on a wide screen, over it on a narrow one
const etroit = () => matchMedia("(max-width: 960px)").matches;
function ouvrirConvs(ouvert) {
  $("convs").dataset.ouvert = String(ouvert);
  $("btn-panneau").setAttribute("aria-expanded", String(ouvert));
  $("voile-convs").hidden = !(ouvert && etroit());
  if (!etroit()) memoire.ecrire("panneau", ouvert);
}
$("btn-panneau").onclick = () => ouvrirConvs($("convs").dataset.ouvert !== "true");
$("voile-convs").onclick = () => ouvrirConvs(false);
matchMedia("(max-width: 960px)").addEventListener("change", () => ouvrirConvs(etroit() ? false : memoire.lire("panneau", true)));

// ------------------------------------------------------------------ the thread
// ------------------------------------------------------------------ conversation compaction
// After llama.cpp's own web UI (ui/apps/chat: utils/compaction.ts, constants/compaction.constants.ts, compactConversation),
// where the compaction lives in the chat page, not in the engine: the model summarizes what lies before the last steps,
// the summary is kept in a node appended to the conversation, and later requests read that summary, framed, then the
// steps the compaction kept as written, then what followed. The whole history stays on screen. With it, the automatic
// trigger of our llama.cpp interface: before a message is sent, once the context reaches a threshold.
// What this engine adds to it. Its main model's template keeps the thinking of earlier turns in the prompt
// (the page sends it back so that the server recognizes what it has read), and with long thinking the context fills with
// thinking before it fills with text: five short puzzles hold 8,130 tokens, 7,242 of them thinking, 938 without it. So a
// lighter compaction comes first, which only leaves that thinking out (no summary, every message stays as written); the
// steps kept as written go without their thinking and are bounded by a share of the context; the automatic trigger also
// keeps room for a response; and a response the context cut says what to do, and never leaves the conversation stuck.
const COMPACTION = {
  GABARIT: "This conversation was compacted. Summary of the earlier exchange:\n\n",
  CONSIGNE: "Summarize this conversation so it can seamlessly continue in a fresh context. Capture: the overall goal, key facts and decisions, the current state of any ongoing work (including code, file names, and data discussed), and what remains to be done. Write the summary as dense prose addressed to the assistant that will resume the conversation. Return ONLY the summary, nothing else.",
  CAR_PAR_JETON: 3,            // rough characters per token, to count a message before the server does
  PLEIN: "The context is too full for a summary. Make it longer under About, or start a new conversation.",
  CONVERSATION: "The conversation no longer fits in the model's context. Make it longer under About, or start a new conversation.",
  // ours, for an engine whose main model keeps the thinking of earlier turns in its context: there a step can
  // weigh thousands of tokens, and the context fills with thinking before it fills with text
  PART_GARDEE: 0.5,            // the steps a compaction keeps as written weigh at most this share of the context: the
                               // last response is often the work in progress (a whole file), a summary would lose it
  ECART_MINI: 0.1,             // when neither compaction makes enough room, the summary is chosen over leaving the thinking
                               // out only if it leaves this share of the context less
  GAIN_MINI: 0.02,             // leaving the earlier thinking out is worth it from this share of the context
  RESUME_PREVU: 512,           // what a summary is expected to weigh, when choosing between the two compactions
  POIDS_IMAGE: 1000,           // rough weight of an image in a kept step: its true size is only known once read
  REESSAI_MINI: 0.2,           // asking again after a compaction is offered when it frees this share of the context
  // The server's /tokenize is exact and fast (measured on the server's machine: 13 ms for 76,000 characters, 21 ms for 152,000;
  // the 21 s first written here were a slow link to it, not the server). Asked up to this length; above it, the
  // measured average of the model's own thinking, 3.3 characters a token
  COMPTE_MAXI: 200000, CAR_PAR_JETON_MESURE: 3.3,
  SUITES_MAX: 3,               // automatic continuations of one response the context cut
  MARGE_REPONSE: 1.5,          // the room kept for a response: the longest so far and half as much again (its thinking varies)
};
let compactage = null;         // {controleur, c, noeud, debut, phase} while a summary is being written
const elementsCompaction = new WeakMap();
const estNoeud = (m) => !!m && m.role === "compaction";
// two kinds of node: a summary (an empty one is an interrupted compaction), or the earlier thinking left out (no text)
const estAllege = (m) => estNoeud(m) && m.genre === "reflexion";
// the conversation's last message that is not a compaction node: a response continued after its compaction
// sits before its node and is still the last one; -1 without any
function dernierVrai(c) {
  if (c) for (let i = c.messages.length - 1; i >= 0; i--) if (!estNoeud(c.messages[i])) return i;
  return -1;
}
const estBorne = (m) => estNoeud(m) && !estAllege(m) && !!String(m.texte || "").trim();
// Whether this model's chat template keeps the thinking of earlier turns in the prompt (mesurerGarde): true for Qwen's
// and Inkling's, false for DeepSeek's; null while not measured.
let gardeReflexion = null, gardePour = "";
// What the model reads (sliceAtLastCompaction): everything without a node; with a summary node, that node, the steps it
// kept right before it, then what follows it. A step is a message of the user or a response. Before the last
// node of either kind, a response goes without its thinking: a copy, the thread keeps it.
function vueModele(messages) {
  let borne = -1, allege = -1;
  for (let i = messages.length - 1; i >= 0 && borne < 0; i--) {
    const m = messages[i];
    if (compactage && compactage.noeud === m) continue;
    if (estBorne(m)) borne = i;
    else if (allege < 0 && estAllege(m)) allege = i;
  }
  const sans = Math.max(borne, allege);
  const etape = (m, i) => (i < sans && m.role === "assistant" && m.reflexion ? {...m, reflexion: "", sansReflexion: true} : m);
  const etapes = (de, a) => { const out = []; for (let i = de; i < a; i++) if (!estNoeud(messages[i])) out.push(etape(messages[i], i)); return out; };
  if (borne < 0) return etapes(0, messages.length);
  const avant = etapes(0, borne);
  const gardes = Math.min(Math.max(0, messages[borne].gardes || 0), avant.length);
  return [messages[borne], ...(gardes > 0 ? avant.slice(avant.length - gardes) : []), ...etapes(borne + 1, messages.length)];
}
// thinking tokens of a response: the pieces received while it was written, or the server's count of its text (a
// response from before these counts: its characters, at the measured average)
const penseDe = (m) => (!m.reflexion ? 0 : m.pense != null ? m.pense : Math.ceil(m.reflexion.length / COMPACTION.CAR_PAR_JETON_MESURE));
// rough weight of a step sent without its thinking: what the server wrote less that thinking, else its characters
function poidsEtape(m) {
  if (m.role === "assistant" && m.ecrits != null && !aDesOutils(m)) {
    const pense = m.reflexion || m.sansReflexion ? m.pense : 0;
    if (pense != null) return Math.max(0, m.ecrits - pense) + 8;
  }
  const car = String(m.texte || "").length + (m.fichiers || []).reduce((n, f) => n + String(f.texte || "").length + 40, 0)
    + (aDesOutils(m) ? m.outils.reduce((n, o) => n + String(o.nom || "").length + String(o.args || "").length + 40, 0) : 0);
  return Math.ceil(car / COMPACTION.CAR_PAR_JETON) + 8 + (m.images || []).length * COMPACTION.POIDS_IMAGE;
}
// Where a compaction cuts that view (compactionCut), and the steps it keeps as written: the last ones, up to the number
// set, as far as they fit in a share of the context. Null when nothing lies before the kept steps.
function coupeCompaction(vue, garder, budget) {
  const debuts = [];
  vue.forEach((m, i) => { if (!estNoeud(m)) debuts.push(i); });
  let gardes = 0, poids = 0;
  while (gardes < Math.min(garder, debuts.length)) {
    const p = poidsEtape(vue[debuts[debuts.length - 1 - gardes]]);
    if (budget != null && poids + p > budget) break;
    poids += p; gardes++;
  }
  if (debuts.length - gardes < 1) return null;
  return {index: gardes > 0 ? debuts[debuts.length - gardes] : vue.length, gardes, poids};
}
const etapesGardees = () => { const n = Math.floor(+reglages.compactionEtapes); return Number.isFinite(n) && n >= 0 ? n : DEFAUTS.compactionEtapes; };
const budgetGarde = () => { const t = +sante.max_context || 0; return t > 0 ? Math.floor(t * COMPACTION.PART_GARDEE) : null; };
// The thinking a light compaction takes out of the context, in tokens: every earlier response's when this model's
// template keeps it; the last response's only while that is not measured (that one is in the context for sure); none
// when the template drops it by itself at the next turn (contexteUtilise then counts without it).
function gainAllegement(vue) {
  if (gardeReflexion === false) return 0;
  let dernier = -1;
  vue.forEach((m, i) => { if (m.role === "assistant") dernier = i; });
  let gain = 0;
  vue.forEach((m, i) => { if (m.role === "assistant" && m.reflexion && (gardeReflexion || i === dernier)) gain += penseDe(m); });
  return gain;
}
// the room a response is expected to need: the longest this conversation still holds, thinking included, with a margin
// ("Room kept for the next response") thinking included ("reponse", the default), or its text
// only ("texte"): a thinking adapts to the room left (the server stops it at three quarters of it), its text does not
const placeDe = (m) => (reglages.compactionPlace === "texte" ? poidsEtape(m) : m.ecrits);
const plusLongueReponse = (vue) => Math.ceil(vue.reduce((n, m) => {
  if (m.role !== "assistant" || m.ecrits == null) return n;
  const v = placeDe(m);
  return v > n ? v : n;
}, 0) * COMPACTION.MARGE_REPONSE);
// The context this conversation holds for its next message: what its last response read and wrote (less its thinking
// when this model's template drops it at the next turn), or what a compaction left (computed, until a response measures it).
// The latest measure of the context: the last response that was measured, or a compaction node after it. A
// response continued after its compaction sits BEFORE its node yet was measured after it: the newer of the two counts.
function derniereMesure(messages) {
  let noeud = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.lus != null) return noeud && !((m.mesureA || 0) > (noeud.temps || 0)) ? noeud : m;
    if (!noeud && (estBorne(m) || estAllege(m))) noeud = m;
  }
  return noeud;
}
function contexteUtilise(c, messages = c && c.messages) {
  if (!c || !messages) return null;
  const m = derniereMesure(messages);
  if (!m) return null;
  if (estNoeud(m)) return m.apres != null ? m.apres : null;
  // a continued response: its earlier text is in what its last request read; its last request wrote the rest
  return Math.max(0, m.lus + (m.ecritsDernier ?? m.ecrits ?? 0) - (gardeReflexion === false ? (m.penseDernier ?? penseDe(m)) : 0));
}
// that context is an estimate while it comes from a compaction: the next response measures it
function contexteEstime(c) {
  const m = c ? derniereMesure(c.messages) : null;
  return !m ? false : estNoeud(m) ? m.apres != null : !!m.compteEstime;
}
// What a compaction would do now, or null: {genre: "reflexion" (the earlier thinking left out) or "resume" (a summary),
// apres: the context it is expected to leave}. Before a message ("auto", after our llama.cpp interface): nothing while
// the context has room, that is under the threshold, in percent of its size, and with room left for a response
// half as long again as the longest so far; otherwise the lightest compaction that makes that room, the thinking first:
// it costs no summary and every message stays as written. By hand ("manuel"): the same choice when room is short; with room, a
// summary when steps lie before the kept ones, else the thinking left out. `besoin`: what a response is known to need
// at least (one the context cut).
function planCompaction(c, mode, arrivant = 0, messages = c && c.messages, besoin = 0, connu = null) {
  if (!c || !messages) return null;
  const total = +sante.max_context || 0;
  const vue = vueModele(messages);
  const coupe = coupeCompaction(vue, etapesGardees(), budgetGarde());
  const gain = gainAllegement(vue);
  // `connu`: the context these messages hold when something else measured it (the server's count in its refusal)
  const utilise = connu != null ? connu : contexteUtilise(c, messages), pct = +reglages.compactionSeuil;
  const leger = total > 0 && gain >= total * COMPACTION.GAIN_MINI ? {genre: "reflexion", gain, avant: utilise, apres: utilise != null ? Math.max(0, utilise - gain) : null} : null;
  // A summary is expected to weigh what the last one of this conversation did (they grow with the work: 2,683 tokens at
  // the sixth of a real session), else a usual size. It is worth it only if it leaves clearly less than there is now:
  // seen on Hy4-flash, which drops earlier thinking by itself, a 500-token message summarized for nothing (3,884 → 3,984).
  const prevu = estNoeud(vue[0]) && vue[0].ecrits ? Math.max(vue[0].ecrits, COMPACTION.RESUME_PREVU / 2) : COMPACTION.RESUME_PREVU;
  // the summary request carries what lies before the kept steps (without thinking), the instruction, and room for
  // the summary: when that cannot fit, there is no summary to make (seen at 8,192: one continued answer whose text alone
  // filled the context; the request was refused, then the message, then its rescue)
  let tient = !!coupe;
  if (coupe && total > 0) {
    let lu = 100 + Math.min(COMPACTION.RESUME_PREVU, total / 8);
    for (let i = 0; i < coupe.index; i++) lu += poidsEtape(vue[i]);
    tient = lu <= total;
  }
  const plein = coupe && tient && (utilise == null || !(total > 0) || utilise - (coupe.poids + prevu) >= total * COMPACTION.GAIN_MINI)
    ? {genre: "resume", coupe, avant: utilise, apres: coupe.poids + prevu} : null;
  const auChoix = mode === "auto" ? null : plein || leger;
  if (!(total > 0) || utilise == null || !Number.isFinite(pct) || pct <= 0) return auChoix;
  const seuil = (total * Math.min(pct, 100)) / 100, reserve = Math.max(plusLongueReponse(vue), Math.ceil(besoin * COMPACTION.MARGE_REPONSE));
  const serre = (u) => u + arrivant >= seuil || u + arrivant + reserve > total;
  if (!serre(utilise)) return auChoix;
  if (leger && !serre(leger.apres)) return leger;
  if (plein && (!leger || !serre(plein.apres))) return plein;
  // neither makes enough room: the one that leaves clearly less, else the thinking (every message stays as written)
  return plein && leger && plein.apres < leger.apres - total * COMPACTION.ECART_MINI ? plein : leger || plein;
}
async function lireFlux(r, surObjet) {          // the objects of a streamed answer, one per "data:" line
  const lecteur = r.body.getReader(), dec = new TextDecoder();
  let tampon = "";
  const traiter = (ligne) => {
    if (!ligne.startsWith("data:")) return;
    const donnee = ligne.slice(5).trim();
    if (!donnee || donnee === "[DONE]") return;
    let j;
    try { j = JSON.parse(donnee); } catch (e) { return; }
    surObjet(j);
  };
  for (;;) {
    const {value, done} = await lecteur.read();
    if (done) break;
    tampon += dec.decode(value, {stream: true});
    let k;
    while ((k = tampon.indexOf("\n")) >= 0) { const ligne = tampon.slice(0, k).trim(); tampon = tampon.slice(k + 1); traiter(ligne); }
  }
  tampon += dec.decode();
  if (tampon.trim()) traiter(tampon.trim());
}
// how many tokens the server counts in a text (its /tokenize, no engine work); null when it cannot say. A text past
// COMPACTION.COMPTE_MAXI is estimated instead.
async function compterJetons(texte, signal) {
  if (texte.length > COMPACTION.COMPTE_MAXI) return Math.ceil(texte.length / COMPACTION.CAR_PAR_JETON_MESURE);
  const r = await fetch("tokenize", {method: "POST", headers: entetes(true), body: JSON.stringify({content: texte}), signal});
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j.tokens) ? j.tokens.length : null;
}
const modeleServi = () => (mesures && mesures.engine && mesures.engine.model) || sante.model || "flash-next";
// Whether this model's template keeps the thinking of earlier turns, measured without the engine: the server
// counts the same short conversation with and without a thinking block (its token count route).
async function mesurerGarde() {
  const modele = modeleServi();
  if (gardePour === modele) return;
  gardePour = modele; gardeReflexion = null;
  const pense = "The user greets me. A short greeting back is all that is needed here. ".repeat(4);
  const compte = async (avec) => {
    const r = await fetch("v1/messages/count_tokens", {method: "POST", headers: entetes(true), body: JSON.stringify({model: modele, messages: [
      {role: "user", content: "Hello."},
      {role: "assistant", content: [...(avec ? [{type: "thinking", thinking: pense, signature: ""}] : []), {type: "text", text: "Hello."}]},
      {role: "user", content: "And again."}]})});
    if (!r.ok) return null;
    const j = await r.json();
    return Number.isFinite(+j.input_tokens) ? +j.input_tokens : null;
  };
  let garde = null;
  try {
    const [a, s] = await Promise.all([compte(true), compte(false)]);
    if (a != null && s != null) garde = a - s > 16;
  } catch (e) { /* not measured: the cautious counts apply */ }
  if (gardePour !== modele) return;                 // another model came meanwhile: its own measure follows
  if (garde === null) gardePour = "";               // asked again at the next reading of the server's state
  gardeReflexion = garde;
  dessinerJauge(); majDernierMessage();
}
// The thinking of each response of a conversation, in tokens as the server counts its text: where it was only counted
// from the pieces received (within a few tokens of it: 5,726 for 5,728, 4,272 for 4,284), or not at all (a conversation
// from before these counts).
async function compterPensees(c) {
  const manque = (c ? c.messages : []).filter((m) => m.role === "assistant" && m.reflexion && m.reflexion.length <= COMPACTION.COMPTE_MAXI
    && (m.pense == null || m.penseDesMorceaux));
  if (!manque.length) return;
  await Promise.all(manque.map(async (m) => {
    try { const n = await compterJetons(m.reflexion); if (n != null) { m.pense = n; delete m.penseDesMorceaux; } } catch (e) { /* the count it has stays */ }
  }));
  garderConvs(); dessinerJauge(); majDernierMessage();
}
// tokens of a step's text as a request carries it, without its thinking
async function jetonsEtape(m, signal) {
  if (m.role === "assistant" && m.ecrits != null && !aDesOutils(m)) {
    const pense = m.reflexion || m.sansReflexion ? m.pense : 0;
    if (pense != null) return Math.max(0, m.ecrits - pense);
  }
  const texte = m.role === "user" ? [m.texte, ...(m.fichiers || []).map(blocFichier)].filter((x) => x).join("\n\n")
    : [m.texte || "", ...(aDesOutils(m) ? m.outils.map((o) => `${o.nom || ""} ${o.args || ""}`) : [])].join("\n");
  return texte ? compterJetons(texte, signal) : 0;
}
// Compacts the conversation (compactConversation): "ok", "echec" (the node is gone, an announcement says why), "arrete"
// (stopped by hand) or "rien" (nothing to compact). `attente`: the message of the user that waits for it, shown after the
// node. `plan`: what to do (planCompaction), by hand when not given.
async function compacter(c, attente = null, plan = planCompaction(c, "manuel")) {
  if (!c || enCours || compactage || !plan) return "rien";
  if (plan.genre === "reflexion") {                 // nothing to write: the node says it, the requests that follow go without that thinking
    const avant = plan.avant != null ? plan.avant : contexteUtilise(c);
    c.messages.push({role: "compaction", genre: "reflexion", texte: "", avant, apres: avant != null ? Math.max(0, avant - plan.gain) : null, temps: Date.now()});
    if (attente) c.messages.push(attente);
    c.modifie = Date.now();
    garderConvs(); dessinerConvs(); dessinerFil();
    return "ok";
  }
  const source = vueModele(c.messages);
  const coupe = coupeCompaction(source, etapesGardees(), budgetGarde());
  if (coupe === null) return "rien";
  const noeud = {role: "compaction", texte: "", gardes: coupe.gardes, avant: plan.avant != null ? plan.avant : contexteUtilise(c), apres: null, temps: Date.now()};
  c.messages.push(noeud);
  if (attente) c.messages.push(attente);
  const controleur = new AbortController();
  compactage = {controleur, c, noeud, debut: performance.now(), phase: "lecture"};
  suivre = true;
  occupe(true);
  c.modifie = Date.now();
  dessinerConvs(); dessinerFil();
  const minuterie = setInterval(() => majCompaction(noeud), 250);
  relever();
  let fin = null, usage = null, erreur = "", arrete = false;
  const consigne = String(reglages.compactionConsigne || "").trim() || COMPACTION.CONSIGNE;
  try {
    // What lies before the kept steps, then the instruction. Ours: without the thinking of those steps and
    // without thinking of its own. A compaction comes when room is short: this is the smallest request that carries
    // the conversation, and its answer is the summary alone (llama.cpp sends the chat's own options and so reuses its
    // cache; here the thinking asked changes the very start of the prompt, and what the server has read with it).
    const corps = {model: modeleServi(), stream: true, reasoning_effort: "none",
                   messages: [...messagesDe(source.slice(0, coupe.index), true), {role: "user", content: consigne}]};
    if (reglages.temperature != null) corps.temperature = reglages.temperature;
    if (reglages.temperature !== 0) {
      if (reglages.top_p != null) corps.top_p = reglages.top_p;
      if (reglages.top_k != null) corps.top_k = reglages.top_k;
    }
    const r = await fetch("v1/chat/completions", {method: "POST", headers: entetes(true), body: JSON.stringify(corps), signal: controleur.signal});
    if (!r.ok) throw await refus(r);
    await lireFlux(r, (j) => {
      if (j.error) throw new Error(j.error.message || "The engine reported an error.");
      if (j.usage) usage = j.usage;
      const ch = (j.choices && j.choices[0]) || {};
      if (ch.finish_reason) fin = ch.finish_reason;
      const d = ch.delta || {};
      if (d.reasoning_content && compactage.phase !== "ecriture") compactage.phase = "reflexion";
      if (d.content) { noeud.texte += d.content; compactage.phase = "ecriture"; }
    });
    if (fin === "length") throw new Error(COMPACTION.PLEIN);   // a summary the limit cut is no summary
    if (!noeud.texte.trim()) throw new Error("The model returned no summary.");
  } catch (e) {
    if (e.name === "AbortError") arrete = true;
    // the server refused the summary request for lack of room: said with what to do about it
    else erreur = e.statut === 400 && /context/i.test(`${e.code} ${e.detail}`) ? COMPACTION.PLEIN : String(e.message || e);
  }
  const resume = !arrete && !erreur;
  if (!resume) {                                    // an interrupted compaction leaves no node behind
    const k = c.messages.indexOf(noeud);
    if (k >= 0) c.messages.splice(k, 1);
  } else {
    noeud.texte = noeud.texte.trim();
    noeud.ecrits = usage ? usage.completion_tokens : null;
    noeud.duree = (performance.now() - compactage.debut) / 1000;
    // The size of the reduced context, computed: the framed summary and the kept steps without their thinking, as the
    // server counts their text (/tokenize, no engine work), plus the template's own tokens around each message.
    // llama.cpp reads the reduced context again instead (its pre-encode), which also leaves its server ready; here the
    // message that waits reads it anyway, and that response then gives the measure. No number when a kept step carries
    // an image: its size is only known once read.
    try {
      const gardees = source.slice(coupe.index);
      if (!gardees.some((m) => (m.images || []).length)) {
        const comptes = await Promise.all([compterJetons(COMPACTION.GABARIT + noeud.texte, controleur.signal), ...gardees.map((m) => jetonsEtape(m, controleur.signal))]);
        // (7 tokens of template around each message, measured: 245 read for 223 of text in 3 messages on the 27B, 208 for 182 on Flash-Next)
        if (comptes.every((n) => n != null)) noeud.apres = comptes.reduce((a, b) => a + b, 0) + 7 * comptes.length + 1;
      }
    } catch (e) {
      if (e.name === "AbortError") arrete = true;     // the summary stays; its size will follow the next response
    }
  }
  clearInterval(minuterie);
  compactage = null;
  occupe(false);
  c.modifie = Date.now();
  garderConvs(); dessinerConvs(); dessinerFil(); relever();
  if (erreur) annonce("erreur", "Compaction failed", erreur, 9000);
  if (!attente) montrerAvisPage();                  // a newer page seen meanwhile (a waiting message: after its response)
  return arrete ? "arrete" : resume ? "ok" : "echec";
}
// The server refused a message because the conversation no longer fits (the page did not know its size: a
// conversation from before these counts, an image, a response without its final count). The refusal says what the
// request weighs, the server's own count: the compaction that makes room for it, then the message again, once. False
// when nothing can be dropped: the refusal then shows as it is.
async function rattraper(c, m, lu) {
  const k = c.messages.indexOf(m), question = k >= 1 ? c.messages[k - 1] : null;
  if (!question || question.role !== "user") return false;
  const avant = c.messages.slice(0, k - 1);
  const car = String(question.texte || "").length + (question.fichiers || []).reduce((n, f) => n + String(f.texte || "").length, 0);
  const arrivant = Math.ceil(car / COMPACTION.CAR_PAR_JETON);
  const plan = planCompaction(c, "auto", arrivant, avant, 0, lu != null ? Math.max(0, lu - arrivant) : +sante.max_context || null);
  if (!plan) return false;
  c.messages.length = k - 1;                        // the refused response goes; its message waits after the node
  const fait = await compacter(c, question, plan);
  if (!c.messages.includes(question)) c.messages.push(question);
  if (fait !== "ok") {
    c.messages.push(m);
    c.modifie = Date.now();
    garderConvs(); dessinerFil();
    return false;
  }
  demander(c, true);
  return true;
}
// A response the context cut, with text written, can go on (the server continues a final assistant message,
// as llama.cpp's prefill-assistant): its own thinking leaves the context (the continuation is text) and, when this model
// keeps earlier turns' thinking, theirs too: the light compaction, its node placed after the response. Null when that
// does not leave a fifth of the context for the rest of it, or the response cannot be continued.
const coupeeParContexte = (m) => !m.limite || !!m.pleinMoteur || (m.ecrits != null && m.ecrits < m.limite);
function continuable(c, m) {
  const k = c ? c.messages.indexOf(m) : -1;
  return k >= 1 && k === dernierVrai(c) && m.role === "assistant" && m.fin === "length" && !m.erreur && !m.arretee
    && !!String(m.texte || "").trim() && !aDesOutils(m) && !enCours && !compactage;
}
function planSuite(c, m) {
  const total = +sante.max_context || 0;
  if (!(total > 0) || m.lus == null || !continuable(c, m)) return null;
  const utilise = m.lus + (m.ecritsDernier ?? m.ecrits ?? 0);     // the continuation reads all of it, its thinking included
  let gain = 0;
  for (const x of vueModele(c.messages)) if (x.role === "assistant" && x.reflexion && (x === m || gardeReflexion === true)) gain += penseDe(x);
  // a context really full (a response stopped by its length with room left is no context cut), and room really freed
  if (utilise < total * 0.9 || gain < total * COMPACTION.GAIN_MINI) return null;
  const apres = Math.max(0, utilise - gain);
  if (total - apres < total * COMPACTION.REESSAI_MINI) return null;
  return {genre: "reflexion", gain, avant: utilise, apres};
}
// compact what planSuite says, then continue the response in its bubble
async function compacterEtPoursuivre(c, m, plan = planSuite(c, m)) {
  if (!plan || (await compacter(c, null, plan)) !== "ok") return false;
  demander(c, false, m);
  return true;
}
// what a compaction of the messages before a cut response would do, when it frees enough room for asking again to be
// worth it (a fifth of the context: the room the threshold keeps for a response); null otherwise
function planReessai(c, avant, coupee) {
  const plan = planCompaction(c, "manuel", 0, avant, (coupee && coupee.ecrits) || 0);
  const total = +sante.max_context || 0, utilise = contexteUtilise(c, avant);
  return plan && plan.apres != null && utilise != null && total > 0 && utilise - plan.apres >= total * COMPACTION.REESSAI_MINI ? plan : null;
}
// A response the context cut: compact what came before its message, then ask again. The cut response goes, as
// with Regenerate; when the compaction does not happen, everything is back as it was.
async function compacterEtReessayer() {
  const c = convCourante();
  if (!c || enCours || compactage) return;
  const n = dernierVrai(c) + 1, coupee = c.messages[n - 1], question = c.messages[n - 2];
  if (!coupee || coupee.role !== "assistant" || !question || question.role !== "user") return;
  const plan = planReessai(c, c.messages.slice(0, n - 2), coupee);
  if (!plan) return;
  const retires = c.messages.splice(n - 2);          // its message, the response, and a continuation's node if any
  const fait = await compacter(c, question, plan);
  if (fait !== "ok") {
    const k = c.messages.indexOf(question);
    if (k >= 0) c.messages.splice(k, 1);
    c.messages.push(...retires);
    c.modifie = Date.now();
    garderConvs(); dessinerFil();
    return;
  }
  demander(c);
}
function elementCompaction(m, i) {
  const el = document.createElement("div");
  el.className = "msg msg--compaction";
  el.dataset.i = i;
  el.innerHTML = `<details class="compaction"><summary>${ic("compacter", "ic ic--p")}<span class="compaction__titre"></span>${ic("chevron", "ic ic--p chevron")}</summary>` +
    `<div class="compaction__corps"><div class="reponse md"></div><div class="msg__meta"><span class="meta-texte"></span><span class="meta-actions">` +
    `<button type="button" class="btn btn--icone" data-copier-msg title="Copy summary" aria-label="Copy summary">${ic("copier")}</button>` +
    `<button type="button" class="btn btn--icone" data-retirer-compaction title="Remove this compaction" aria-label="Remove this compaction">${ic("corbeille")}</button>` +
    `</span></div></div></details>`;
  elementsCompaction.set(m, el);
  majCompaction(m);
  return el;
}
function majCompaction(m) {
  const el = elementsCompaction.get(m);
  if (!el) return;
  const vivant = !!compactage && compactage.noeud === m;
  const leger = estAllege(m);
  const det = el.querySelector("details");
  det.dataset.etat = vivant ? "cours" : "fini";
  det.dataset.genre = leger ? "reflexion" : "resume";
  let titre;
  if (vivant) {
    const live = (mesures && mesures.live) || {};
    const lu = live.state === "reading" ? partLue(live) : null;
    titre = ["Compacting conversation", compactage.phase === "ecriture" ? "writing the summary" : compactage.phase === "reflexion" ? "thinking"
      : lu != null ? `reading ${nf(lu * 100)}%` : "reading"];
    if (m.texte && !det._ouvert) { det._ouvert = true; det.open = true; }      // the summary shows while it is written
  } else {
    titre = [leger ? "Earlier thinking left out" : "Conversation compacted", m.avant != null && m.apres != null ? `${nf(m.avant)} → about ${nf(m.apres)} tokens`
      : m.avant != null ? `from ${nf(m.avant)} tokens` : null];
  }
  const t = el.querySelector(".compaction__titre"), html = morceaux(titre);
  if (t._html !== html) { t._html = html; t.innerHTML = html; }
  const rep = el.querySelector(".reponse"), texte = leger ? "leger:" : m.texte;
  if (rep._texte !== texte) {
    rep._texte = texte;
    rep.innerHTML = leger ? `<p>The thinking of the responses above is no longer sent to the model. Every message stays as written.</p>`
      : m.texte ? enHtml(m.texte) : "";
  }
  const meta = leger ? [quand(m.temps)] : [m.ecrits != null ? `${nf(m.ecrits)} tokens` : null, m.duree != null ? `${nf(m.duree, 1)} s` : null,
    m.gardes != null ? `${nf(m.gardes)} ${m.gardes === 1 ? "step" : "steps"} kept as written` : null, quand(m.temps)];
  el.querySelector(".meta-texte").innerHTML = vivant ? "" : morceaux(meta);
  el.querySelector(".meta-actions").hidden = vivant;
  el.querySelector("[data-copier-msg]").hidden = leger;
}
function retirerCompaction(i) {
  const c = convCourante();
  if (!c || enCours || compactage || !estNoeud(c.messages[i])) return;
  const [noeud] = c.messages.splice(i, 1);
  c.modifie = Date.now();
  garderConvs(); dessinerFil();
  annonce("info", "Compaction removed", estAllege(noeud) ? "The model reads the earlier thinking again." : "The model reads the whole conversation again.", 7000, {libelle: "Undo", faire: () => {
    c.messages.splice(Math.min(i, c.messages.length), 0, noeud);
    c.modifie = Date.now();
    garderConvs(); dessinerFil();
  }});
}
// The context gauge: the chip beside the response settings, and its details in the drawer with the compaction button.
function dessinerJauge() {
  const c = convCourante();
  const total = +sante.max_context || 0;
  let utilise = contexteUtilise(c), environ = contexteEstime(c);
  // while its response is read or written, what the context holds now, as the server says it: the message read
  // and what is written so far (llama.cpp's gauge moves the same way). It only goes up during a response: the server
  // first announces an estimate of the message to read (618 tokens, then 549 counted; 1,921, then 2,474), and it is
  // idle again an instant before the page has the end of the stream (seen through the real window: the gauge fell back
  // to the value from before the request at the end of each response).
  const live = (mesures && mesures.live) || {};
  const mien = !!enCours && enCours.c === c;
  if (mien && enCours.phase !== "envoi" && live.prompt_tokens != null && (live.state === "reading" || live.state === "generating")) {
    enCours.jauge = Math.max(enCours.jauge || 0, enCours.plancher || 0, live.prompt_tokens + (live.state === "generating" ? Math.max(live.generated || 0, 0) : 0));
    // kept for a response that ends without the server's count; the message's size is exact once it is being written
    if (live.state === "generating" || enCours.lusVivant == null) enCours.lusVivant = live.prompt_tokens;
    if (live.state === "generating") enCours.ecritsVivant = Math.max(enCours.ecritsVivant || 0, live.generated || 0);
  }
  const enVol = mien && enCours.jauge != null;
  if (enVol) { utilise = total > 0 ? Math.min(enCours.jauge, total) : enCours.jauge; environ = false; }
  const connu = total > 0 && utilise != null;
  const pct = connu ? Math.min(100, Math.round((utilise / total) * 100)) : 0;
  // amber when the next message will compact first (automatic), or when the context is nearly full
  const auto = !!reglages.compactionAuto;
  const haut = connu && (pct >= (auto ? Math.min(+reglages.compactionSeuil || DEFAUTS.compactionSeuil, 100) : 90) || (auto && !enVol && !!planCompaction(c, "auto")));
  const puce = $("btn-jauge");
  puce.hidden = !connu;
  puce.dataset.niveau = haut ? "haut" : "";
  puce.title = connu ? `Context: ${environ ? "about " : ""}${nf(utilise)} of ${nf(total)} tokens` : "Context";
  $("jauge-arc").style.strokeDasharray = `${pct} 100`;
  $("jauge-texte").textContent = `${connu && environ ? "~" : ""}${pct}%`;
  $("o-jauge").textContent = connu ? `${environ ? "about " : ""}${nf(utilise)} / ${nf(total)} tokens` : "";
  $("jauge-barre-boite").dataset.niveau = haut ? "haut" : "";
  $("jauge-barre").style.width = `${pct}%`;
  $("jauge-note").innerHTML = connu ? morceaux([`${environ ? "about " : ""}${pct}% used`, `${nf(Math.max(0, total - utilise))} remaining`])
    : esc(c && c.messages.length ? "Known after the next response." : "Known after the first response.");
  // the button, and under it what it would do now: said, not left to a tooltip on a greyed button
  const plan = planCompaction(c, "manuel");
  const quoi = !plan ? "Nothing to compact yet." : plan.genre === "resume" ? "The model summarizes the conversation; the last steps stay as written."
    : "Leaves out the thinking of earlier responses; every message stays as written.";
  $("btn-compacter").disabled = !plan || !!enCours || !!compactage;
  $("btn-compacter").title = quoi;
  $("compacter-note").textContent = quoi;
}
// the last message's end notice follows what the server can do (a longer context) and what a compaction could
function majDernierMessage() {
  const c = convCourante();
  if (!c || enCours || compactage) return;
  const m = c.messages[dernierVrai(c)], el = m && elements.get(m);
  if (el && m.role === "assistant") majLapilli(el, m, false);
}
// whether the Engine settings card can serve a longer context than now
function contextePlusLong() {
  const m = reglagesMoteur, ctx = (m && m.context) || {};
  if (!m || !m.supported || ctx.source === "command line" || ctx.source === "slots") return false;
  const servi = +sante.max_context || +ctx.value || 0;
  return (ctx.choices || []).some((n) => n > servi);
}
const elements = new WeakMap();            // a Lapilli message -> its element in the thread
function elementMessage(m, i) {
  if (estNoeud(m)) return elementCompaction(m, i);
  const el = document.createElement("div");
  el.dataset.i = i;
  if (m.role === "user") {
    el.className = "msg msg--moi";
    if (m.fichiers && m.fichiers.length) {
      const w = document.createElement("div");
      w.className = "pieces-msg";
      for (const f of m.fichiers) {
        const p = document.createElement("span");
        p.className = "piece piece--fixe";
        p.innerHTML = ic("fichier", "ic ic--p");
        const n = document.createElement("span"); n.className = "piece__nom"; n.textContent = f.nom; p.appendChild(n);
        w.appendChild(p);
      }
      el.appendChild(w);
    }
    if (m.images && m.images.length) {               // one click shows it full size
      const w = document.createElement("div");
      w.className = "images-msg";
      for (const i of m.images) {
        if (i.image) {
          const b = document.createElement("button");
          b.type = "button"; b.className = "image-msg"; b.title = `${i.nom}: view full size`;
          b.setAttribute("aria-label", `View image ${i.nom} full size`);
          const v = document.createElement("img");
          v.src = i.image; v.alt = i.nom;
          // its on-screen size, computed here (280 x 200 at most, proportions kept) so the frame fits tightly around it
          // (CSS alone left empty space on its right: the width was capped AFTER the height)
          if (i.l && i.h) { const k = Math.min(1, 280 / i.l, 200 / i.h); v.width = Math.round(i.l * k); v.height = Math.round(i.h * k); }
          b.appendChild(v);
          b.onclick = () => voirImage(i);
          w.appendChild(b);
        } else {
          const p = document.createElement("span");
          p.className = "piece piece--fixe";
          p.innerHTML = ic("fichier", "ic ic--p");
          const n = document.createElement("span"); n.className = "piece__nom"; n.textContent = `${i.nom} (no longer kept)`; p.appendChild(n);
          w.appendChild(p);
        }
      }
      el.appendChild(w);
    }
    if (m.texte) {
      const b = document.createElement("div");
      b.className = "bulle";
      b.textContent = m.texte;
      el.appendChild(b);
    }
    const meta = document.createElement("div");
    meta.className = "msg__meta";
    meta.innerHTML = `<span class="meta-texte">${morceaux(["You", quand(m.temps)])}</span><span class="meta-actions">` +
      `<button type="button" class="btn btn--icone" data-copier-msg title="Copy message" aria-label="Copy message">${ic("copier")}</button></span>`;
    el.appendChild(meta);
    return el;
  }
  el.className = "msg msg--lapilli";
  el.innerHTML = `<div class="msg__avatar"><img src="web/lapilli-logo.svg" alt=""></div><div class="msg__contenu">` +
    `<details class="reflexion" hidden><summary>${ic("reflexion", "ic ic--p")}<span class="reflexion__titre"></span>${ic("chevron", "ic ic--p chevron")}</summary>` +
    `<div class="reflexion__corps"></div></details>` +
    `<div class="reponse md"></div><div class="outils" hidden></div><div class="activite" hidden></div><div class="fin" hidden></div>` +
    `<div class="msg__meta"><span class="meta-texte"></span><span class="meta-actions">` +
    `<button type="button" class="btn btn--icone" data-copier-msg title="Copy response" aria-label="Copy response">${ic("copier")}</button>` +
    `<button type="button" class="btn btn--icone" data-regenerer title="Regenerate response" aria-label="Regenerate response">${ic("regenerer")}</button>` +
    `</span></div></div>`;
  elements.set(m, el);
  majLapilli(el, m, false);
  return el;
}

// a long run without spaces (a URL, a path) may wrap after "/ . - _ @ ? & = : , ;", never in the middle
// of a word (otherwise a narrow screen splits a word inside a URL)
function coupable(texte) {
  return String(texte).split(/(\S{24,})/).map((x, i) => (i % 2 ? x.split(/(?<=[\/.\-_@?&=:,;])(?=\S)/).map(esc).join("<wbr>") : esc(x))).join("");
}
function majReflexion(el, m, vivant) {
  const det = el.querySelector("details.reflexion");
  if (!m.reflexion) { det.hidden = true; return; }
  det.hidden = false;
  const enTrain = vivant && !m.texte && !aDesOutils(m) && !m.erreur;   // a tool call ends the thinking
  det.dataset.vivant = enTrain ? "1" : "0";
  const s = enTrain && enCours && enCours.debutRefl ? (performance.now() - enCours.debutRefl) / 1000 : m.reflexionS;
  el.querySelector(".reflexion__titre").textContent = enTrain ? `Thinking${s != null ? ` · ${nf(s, 0)} s` : ""}`
    : m.reflexionS != null ? `Thought for ${nf(m.reflexionS, 1)} s` : "Thinking";
  const corps = el.querySelector(".reflexion__corps");
  if (det.open) {
    const enBas = corps.scrollHeight - corps.scrollTop - corps.clientHeight < 40;
    if (corps.textContent.length !== m.reflexion.length) corps.innerHTML = coupable(m.reflexion);
    if (enBas) corps.scrollTop = corps.scrollHeight;
  } else {
    corps.dataset.attente = "1";
  }
  // open while it is being written (if wanted), closed when the answer starts; unless the user toggled it
  if (enTrain && reglages.montrer && !det.dataset.touchee && !det.open) { det._auto = true; det.open = true; corps.innerHTML = coupable(m.reflexion); }
  if (!enTrain && enCours && enCours.m === m && enCours.finRefl && !enCours.refermee) {
    enCours.refermee = true;
    if (det.open && !det.dataset.touchee) { det._auto = true; det.open = false; }
  }
}
function majLapilli(el, m, vivant) {
  majReflexion(el, m, vivant);
  majOutils(el, m, vivant);
  const rep = el.querySelector(".reponse");
  const outils = aDesOutils(m);
  rep.classList.remove("curseur-ecriture");
  if (m.erreur && !m.texte) {
    rep.hidden = false;
    rep.innerHTML = `<div class="erreur-msg">${ic("erreur")}<span></span></div>`;
    rep.querySelector("span").textContent = m.erreur;
  } else if (!m.texte && (vivant || outils)) {
    rep.innerHTML = "";                              // nothing written (yet): the activity line, or the tool call, says what is going on
    rep.hidden = true;
  } else {
    rep.hidden = false;
    rep.innerHTML = enHtml(m.texte || "") + (m.erreur ? `<div class="erreur-msg">${ic("erreur")}<span>${esc(m.erreur)}</span></div>` : "");
    if (vivant && !outils) {                         // the cursor at the end of the last text block (not during a tool call)
      const dernier = [...rep.querySelectorAll("p, li, h1, h2, h3, h4, td")].pop();
      if (dernier) dernier.classList.add("curseur-ecriture"); else rep.classList.add("curseur-ecriture");
    }
    if (!m.texte && !m.erreur) {
      rep.innerHTML = `<p class="doux">${m.arretee ? "Stopped before writing a response." : !m.meta ? "Response interrupted: the page was reloaded while it was being written." : "No written response."}</p>`;
    }
  }
  const fin = el.querySelector(".fin");
  const notes = [];
  // a notice's buttons as one group: they go to the next line together, on the right
  const actions = (b) => (b ? `<span class="fin-note__actions">${b}</span>` : "");
  if (!vivant && outils) {                           // the page has no tools
    notes.push(`<div class="fin-note"><span class="fin-note__texte">${ic("info", "ic ic--p")}<span>${m.outils.length > 1 ? "The model wanted to use tools." : "The model wanted to use a tool."} This page has none: nothing was run.</span></span></div>`);
  }
  if (!vivant && m.fin === "length") {
    // the length the response asked for, or the end of the context: with no length, or fewer tokens than the
    // length asked (the server cut it to the room the conversation left), it is the context that stopped it, and the
    // settings cannot give it more room
    const contexte = coupeeParContexte(m);
    const ctx = +sante.max_context || 0;
    if (contexte) {
      // with what to do about it. Something came before its message: compact that, then ask again. Nothing
      // did: when its thinking took most of it (said with its count: the server stops a thinking at three quarters of
      // the room, whatever the context), a shorter thinking; and a longer context when the server can serve one.
      const conv = convCourante(), k = conv ? conv.messages.indexOf(m) : -1;
      const enDernier = !!conv && k >= 1 && k === dernierVrai(conv) && !enCours && !compactage;
      const avant = enDernier && conv.messages[k - 1].role === "user" ? conv.messages.slice(0, k - 1) : null;
      // with text written, it goes on; without, its message is asked again
      const suite = enDernier ? planSuite(conv, m) : null;
      const plan = !suite && avant ? planReessai(conv, avant, m) : null;
      const plusLong = enDernier && !plan && contextePlusLong(), pensif = enDernier && !plan && penseDe(m) * 2 > (m.ecrits || 0);
      const lien = `<a href="#apropos" data-vers-moteur>About</a>`;
      const pense = pensif ? (m.pense != null ? `, ${nf(m.pense)} of them for its thinking` : ", most of them for its thinking") : "";
      const conseil = pensif ? ` Choose a shorter thinking${plusLong ? `, or make the context longer under ${lien}` : ""}.` : plusLong ? ` Make it longer under ${lien}.` : "";
      notes.push(`<div class="fin-note"><span class="fin-note__texte">${ic("alerte", "ic ic--p")}<span>The response filled the model's context${ctx ? ` (${nf(ctx)}\u00a0tokens)` : ""}${pense}.${conseil}</span></span>` +
        actions((suite ? `<button type="button" class="btn btn--doux" data-compacter-poursuivre>Compact and continue</button>`
          : plan ? `<button type="button" class="btn btn--doux" data-compacter-reessayer>Compact and try again</button>` : "") +
          (pensif ? `<button type="button" class="btn btn--doux" data-ouvrir-reglages>Settings</button>` : "")) + `</div>`);
    } else {
      const conv2 = convCourante(), place = (+sante.max_context || 0) - (m.lus || 0) - (m.ecritsDernier ?? m.ecrits ?? 0);
      const encore = conv2 && continuable(conv2, m) && place > Math.min(1024, (+sante.max_context || 0) / 8);
      notes.push(`<div class="fin-note"><span class="fin-note__texte">${ic("alerte", "ic ic--p")}<span>The response reached the maximum length (${nf(m.limite)}\u00a0tokens).</span></span>` +
        actions((encore ? `<button type="button" class="btn btn--doux" data-poursuivre>Continue</button>` : "") +
          `<button type="button" class="btn btn--doux" data-ouvrir-reglages>Settings</button>`) + `</div>`);
    }
  }
  const notesHtml = notes.join("");
  if (fin._notes !== notesHtml) { fin._notes = notesHtml; fin.innerHTML = notesHtml; }
  fin.hidden = !notes.length;
  el.querySelector(".activite").hidden = !vivant;
  el.querySelector(".msg__meta .meta-texte").innerHTML = vivant ? "" : morceaux(m.meta || ["Interrupted"]);
  if (m.metaTitre) el.querySelector(".msg__meta .meta-texte").title = m.metaTitre;
  el.querySelector("[data-copier-msg]").hidden = vivant || !m.texte;
  const c = convCourante();
  const dernier = c && c.messages[dernierVrai(c)] === m;
  el.querySelector("[data-regenerer]").hidden = vivant || !dernier || !!enCours;
}
function dessinerFil() {
  const fil = $("fil");
  fil.querySelectorAll(".msg").forEach((e) => e.remove());
  const c = convCourante();
  const vide = !c || !c.messages.length;
  $("accueil").hidden = !vide;
  if (c) c.messages.forEach((m, i) => fil.appendChild(elementMessage(m, i)));
  descendre(true);
  dessinerJauge();
}
const filDefile = $("fil-defile");
const presDuBas = () => filDefile.scrollHeight - filDefile.scrollTop - filDefile.clientHeight < 140;
let suivre = true;                              // follow the end of the text, unless the user scrolled up
function descendre(force) {
  if (force || suivre) filDefile.scrollTop = filDefile.scrollHeight;
  majVersBas();
}
function majVersBas() { $("vers-bas").hidden = presDuBas(); }
filDefile.addEventListener("scroll", () => { suivre = presDuBas(); majVersBas(); }, {passive: true});
$("vers-bas").onclick = () => { suivre = true; filDefile.scrollTo({top: filDefile.scrollHeight, behavior: "smooth"}); };

$("fil").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-copier-code]");
  if (cc) { copier(cc.closest(".code-bloc").querySelector("pre").textContent, cc); return; }
  const cm = e.target.closest("[data-copier-msg]");
  if (cm) {
    const c = convCourante(), m = c && c.messages[+cm.closest(".msg").dataset.i];
    if (m) copier(m.texte || "", cm);
    return;
  }
  if (e.target.closest("[data-regenerer]")) { regenerer(); return; }
  const rc = e.target.closest("[data-retirer-compaction]");
  if (rc) { retirerCompaction(+rc.closest(".msg").dataset.i); return; }
  if (e.target.closest("[data-compacter-reessayer]")) { compacterEtReessayer(); return; }
  if (e.target.closest("[data-compacter-poursuivre]")) {   // compact, then the response goes on
    const c = convCourante(), m = c && c.messages[dernierVrai(c)];
    if (m) compacterEtPoursuivre(c, m);
    return;
  }
  if (e.target.closest("[data-poursuivre]")) {             // llama.cpp's Continue: the response goes on
    const c = convCourante(), m = c && c.messages[dernierVrai(c)];
    if (m && continuable(c, m)) demander(c, false, m);
    return;
  }
  if (e.target.closest("[data-vers-moteur]")) {    // the Engine settings card, on About
    e.preventDefault();
    montrerVue("apropos");
    $("carte-reglages-moteur").scrollIntoView({block: "start"});
    return;
  }
  if (e.target.closest("[data-repondre-maintenant]")) { repondreMaintenant(); return; }
  if (e.target.closest("[data-ouvrir-reglages]")) { ouvrirTiroir(true); return; }
  const s = e.target.closest(".suggestion");
  if (s) { $("saisie").value = s.dataset.q; ajusterSaisie(); envoyer(); }
});
$("fil").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS" || !d.classList.contains("reflexion")) return;
  if (d._auto) { d._auto = false; return; }          // our own openings, not the user's
  d.dataset.touchee = "1";
  const corps = d.querySelector(".reflexion__corps");
  if (d.open && corps.dataset.attente) {
    const c = convCourante(), m = c && c.messages[+d.closest(".msg").dataset.i];
    if (m) corps.innerHTML = coupable(m.reflexion);
    delete corps.dataset.attente;
  }
}, true);

// ------------------------------------------------------------------ tool calls
// The server sends a tool call the model writes on its own ("tool_calls"), even when the page declares no tools: the
// name, then the arguments (JSON) in chunks. They are shown collapsed (a whole file can weigh 40 KB) and are sent
// back with the history.
function aDesOutils(m) { return Array.isArray(m.outils) && m.outils.length > 0; }
function lireArgs(texte) {
  // a call's arguments: a JSON object, read even when cut off or still being written (we try to close it)
  const brut = String(texte || "");
  if (!brut.trim()) return {objet: {}, complet: true};
  try { return {objet: JSON.parse(brut), complet: true}; } catch (e) { /* cut off, or not finished yet */ }
  let b = brut.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(b)) b = b.slice(0, -1);   // a lone escape backslash at the end
  const essais = [b, b.replace(/,\s*"(?:[^"\\]|\\.)*"?\s*:?\s*$/, "")];   // without a half-written key at the end
  for (const debut of essais) {
    for (const fin of ['"}', "}", '"]}', "]}", '"}]}', "}]}"]) {
      try { return {objet: JSON.parse(debut + fin), complet: false}; } catch (e) { /* try the next closing */ }
    }
  }
  return {objet: null, complet: false};
}
function argsValides(texte) {
  if (!String(texte || "").trim()) return true;
  try { const v = JSON.parse(texte); return v !== null && typeof v === "object" && !Array.isArray(v); } catch (e) { return false; }
}
function blocCode(texte, langue) {   // a markdown code block whose fence cannot occur in the text
  const n = Math.max(3, ...(String(texte).match(/`{3,}/g) || []).map((x) => x.length + 1));
  const f = "`".repeat(n);
  return `${f}${langue || ""}\n${texte}\n${f}\n`;
}
function langueOutil(objet) {        // the target file's language, from its name (index.html: html)
  for (const k of ["path", "file_path", "filepath", "filename", "file", "fichier", "chemin", "target"]) {
    const v = objet && objet[k];
    const x = typeof v === "string" ? /\.([a-z0-9]{1,8})$/i.exec(v.trim()) : null;
    if (x) return x[1].toLowerCase();
  }
  return "";
}
function estLong(v) { return typeof v === "string" && (v.includes("\n") || v.length > 100); }
function resumeOutil(o, enTrain) {
  // the header: "Tool call: name", then the first short argument (a file name) and the size of the longest one
  const {objet} = lireArgs(o.args);
  const infos = [];
  if (objet && typeof objet === "object" && !Array.isArray(objet)) {
    const valeurs = Object.values(objet);
    const court = valeurs.find((v) => typeof v === "string" && v.trim() && !estLong(v));
    if (court) infos.push(court.length > 48 ? court.slice(0, 47) + "…" : court);
    const longs = valeurs.filter(estLong);
    if (longs.length) {
      const plus = longs.reduce((a, b) => (b.length > a.length ? b : a));
      const lignes = plus.split("\n").length;
      infos.push(lignes > 1 ? `${nf(lignes)} lines` : `${nf(plus.length)} characters`);
    }
  } else if (o.args) {
    infos.push(`${nf(String(o.args).length)} characters`);
  }
  return `<span class="outil__nom"><span class="insecable">${enTrain ? "Tool call in progress:" : "Tool call:"}</span> ` +
    `<code>${esc(o.nom || "unnamed")}</code></span>` + (infos.length ? `<span class="outil__infos">${morceaux(infos)}</span>` : "");
}
function corpsOutil(o, vivant) {
  const {objet, complet} = lireArgs(o.args);
  let h = "";
  if (!objet || typeof objet !== "object" || Array.isArray(objet)) {
    h = enHtml(blocCode(String(o.args || ""), "json"));     // not a readable object: the text as is
  } else {
    const langue = langueOutil(objet);
    for (const [cle, v] of Object.entries(objet)) {
      if (estLong(v)) h += `<div class="outil__cle">${esc(cle)}</div>` + enHtml(blocCode(v, langue));
      else if (v === null || typeof v !== "object") h += `<div class="outil__ligne"><span class="outil__cle">${esc(cle)}</span><code>${esc(String(v))}</code></div>`;
      else h += `<div class="outil__cle">${esc(cle)}</div>` + enHtml(blocCode(JSON.stringify(v, null, 2), "json"));
    }
    if (!h) h = `<p class="doux">No arguments.</p>`;
  }
  if (!complet && !vivant) h += `<p class="doux">The call was cut off before it ended.</p>`;
  return h;
}
function outilEnMarkdown(o) {        // for the Markdown export: readable arguments, long ones as code blocks
  const {objet} = lireArgs(o.args);
  const md = [`_Tool call: ${o.nom || "unnamed"} (not run)_`, ""];
  if (!objet || typeof objet !== "object" || Array.isArray(objet)) return md.concat([blocCode(String(o.args || ""), "json")]);
  const langue = langueOutil(objet);
  for (const [cle, v] of Object.entries(objet)) {
    if (estLong(v)) md.push(`${cle}:`, "", blocCode(v, langue));
    else if (v === null || typeof v !== "object") md.push(`- ${cle}: ${String(v)}`, "");
    else md.push(`${cle}:`, "", blocCode(JSON.stringify(v, null, 2), "json"));
  }
  return md;
}
function peindreCorpsOutil(det, o, vivant) {
  const corps = det.querySelector(".outil__corps");
  const cle = `${String(o.args || "").length}|${vivant ? 1 : 0}`;
  if (corps._cle === cle) return;
  corps._cle = cle;
  corps.innerHTML = corpsOutil(o, vivant);
}
function majOutils(el, m, vivant) {
  const box = el.querySelector(".outils");
  if (!box) return;
  const liste = aDesOutils(m) ? m.outils : [];
  box.hidden = !liste.length;
  while (box.children.length > liste.length) box.lastElementChild.remove();
  liste.forEach((o, k) => {
    let det = box.children[k];
    if (!det) {
      det = document.createElement("details");
      det.className = "outil";
      det.dataset.k = String(k);
      det.innerHTML = `<summary>${ic("outil", "ic ic--p")}<span class="outil__titre"></span>${ic("chevron", "ic ic--p chevron")}</summary>` +
        `<div class="outil__corps md"></div>`;
      box.appendChild(det);
    }
    const enTrain = vivant && k === liste.length - 1;
    det.dataset.vivant = enTrain ? "1" : "0";
    const t = det.querySelector(".outil__titre"), titre = resumeOutil(o, enTrain);
    if (t._titre !== titre) { t._titre = titre; t.innerHTML = titre; }
    if (det.open) peindreCorpsOutil(det, o, vivant);   // collapsed: its body is written when it opens
  });
}
$("fil").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS" || !d.classList.contains("outil") || !d.open) return;
  const c = convCourante(), m = c && c.messages[+d.closest(".msg").dataset.i];
  const o = m && aDesOutils(m) ? m.outils[+d.dataset.k] : null;
  if (o) peindreCorpsOutil(d, o, !!(enCours && enCours.m === m));
}, true);

// ------------------------------------------------------------------ response settings
const DEFAUTS = {reflexion: "medium", longueur: 8192, montrer: true, temperature: null, top_p: null, top_k: null, graine: "",
                 // the compaction: automatic at 80% as in our llama.cpp interface, llama.cpp's 10 kept steps, its prompt when empty
                 compactionAuto: true, suiteAuto: true, compactionSeuil: 80, compactionPlace: "reponse", compactionEtapes: 10, compactionConsigne: ""};
let reglages = {...DEFAUTS, ...memoire.lire("reglages", {})};
const NOMS_REFLEXION = {none: "No thinking", low: "Short thinking", medium: "Medium thinking", high: "Long thinking"};
const AIDE_REFLEXION = {none: "answers right away", low: "thinks a little", medium: "thinks, then answers", high: "thinks it through"};
function resumeReglages() {
  const l = reglages.longueur > 0 ? `${nf(reglages.longueur)} tokens max` : "no limit";
  $("reglage-resume").textContent = `${NOMS_REFLEXION[reglages.reflexion] || "Medium thinking"} · ${l}`;
}
// the lengths a response may ask for: from 1,024 up to the server's context (/health max_context: the steps below
// it, then "No limit", the rest of the context), not a list that stopped at 32,768 whatever the model; an unknown context
// keeps that list.  A chosen length goes with fit_max_tokens (the server cuts it to the room the conversation leaves).
const PALIERS = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
let paliersPour = -1;
function construirePaliers() {
  const ctx = +sante.max_context || 0;
  if (ctx === paliersPour) return;
  paliersPour = ctx;
  const option = (v, texte) => { const o = document.createElement("option"); o.value = String(v); o.textContent = texte; return o; };
  const valeurs = PALIERS.filter((v) => (ctx > 0 ? v < ctx : v <= 32768));
  $("r-longueur").replaceChildren(...valeurs.map((v) => option(v, `${nf(v)} tokens`)), option(0, "No limit"));
  ligneContexte();
}
// the drawer's context line; with the Engine settings card on About, a link to it
let lignePour = "";
function ligneContexte() {
  const ctx = +sante.max_context || 0;
  const lien = !!(reglagesMoteur && reglagesMoteur.supported);
  if (lignePour === `${ctx}:${lien}`) return;
  lignePour = `${ctx}:${lien}`;
  majDernierMessage();
  const c = $("r-contexte");
  c.hidden = !(ctx > 0);
  c.replaceChildren();
  if (!(ctx > 0)) return;
  c.append(`This model's context: ${nf(ctx)}\u00a0tokens, the conversation and the response together.`);
  if (!lien) return;
  const a = document.createElement("a");
  a.href = "#apropos";
  a.textContent = "Change it under About";
  a.onclick = (e) => {                              // the drawer closes on the Engine settings card
    e.preventDefault();
    ouvrirTiroir(false);
    montrerVue("apropos");
    $("carte-reglages-moteur").scrollIntoView({block: "start"});
  };
  c.append(" ", a, ".");
}
function chargerTiroir() {
  for (const b of $("r-reflexion").children) b.setAttribute("aria-checked", String(b.dataset.v === reglages.reflexion));
  $("o-reflexion").textContent = AIDE_REFLEXION[reglages.reflexion] || "";
  construirePaliers();
  const sel = $("r-longueur");
  if (![...sel.options].some((o) => +o.value === +reglages.longueur)) {   // a length kept from another model: in its place
    const o = document.createElement("option"); o.value = String(reglages.longueur); o.textContent = `${nf(reglages.longueur)} tokens`;
    sel.insertBefore(o, [...sel.options].find((x) => +x.value === 0 || +x.value > reglages.longueur) || null);
  }
  sel.value = String(reglages.longueur);
  $("r-montrer").setAttribute("aria-checked", String(!!reglages.montrer));
  const t = reglages.temperature ?? defautsModele.temperature, p = reglages.top_p ?? defautsModele.top_p, k = reglages.top_k ?? defautsModele.top_k;
  $("r-temperature").value = t; $("r-topp").value = p; $("r-topk").value = k;
  $("o-temperature").textContent = `${+t === 0 ? "0 · always the same" : nf(+t, 2)}${reglages.temperature == null ? " (default)" : ""}`;
  $("o-topp").textContent = `${nf(+p, 2)}${reglages.top_p == null ? " (default)" : ""}`;
  $("o-topk").textContent = `${nf(+k)}${reglages.top_k == null ? " (default)" : ""}`;
  $("r-topp").disabled = $("r-topk").disabled = +t === 0;
  $("r-graine").value = reglages.graine || "";
  $("r-compaction-auto").setAttribute("aria-checked", String(!!reglages.compactionAuto));
  $("r-compaction-seuil").value = reglages.compactionSeuil;
  $("r-compaction-seuil").disabled = !reglages.compactionAuto;
  $("r-suite-auto").setAttribute("aria-checked", String(!!reglages.suiteAuto));
  $("r-suite-auto").disabled = !reglages.compactionAuto;
  $("r-compaction-place").value = reglages.compactionPlace === "texte" ? "texte" : "reponse";
  $("r-compaction-place").disabled = !reglages.compactionAuto;
  $("r-compaction-etapes").value = reglages.compactionEtapes;
  if (document.activeElement !== $("r-compaction-consigne")) $("r-compaction-consigne").value = reglages.compactionConsigne || COMPACTION.CONSIGNE;
  dessinerJauge();
  $("r-defauts").textContent = `Model defaults: temperature ${nf(defautsModele.temperature, 2)}, top-p ${nf(defautsModele.top_p, 2)}, top-k ${nf(defautsModele.top_k)}.`;
  resumeReglages();
}
function garderReglages(note = "Saved in this browser.") {
  memoire.ecrire("reglages", reglages);
  chargerTiroir();
  majDernierMessage();                              // what its end notice offers follows the compaction settings
  $("r-note").textContent = note;
}
for (const b of $("r-reflexion").children) b.onclick = () => { reglages.reflexion = b.dataset.v; garderReglages(); };
$("r-longueur").onchange = () => { reglages.longueur = +$("r-longueur").value; garderReglages(); };
$("r-montrer").onclick = () => { reglages.montrer = !reglages.montrer; garderReglages(); };
$("r-temperature").oninput = () => { reglages.temperature = +$("r-temperature").value; garderReglages(); };
$("r-topp").oninput = () => { reglages.top_p = +$("r-topp").value; garderReglages(); };
$("r-topk").oninput = () => { reglages.top_k = +$("r-topk").value; garderReglages(); };
$("r-graine").onchange = () => { reglages.graine = $("r-graine").value.trim(); garderReglages(); };
$("r-retablir").onclick = () => { reglages = {...DEFAUTS}; garderReglages("Default settings restored."); };
const entierEntre = (el, min, max, defaut) => { const n = Math.round(+el.value); return el.value.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut; };
$("r-compaction-auto").onclick = () => { reglages.compactionAuto = !reglages.compactionAuto; garderReglages(); };
$("r-suite-auto").onclick = () => { reglages.suiteAuto = !reglages.suiteAuto; garderReglages(); };
$("r-compaction-seuil").onchange = () => { reglages.compactionSeuil = entierEntre($("r-compaction-seuil"), 1, 100, DEFAUTS.compactionSeuil); garderReglages(); };
$("r-compaction-place").onchange = () => { reglages.compactionPlace = $("r-compaction-place").value === "texte" ? "texte" : "reponse"; garderReglages(); };
$("r-compaction-etapes").onchange = () => { reglages.compactionEtapes = entierEntre($("r-compaction-etapes"), 0, 100, DEFAUTS.compactionEtapes); garderReglages(); };
$("r-compaction-consigne").onchange = () => {
  const t = $("r-compaction-consigne").value.trim();
  reglages.compactionConsigne = t === COMPACTION.CONSIGNE ? "" : t;   // the default one is not kept as a choice
  garderReglages();
};
$("btn-compacter").onclick = () => { ouvrirTiroir(false); compacter(convCourante()); };
$("btn-jauge").onclick = () => { ouvrirTiroir(true); $("bloc-jauge").scrollIntoView({block: "nearest"}); };
function ouvrirTiroir(ouvert) {
  $("tiroir").dataset.ouvert = String(ouvert);
  $("tiroir").setAttribute("aria-hidden", String(!ouvert));
  $("voile").hidden = !ouvert;
  if (ouvert) { chargerTiroir(); $("r-note").textContent = "Saved in this browser."; setTimeout(() => $("tiroir-fermer").focus(), 60); }
  else if (vue === "discussion" && !estTactile()) $("saisie").focus();
}
$("btn-reglages").onclick = () => ouvrirTiroir(true);
$("tiroir-fermer").onclick = () => ouvrirTiroir(false);
$("voile").onclick = () => ouvrirTiroir(false);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const vue = document.querySelector(".visionneuse");
  if (vue) { vue.remove(); return; }
  if ($("tiroir").dataset.ouvert === "true") { ouvrirTiroir(false); return; }
  if (etroit() && $("convs").dataset.ouvert === "true") ouvrirConvs(false);
});

// ------------------------------------------------------------------ attached files (text; images when the server reads them)
const EXT_TEXTE = /\.(txt|md|markdown|rst|tex|py|pyi|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|c|cc|cpp|cxx|h|hh|hpp|cu|cuh|rs|go|java|kt|kts|swift|rb|php|pl|lua|r|jl|scala|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|diff|patch|gradle|cmake|mk|dockerfile|gitignore|proto|graphql|ino|srt)$/i;
const MAX_FICHIER = 512 * 1024;
let pieces = [];                                // {nom, texte}; an image: {nom, image, l, h}
// an image is accepted only if the server reads images (/health "images"); scaled down to 1600 px on its longest
// side, as JPEG (transparency becomes white): fewer tokens to read, less room in this browser. It is sent as bytes
// ("data:"): the server never reads a file by its path.
const IMAGE_COTE = 1600;
const MAX_IMAGE = 32 * 1024 * 1024;             // the server's limit for one image
function lireImage(f) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, IMAGE_COTE / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const l = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const cv = document.createElement("canvas");
      cv.width = l; cv.height = h;
      const cx = cv.getContext("2d");
      cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, l, h);
      cx.drawImage(img, 0, 0, l, h);
      ok({nom: f.name || "screenshot.png", image: cv.toDataURL("image/jpeg", 0.9), l, h});
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("unreadable")); };
    img.src = url;
  });
}
const estTexte = (f) => f.type.startsWith("text/") || /json|xml|javascript|yaml|toml|x-sh|x-python/.test(f.type) || EXT_TEXTE.test(f.name) ||
  /(^|[\\/])(makefile|dockerfile|readme|license)$/i.test(f.name);
function ajouterFichiers(liste) {
  for (const f of liste) {
    if (f.type.startsWith("image/")) {
      if (!sante.images) { annonce("alerte", "No images", "This server reads text only (vision is off).", 6000); continue; }
      if (f.size > MAX_IMAGE) { annonce("alerte", "Image too large", `${f.name} is over 32 MB.`, 6000); continue; }
      lireImage(f).then((p) => { pieces.push(p); dessinerPieces(); })
        .catch(() => annonce("erreur", "Unreadable image", `${f.name}: this browser cannot read it.`, 6000));
      continue;
    }
    if (!estTexte(f)) { annonce("alerte", "Not a text file", `${f.name}: attach text (code, notes, logs, data).`, 6000); continue; }
    if (f.size > MAX_FICHIER) { annonce("alerte", "File too large", `${f.name} is over 512 KB.`, 6000); continue; }
    const r = new FileReader();
    r.onload = () => {
      const texte = String(r.result);
      if (texte.includes("\u0000")) { annonce("alerte", "Not a text file", `${f.name} looks like a binary file.`, 6000); return; }
      pieces.push({nom: f.name, texte});
      dessinerPieces();
    };
    r.onerror = () => annonce("erreur", "Could not read the file", f.name, 6000);
    r.readAsText(f);
  }
}
function dessinerPieces() {
  const box = $("pieces");
  box.hidden = !pieces.length;
  box.innerHTML = "";
  pieces.forEach((p, i) => {
    const c = document.createElement("span");
    c.className = "piece";
    if (p.image) {                                 // its thumbnail
      c.classList.add("piece--image");
      const v = document.createElement("img");
      v.className = "piece__vignette"; v.src = p.image; v.alt = "";
      c.appendChild(v);
    } else c.innerHTML = ic("fichier", "ic ic--p");
    const n = document.createElement("span"); n.className = "piece__nom"; n.textContent = p.nom; n.title = p.nom; c.appendChild(n);
    const x = document.createElement("button");
    x.type = "button"; x.className = "btn btn--icone"; x.title = "Remove"; x.setAttribute("aria-label", `Remove ${p.nom}`);
    x.innerHTML = ic("croix");
    x.onclick = () => { pieces.splice(i, 1); dessinerPieces(); };
    c.appendChild(x);
    box.appendChild(c);
  });
}
// an image at full size, over the page; a click or Escape closes it
function voirImage(i) {
  const v = document.createElement("div");
  v.className = "visionneuse";
  v.setAttribute("role", "dialog"); v.setAttribute("aria-modal", "true"); v.setAttribute("aria-label", i.nom);
  v.innerHTML = `<img alt=""><button type="button" class="btn btn--icone visionneuse__fermer" aria-label="Close" title="Close">${ic("croix")}</button>`;
  v.querySelector("img").src = i.image;
  v.querySelector("img").alt = i.nom;
  v.onclick = () => v.remove();
  document.body.appendChild(v);
  v.querySelector("button").focus();
}
// a pasted screenshot (Ctrl+V) is attached like a dropped file
$("saisie").addEventListener("paste", (e) => {
  const fs = [...((e.clipboardData || {}).files || [])].filter((f) => f.type.startsWith("image/"));
  if (!fs.length) return;
  e.preventDefault();
  ajouterFichiers(fs);
});
function blocFichier(f) {                       // the file's text, fenced with more backticks than it contains
  const plusLong = Math.max(2, ...(f.texte.match(/`+/g) || []).map((s) => s.length));
  const clotures = "`".repeat(plusLong + 1);
  return `File: ${f.nom}\n${clotures}\n${f.texte}\n${clotures}`;
}
$("btn-joindre").onclick = () => $("fichiers").click();
$("fichiers").onchange = () => { ajouterFichiers($("fichiers").files); $("fichiers").value = ""; };
for (const cible of [$("fil-defile"), $("saisie-form")]) {
  cible.addEventListener("dragover", (e) => {
    if (![...((e.dataTransfer || {}).types || [])].includes("Files")) return;
    e.preventDefault();
    $("saisie-form").classList.add("depot");
  });
  cible.addEventListener("dragleave", () => $("saisie-form").classList.remove("depot"));
  cible.addEventListener("drop", (e) => {
    $("saisie-form").classList.remove("depot");
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    ajouterFichiers(e.dataTransfer.files);
    $("saisie").focus();
  });
}

// ------------------------------------------------------------------ send, follow the response, stop it
let enCours = null;          // {controleur, c, m, el, idClient, debut, premier, debutRefl, finRefl, morceaux, phase}
function occupe(oui) {
  $("btn-arreter").hidden = !oui;
  $("btn-envoyer").disabled = oui;
  $("saisie-aide").hidden = oui;
}
function ajusterSaisie() {
  const t = $("saisie");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, Math.round(innerHeight * 0.4))}px`;
}
$("saisie").addEventListener("input", ajusterSaisie);
$("saisie").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); envoyer(); }
});
$("saisie-form").onsubmit = (e) => { e.preventDefault(); envoyer(); };
$("btn-arreter").onclick = () => { if (compactage) compactage.controleur.abort(); else if (enCours) enCours.controleur.abort(); };

function messagesApi(c, sauf) { return messagesDe(vueModele(c.messages.filter((m) => m !== sauf))); }
function messagesDe(liste, sansReflexion = false) {
  const out = [];
  for (const m of liste) {
    if (estNoeud(m)) { out.push({role: "user", content: COMPACTION.GABARIT + m.texte}); continue; }   // the summary, framed
    if (m.role === "user") {
      const texteMsg = [m.texte, ...(m.fichiers || []).map(blocFichier)].filter((s) => s).join("\n\n");
      // its images as bytes, after its text; an image this browser no longer keeps (storage full) is mentioned
      // to the model instead of vanishing
      const imgs = m.images || [];
      out.push({role: "user", content: !imgs.length ? texteMsg : [...(texteMsg ? [{type: "text", text: texteMsg}] : []),
        ...imgs.map((i) => (i.image ? {type: "image_url", image_url: {url: i.image}}
                                    : {type: "text", text: `[image "${i.nom}": no longer kept by this browser]`}))]});
    } else {
      // a turn without text (only thinking, a stop, an error) stays a Lapilli turn: the history alternates.
      // The thinking goes back with its answer: Flash-Next's chat template keeps it by default, and the server then
      // recognizes its own memory (a follow-up reuses about 95% of its message and starts in 0.2 s, instead of
      // reading the whole previous answer again)
      const msg = {role: "assistant", content: m.texte || ""};
      if (m.reflexion && !sansReflexion) msg.reasoning_content = m.reflexion;
      // its tool calls go back too (the server recognizes its own memory); a cut-off call (incomplete JSON) would be
      // refused by the server: it stays on screen only
      const appels = aDesOutils(m) ? m.outils.filter((o) => o.nom && argsValides(o.args)) : [];
      if (appels.length) msg.tool_calls = appels.map((o, k) => ({id: o.id || `call-${k + 1}`, type: "function",
                                                                 function: {name: o.nom, arguments: o.args || "{}"}}));
      out.push(msg);
    }
  }
  return out;
}
async function envoyer() {
  const texte = $("saisie").value.trim();
  if ((!texte && !pieces.length) || enCours || compactage) return;
  let c = convCourante();
  if (!c) {
    c = {id: nouvelId(), titre: titreDe(texte, pieces), cree: Date.now(), modifie: Date.now(), messages: []};
    convs.unshift(c);
    courante = c.id;
  }
  const message = {role: "user", texte, fichiers: pieces.filter((p) => !p.image).map((p) => ({nom: p.nom, texte: p.texte})),
                   images: pieces.filter((p) => p.image).map((p) => ({nom: p.nom, image: p.image, l: p.l, h: p.h})),
                   temps: Date.now()};
  // (our llama.cpp interface) near the end of the context, compact first: the message waits, then goes on the reduced context
  const car = texte.length + pieces.reduce((n, p) => n + (p.image ? 0 : String(p.texte || "").length), 0);
  const plan = reglages.compactionAuto ? planCompaction(c, "auto", Math.ceil(car / COMPACTION.CAR_PAR_JETON)) : null;
  const piecesAvant = pieces;
  pieces = []; dessinerPieces();
  $("saisie").value = ""; ajusterSaisie();
  if (plan) {
    const fait = await compacter(c, message, plan);
    if (fait === "arrete") {                       // stopped by hand: the message goes back to the input, unsent
      const k = c.messages.indexOf(message);
      if (k >= 0) c.messages.splice(k, 1);
      $("saisie").value = texte; pieces = piecesAvant; dessinerPieces(); ajusterSaisie();
      garderConvs(); dessinerFil();
      return;
    }
    if (fait === "rien") c.messages.push(message);   // no compaction ran: sent as usual
  } else c.messages.push(message);                   // (a failed compaction leaves the message in place: it is sent all the same)
  demander(c);
}
async function regenerer() {
  const c = convCourante();
  if (!c || enCours || compactage) return;
  const idx = dernierVrai(c), dernier = c.messages[idx];
  if (!dernier || dernier.role !== "assistant") return;
  const retires = c.messages.splice(idx);           // the response, and the node of its continuation if any
  // asked again as a message is sent: near the end of the context, compact first what came before its message
  // (a response the context cut says what room it needs at least)
  const question = c.messages[c.messages.length - 1];
  if (reglages.compactionAuto && question && question.role === "user") {
    const car = String(question.texte || "").length + (question.fichiers || []).reduce((n, f) => n + String(f.texte || "").length, 0);
    const plan = planCompaction(c, "auto", Math.ceil(car / COMPACTION.CAR_PAR_JETON), c.messages.slice(0, -1), dernier.fin === "length" ? placeDe(dernier) || 0 : 0);
    if (plan) {
      c.messages.pop();
      const fait = await compacter(c, question, plan);
      if (!c.messages.includes(question)) c.messages.push(question);
      if (fait === "arrete") {                       // stopped by hand: the response is back as it was
        c.messages.push(...retires);
        c.modifie = Date.now();
        garderConvs(); dessinerFil();
        return;
      }
    }
  }
  demander(c);
}

let peintureDemandee = 0, dernierePeinture = 0;
function peindreBientot() {
  if (peintureDemandee) return;
  const taille = enCours ? enCours.m.texte.length : 0;
  const pause = taille > 80000 ? 300 : taille > 20000 ? 150 : 40;    // a long text is re-rendered less often
  const attente = Math.max(0, pause - (performance.now() - dernierePeinture));
  peintureDemandee = setTimeout(() => requestAnimationFrame(() => {
    peintureDemandee = 0; dernierePeinture = performance.now();
    if (enCours) { majLapilli(enCours.el, enCours.m, true); activite(); descendre(); }
  }), attente);
}

function activite() {
  if (!enCours) return;
  const {el, m} = enCours;
  const box = el.querySelector(".activite");
  const live = (mesures && mesures.live) || {};
  const maintenant = performance.now();
  const dur = (maintenant - enCours.debut) / 1000;
  const serveur = live.state === "generating" && live.generated ? live.generated : null;
  const jetons = Math.max(serveur || 0, enCours.morceaux);
  const vitesse = live.state === "generating" && live.tok_s ? live.tok_s
    : enCours.premier && maintenant - enCours.premier > 800 ? enCours.morceaux / ((maintenant - enCours.premier) / 1000) : null;
  let phase = enCours.phase, txt = [], barreLue = null, bouton = "";
  if (echecs >= 3 && phase !== "ecriture" && phase !== "reflexion" && phase !== "outil") {
    txt = ["Server unreachable", `${nf(dur, 0)} s`];
  } else if (phase === "envoi" || phase === "lecture") {
    if (live.state === "loading") {
      phase = "lecture";
      txt = ["Loading the model", (live.load || {}).percent != null ? `${nf(live.load.percent)}%` : null];
      barreLue = ((live.load || {}).percent || 0) / 100;
    } else if (live.queued > 0 && live.state !== "reading") {
      txt = ["Waiting in line", `${nf(live.queued)} ahead`];
    } else {
      phase = "lecture";
      const lu = live.state === "reading" ? partLue(live) : null;
      txt = [enCours.suite ? "Reading the conversation" : "Reading your message", live.state === "reading" && live.prompt_tokens ? `${nf(live.prompt_tokens)} tokens` : null,
             lu != null ? `${nf(lu * 100)}%` : null, dur >= 1 ? `${nf(dur, 0)} s` : null];
      barreLue = live.state === "reading" ? lu || 0 : null;
    }
  } else if (phase === "reflexion") {
    const s = enCours.debutRefl ? (maintenant - enCours.debutRefl) / 1000 : 0;
    txt = [enCours.maintenantDemande ? "End of thinking requested" : "Thinking", `${nf(s, 0)} s`, `${nf(jetons)} tokens`, vitesse ? `${nf(vitesse, 1)} tokens/s` : null];
    if (!enCours.maintenantDemande) bouton = `<button type="button" class="btn btn--doux" data-repondre-maintenant title="Stop thinking and answer right away">${ic("maintenant", "ic ic--p")}Answer now</button>`;
  } else if (phase === "outil") {
    const o = aDesOutils(m) ? m.outils[m.outils.length - 1] : null;
    txt = ["Tool call", o && o.nom ? o.nom : null, `${nf(jetons)} tokens`, vitesse ? `${nf(vitesse, 1)} tokens/s` : null];
  } else {
    txt = ["Writing", `${nf(jetons)} tokens`, vitesse ? `${nf(vitesse, 1)} tokens/s` : null];
  }
  box.dataset.phase = phase;
  const cle = JSON.stringify([phase, txt, barreLue == null ? null : Math.round(barreLue * 100), bouton ? 1 : 0]);
  if (box._cle === cle) return;
  box._cle = cle;
  box.innerHTML = `<span class="activite__texte"><span class="activite__point"></span>${morceaux(txt)}</span>` +
    (barreLue != null ? `<span class="activite__barre"><i style="width:${(barreLue * 100).toFixed(1)}%"></i></span>` : "") + bouton;
}

async function repondreMaintenant() {
  if (!enCours || enCours.maintenantDemande) return;
  const en = enCours;
  en.maintenantDemande = true;
  activite();
  try {
    const r = await fetch("v1/answer_now", {method: "POST", headers: entetes(true), body: JSON.stringify({request_id: en.idClient})});
    if (!r.ok) throw await refus(r);
    annonce("info", "Answer requested", "Lapilli is wrapping up its thinking to answer.", 3000);
  } catch (e) {
    if (e.code !== "not_thinking") en.maintenantDemande = false;
    annonce(e.code === "not_thinking" ? "info" : "erreur", "Answer now", String(e.message || e), 6000);
    activite();
  }
}

async function demander(c, rattrapage = false, suite = null) {
  // `suite`: a response that goes on, in its bubble (the server continues the final assistant message)
  const m = suite || {role: "assistant", texte: "", reflexion: "", temps: Date.now()};
  const avant = suite ? {ecrits: m.ecrits || 0, pense: m.pense || 0, refl: m.reflexionS || 0, duree: m.dureeS || 0} : null;
  const sauve = suite ? {...suite} : null;          // the response as it was: a continuation that writes nothing leaves it so
  if (suite) {
    m.suites = (m.suites || 0) + 1;
    for (const k of ["erreur", "arretee", "fin", "pleinMoteur", "compteEstime"]) delete m[k];
    m.reflexionS = null;
  } else c.messages.push(m);
  c.modifie = Date.now();
  garderConvs(); dessinerConvs(); dessinerFil();
  const el = elements.get(m);
  const controleur = new AbortController();
  enCours = {controleur, c, m, el, suite: !!suite, idClient: `lapilli-${nouvelId()}`, debut: performance.now(), premier: null, debutRefl: null, finRefl: null,
             morceaux: 0, pensees: 0, phase: "envoi", maintenantDemande: false, jauge: null, plancher: 0};
  enCours.plancher = contexteUtilise(c) || 0;       // what the conversation held before this request: the gauge starts from it
  suivre = true;
  occupe(true);
  majLapilli(el, m, true);
  activite();
  const minuterie = setInterval(activite, 250);
  const garde = setInterval(() => { c.modifie = Date.now(); garderConvs(); }, 5000);
  relever();

  const corps = {model: (mesures && mesures.engine && mesures.engine.model) || sante.model || "flash-next",
                 messages: suite ? messagesDe(vueModele(c.messages)) : messagesApi(c, m), stream: true, reasoning_effort: reglages.reflexion};
  if (suite) corps.continue_final_message = true;  // llama.cpp's request field: this response goes on
  if (reglages.longueur > 0) {   // a cap the server fits to the room the conversation leaves (fit_max_tokens), never a refusal
    corps.max_tokens = reglages.longueur;
    corps.fit_max_tokens = true;
  }
  if (reglages.temperature != null) corps.temperature = reglages.temperature;
  if (reglages.temperature !== 0) {
    if (reglages.top_p != null) corps.top_p = reglages.top_p;
    if (reglages.top_k != null) corps.top_k = reglages.top_k;
  }
  if (reglages.graine !== "" && Number.isFinite(+reglages.graine)) corps.seed = +reglages.graine;
  m.limite = corps.max_tokens ? (avant ? avant.ecrits : 0) + corps.max_tokens : null;

  let usage = null, timings = null, fin = null, refuse = null;
  try {
    const r = await fetch("v1/chat/completions", {method: "POST", headers: {...entetes(true), "x-client-request-id": enCours.idClient},
                                                    body: JSON.stringify(corps), signal: controleur.signal});
    if (!r.ok) throw await refus(r);
    enCours.phase = "lecture";
    activite();
    const lecteur = r.body.getReader(), dec = new TextDecoder();
    let tampon = "";
    const traiter = (ligne) => {
      if (!ligne.startsWith("data:")) return;                   // ": keep-alive" while a long message is being read
      const donnee = ligne.slice(5).trim();
      if (!donnee || donnee === "[DONE]") return;
      let j;
      try { j = JSON.parse(donnee); } catch (e) { return; }
      if (j.error) throw new Error(j.error.message || "The engine reported an error.");
      if (j.usage) usage = j.usage;
      if (j.timings) timings = j.timings;
      const ch = (j.choices && j.choices[0]) || {};
      if (ch.finish_reason) fin = ch.finish_reason;
      const d = ch.delta || {};
      const t = performance.now();
      if (d.reasoning_content) {
        if (!enCours.premier) enCours.premier = t;
        if (!enCours.debutRefl) enCours.debutRefl = t;
        m.reflexion += d.reasoning_content;
        enCours.morceaux++;
        enCours.pensees++;                          // one piece is one token, or nearly (measured: 5,726 for 5,728)
        enCours.phase = "reflexion";
      }
      if (d.content) {
        if (!enCours.premier) enCours.premier = t;
        if (enCours.debutRefl && !enCours.finRefl) { enCours.finRefl = t; m.reflexionS = (t - enCours.debutRefl) / 1000; }
        m.texte += d.content;
        enCours.morceaux++;
        enCours.phase = "ecriture";
      }
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {   // sent separately
        if (!enCours.premier) enCours.premier = t;
        if (enCours.debutRefl && !enCours.finRefl) { enCours.finRefl = t; m.reflexionS = (t - enCours.debutRefl) / 1000; }
        if (!Array.isArray(m.outils)) m.outils = [];
        for (const tc of d.tool_calls) {
          const k = Number.isInteger(tc.index) && tc.index >= 0 && tc.index < 64 ? tc.index : m.outils.length;
          while (m.outils.length <= k) m.outils.push({id: "", nom: "", args: ""});
          const o = m.outils[k], fn = tc.function || {};
          if (tc.id) o.id = String(tc.id);
          if (fn.name) o.nom += String(fn.name);
          if (fn.arguments != null) o.args += typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
        }
        enCours.morceaux++;
        enCours.phase = "outil";
      }
      if (d.reasoning_content || d.content || d.tool_calls) peindreBientot();
    };
    for (;;) {
      const {value, done} = await lecteur.read();
      if (done) break;
      tampon += dec.decode(value, {stream: true});
      let k;
      while ((k = tampon.indexOf("\n")) >= 0) {
        const ligne = tampon.slice(0, k).trim();
        tampon = tampon.slice(k + 1);
        traiter(ligne);
      }
    }
    tampon += dec.decode();
    if (tampon.trim()) traiter(tampon.trim());                  // a last line without a line ending
  } catch (e) {
    if (e.name === "AbortError") m.arretee = true;
    // the engine's own words for a context that is full: the 27B's next draft block no longer fits and it fails
    // the request instead of ending it (src/dense/session.cpp). For the page it is a response the context cut.
    else if (/no room for a draft block/i.test(String(e.message || ""))) { fin = "length"; m.pleinMoteur = true; }
    else {
      m.erreur = String(e.message || e);
      // refused for lack of room with messages before this one: it is the conversation that no longer fits. What the
      // server says it weighs (its own count) is kept: a compaction can still make room and send the message again.
      if (e.statut === 400 && /context/i.test(`${e.code} ${e.detail}`) && vueModele(c.messages).filter((x) => !estNoeud(x) && x !== m).length > 1) {
        m.erreur = COMPACTION.CONVERSATION;
        refuse = {lu: +((/prompt \((\d+) tokens\)/.exec(String(e.detail || "")) || [])[1]) || null};
      }
    }
  }
  clearInterval(minuterie);
  clearInterval(garde);
  clearTimeout(peintureDemandee); peintureDemandee = 0;
  const maintenant = performance.now();
  if (enCours.debutRefl && m.reflexionS == null) m.reflexionS = ((enCours.finRefl || maintenant) - enCours.debutRefl) / 1000;
  if (avant) m.reflexionS = avant.refl + (m.reflexionS || 0) || null;
  m.fin = fin;
  const duree = (maintenant - enCours.debut) / 1000 + (avant ? avant.duree : 0);
  m.dureeS = duree;
  const nDernier = usage ? usage.completion_tokens : null;
  const n = nDernier == null ? null : nDernier + (avant ? avant.ecrits : 0);
  m.ecrits = n;   // the end notice tells a length reached from a context filled
  m.ecritsDernier = nDernier;                       // with lus: what the context holds after this request
  m.mesureA = Date.now();                           // newer than a compaction node placed before it continued
  m.lus = usage && usage.prompt_tokens != null ? usage.prompt_tokens : null;   // with ecrits: the context this conversation holds
  // without the server's final count (stopped by hand, an engine error) the response still sits in the
  // conversation: what the server said while it was written (the message read, the tokens written at its last reading)
  // and the pieces received stand for it, marked as an estimate. Without them the gauge showed the context from before.
  if (!usage && enCours.lusVivant != null) {
    m.lus = enCours.lusVivant;
    m.ecritsDernier = Math.max(enCours.ecritsVivant || 0, enCours.morceaux);
    m.ecrits = m.ecritsDernier + (avant ? avant.ecrits : 0);
    m.compteEstime = true;
  }
  // its thinking in tokens, known at once from the pieces received (a message sent right away already counts on
  // it); the server's own count of the text replaces it a moment later (compterPensees)
  if (m.reflexion) { m.pense = enCours.pensees + (avant ? avant.pense : 0); m.penseDernier = enCours.pensees; m.penseDesMorceaux = true; }
  const meta = [];
  if (m.arretee) meta.push("Stopped");
  if (m.erreur) meta.push("Error");
  if (n != null) meta.push(`${nf(n)} tokens`);
  else if (enCours.morceaux) meta.push(`about ${nf(enCours.morceaux + (avant ? avant.ecrits : 0))} tokens`);
  if (m.suites) meta.push(m.suites === 1 ? "continued" : `continued ${m.suites} times`);
  const vit = timings && timings.predicted_per_second ? timings.predicted_per_second
    : n && enCours.premier && maintenant - enCours.premier > 250 ? n / ((maintenant - enCours.premier) / 1000) : null;
  if (vit) meta.push(`${nf(vit, 1)} tokens/s`);
  // the reading speed only means something for a long message (a short one is read in an instant, fixed costs included)
  if (timings && timings.prompt_n >= 1024 && timings.prompt_ms >= 100 && timings.prompt_per_second) meta.push(`reading ${nf(timings.prompt_per_second)} tokens/s`);
  if (m.reflexionS != null) meta.push(`thinking ${nf(m.reflexionS, 1)} s`);
  meta.push(`${nf(duree, 1)} s`);
  m.meta = meta;
  const titre = [];
  if (usage) titre.push(`Message read: ${nf(usage.prompt_tokens)} tokens${usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens ? ` (${nf(usage.prompt_tokens_details.cached_tokens)} reused from the cache)` : ""}`);
  if (timings && timings.draft_n) titre.push(`Drafts accepted: ${nf(timings.draft_n_accepted)} of ${nf(timings.draft_n)}`);
  m.metaTitre = titre.join("\n");
  const fini = enCours;
  enCours = null;
  occupe(false);
  c.modifie = Date.now();
  // a continuation that wrote nothing (refused, the link cut, stopped at once): the response stays as it was, its
  // measures and its line included; an error is told in a notice. Never its message asked again: its text would go.
  if (sauve && !usage && !fini.morceaux && String(m.texte || "") === String(sauve.texte || "")) {
    const erreur = m.erreur;
    for (const k of Object.keys(m)) if (!(k in sauve)) delete m[k];
    Object.assign(m, sauve);
    garderConvs(); dessinerConvs();
    for (const x of c.messages) { const e2 = elements.get(x); if (e2) majLapilli(e2, x, false); }
    dessinerJauge();
    compterPensees(c);                              // the server's count of its thinking, which the snapshot may predate
    if (erreur) annonce("erreur", "The response could not go on", erreur, 9000);
    relever();
    montrerAvisPage();
    return;
  }
  // refused for lack of room: once, compact what the server's own count says must go, and send the message again
  if (refuse && !rattrapage && !suite && reglages.compactionAuto && await rattraper(c, m, refuse.lu)) return;
  if (m.erreur) annonce("erreur", "The response failed", m.erreur, 9000);
  garderConvs(); dessinerConvs();
  majLapilli(fini.el, m, false);
  // the "Regenerate" button lives on the last message only: redraw the meta lines of the others
  for (const x of c.messages) { const e2 = elements.get(x); if (e2 && x !== m) majLapilli(e2, x, false); }
  descendre();
  dessinerJauge();
  compterPensees(c);                                // its thinking, as the server counts it: what a compaction would free
  relever();
  if (m.arretee) { setTimeout(relever, 250); setTimeout(relever, 800); }   // the server sees the closed connection at the next token
  // cut by the context with text written: compact its thinking (and the earlier one) and go on in its bubble,
  // a few times at most, when the automatic compaction is on
  if (reglages.compactionAuto && reglages.suiteAuto && coupeeParContexte(m) && (m.suites || 0) < COMPACTION.SUITES_MAX
      && (await compacterEtPoursuivre(c, m))) return;
  montrerAvisPage();                                // a newer page seen while it was written
}

// ------------------------------------------------------------------ save the conversation (Markdown)
function exporter() {
  const c = convCourante();
  if (!c || !c.messages.length) { annonce("info", "Nothing to save", "The conversation is empty.", 3000); return; }
  const md = [`# ${c.titre}`, "", `_${quand(c.cree)}, with Lapilli (${(mesures && mesures.engine && mesures.engine.model) || sante.model})_`, ""];
  for (const m of c.messages) {
    if (estNoeud(m)) {
      if (estAllege(m)) md.push("_The thinking of the responses above was left out of the context from here on._", "");
      else if (m.texte) md.push("## Conversation compacted", "", "_Summary of the earlier exchange, written by the model:_", "", m.texte, "");
      continue;
    }
    if (m.role === "user") {
      md.push("## You", "", m.texte || "");
      for (const f of m.fichiers || []) md.push("", `_Attached file: ${f.nom}_`);
      for (const i of m.images || []) md.push("", `_Attached image: ${i.nom}_`);
      md.push("");
    } else {
      md.push("## Lapilli", "");
      if (m.reflexion) md.push("<details><summary>Thinking</summary>", "", m.reflexion, "", "</details>", "");
      md.push(m.texte || m.erreur || "", "");
      for (const o of aDesOutils(m) ? m.outils : []) md.push(...outilEnMarkdown(o), "");
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md.join("\n")], {type: "text/markdown;charset=utf-8"}));
  const d = new Date(), z = (x) => String(x).padStart(2, "0");
  a.download = `lapilli-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  annonce("succes", "Conversation saved", a.download, 3000);
}

// ------------------------------------------------------------------ startup
(function demarrer() {
  ouvrirConvs(etroit() ? false : memoire.lire("panneau", true));
  chargerTiroir();
  occupe(false);
  dessinerConvs();
  dessinerFil();
  montrerVue(location.hash.slice(1) || "discussion");
  lireSante();
  lireProps();
  relever();
  lireReglagesMoteur();
  compterPensees(convCourante());
  verifierPage();                                   // the reference: the page this tab was given
  window.addEventListener("resize", () => { ajusterSaisie(); majVersBas(); });
  // marked arrives with "defer" just before this script; if it is missing, the text stays readable as is
  if (!window.marked) annonce("alerte", "Formatting unavailable", "Text is shown raw (marked could not be loaded).", 8000);
})();
$("btn-exporter").onclick = exporter;
