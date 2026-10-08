// Fonction serveur (Vercel) : reçoit les photos des notes manuscrites,
// les envoie à l'API d'Anthropic et renvoie la fiche préremplie.
// La clé API reste ici, côté serveur. Elle n'est jamais envoyée au navigateur.

const crypto = require("crypto");

const MODELE_DEFAUT = "claude-sonnet-5-5";
const URL_API = "https://api.anthropic.com/v1/messages";
const TYPES_IMAGE = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_PHOTOS = 8;
const MAX_CARACTERES_PAR_PHOTO = 7000000; // base64, environ 5 Mo
const DELAI_MS = 55000;

const NIVEAUX = ["", "A0", "A1", "A2", "B1", "B2", "C1", "C2"];
const NUANCES = ["", "fragile", "solide", "+"];
const FREQUENCES = ["", "1", "2", "3", "4+"];
const CHAMPS = [
  "prenom", "niveau", "points", "interets", "situations", "frequence", "exclus",
  "experience", "passe", "metier", "lieu", "medias", "note"
];
const CHAMPS_LISTE = ["points", "interets", "situations", "exclus", "medias"];
const CHAMPS_TEXTE = ["prenom", "experience", "passe", "metier", "lieu", "note"];

const texte = (description) => ({ type: "string", description });
const liste = (description) => ({ type: "array", items: { type: "string" }, description });

const SCHEMA = {
  type: "object",
  properties: {
    prenom: texte("Prénom de l'élève, s'il est écrit. Sinon chaîne vide."),
    niveau: { type: "string", enum: NIVEAUX, description: "Niveau CECRL, uniquement s'il est écrit dans les notes. Sinon chaîne vide." },
    nuance: { type: "string", enum: NUANCES, description: "Nuance écrite à côté du niveau (fragile, solide, +). Sinon chaîne vide." },
    points: liste("Points à travailler en priorité, 3 au maximum, dans l'ordre des notes."),
    interets: liste("Centres d'intérêt et loisirs de l'élève."),
    situations: liste("Situations concrètes où l'élève veut utiliser le français."),
    frequence: { type: "string", enum: FREQUENCES, description: "Nombre de cours par semaine, uniquement s'il est écrit. Sinon chaîne vide." },
    exclus: liste("Sujets à ne pas aborder avec l'élève."),
    experience: texte("Vécu de l'élève en français hors cours. Sinon chaîne vide."),
    passe: texte("Cours de français déjà suivis. Sinon chaîne vide."),
    metier: texte("Métier ou études. Sinon chaîne vide."),
    lieu: texte("Lieu de vie. Sinon chaîne vide."),
    medias: liste("Titres et noms propres : séries, films, podcasts, artistes, chaînes."),
    note: texte("Demande particulière de l'élève. Sinon chaîne vide."),
    incertains: {
      type: "array",
      description: "Mots reportés dans la fiche dont la lecture est douteuse.",
      items: {
        type: "object",
        properties: {
          champ: { type: "string", enum: CHAMPS },
          valeur: texte("Le mot ou l'élément douteux, écrit exactement comme dans la fiche.")
        },
        required: ["champ", "valeur"],
        additionalProperties: false
      }
    },
    restes: liste("Ce qui est lisible dans les notes mais n'entre dans aucune case, cité tel qu'écrit.")
  },
  required: [
    "prenom", "niveau", "nuance", "points", "interets", "situations", "frequence", "exclus",
    "experience", "passe", "metier", "lieu", "medias", "note", "incertains", "restes"
  ],
  additionalProperties: false
};

const CONSIGNES = `Tu lis les photos de notes manuscrites qu'une professeure de français langue étrangère a prises pendant une leçon d'essai. Les notes mêlent français et anglais, avec des abréviations, des flèches, des encadrés et des cœurs (un cœur signale ce que l'élève aime). Tu reportes ce qui est écrit dans une fiche à 13 cases. La professeure relira et validera chaque case : ta lecture doit être fidèle, pas complète à tout prix.

Règles :
1. Ne reporte que ce qui figure dans les notes. Aucune déduction, aucun ajout. Une case sans information reste vide (chaîne vide ou liste vide).
2. niveau : seulement si un niveau CECRL est écrit (A0, A1, A2, B1, B2, C1, C2). Ne l'estime jamais d'après le contenu. nuance : seulement si elle est écrite à côté du niveau.
3. frequence : seulement si un nombre de cours par semaine est écrit (par exemple « 1x semaine »). Un volume en heures va dans restes.
4. points : ce que la professeure note comme à travailler (grammaire, conjugaison, structure, compréhension orale, confiance, prononciation, articles…). Trois au maximum, dans l'ordre des notes, en un à quatre mots chacun.
5. interets : loisirs et goûts. medias : uniquement les titres et noms propres (séries, films, podcasts, artistes, chaînes, applications). Un même élément ne va que dans une seule des deux cases.
6. situations : moments concrets où l'élève veut se débrouiller en français (restaurant, réunions, téléphone, garderie, démarches…). Un objectif général (vivre à Paris, réussir un examen) n'est pas une situation : il va dans restes.
7. exclus : sujets que la professeure note comme à éviter (par exemple « pas politique »).
8. experience : ce que l'élève a vécu en français hors cours (séjours, vie dans un pays francophone, entourage). passe : les cours déjà suivis. metier : métier ou études. lieu : où vit l'élève.
9. note : une demande particulière (argot, expressions, un format de cours souhaité).
10. prenom : le prénom de l'élève s'il est écrit, en général en haut de la première page. Si un prénom isolé pourrait être celui d'un proche, reporte-le et signale-le dans incertains.
11. incertains : chaque mot reporté dont la lecture est douteuse, avec la case concernée et la valeur exactement telle que tu l'as écrite dans la fiche.
12. restes : tout ce qui est lisible mais n'entre dans aucune case (objectif général, devoirs, famille, erreurs relevées, phrases inachevées), cité court et tel qu'écrit.
13. Écris en français. Traduis les mots anglais courants (listening devient compréhension orale), mais garde tels quels les titres et les noms propres. Formulations courtes, majuscule initiale, pas de point final.`;

