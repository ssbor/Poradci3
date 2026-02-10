// tools/build-daily.js
// Node 20+, ESM ("type": "module" v package.json)

import fs from "fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import zlib from "zlib";

// stream-json je CJS: importujeme ".js" entry a destrukturalizujeme z defaultu
import parserPkg from "stream-json/Parser.js";
import pickPkg from "stream-json/filters/Pick.js";
import streamArrayPkg from "stream-json/streamers/StreamArray.js";
const { parser } = parserPkg;
const { pick } = pickPkg;
const { streamArray } = streamArrayPkg;

const INPUT_URL =
  process.env.MPSV_URL ||
  "https://data.mpsv.cz/web/data/volna-mista-za-celou-cr";

let SOURCE_URL = INPUT_URL;

const OUTDIR = "./public/data";
const DEFAULT_MAX_LAST_OFFERS = 200;

const CISELNIKY_DIR = "./tools/.cache/ciselniky";
const CISELNIKY = {
  kraje: "https://data.mpsv.cz/od/soubory/ciselniky/kraje.json",
  okresy: "https://data.mpsv.cz/od/soubory/ciselniky/okresy.json",
  obce: "https://data.mpsv.cz/od/soubory/ciselniky/obce.json"
};

const CATEGORIES_PATH =
  process.env.MPSV_CATEGORIES || new URL("./mpsv-categories.json", import.meta.url);

function loadCategoriesConfig() {
  try {
    const raw = fs.readFileSync(CATEGORIES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const categories = parsed?.categories && typeof parsed.categories === "object" ? parsed.categories : null;
    const maxLastOffers = Number(parsed?.max_last_offers);

    if (!categories || !Object.keys(categories).length) {
      throw new Error("Missing or empty 'categories' in config");
    }

    return {
      categories,
      maxLastOffers: Number.isFinite(maxLastOffers) && maxLastOffers > 0 ? maxLastOffers : DEFAULT_MAX_LAST_OFFERS
    };
  } catch (e) {
    console.warn(
      "⚠️ Nepodařilo se načíst konfiguraci kategorií, použiju default (auto/agri/gastro):",
      String(e)
    );
    return {
      categories: {
        auto: { isco_prefixes: ["7231"], keywords: [] },
        agri: { isco_prefixes: ["61", "62"], keywords: [] },
        gastro: { isco_prefixes: ["512", "5131"], keywords: [] }
      },
      maxLastOffers: DEFAULT_MAX_LAST_OFFERS
    };
  }
}

// ---- Pomocné funkce ----
function ensureOutDir() {
  fs.mkdirSync(OUTDIR, { recursive: true });
}

function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
}

function safeJsonParse(raw) {
  // handle potential BOM
  const txt = String(raw || "").replace(/^\uFEFF/, "");
  return JSON.parse(txt);
}

function writePlaceholder(note = "placeholder – build failed") {
  const { categories } = loadCategoriesConfig();
  ensureOutDir();
  for (const tag of Object.keys(categories)) {
    const out = {
      summary: {
        count: 0,
        median_wage_low: null,
        tag,
        note,
        source: SOURCE_URL,
        built_at: new Date().toISOString()
      },
      top_employers: [],
      offers: [],
      last_offers: []
    };
    fs.writeFileSync(`${OUTDIR}/${tag}.json`, JSON.stringify(out));
  }
  console.log("⚠️ Zapsány placeholder JSONy (deploy proběhne).");
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function getId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.id ?? "";
  return "";
}

function classifyByRules({ czIscostring, profese, categories }) {
  const digits = String(czIscostring || "").replace(/\D/g, "");
  const profeseLower = String(profese || "").toLowerCase();

  // Prefer CZ-ISCO match. Use keywords only when CZ-ISCO is missing.
  if (digits) {
    for (const [tag, rule] of Object.entries(categories)) {
      const prefixes = Array.isArray(rule?.isco_prefixes) ? rule.isco_prefixes : [];
      if (prefixes.some(p => digits.startsWith(String(p).replace(/\D/g, "")))) return tag;
    }
    return null;
  }

  for (const [tag, rule] of Object.entries(categories)) {
    const keywords = Array.isArray(rule?.keywords) ? rule.keywords : [];
    if (keywords.some(k => profeseLower.includes(String(k).toLowerCase()))) return tag;
  }

  return null;
}

