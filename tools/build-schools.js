// tools/build-schools.js
// Downloads MPSV dataset "skoly" into public/data for local-only browsing.
// Node 20+, ESM ("type": "module" in package.json)

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const OUTDIR = path.join('.', 'public', 'data');
const OUT_FILE = path.join(OUTDIR, 'skoly.json');
const INDEX_FILE = path.join(OUTDIR, 'skoly_index.json');
const META_FILE = path.join(OUTDIR, 'skoly_meta.json');

const SOURCE_URL =
  process.env.SKOLY_URL ||
  'https://data.mpsv.cz/od/soubory/skoly/skoly.json';

function ensureOutDir() {
  fs.mkdirSync(OUTDIR, { recursive: true });
}

function safeJsonParse(raw) {
  const txt = String(raw || '').replace(/^\uFEFF/, '');
  return JSON.parse(txt);
}

function normalizeKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]+/g, '')
    .replace(/\s+/g, ' ');
}

async function fetchWithRetry(url, { tries = 4, timeoutMs = 180000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // Without explicit JSON accept, data.mpsv.cz may serve a cookie-consent HTML.
          accept: 'application/json'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (e) {
      lastErr = e;
      // small backoff
      await new Promise((r) => setTimeout(r, 500 + i * 750));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

async function downloadToFile(url, filePath) {
  const res = await fetchWithRetry(url);
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    return;
  }

  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, fs.createWriteStream(filePath));
}

function writeMeta(meta) {
  ensureOutDir();
  fs.writeFileSync(META_FILE, JSON.stringify(meta));
}

function loadCiselnikMaps() {
  // Optional: when build-daily.js ran before, it cached ciselniky here.
  const dir = path.join('.', 'tools', '.cache', 'ciselniky');

  const read = (name) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return null;
    return safeJsonParse(fs.readFileSync(p, 'utf8'));
  };

  const kraje = read('kraje.json');
  const okresy = read('okresy.json');
  const obce = read('obce.json');

  const krajeById = new Map();
  for (const k of kraje?.polozky || []) {
    if (!k?.id) continue;
    krajeById.set(String(k.id), {
      name: k?.nazev?.cs ?? '',
      nuts3: k?.kodNuts3 ?? '',
      kod: k?.kod ?? ''
    });
  }

  const okresyById = new Map();
  for (const o of okresy?.polozky || []) {
    if (!o?.id) continue;
    okresyById.set(String(o.id), {
      name: o?.nazev?.cs ?? '',
      krajId: o?.kraj?.id ?? ''
    });
  }

  const obceById = new Map();
  for (const o of obce?.polozky || []) {
    if (!o?.id) continue;
    obceById.set(String(o.id), {
      name: o?.nazev?.cs ?? '',
      okresId: o?.okres?.id ?? ''
    });
  }

  const ok = krajeById.size && okresyById.size && obceById.size;
  return ok ? { krajeById, okresyById, obceById } : null;
}