function memeTexte(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function propre(valeur, max) {
  if (typeof valeur !== "string") return "";
  return valeur.replace(/\s+/g, " ").trim().slice(0, max || 200);
}

function listePropre(valeur, max) {
  if (!Array.isArray(valeur)) return [];
  const vus = new Set();
  const sortie = [];
  for (const element of valeur) {
    const mot = propre(element, 80);
    const cle = mot.toLowerCase();
    if (!mot || vus.has(cle)) continue;
    vus.add(cle);
    sortie.push(mot);
    if (sortie.length >= max) break;
  }
  return sortie;
}

function choix(valeur, permis) {
  const brut = propre(valeur, 20);
  const trouve = permis.find((p) => p.toLowerCase() === brut.toLowerCase());
  return trouve || "";
}

// Ne fait jamais confiance à la forme de la réponse : tout est revérifié ici.
function nettoyer(brut) {
  const source = brut && typeof brut === "object" ? brut : {};
  const fiche = {};
  for (const champ of CHAMPS_TEXTE) fiche[champ] = propre(source[champ], champ === "prenom" ? 60 : 200);
  for (const champ of CHAMPS_LISTE) fiche[champ] = listePropre(source[champ], champ === "points" ? 3 : 12);
  fiche.niveau = choix(source.niveau, NIVEAUX);
  fiche.nuance = fiche.niveau ? choix(source.nuance, NUANCES) : "";
  fiche.frequence = choix(source.frequence, FREQUENCES);

  const incertains = [];
  if (Array.isArray(source.incertains)) {
    for (const item of source.incertains) {
      if (!item || typeof item !== "object") continue;
      const champ = choix(item.champ, CHAMPS);
      const valeur = propre(item.valeur, 80);
      if (champ && valeur) incertains.push({ champ, valeur });
      if (incertains.length >= 20) break;
    }
  }
  return { fiche, incertains, restes: listePropre(source.restes, 15) };
}

function extraireJson(texteReponse) {
  try {
    return JSON.parse(texteReponse);
  } catch (e) {
    const debut = texteReponse.indexOf("{");
    const fin = texteReponse.lastIndexOf("}");
    if (debut === -1 || fin <= debut) throw new Error("reponse_illisible");
    return JSON.parse(texteReponse.slice(debut, fin + 1));
  }
}

async function appelerAnthropic(cle, modele, images, structure) {
  const contenu = images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.media_type, data: image.data }
  }));
  contenu.push({
    type: "text",
    text: images.length + " page(s) de notes pour un même élève. Remplis la fiche." +
      (structure ? "" : "\n\nRéponds uniquement par un objet JSON conforme à ce schéma, sans aucun texte autour :\n" + JSON.stringify(SCHEMA))
  });
  const corps = {
    model: modele,
    max_tokens: 2000,
    system: CONSIGNES,
    messages: [{ role: "user", content: contenu }]
  };
  if (structure) corps.output_config = { format: { type: "json_schema", schema: SCHEMA } };

  const controle = new AbortController();
  const minuterie = setTimeout(() => controle.abort(), DELAI_MS);
  try {
    const reponse = await fetch(URL_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cle,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(corps),
      signal: controle.signal
    });
    let donnees = null;
    try { donnees = await reponse.json(); } catch (e) { donnees = null; }
    return { statut: reponse.status, donnees };
  } finally {
    clearTimeout(minuterie);
  }
}

function messageErreur(statut, donnees) {
  const type = donnees && donnees.error && donnees.error.type;
  if (statut === 401 || type === "authentication_error") return "La clé API Anthropic est refusée. Vérifie ANTHROPIC_API_KEY dans les réglages du serveur.";
  if (statut === 403 || type === "permission_error") return "Cette clé API n'a pas accès au modèle demandé.";
  if (statut === 404 || type === "not_found_error") return "Le modèle demandé est introuvable. Vérifie ANTHROPIC_MODEL.";
  if (statut === 413 || type === "request_too_large") return "Les photos sont trop lourdes pour une seule lecture. Envoie moins de pages à la fois.";
  if (statut === 429 || type === "rate_limit_error") return "La limite d'utilisation de l'API est atteinte. Réessaie dans une minute.";
  if (statut === 529 || type === "overloaded_error" || statut >= 500) return "L'API d'Anthropic est momentanément indisponible. Réessaie dans un instant.";
  if (statut === 400 && donnees && donnees.error && /credit|billing/i.test(String(donnees.error.message))) return "Le compte Anthropic n'a plus de crédit. Ajoute du crédit dans la console.";
  return "L'API d'Anthropic a refusé la demande (erreur " + statut + ").";
}

