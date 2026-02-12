import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import StreamZip from 'node-stream-zip';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'obce_centroids.json');

const CACHE_DIR = path.join(ROOT, '.cache');
const ZIP_FILE = path.join(CACHE_DIR, 'ruian-stat-5514.zip');
const EXTRACT_DIR = path.join(CACHE_DIR, 'ruian-stat-5514');

const SOURCE_URL = 'https://services.cuzk.gov.cz/shp/stat/epsg-5514/1.zip';

const FORCE = process.env.FORCE_OBCE_BUILD === '1' || process.env.FORCE_OBCE_BUILD === 'true';

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function download(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(filePath, buf);
}

function pickField(props, candidates) {
  if (!props || typeof props !== 'object') return null;
  const keys = Object.keys(props);
  for (const c of candidates) {
    const hit = keys.find((k) => String(k).toLowerCase() === String(c).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]+/g, '')
    .replace(/\s+/g, ' ');
}

function detectDbfEncoding(extractDir, layerBaseName) {
  const base = String(layerBaseName || '').trim() || 'OBCE_P';
  const cpgPath = path.join(extractDir, `${base}.cpg`);
  if (!exists(cpgPath)) return 'utf-8';
  const raw = String(fs.readFileSync(cpgPath, 'utf8') || '').trim().toLowerCase();
  if (!raw) return 'utf-8';

  // Common values for ČÚZK/RÚIAN shapefiles are e.g. "1250".
  if (raw.includes('1250')) return 'cp1250';
  if (raw.includes('utf')) return 'utf-8';
  if (raw.includes('8859-2') || raw.includes('latin2')) return 'iso-8859-2';
  return raw;
}

function centroidOfRing(ring) {
  // ring: [[x,y], ...] (may be closed or not)
  if (!Array.isArray(ring) || ring.length < 3) return null;

  let area2 = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const x1 = Number(a?.[0]);
    const y1 = Number(a?.[1]);
    const x2 = Number(b?.[0]);
    const y2 = Number(b?.[1]);
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    const cross = x1 * y2 - x2 * y1;
    area2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  if (!Number.isFinite(area2) || Math.abs(area2) < 1e-12) return null;
  const area6 = area2 * 3;
  return { x: cx / area6, y: cy / area6, area2 };
}

function centroidOfPolygon(coords) {
  // coords: [ring1, ring2, ...] with holes
  if (!Array.isArray(coords) || coords.length === 0) return null;
  // For centroid, use the outer ring only (holes negligible for our use and avoids weirdness)
  const outer = coords[0];
  const c = centroidOfRing(outer);
  if (!c) return null;
  return { x: c.x, y: c.y };
}

function centroidOfGeometry(geom) {
  if (!geom || typeof geom !== 'object') return null;
  const t = geom.type;
  if (t === 'Polygon') {
    return centroidOfPolygon(geom.coordinates);
  }
  if (t === 'MultiPolygon') {
    // pick largest by absolute area2 of outer ring
    let best = null;
    let bestAbsArea2 = -Infinity;
    for (const poly of geom.coordinates || []) {
      if (!Array.isArray(poly) || poly.length === 0) continue;
      const outer = poly[0];
      const c = centroidOfRing(outer);
      if (!c) continue;
      const absA = Math.abs(c.area2);
      if (absA > bestAbsArea2) {
        bestAbsArea2 = absA;
        best = { x: c.x, y: c.y };
      }
    }
    return best;
  }
  return null;
}

async function extractNeeded(zipPath, outDir) {
  await ensureDir(outDir);
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const needed = [
      '1/OBCE_P.shp',
      '1/OBCE_P.shx',
      '1/OBCE_P.dbf',
      '1/OBCE_P.prj',
      '1/OBCE_P.cpg',
      '1/OKRESY_P.shp',
      '1/OKRESY_P.shx',
      '1/OKRESY_P.dbf',
      '1/OKRESY_P.prj',
      '1/OKRESY_P.cpg'
    ];

    for (const entry of needed) {
      const outPath = path.join(outDir, path.basename(entry));
      if (exists(outPath) && !FORCE) continue;
      await zip.extract(entry, outPath);
    }
  } finally {
    await zip.close();
  }
}

function defineEpsg5514() {
  // EPSG:5514 S-JTSK / Krovak East North
  // Common proj4 definition.
  const def =
    '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 ' +
    '+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 ' +
    '+units=m +no_defs';
  proj4.defs('EPSG:5514', def);
}