function buildIndex(rawSchools, maps) {
  const krajeById = maps?.krajeById;
  const okresyById = maps?.okresyById;
  const obceById = maps?.obceById;

  const schools = [];
  let programsCount = 0;

  for (const s of rawSchools || []) {
    const id = String(s?.id || '').trim();
    const name = String(s?.nazev || '').trim();
    if (!id || !name) continue;

    const addr = s?.adresaSidla || {};
    const krajId = String(addr?.kraj?.id || '').trim();
    const okresId = String(addr?.okres?.id || '').trim();
    const obecId = String(addr?.obec?.id || '').trim();

    const kraj = krajeById?.get(krajId) || { name: '', nuts3: '', kod: '' };
    const okres = okresyById?.get(okresId) || { name: '' };
    const obec = obceById?.get(obecId) || { name: '' };

    const programs = [];
    const parts = Array.isArray(s?.soucastiSkoly) ? s.soucastiSkoly : [];
    for (const part of parts) {
      const obory = Array.isArray(part?.vyucovaneObory) ? part.vyucovaneObory : [];
      for (const o of obory) {
        const oborName = String(o?.nazevOboru || '').trim();
        const oborCode = String(o?.kod || '').trim();
        if (!oborName && !oborCode) continue;
        const entry = {
          name: oborName,
          code: oborCode,
          delka: Number(o?.delkaStudia) || null,
          forma: String(o?.formaStudia?.id || '').trim(),
          druh: String(o?.druhStudia?.id || '').trim(),
          stupen: String(o?.stupenVzdelani?.id || '').trim(),
          ukonceni: String(o?.ukonceniStudia?.id || '').trim(),
          prijatoKeDni: String(o?.prijatoKeDni || '').trim() // optional
        };
        // lightweight search keys
        entry.nk = normalizeKey(entry.name);
        programs.push(entry);
      }
    }

    programsCount += programs.length;

    const school = {
      id,
      portalId: Number(s?.portalId) || null,
      name,
      nk: normalizeKey(name),
      ico: String(s?.ico || '').trim(),
      email: String(s?.email || '').trim(),
      url: String(s?.urlAdresa || '').trim(),
      typSkoly: String(s?.typSkoly?.id || '').trim(),
      typZrizovatele: String(s?.typZrizovatele?.id || '').trim(),
      adresa: {
        psc: String(addr?.psc || '').trim(),
        ulice: String(addr?.ulice || '').trim(),
        cisloDomovni: String(addr?.cisloDomovni || '').trim(),
        cisloOrientacni: String(addr?.cisloOrientacni || '').trim(),
        obecId,
        okresId,
        krajId,
        obec: obec.name || '',
        okres: okres.name || '',
        kraj: kraj.name || '',
        nuts3: kraj.nuts3 || ''
      },
      programs
    };
    school.ak = normalizeKey(
      [school.adresa.obec, school.adresa.okres, school.adresa.kraj, school.adresa.psc]
        .filter(Boolean)
        .join(' ')
    );

    schools.push(school);
  }

  return {
    built_at: new Date().toISOString(),
    source: SOURCE_URL,
    count_schools: schools.length,
    count_programs: programsCount,
    schools
  };
}

async function main() {
  ensureOutDir();
  console.log('[skoly] downloading…');

  try {
    await downloadToFile(SOURCE_URL, OUT_FILE);

    // Build a compact client-side search index
    console.log('[skoly] building index…');
    const raw = safeJsonParse(fs.readFileSync(OUT_FILE, 'utf8'));
    const rawSchools = Array.isArray(raw?.polozky) ? raw.polozky : [];
    const maps = loadCiselnikMaps();
    const index = buildIndex(rawSchools, maps);
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index));

    writeMeta({
      ok: true,
      built_at: new Date().toISOString(),
      source: SOURCE_URL
    });

    const st = fs.statSync(OUT_FILE);
    const stIdx = fs.statSync(INDEX_FILE);
    console.log(`[skoly] wrote ${OUT_FILE} (${st.size} bytes)`);
    console.log(`[skoly] wrote ${INDEX_FILE} (${stIdx.size} bytes)`);
  } catch (e) {
    console.error('[skoly] failed:', e);

    // Keep deployment healthy: write an empty placeholder.
    try {
      fs.writeFileSync(OUT_FILE, JSON.stringify({ polozky: [] }));
    } catch {
      // ignore
    }

    try {
      fs.writeFileSync(
        INDEX_FILE,
        JSON.stringify({ built_at: new Date().toISOString(), source: SOURCE_URL, count_schools: 0, count_programs: 0, schools: [] })
      );
    } catch {
      // ignore
    }

    writeMeta({
      ok: false,
      built_at: new Date().toISOString(),
      source: SOURCE_URL,
      error: String(e)
    });

    process.exitCode = 1;
  }
}

main();