const DEMO = {
  prenom: "Catarina", niveau: "", nuance: "",
  points: ["Grammaire", "Conjugaison", "Prononciation"],
  interets: ["Plage", "Tennis", "Cuisine", "Voyages", "Films et séries"],
  situations: [], frequence: "", exclus: ["Politique"],
  experience: "Est déjà allée à Paris",
  passe: "A déjà suivi des cours de français",
  metier: "Marketing au département de l'Éducation, sur les vidéos",
  lieu: "Sydney en ce moment, sinon Londres",
  medias: ["Lupin", "Dix pour cent", "Gilmore Girls", "Charles Aznavour", "Aya Nakamura", "Booba"],
  note: "Argot et expressions françaises",
  incertains: [{ champ: "medias", valeur: "Booba" }],
  restes: ["goal : opportunité de habiter Paris", "Devoirs", "un frère et sœurs"]
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ erreur: "Méthode non autorisée." });
  }

  const codeAttendu = process.env.CODE_ACCES;
  if (codeAttendu) {
    let codeRecu = String(req.headers["x-code-acces"] || "");
    try { codeRecu = decodeURIComponent(codeRecu); } catch (e) { /* garde la valeur brute */ }
    if (!memeTexte(codeRecu, codeAttendu)) {
      return res.status(401).json({ erreur: "Code d'accès incorrect ou manquant." });
    }
  }

  let corps = req.body;
  if (typeof corps === "string") {
    try { corps = JSON.parse(corps); } catch (e) { corps = null; }
  }
  const images = corps && Array.isArray(corps.images) ? corps.images : null;
  if (!images || images.length === 0) {
    return res.status(400).json({ erreur: "Aucune photo reçue." });
  }
  if (images.length > MAX_PHOTOS) {
    return res.status(400).json({ erreur: "Trop de photos : " + MAX_PHOTOS + " pages au maximum par lecture." });
  }
  for (const image of images) {
    const valide = image && TYPES_IMAGE.includes(image.media_type) && typeof image.data === "string" &&
      image.data.length > 0 && image.data.length <= MAX_CARACTERES_PAR_PHOTO && /^[A-Za-z0-9+/=]+$/.test(image.data);
    if (!valide) return res.status(400).json({ erreur: "Une des photos n'est pas dans un format accepté." });
  }

  if (process.env.MODE_DEMO === "1") {
    return res.status(200).json(Object.assign(nettoyer(DEMO), { modele: "démonstration" }));
  }

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) {
    return res.status(500).json({ erreur: "La clé ANTHROPIC_API_KEY n'est pas configurée sur le serveur." });
  }
  const modele = process.env.ANTHROPIC_MODEL || MODELE_DEFAUT;

  try {
    let resultat = await appelerAnthropic(cle, modele, images, true);
    // Si le modèle choisi n'accepte pas la sortie structurée, second essai en JSON simple.
    const refusStructure = resultat.statut === 400 && resultat.donnees && resultat.donnees.error &&
      /output_config|json_schema|schema|format/i.test(String(resultat.donnees.error.message));
    if (refusStructure) resultat = await appelerAnthropic(cle, modele, images, false);

    if (resultat.statut !== 200 || !resultat.donnees) {
      console.error("Anthropic", resultat.statut, resultat.donnees && resultat.donnees.error);
      return res.status(502).json({ erreur: messageErreur(resultat.statut, resultat.donnees) });
    }
    const message = resultat.donnees;
    if (message.stop_reason === "refusal") {
      return res.status(502).json({ erreur: "Le modèle a refusé de lire ces photos." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(502).json({ erreur: "La lecture a été coupée avant la fin. Réessaie avec moins de pages." });
    }
    const texteReponse = (Array.isArray(message.content) ? message.content : [])
      .filter((bloc) => bloc && bloc.type === "text")
      .map((bloc) => bloc.text)
      .join("");
    let brut;
    try {
      brut = extraireJson(texteReponse);
    } catch (e) {
      return res.status(502).json({ erreur: "La réponse du modèle n'a pas pu être interprétée. Réessaie." });
    }
    return res.status(200).json(Object.assign(nettoyer(brut), { modele: message.model || modele }));
  } catch (e) {
    if (e && e.name === "AbortError") {
      return res.status(504).json({ erreur: "La lecture a pris trop de temps. Réessaie, ou envoie moins de pages." });
    }
    console.error("Erreur serveur", e);
    return res.status(500).json({ erreur: "Le serveur n'a pas pu joindre l'API d'Anthropic." });
  }
};