async function main() {
  await ensureDir(path.dirname(OUT_FILE));
  await ensureDir(CACHE_DIR);

  if (exists(OUT_FILE) && !FORCE) {
    console.log('[obce] obce_centroids.json exists; skipping (set FORCE_OBCE_BUILD=1 to rebuild)');
    return;
  }

  if (!exists(ZIP_FILE) || FORCE) {
    console.log('[obce] downloading RUIAN SHP…');
    await download(SOURCE_URL, ZIP_FILE);
  } else {
    console.log('[obce] using cached zip');
  }

  await ensureDir(EXTRACT_DIR);
  console.log('[obce] extracting OBCE_P layer…');
  await extractNeeded(ZIP_FILE, EXTRACT_DIR);

  defineEpsg5514();
  const toWgs84 = proj4('EPSG:5514', 'WGS84');

  const shpPath = path.join(EXTRACT_DIR, 'OBCE_P.shp');
  const dbfPath = path.join(EXTRACT_DIR, 'OBCE_P.dbf');

  const okresShpPath = path.join(EXTRACT_DIR, 'OKRESY_P.shp');
  const okresDbfPath = path.join(EXTRACT_DIR, 'OKRESY_P.dbf');

  const okresByCode = {};
  if (exists(okresShpPath) && exists(okresDbfPath)) {
    console.log('[obce] reading OKRESY_P for okres names…');
    const okresEncoding = detectDbfEncoding(EXTRACT_DIR, 'OKRESY_P');
    console.log(`[obce] OKRESY_P DBF encoding: ${okresEncoding}`);
    const osrc = await shapefile.open(okresShpPath, okresDbfPath, { encoding: okresEncoding });

    let codeField = null;
    let nameField = null;

    while (true) {
      const { done, value } = await osrc.read();
      if (done) break;
      const props = value?.properties || {};
      if (!codeField) {
        codeField = pickField(props, ['KOD', 'OKRES_KOD', 'KOD_OKRES', 'CODE']);
        nameField = pickField(props, ['NAZEV', 'NAZ_OKRES', 'NAZEV_OKRES', 'NAME']);
      }
      const code = codeField ? String(props?.[codeField] || '').trim() : '';
      const name = nameField ? String(props?.[nameField] || '').trim() : '';
      if (code && name) okresByCode[code] = name;
    }

    const n = Object.keys(okresByCode).length;
    console.log(`[obce] loaded ${n} okres names`);
  } else {
    console.log('[obce] OKRESY_P layer not found; okres names will be missing');
  }

  console.log('[obce] reading shapefile and computing centroids…');

  const dbfEncoding = detectDbfEncoding(EXTRACT_DIR, 'OBCE_P');
  console.log(`[obce] DBF encoding: ${dbfEncoding}`);
  const src = await shapefile.open(shpPath, dbfPath, { encoding: dbfEncoding });

  let nameField = null;
  let krajField = null;
  let okresField = null;

  const items = [];
  let readCount = 0;

  while (true) {
    const { done, value } = await src.read();
    if (done) break;
    readCount++;

    const props = value?.properties || {};
    if (!nameField) {
      nameField = pickField(props, ['NAZEV', 'NAZEV_OBCE', 'NAZ_OBEC']);
      // Prefer NUTS3 codes (CZ0xx) for compatibility with UI filters.
      krajField = pickField(props, ['NUTS3_KOD', 'NUTS3', 'NUTS3_CODE']);
      okresField = pickField(props, ['OKRES_KOD', 'KOD_OKRES', 'KOD_OKRESU']);
      if (!nameField) {
        throw new Error('[obce] cannot detect municipality name field in OBCE_P.dbf');
      }
    }

    const name = String(props?.[nameField] || '').trim();
    if (!name) continue;

    const centroid = centroidOfGeometry(value?.geometry);
    if (!centroid) continue;

    const [lon, lat] = toWgs84.forward([centroid.x, centroid.y]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const kraj = krajField ? String(props?.[krajField] || '').trim() : '';
    const okresCode = okresField ? String(props?.[okresField] || '').trim() : '';
    const okresName = okresCode ? String(okresByCode[okresCode] || '').trim() : '';

    items.push({
      n: name,
      nn: normalizeName(name),
      k: kraj,
      o: okresCode,
      on: okresName,
      lat: Number(lat),
      lon: Number(lon)
    });
  }

  // Build compact indices
  const byName = {};
  const byNameKraj = {};

  for (const it of items) {
    if (!byName[it.nn]) byName[it.nn] = [];
    byName[it.nn].push({ n: it.n, k: it.k, o: it.o, on: it.on, lat: it.lat, lon: it.lon });

    if (it.k) {
      byNameKraj[`${it.nn}|${it.k}`] = {
        lat: it.lat,
        lon: it.lon,
        n: it.n,
        o: it.o,
        on: it.on
      };
    }
  }

  const out = {
    built_at: new Date().toISOString(),
    source: {
      url: SOURCE_URL,
      license: 'CC-BY 4.0 (ČÚZK) – see https://cuzk.gov.cz/Predpisy/Podminky-poskytovani-prostor-dat-a-sitovych-sluzeb/Podminky-poskytovani-prostorovych-dat-CUZK.aspx'
    },
    count: items.length,
    byName,
    byNameKraj
  };

  await fsp.writeFile(OUT_FILE, JSON.stringify(out));
  console.log(`[obce] wrote ${OUT_FILE} (count=${items.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
