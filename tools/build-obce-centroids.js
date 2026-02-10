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
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/\s+/g, ' ');
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
      '1/OBCE_P.cpg'
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

  console.log('[obce] reading shapefile and computing centroids…');

  const src = await shapefile.open(shpPath, dbfPath, { encoding: 'utf-8' });

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
      krajField = pickField(props, ['KOD_VUSC', 'KOD_KRAJ', 'VUSC_KOD', 'KRAJ_KOD']);
      okresField = pickField(props, ['KOD_OKRES', 'OKRES_KOD', 'NAZ_OKRES', 'OKRES']);
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
    const okres = okresField ? String(props?.[okresField] || '').trim() : '';

    items.push({
      n: name,
      nn: normalizeName(name),
      k: kraj,
      o: okres,
      lat: Number(lat),
      lon: Number(lon)
    });
  }

  // Build compact indices
  const byName = {};
  const byNameKraj = {};

  for (const it of items) {
    if (!byName[it.nn]) byName[it.nn] = [];
    byName[it.nn].push({ n: it.n, k: it.k, o: it.o, lat: it.lat, lon: it.lon });

    if (it.k) {
      byNameKraj[`${it.nn}|${it.k}`] = { lat: it.lat, lon: it.lon, n: it.n, o: it.o };
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