async function fetchJsonWithCache(url, cacheFilePath, { maxAgeMs = 1000 * 60 * 60 * 24 * 30 } = {}) {
  try {
    const st = fs.statSync(cacheFilePath);
    const age = Date.now() - st.mtimeMs;
    if (age >= 0 && age < maxAgeMs) {
      return safeJsonParse(fs.readFileSync(cacheFilePath, "utf-8"));
    }
  } catch {
    // ignore
  }

  const res = await fetchWithRetry(url, { tries: 4, timeoutMs: 180000 });
  const js = await res.json();
  ensureDir(CISELNIKY_DIR);
  fs.writeFileSync(cacheFilePath, JSON.stringify(js));
  return js;
}

async function resolveDatasetUrl(url) {
  const u = String(url || "").trim();
  if (!u) throw new Error("Missing MPSV_URL");

  // Direct file URLs (or gz) can be used as-is.
  if (/\.(json|jsonld|gz)(\?|#|$)/i.test(u)) return u;

  // Dataset landing pages (like /web/data/...) should be resolved to actual file links.
  // We pick the standard JSON export if present, otherwise JSON-LD.
  const res = await fetchWithRetry(u, { tries: 4, timeoutMs: 180000 });
  const html = await res.text();

  const candidates = [];
  const re = /https:\/\/data\.mpsv\.cz\/od\/soubory\/[^\s"']+?\.(json|jsonld)(?:\?[^\s"']*)?/gi;
  let m;
  while ((m = re.exec(html))) {
    candidates.push(m[0]);
  }

  // Prefer the known VPM exports if present.
  const preferredJson = candidates.find((x) => /\/od\/soubory\/volna-mista\/volna-mista\.json(\?|$)/i.test(x));
  if (preferredJson) return preferredJson;
  const preferredJsonLd = candidates.find((x) => /\/od\/soubory\/volna-mista\/volna-mista\.jsonld(\?|$)/i.test(x));
  if (preferredJsonLd) return preferredJsonLd;

  // Fallback: any JSON file found on the page.
  const anyJson = candidates.find((x) => /\.json(\?|$)/i.test(x));
  if (anyJson) return anyJson;
  const anyJsonLd = candidates.find((x) => /\.jsonld(\?|$)/i.test(x));
  if (anyJsonLd) return anyJsonLd;

  throw new Error("Could not resolve dataset page to a downloadable JSON URL: " + u);
}

async function loadCiselnikMaps() {
  const [kraje, okresy, obce] = await Promise.all([
    fetchJsonWithCache(CISELNIKY.kraje, `${CISELNIKY_DIR}/kraje.json`, { maxAgeMs: 1000 * 60 * 60 * 24 * 90 }),
    fetchJsonWithCache(CISELNIKY.okresy, `${CISELNIKY_DIR}/okresy.json`, { maxAgeMs: 1000 * 60 * 60 * 24 * 90 }),
    fetchJsonWithCache(CISELNIKY.obce, `${CISELNIKY_DIR}/obce.json`, { maxAgeMs: 1000 * 60 * 60 * 24 * 90 })
  ]);

  const krajeById = new Map();
  for (const k of kraje?.polozky || []) {
    const id = k?.id;
    if (!id) continue;
    krajeById.set(id, {
      name: k?.nazev?.cs ?? "",
      nuts3: k?.kodNuts3 ?? "",
      kod: k?.kod ?? ""
    });
  }

  const okresyById = new Map();
  for (const o of okresy?.polozky || []) {
    const id = o?.id;
    if (!id) continue;
    okresyById.set(id, {
      name: o?.nazev?.cs ?? "",
      krajId: getId(o?.kraj)
    });
  }

  const obceById = new Map();
  for (const o of obce?.polozky || []) {
    const id = o?.id;
    if (!id) continue;
    obceById.set(id, {
      name: o?.nazev?.cs ?? "",
      okresId: getId(o?.okres)
    });
  }

  return { krajeById, okresyById, obceById };
}

// ——— Normalizace jedné položky podle schématu 'volna-mista' (JSON/.gz) ———
function normalizeFromMpsvJson(rec, maps) {
  const profese = rec?.pozadovanaProfese?.cs ?? "";
  const isco = rec?.profeseCzIsco?.id ?? "";
  const zam = rec?.zamestnavatel?.nazev ?? "";
  const mzda_od = rec?.mesicniMzdaOd ?? null;
  const mzda_do = rec?.mesicniMzdaDo ?? null;

  // Lokalita – snažíme se získat čitelné názvy + stabilní ID (pro mapování)
  // Preferujeme mistoVykonuPrace.*; často ale bývá prázdné, tak bereme i adresu pracoviště
  // nebo adresu prvního kontaktu.
  const krajObj = rec?.mistoVykonuPrace?.kraje?.[0] ?? null;
  const okresObj = rec?.mistoVykonuPrace?.okresy?.[0] ?? null;
  const obecObj = rec?.mistoVykonuPrace?.obec ?? null;

  const workplaceAddr = rec?.mistoVykonuPrace?.pracoviste?.[0]?.adresa ?? null;
  const contactAddr = rec?.prvniKontaktSeZamestnavatelem?.kdeSeHlasit?.adresa ?? null;

  const krajFromWorkplace = getId(workplaceAddr?.kraj);
  const okresFromWorkplace = getId(workplaceAddr?.okres);
  const obecFromWorkplace = getId(workplaceAddr?.obec);

  const krajFromContact = getId(contactAddr?.kraj);
  const okresFromContact = getId(contactAddr?.okres);
  const obecFromContact = getId(contactAddr?.obec);

  let kraj_id = getId(krajObj) || krajFromWorkplace || krajFromContact;
  let okres_id = getId(okresObj) || okresFromWorkplace || okresFromContact;
  const obec_id = getId(obecObj) || obecFromWorkplace || obecFromContact;

  // try to derive missing IDs via ciselnik links
  const obecInfo = obec_id ? maps?.obceById?.get(obec_id) : null;
  if (!okres_id && obecInfo?.okresId) okres_id = obecInfo.okresId;

  const okresInfo = okres_id ? maps?.okresyById?.get(okres_id) : null;
  if (!kraj_id && okresInfo?.krajId) kraj_id = okresInfo.krajId;

  const krajInfo = kraj_id ? maps?.krajeById?.get(kraj_id) : null;

  const kraj_name = (krajObj?.nazev?.cs ?? krajObj?.cs ?? krajInfo?.name ?? "").trim();
  const kraj_nuts3 = String(krajInfo?.nuts3 ?? "").trim();
  const okres_name = (okresObj?.nazev?.cs ?? okresObj?.cs ?? okresInfo?.name ?? "").trim();
  const obec_name = (obecObj?.nazev?.cs ?? obecObj?.cs ?? obecInfo?.name ?? "").trim();

  const mistoKontaktuRaw = rec?.prvniKontaktSeZamestnavatelem?.kdeSeHlasit?.mistoKontaktu ?? "";
  const mistoKontaktu = String(mistoKontaktuRaw || "").trim();
  const adresaText = rec?.mistoVykonuPrace?.adresaText ?? "";

  const streetName =
    workplaceAddr?.ulice?.nazev ?? contactAddr?.ulice?.nazev ?? "";
  const streetNo =
    workplaceAddr?.cisloDomovni ?? contactAddr?.cisloDomovni ?? null;
  const psc = workplaceAddr?.psc ?? contactAddr?.psc ?? "";
  const adresaTextFallback = [
    [streetName, streetNo != null ? String(streetNo) : ""].filter(Boolean).join(" "),
    psc
  ]
    .filter(Boolean)
    .join(", ");

  // 'lokalita' je text, který jde typicky geokódovat (pro výpočet vzdálenosti)
  const mistoKontaktuLooksLikeAddress = (() => {
    if (!mistoKontaktu) return false;
    const lower = mistoKontaktu.toLowerCase();
    if (/vice\s+adres|více\s+adres/i.test(mistoKontaktu)) return false;
    const hasAddressHints =
      /\d/.test(mistoKontaktu) ||
      lower.includes("ul") ||
      lower.includes("nám") ||
      lower.includes("psc") ||
      lower.includes("č.p") ||
      lower.includes("cp");
    const looksLikeOnlyCompany =
      !hasAddressHints &&
      /(s\.r\.o\.|a\.s\.|spol\.|v\.o\.s\.|k\.s\.|o\.p\.s\.)/i.test(mistoKontaktu);
    return hasAddressHints && !looksLikeOnlyCompany;
  })();

  const lokalita =
    String(adresaText || "").trim() ||
    (mistoKontaktuLooksLikeAddress ? mistoKontaktu : "") ||
    String(adresaTextFallback || "").trim() ||
    [obec_name, okres_name, kraj_name].filter(Boolean).join(", ") ||
    String(kraj_name || okres_name || "").trim() ||
    "";

  // Do 'okres' dáme čitelné místo (kvůli UI), fallback na ID
  const okres =
    String(okres_name || "").trim() ||
    String(obec_name || "").trim() ||
    String(okres_id || obec_id || lokalita || "");

  const datum =
    rec?.datumZmeny ??
    rec?.datumVlozeni ??
    rec?.terminZahajeniPracovnihoPomeru ??
    rec?.expirace ??
    "";

  return {
    // IMPORTANT: UI + chatbot expect NUTS3 code here (e.g. CZ032)
    kraj: String(kraj_nuts3 || "").trim() || "",
    kraj_id: String(kraj_id || ""),
    kraj_nazev: String(kraj_name || ""),
    okres: String(okres || ""),
    okres_id: String(okres_id || ""),
    obec_id: String(obec_id || ""),
    obec: String(obec_name || ""),
    lokalita: String(lokalita || ""),
    profese: String(profese || ""),
    cz_isco: String(isco || ""),
    mzda_od: mzda_od != null ? Number(mzda_od) : null,
    mzda_do: mzda_do != null ? Number(mzda_do) : null,
    zamestnavatel: String(zam || ""),
    datum: String(datum || "")
  };
}

// JSON-LD fallback – pro případ .jsonld (schema.org JobPosting)
function normalizeFromJsonLd(rec) {
  const profese =
    rec?.pozadovanaProfese?.cs ??
    rec?.profeseNazev ??
    rec?.title ??
    rec?.name ??
    "";
  const isco = rec?.profeseCzIsco?.id ?? rec?.czIsco ?? rec?.occupationalCategory ?? "";
  let zam = rec?.zamestnavatel?.nazev ?? rec?.zamestnavatelNazev ?? rec?.hiringOrganization ?? "";
  if (zam && typeof zam === "object") zam = zam.name ?? "";
  const mzda_od =
    rec?.mesicniMzdaOd ??
    rec?.mzdaOd ??
    rec?.baseSalary?.value?.minValue ??
    rec?.baseSalary?.minValue ??
    null;
  const mzda_do =
    rec?.mesicniMzdaDo ??
    rec?.mzdaDo ??
    rec?.baseSalary?.value?.maxValue ??
    rec?.baseSalary?.maxValue ??
    null;

  const kraj =
    rec?.krajKod ?? rec?.krajKód ?? rec?.jobLocation?.address?.addressRegion ?? "";
  const okres =
    rec?.okresKod ?? rec?.okresKód ?? rec?.jobLocation?.address?.addressLocality ?? "";

  const lokalita =
    rec?.jobLocation?.address?.streetAddress ??
    rec?.jobLocation?.address?.addressLocality ??
    rec?.jobLocation?.address?.addressRegion ??
    "";

  const datum =
    rec?.datumZmeny ??
    rec?.datumVlozeni ??
    rec?.datumAktualizace ??
    rec?.datePosted ??
    rec?.validFrom ??
    "";

  return {
    kraj: String(kraj || ""),
    kraj_id: "",
    okres: String(okres || ""),
    okres_id: "",
    obec_id: "",
    lokalita: String(lokalita || okres || kraj || ""),
    profese: String(profese || ""),
    cz_isco: String(isco || "").replace(/\D/g, ""),
    mzda_od: mzda_od != null ? Number(mzda_od) : null,
    mzda_do: mzda_do != null ? Number(mzda_do) : null,
    zamestnavatel: String(zam || ""),
    datum: String(datum || "")
  };
}

// ---- Síť s retry + timeoutem ----
async function fetchWithRetry(url, { tries = 4, timeoutMs = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(30000, 2000 * 2 ** i); // 2s, 4s, 8s, 16s, max 30s
      console.warn(`Fetch failed (attempt ${i + 1}/${tries}): ${e}. Retrying in ${backoff} ms...`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function main() {
  const { categories, maxLastOffers } = loadCategoriesConfig();

  console.log("🗺️ Načítám číselníky (kraje/okresy/obce)…");
  const maps = await loadCiselnikMaps();

  SOURCE_URL = await resolveDatasetUrl(INPUT_URL);
  console.log("⬇️ Stahuji:", SOURCE_URL);
  const resp = await fetchWithRetry(SOURCE_URL, { tries: 4, timeoutMs: 180000 });
  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }

  const enc = (resp.headers.get("content-encoding") || "").toLowerCase();
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  const isJsonLd = SOURCE_URL.endsWith(".jsonld") || ctype.includes("ld+json");
  const looksGz = SOURCE_URL.endsWith(".gz") || ctype.includes("gzip");
  // Pokud server poslal už rozbalené (enc != ''), gunzip NEpoužijeme.
  const shouldGunzip = !enc && looksGz;

  const web = Readable.fromWeb(resp.body);
  const input = shouldGunzip ? web.pipe(zlib.createGunzip()) : web;

  const tags = Object.keys(categories);
  const buckets = Object.fromEntries(tags.map(t => [t, []]));
  const wages = Object.fromEntries(tags.map(t => [t, []]));
  const employers = Object.fromEntries(tags.map(t => [t, {}]));
  const sample = [];
  const rawSample = [];

  function ingest(norm) {
    const cat = classifyByRules({
      czIscostring: norm.cz_isco,
      profese: norm.profese,
      categories
    });
    if (!cat) return;
    buckets[cat].push(norm);
    if (norm.mzda_od != null) wages[cat].push(Number(norm.mzda_od));
    if (norm.zamestnavatel)
      employers[cat][norm.zamestnavatel] =
        (employers[cat][norm.zamestnavatel] || 0) + 1;
  }

  async function* sink(stream) {
    for await (const { value: rec } of stream) {
      if (rawSample.length < 1) rawSample.push(rec);
      const norm = isJsonLd ? normalizeFromJsonLd(rec) : normalizeFromMpsvJson(rec, maps);
      if (sample.length < 50) sample.push(norm); // diagnostika
      ingest(norm);
    }
  }

  // JSON (.json / .json.gz): root je objekt → pole je v "polozky"
  // JSON-LD (.jsonld): root objekt → pole je v "@graph"
  if (isJsonLd) {
    await pipeline(input, parser(), pick({ filter: "@graph" }), streamArray(), sink);
  } else {
    await pipeline(input, parser(), pick({ filter: "polozky" }), streamArray(), sink);
  }

  ensureOutDir();
  fs.writeFileSync(`${OUTDIR}/_sample.json`, JSON.stringify(sample, null, 2));
  fs.writeFileSync(`${OUTDIR}/_raw_sample.json`, JSON.stringify(rawSample, null, 2));

  // Manifest of available categories for the frontend (index / generic obor page)
  const categoriesManifest = {
    source: SOURCE_URL,
    built_at: new Date().toISOString(),
    categories: Object.entries(categories).map(([tag, rule]) => ({
      tag,
      label: String(rule?.label || tag),
      isco_prefixes: Array.isArray(rule?.isco_prefixes) ? rule.isco_prefixes : [],
      keywords: Array.isArray(rule?.keywords) ? rule.keywords : []
    }))
  };
  fs.writeFileSync(`${OUTDIR}/categories.json`, JSON.stringify(categoriesManifest));

  for (const tag of Object.keys(buckets)) {
    const rows = buckets[tag].slice(-maxLastOffers).reverse();
    const allOffers = buckets[tag];
    const topEmployers = Object.entries(employers[tag])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    const out = {
      summary: {
        count: allOffers.length,
        median_wage_low: median(wages[tag]),
        tag,
        source: SOURCE_URL,
        built_at: new Date().toISOString()
      },
      top_employers: topEmployers,
      offers: allOffers,
      last_offers: rows
    };
    fs.writeFileSync(`${OUTDIR}/${tag}.json`, JSON.stringify(out));
  }

  console.log(
    "✅ Build complete:",
    Object.fromEntries(Object.keys(buckets).map(t => [t, buckets[t].length]))
  );
}

try {
  await main();
} catch (e) {
  console.error("❌ Build failed:", e);
  // zapíšeme placeholdery a dovolíme deployi doběhnout,
  // aby se stránka nezlomila (ať je co načíst)
  writePlaceholder(String(e));
  process.exit(0);
}
