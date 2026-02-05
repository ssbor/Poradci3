/* Live MPSV JSON loader + client-side filters
   Exposes:
   - window.DATA[tag] = offers (for chatbot compatibility)
   - window.JobsLive.initOborPage(tag)

   Data source: /data/{tag}.json created by tools/build-daily.js
*/

(function () {
  'use strict';

  const DATA = (window.DATA = window.DATA || {});

  // NUTS3 codes for CZ regions (kraje)
  const CZ_REGIONS = [
    { code: 'CZ010', name: 'Hlavní město Praha' },
    { code: 'CZ020', name: 'Středočeský kraj' },
    { code: 'CZ031', name: 'Jihočeský kraj' },
    { code: 'CZ032', name: 'Plzeňský kraj' },
    { code: 'CZ041', name: 'Karlovarský kraj' },
    { code: 'CZ042', name: 'Ústecký kraj' },
    { code: 'CZ051', name: 'Liberecký kraj' },
    { code: 'CZ052', name: 'Královéhradecký kraj' },
    { code: 'CZ053', name: 'Pardubický kraj' },
    { code: 'CZ063', name: 'Kraj Vysočina' },
    { code: 'CZ064', name: 'Jihomoravský kraj' },
    { code: 'CZ071', name: 'Olomoucký kraj' },
    { code: 'CZ072', name: 'Zlínský kraj' },
    { code: 'CZ080', name: 'Moravskoslezský kraj' }
  ];

  const CZ_REGION_NAME_BY_CODE = Object.fromEntries(CZ_REGIONS.map((r) => [r.code, r.name]));

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  function average(arr) {
    if (!arr.length) return null;
    const sum = arr.reduce((acc, n) => acc + n, 0);
    return Math.round(sum / arr.length);
  }

  function fmtInt(n) {
    if (n == null || Number.isNaN(n)) return '–';
    return Number(n).toLocaleString('cs-CZ');
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function haversineKm(a, b) {
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const GEO_CACHE_KEY = 'ssbor_geo_cache_v1';
  function loadGeoCache() {
    try {
      const raw = localStorage.getItem(GEO_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  function saveGeoCache(cache) {
    try {
      localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // ignore
    }
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function geocodeOnce(query) {
    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
      encodeURIComponent(query);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Geocode HTTP ' + res.status);
    const js = await res.json();
    const first = js && js[0];
    if (!first) return null;
    return { lat: Number(first.lat), lon: Number(first.lon) };
  }

  function ensureAllRegionsInSelect(tag) {
    const regionSel =
      document.querySelector(`select[data-role=region][data-target="${tag}"]`) ||
      document.querySelector('select[data-role=region]');

    if (!regionSel) return;

    const current = String(regionSel.value || '');
    const existingValues = Array.from(regionSel.querySelectorAll('option')).map((o) => o.value);
    const hasAll = CZ_REGIONS.every((r) => existingValues.includes(r.code));
    if (hasAll) return;

    const keepForeign = existingValues.includes('zahranici_bor');

    regionSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'Všechny kraje';
    regionSel.appendChild(optAll);

    CZ_REGIONS.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.code;
      opt.textContent = r.name;
      regionSel.appendChild(opt);
    });

    if (keepForeign) {
      const optZ = document.createElement('option');
      optZ.value = 'zahranici_bor';
      optZ.textContent = 'Zahraničí (do 70km od Boru)';
      regionSel.appendChild(optZ);
    }

    regionSel.value = current;
    if (regionSel.value !== current) regionSel.value = '';
  }

  function ensureFilterUI(tag, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const explicitHost = document.querySelector(
      `[data-role="filters-host"][data-target="${tag}"]`
    );

    const host =
      explicitHost ||
      document.querySelector(
        `.card select[data-role=region][data-target="${tag}"]`
      )?.closest('.card');
    if (!host) return;

    if (host.querySelector('[data-role="live-filters"]')) return;

    const wrap = document.createElement('div');
    wrap.setAttribute('data-role', 'live-filters');
    wrap.style.marginTop = explicitHost ? '0' : '.75rem';

    wrap.innerHTML = `
      <div class="filters-header">
        <button class="btn btn--ghost filters-toggle" data-role="toggle-filters" data-target="${tag}" type="button" aria-expanded="false">
          Filtr
        </button>
      </div>
      <div class="filters-panel" data-role="filters-panel" data-target="${tag}" hidden>
        <div class="filters-grid">
          <div class="field field--span2">
            <label class="field__label" for="origin-${tag}">Moje poloha</label>
            <div class="field__row">
              <input id="origin-${tag}" class="input" data-role="origin" data-target="${tag}" placeholder="Např. Plzeň" autocomplete="address-level2" />
              <button class="btn btn--ghost" data-role="use-origin" data-target="${tag}" type="button">Použít</button>
            </div>
          </div>

          <div class="field">
            <label class="field__label" for="minw-${tag}">Min. mzda (Kč)</label>
            <input id="minw-${tag}" class="input" data-role="minw" data-target="${tag}" inputmode="numeric" placeholder="např. 30000" />
          </div>

          <div class="field">
            <label class="field__label" for="limit-${tag}">Do (km/min)</label>
            <div class="field__row">
              <input id="limit-${tag}" class="input" data-role="limit" data-target="${tag}" inputmode="numeric" placeholder="např. 30" />
                <select class="select select--unit" data-role="limit-unit" data-target="${tag}" aria-label="Jednotka (km/min)">
                <option value="km" selected>km</option>
                <option value="min">min</option>
              </select>
            </div>
          </div>

          <div class="field field--actions">
            <div class="field__row">
              <button class="btn btn--primary" data-role="search" data-target="${tag}" type="button">Hledat</button>
              <button class="btn btn--ghost" data-role="clear" data-target="${tag}" type="button">Vyčistit</button>
            </div>
          </div>
        </div>
      </div>
      <div class="muted" data-role="status" data-target="${tag}" style="margin-top:.5rem"></div>
    `;

    host.appendChild(wrap);
  }

  async function fetchJSON(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function pickEl(tag, sel) {
    return (
      document.querySelector(sel.replace('$t', tag)) ||
      document.querySelector(sel.replace('-$t', '').replace('$t', ''))
    );
  }

  function getInputs(tag) {
    const regionSel =
      document.querySelector(`select[data-role=region][data-target="${tag}"]`) ||
      document.querySelector('select[data-role=region]');

    const originEl = document.querySelector(`input[data-role=origin][data-target="${tag}"]`);
    const minwEl = document.querySelector(`input[data-role=minw][data-target="${tag}"]`);
    const limitEl = document.querySelector(`input[data-role=limit][data-target="${tag}"]`);
    const limitUnitEl = document.querySelector(`select[data-role=limit-unit][data-target="${tag}"]`);
    const statusEl = document.querySelector(`div[data-role=status][data-target="${tag}"]`);

    return { regionSel, originEl, minwEl, limitEl, limitUnitEl, statusEl };
  }

  function normalizeRegionValue(v) {
    return String(v || '').trim();
  }

  function offerText(o) {
    return (
      (o.profese || '') +
      ' ' +
      (o.zamestnavatel || '') +
      ' ' +
      (o.okres || '') +
      ' ' +
      (o.lokalita || '') +
      ' ' +
      (o.kraj || '')
    ).toLowerCase();
  }

  function parseIntOrNull(s) {
    const cleaned = String(s || '').replace(/\s+/g, '').replace(/[^0-9]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function estimateMinutesFromKm(km) {
    // Simple estimate (not a real routing engine)
    if (!Number.isFinite(km)) return null;
    const speedKmh = 55;
    const base = (km / speedKmh) * 60;
    const overhead = 6;
    return Math.max(1, Math.round(base + overhead));
  }

  function ensurePagerUI(tag) {
    const tb = pickEl(tag, `[data-id="tbl-$t"]`) || pickEl(tag, `[data-id="tbl"]`);
    const card = tb?.closest?.('.card');
    if (!card) return;
    const tableWrap = card.querySelector('.table-wrap');
    if (!tableWrap) return;

    const existingTop = card.querySelector(
      `div[data-role=pager][data-target="${tag}"][data-pos="top"]`
    );
    const existingBottom = card.querySelector(
      `div[data-role=pager][data-target="${tag}"][data-pos="bottom"]`
    );
    if (existingTop && existingBottom) return;

    const rightHtml = (pos) => {
      if (pos === 'bottom') return '';
      return `
        <div class="pager__right">
          <span class="pager__label">Na stránce</span>
          <select class="select" data-role="page-size" data-target="${tag}" aria-label="Počet nabídek na stránce">
            <option value="30" selected>30</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="all">Vše</option>
          </select>
        </div>
      `;
    };

    const makePager = (pos) => {
      const pager = document.createElement('div');
      pager.className = 'pager';
      pager.setAttribute('data-role', 'pager');
      pager.setAttribute('data-target', tag);
      pager.setAttribute('data-pos', pos);
      pager.innerHTML = `
        <div class="pager__left">
          <button class="btn btn--ghost" data-role="page-prev" data-target="${tag}" type="button" aria-label="Předchozí stránka">←</button>
          <div class="pager__info" data-role="page-info" data-target="${tag}">Stránka 1/1</div>
          <button class="btn btn--ghost" data-role="page-next" data-target="${tag}" type="button" aria-label="Další stránka">→</button>
        </div>
        ${rightHtml(pos)}
      `;
      return pager;
    };

    if (!existingTop) {
      const pagerTop = makePager('top');
      card.insertBefore(pagerTop, tableWrap);
    }
    if (!existingBottom) {
      const pagerBottom = makePager('bottom');
      tableWrap.insertAdjacentElement('afterend', pagerBottom);
    }
  }

  function scrollOffersToTop(tag) {
    const tb = pickEl(tag, `[data-id="tbl-$t"]`) || pickEl(tag, `[data-id="tbl"]`);
    const card = tb?.closest?.('.card');
    if (!card) return;

    const topPager = card.querySelector(
      `div[data-role=pager][data-target="${tag}"][data-pos="top"]`
    );
    const target = topPager || card;

    requestAnimationFrame(() => {
      try {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch {
        target.scrollIntoView(true);
      }
    });
  }

  function render(tag, state) {
    const { regionSel, originEl, minwEl, limitEl, limitUnitEl, statusEl } = getInputs(tag);

    ensurePagerUI(tag);

    const region = normalizeRegionValue(regionSel ? regionSel.value : '');
    const originText = String(originEl?.value || state.originText || '').trim();
    const minWage = parseIntOrNull(minwEl?.value);
    const limitVal = parseIntOrNull(limitEl?.value);
    const unit = String(limitUnitEl?.value || state.limitUnit || 'km');
    state.limitUnit = unit;
    state.originText = originText;

    const wantsLimit = limitVal != null;
    const canLimit = !!state.userLoc && wantsLimit;

    let rows = state.offers.slice();

    rows = rows.filter((r) => {
      if (region === 'zahranici_bor') {
        // Live MPSV feed is CZ-heavy; if you later add foreign offers, set kraj='zahranici_bor' or similar.
        return r.kraj === 'zahranici_bor' || r.area === 'zahranici_bor';
      }
      if (!region) return true;
      return r.kraj === region || r.kraj_id === region;
    });

    if (minWage != null) {
      rows = rows.filter((r) => typeof r.mzda_od === 'number' && r.mzda_od >= minWage);
    }

    // km/min limit filter (requires origin geocoded)
    if (canLimit) {
      rows = rows.filter((r) => {
        const key = state.offerKey(r);
        const km = state.distances.get(key);
        if (typeof km !== 'number') return false;
        if (unit === 'km') return km <= limitVal;
        const mins = estimateMinutesFromKm(km);
        return typeof mins === 'number' && mins <= limitVal;
      });
    }

    rows.sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || '')));

    // Pagination
    const pageSizeRaw = state.pageSize;
    const pageSize = pageSizeRaw === 'all' ? rows.length : Number(pageSizeRaw || 30);
    const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 30;
    const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
    state.page = Math.min(Math.max(1, Number(state.page || 1)), totalPages);
    const from = (state.page - 1) * safePageSize;
    const to = from + safePageSize;
    const pageRows = pageSizeRaw === 'all' ? rows : rows.slice(from, to);

    const wages = rows
      .map((r) => r.mzda_od)
      .filter((v) => typeof v === 'number' && !Number.isNaN(v));

    const countEl = pickEl(tag, `[data-id="count-$t"]`) || pickEl(tag, `[data-id="count"]`);
    const medianEl = pickEl(tag, `[data-id="median-$t"]`) || pickEl(tag, `[data-id="median"]`);
    const topEl = pickEl(tag, `[data-id="top-$t"]`) || pickEl(tag, `[data-id="top"]`);
    const tb = pickEl(tag, `[data-id="tbl-$t"]`) || pickEl(tag, `[data-id="tbl"]`);

    if (countEl) countEl.textContent = rows.length;
    if (medianEl) medianEl.textContent = fmtInt(average(wages));

    // Intentionally do not write a verbose status line under the expanded filters.
    // (statusEl is reserved for loading/errors and explicit user actions)

    if (topEl) {
      const cnt = {};
      rows.forEach((r) => {
        const name = r.zamestnavatel || '';
        if (!name) return;
        cnt[name] = (cnt[name] || 0) + 1;
      });
      const top = Object.entries(cnt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      topEl.innerHTML = '';
      if (!top.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = '–';
        topEl.appendChild(li);
      }
      top.forEach(([name, c]) => {
        const li = document.createElement('li');
        li.textContent = `${name} (${c})`;
        topEl.appendChild(li);
      });
    }

    if (tb) {
      tb.innerHTML = '';
      pageRows.forEach((r) => {
        const tr = document.createElement('tr');
        const mzda =
          (r.mzda_od ? fmtInt(r.mzda_od) : '') + (r.mzda_do ? '–' + fmtInt(r.mzda_do) : '');
        const key = state.offerKey(r);
        const km = state.distances.get(key);
        const kmText = typeof km === 'number' ? km.toFixed(0) : '–';
        const mins = state.userLoc ? estimateMinutesFromKm(km) : null;
        const minsText = typeof mins === 'number' ? String(mins) : '–';
        const extraCell = state.userLoc
          ? unit === 'min'
            ? `<td>${minsText}</td>`
            : `<td>${kmText}</td>`
          : '';

        tr.innerHTML =
          `<td>${escapeHtml(r.profese || '')}</td>` +
          `<td>${escapeHtml(r.zamestnavatel || '')}</td>` +
          `<td>${escapeHtml(r.okres || r.lokalita || '')}</td>` +
          (state.userLoc
            ? `<td>${escapeHtml(mzda || '')}</td>${extraCell}<td>${escapeHtml(r.datum || '')}</td>`
            : `<td>${escapeHtml(mzda || '')}</td><td>${escapeHtml(r.datum || '')}</td>`);

        tb.appendChild(tr);
      });
    }

    // Pager UI update
    document
      .querySelectorAll(`div[data-role=page-info][data-target="${tag}"]`)
      .forEach((el) => {
        el.textContent = `Stránka ${state.page}/${totalPages}`;
      });

    document
      .querySelectorAll(`button[data-role=page-prev][data-target="${tag}"]`)
      .forEach((btn) => {
        btn.disabled = state.page <= 1 || totalPages <= 1;
      });
    document
      .querySelectorAll(`button[data-role=page-next][data-target="${tag}"]`)
      .forEach((btn) => {
        btn.disabled = state.page >= totalPages || totalPages <= 1;
      });

    document
      .querySelectorAll(`select[data-role=page-size][data-target="${tag}"]`)
      .forEach((sel) => {
        const desired = String(state.pageSize || '30');
        if (String(sel.value) !== desired) sel.value = desired;
      });

    // Note: no running status summary.

    // Toggle distance column headers if needed
    const thead = document.querySelector('table thead tr');
    if (thead) {
      const hasLimit = !!thead.querySelector('[data-role="th-limit"]');
      if (state.userLoc) {
        if (!hasLimit) {
          const th = document.createElement('th');
          th.setAttribute('data-role', 'th-limit');
          th.textContent = state.limitUnit === 'min' ? 'Min' : 'Km';
          const ths = thead.querySelectorAll('th');
          const before = ths.length >= 1 ? ths[ths.length - 1] : null;
          if (before) thead.insertBefore(th, before);
          else thead.appendChild(th);
        } else {
          const th = thead.querySelector('[data-role="th-limit"]');
          if (th) th.textContent = state.limitUnit === 'min' ? 'Min' : 'Km';
        }
      } else {
        thead.querySelector('[data-role="th-limit"]')?.remove();
      }
    }
  }

  function bestGeocodeQueryForOffer(o) {
    const krajCode = String(o?.kraj || '').trim();
    const krajName = String(o?.kraj_nazev || CZ_REGION_NAME_BY_CODE[krajCode] || '').trim();
    const obec = String(o?.obec || '').trim();
    const okres = String(o?.okres || '').trim();
    const lokalita = String(o?.lokalita || '').trim();

    // Prefer: obec + kraj (stable and geocodable)
    if (obec && krajName) return `${obec}, ${krajName}, Czechia`;
    if (okres && krajName) return `${okres}, ${krajName}, Czechia`;

    // Fallback to provided locality text; still hint Czechia
    if (lokalita) return `${lokalita}, Czechia`;
    if (okres) return `${okres}, Czechia`;
    if (krajName) return `${krajName}, Czechia`;
    return '';
  }

  async function computeDistances(tag, state) {
    if (!state.userLoc) return;

    const cache = state.geoCache;
    const uniqueQueries = [];

    for (const o of state.offers) {
      const q = bestGeocodeQueryForOffer(o);
      if (!q) continue;
      if (Object.prototype.hasOwnProperty.call(cache, q)) continue;
      uniqueQueries.push(q);
    }

    // polite throttling (and avoid too many requests)
    const MAX_LOOKUPS = 60;
    const todo = uniqueQueries.slice(0, MAX_LOOKUPS);

    for (let i = 0; i < todo.length; i++) {
      const q = todo[i];
      try {
        const coords = await geocodeOnce(q);
        if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
          cache[q] = coords;
          saveGeoCache(cache);
        } else {
          cache[q] = null;
          saveGeoCache(cache);
        }
      } catch {
        // store null to prevent hammering
        cache[q] = null;
        saveGeoCache(cache);
      }
      await sleep(900);
      render(tag, state);
    }

    // now compute distances for offers with cached coords
    for (const o of state.offers) {
      const key = state.offerKey(o);
      const q = bestGeocodeQueryForOffer(o);
      const coords = q ? cache[q] : null;
      if (coords && typeof coords === 'object') {
        state.distances.set(key, haversineKm(state.userLoc, coords));
      }
    }
  }

  async function initOborPage(tag, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const enableFilters = !!opts.enableFilters;
    if (enableFilters) ensureFilterUI(tag, opts);
    ensureAllRegionsInSelect(tag);

    const variantSel =
      document.querySelector(`select[data-role=variant][data-target="${tag}"]`) ||
      document.querySelector('select[data-role=variant]');

    const state = {
      tag,
      dataTag: tag,
      offers: [],
      page: 1,
      pageSize: 30,
      userLoc: null,
      originText: '',
      limitUnit: 'km',
      originResolved: '',
      distances: new Map(),
      geoCache: loadGeoCache(),
      offerKey: (o) =>
        [o.cz_isco || '', o.zamestnavatel || '', o.okres || o.lokalita || '', o.datum || ''].join('|')
    };

    const getDataTag = () => {
      const v = String(variantSel?.value || '').trim();
      return v || tag;
    };

    const applyVariantPageMeta = (baseTag, dataTag) => {
      if (baseTag !== 'gastro') return;
      const meta = {
        kuchar: {
          label: 'Kuchař',
          isco: '5120',
          tip: 'Tip: napište do chatu „kuchař“ a pak lokalitu.',
          table: 'Tabulka nabídek kuchař'
        },
        cisnik: {
          label: 'Číšník / servírka',
          isco: '5131',
          tip: 'Tip: napište do chatu „číšník“ a pak lokalitu.',
          table: 'Tabulka nabídek číšník / servírka'
        },
        barman: {
          label: 'Barman',
          isco: '5132',
          tip: 'Tip: napište do chatu „barman“ a pak lokalitu.',
          table: 'Tabulka nabídek barman'
        }
      };
      const m = meta[String(dataTag)];
      if (!m) return;

      try {
        document.title = `${m.label} – nabídky práce (SŠ Bor)`;
      } catch {
        // ignore
      }

      const sub = document.querySelector('[data-role=page-subtitle]') || document.querySelector('.brand-sub');
      if (sub) sub.textContent = `Možnosti uplatnění · ${m.label}`;

      const h1 = document.querySelector('[data-role=page-title]') || document.querySelector('.hero h1');
      if (h1) {
        const badge = h1.querySelector('.badge');
        h1.textContent = m.label + ' ';
        if (badge) h1.appendChild(badge);
      }

      const iscoEl = document.querySelector('[data-role=variant-isco]');
      if (iscoEl) iscoEl.textContent = `CZ‑ISCO ${m.isco}`;

      const tipEl = document.querySelector('[data-role=variant-tip]');
      if (tipEl) tipEl.textContent = m.tip;

      const tbl = document.querySelector('table[data-role=offers-table]') || document.querySelector('table.table');
      if (tbl) tbl.setAttribute('aria-label', m.table);
    };

    // Load data
    const reloadData = async () => {
      const { statusEl } = getInputs(tag);
      try {
        if (statusEl) statusEl.textContent = 'Načítám data…';
        const dataTag = getDataTag();
        state.dataTag = dataTag;
        const data = await fetchJSON(`data/${dataTag}.json`);
        const offers = Array.isArray(data?.offers)
          ? data.offers
          : Array.isArray(data?.last_offers)
            ? data.last_offers
            : [];
        state.offers = offers;
        DATA[dataTag] = offers;
        // Distances depend on offer set.
        state.distances.clear();
        state.page = 1;
        render(tag, state);
        applyVariantPageMeta(tag, dataTag);
        if (statusEl) statusEl.textContent = '';
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Nepodařilo se načíst data: ' + String(e);
        throw e;
      }
    };

    try {
      await reloadData();
    } catch {
      return;
    }

    // Switch dataset variant (e.g. on Automechanik page)
    variantSel?.addEventListener('change', async () => {
      const { statusEl } = getInputs(tag);
      try {
        if (statusEl) statusEl.textContent = 'Načítám…';
        await reloadData();
        state.page = 1;
        if (state.userLoc) {
          state.distances.clear();
          await computeDistances(tag, state);
        }
        render(tag, state);
        applyVariantPageMeta(tag, state.dataTag);
        if (statusEl) statusEl.textContent = '';
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Nepodařilo se přepnout: ' + String(e);
      }
    });

    // Wire UI
    const { regionSel, originEl, minwEl, limitEl, limitUnitEl } = getInputs(tag);

    // Pager UI events
    ensurePagerUI(tag);
    document
      .querySelectorAll(`button[data-role=page-prev][data-target="${tag}"]`)
      .forEach((btn) => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          const isBottom =
            btn.closest('div[data-role=pager]')?.getAttribute('data-pos') === 'bottom';
          state.page = Math.max(1, Number(state.page || 1) - 1);
          render(tag, state);
          if (isBottom) scrollOffersToTop(tag);
        });
      });
    document
      .querySelectorAll(`button[data-role=page-next][data-target="${tag}"]`)
      .forEach((btn) => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          const isBottom =
            btn.closest('div[data-role=pager]')?.getAttribute('data-pos') === 'bottom';
          state.page = Number(state.page || 1) + 1;
          render(tag, state);
          if (isBottom) scrollOffersToTop(tag);
        });
      });
    document
      .querySelectorAll(`select[data-role=page-size][data-target="${tag}"]`)
      .forEach((sel) => {
        if (sel.dataset.bound === '1') return;
        sel.dataset.bound = '1';
        sel.addEventListener('change', (e) => {
          const isBottom =
            sel.closest('div[data-role=pager]')?.getAttribute('data-pos') === 'bottom';
          const val = String(e?.target?.value || '30');
          state.pageSize = val === 'all' ? 'all' : Number(val) || 30;
          state.page = 1;
          render(tag, state);
          if (isBottom) scrollOffersToTop(tag);
        });
      });

    // Collapsible filter panel
    const toggleBtn = document.querySelector(
      `button[data-role=toggle-filters][data-target="${tag}"]`
    );
    const panelEl = document.querySelector(`div[data-role=filters-panel][data-target="${tag}"]`);
    const openKey = `ssbor_filters_open_v1_${tag}`;

    const setFiltersOpen = (open) => {
      if (!panelEl || !toggleBtn) return;
      panelEl.hidden = !open;
      toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggleBtn.classList.toggle('is-open', open);
      try {
        localStorage.setItem(openKey, open ? '1' : '0');
      } catch {
        // ignore
      }
    };

    const getFiltersOpen = () => {
      try {
        const v = localStorage.getItem(openKey);
        if (v === '1') return true;
        if (v === '0') return false;
      } catch {
        // ignore
      }
      return !!opts.filtersDefaultOpen;
    };

    setFiltersOpen(getFiltersOpen());
    toggleBtn?.addEventListener('click', () => {
      const currentlyOpen = panelEl ? !panelEl.hidden : false;
      setFiltersOpen(!currentlyOpen);
    });

    const applyLimitUnitUX = () => {
      const unit = String(limitUnitEl?.value || state.limitUnit || 'km');
      state.limitUnit = unit;
      const label = document.querySelector(`label[for="limit-${tag}"]`);
        if (label) label.textContent = 'Do (km/min)';
      if (limitEl) limitEl.placeholder = unit === 'min' ? 'např. 45' : 'např. 30';
    };

    const resolveOriginIfNeeded = async () => {
      const val = String(originEl?.value || '').trim();
      const { statusEl } = getInputs(tag);
      if (!val) {
        if (statusEl) statusEl.textContent = 'Vyplňte „Moje poloha“ (např. Plzeň).';
        return false;
      }

      // If already resolved for the same text, don't re-geocode.
      if (state.userLoc && state.originResolved === val) return true;

      try {
        if (statusEl) statusEl.textContent = 'Zjišťuji polohu: ' + val + '…';
        const coords = await geocodeOnce(val + ', Czechia');
        if (!coords) {
          if (statusEl) statusEl.textContent = 'Nepodařilo se najít polohu pro: ' + val;
          return false;
        }
        state.userLoc = coords;
        state.originText = val;
        state.originResolved = val;
        state.distances.clear();
        await computeDistances(tag, state);
        render(tag, state);
        if (statusEl) statusEl.textContent = '';
        return true;
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Nepodařilo se geokódovat: ' + String(e);
        return false;
      }
    };

    const rerender = debounce(() => {
      state.page = 1;
      render(tag, state);
    }, 120);
    regionSel?.addEventListener('change', rerender);
    minwEl?.addEventListener('input', rerender);
    limitEl?.addEventListener('input', rerender);
    limitUnitEl?.addEventListener('change', () => {
      applyLimitUnitUX();
      render(tag, state);
    });

    applyLimitUnitUX();

    // Explicit search button (requested UX)
    document
      .querySelector(`button[data-role=search][data-target="${tag}"]`)
      ?.addEventListener('click', async () => {
        // If origin filled and not resolved yet, resolve it first.
        const hasOrigin = String(originEl?.value || '').trim().length > 0;
        if (hasOrigin && !state.userLoc) {
          const ok = await resolveOriginIfNeeded();
          if (!ok) return;
        }
        render(tag, state);
      });

    // Enter key triggers search in key fields
    originEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document
          .querySelector(`button[data-role=search][data-target="${tag}"]`)
          ?.click();
      }
    });
    limitEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document
          .querySelector(`button[data-role=search][data-target="${tag}"]`)
          ?.click();
      }
    });

    // Manual origin -> geocode and use as location
    document
      .querySelector(`button[data-role=use-origin][data-target="${tag}"]`)
      ?.addEventListener('click', async () => {
        await resolveOriginIfNeeded();
      });

    // Existing hero button should actually refresh data
    document
      .querySelector(`button[data-role=load][data-target="${tag}"]`)
      ?.addEventListener('click', async () => {
        await reloadData();
        // If user already enabled location, recompute distances for the new list.
        if (state.userLoc) {
          state.distances.clear();
          await computeDistances(tag, state);
        }
        render(tag, state);
      });

    document
      .querySelector(`button[data-role=clear][data-target="${tag}"]`)
      ?.addEventListener('click', () => {
        if (originEl) originEl.value = '';
        if (minwEl) minwEl.value = '';
        if (limitEl) limitEl.value = '';
        if (limitUnitEl) limitUnitEl.value = 'km';
        state.distances.clear();
        state.userLoc = null;
        state.originText = '';
        state.originResolved = '';
        state.limitUnit = 'km';
        applyLimitUnitUX();
        render(tag, state);
      });

    // Initial render
    render(tag, state);
  }

  window.JobsLive = { initOborPage };
})();
