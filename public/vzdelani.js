(function () {
  'use strict';

  function normalizeKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]+/g, '')
      .replace(/\s+/g, ' ');
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function fetchJSON(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function shortId(id) {
    const s = String(id || '').trim();
    const slash = s.lastIndexOf('/');
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function labelForma(id) {
    const k = shortId(id);
    if (!k) return '';
    const m = {
      // MPSV codes seen in data: prez, komb, dal, vec, dist, den, jina
      prez: 'Prezenční',
      den: 'Denní',
      komb: 'Kombinované',
      dal: 'Dálkové',
      vec: 'Večerní',
      dist: 'Distanční',
      jina: 'Jiná',

      // fallback/synonyms (just in case)
      denni: 'Denní',
      dalk: 'Dálkové',
      dalkove: 'Dálkové',
      vecer: 'Večerní',
      vecerni: 'Večerní'
    };
    return m[k] || k;
  }

  function labelUkonceni(id) {
    const k = shortId(id);
    if (!k) return '';
    const m = {
      // MPSV codes seen in data: abs, jin, mat, ne, stzk, zavz, zzvl
      mat: 'Maturitní zkouška',
      stzk: 'Státní závěrečná zkouška',
      zavz: 'Závěrečná zkouška',
      zzvl: 'Závěrečná zkouška + výuční list',
      abs: 'Absolutorium',
      ne: 'Bez ukončení',
      jin: 'Jiné',

      // fallback/synonyms (just in case)
      vyuc: 'Výuční list',
      zavr: 'Závěrečná zkouška'
    };
    return m[k] || k;
  }

  function buildOptionList(values, { emptyLabel = 'Vše' } = {}) {
    const opts = [{ value: '', label: emptyLabel }];
    for (const v of values) {
      if (!v) continue;
      opts.push({ value: v.value, label: v.label });
    }
    return opts;
  }

  function setSelectOptions(sel, options) {
    if (!sel) return;
    const cur = String(sel.value || '');
    sel.innerHTML = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = cur;
    if (sel.value !== cur) sel.value = '';
  }

  function createResultCard(school, matches) {
    const addr = school.adresa || {};
    const title = escapeHtml(school.name || '');
    const place = [addr.obec, addr.okres, addr.kraj].filter(Boolean).join(' · ');

    const url = String(school.url || '').trim();
    const urlHtml = url
      ? `<a class="btn btn--ghost" href="https://${escapeHtml(url.replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener">Web školy</a>`
      : '';

    const progHtml = matches
      .slice(0, 6)
      .map((p) => {
        const chips = [p.forma ? labelForma(p.forma) : '', p.ukonceni ? labelUkonceni(p.ukonceni) : '']
          .filter(Boolean)
          .map((x) => `<span class="tag" style="margin-right:.35rem">${escapeHtml(x)}</span>`)
          .join('');

        const code = p.code ? `<span class="muted">${escapeHtml(p.code)}</span> · ` : '';
        return `<div style="margin:.35rem 0">
          <div><b>${escapeHtml(p.name || '')}</b></div>
          <div class="muted" style="margin-top:.15rem">${code}${chips}</div>
        </div>`;
      })
      .join('');

    return `
      <div class="card" style="margin-top: 1rem">
        <div class="card-title-row">
          <h3 style="margin:0">${title}</h3>
          <div class="muted">${escapeHtml(place || '')}</div>
        </div>
        <div class="muted" style="margin-top:.4rem">
          ${addr.psc ? escapeHtml(addr.psc) + ' · ' : ''}
          ${escapeHtml([addr.ulice, [addr.cisloDomovni, addr.cisloOrientacni].filter(Boolean).join('/')].filter(Boolean).join(' '))}
        </div>
        <div style="margin-top:.9rem">
          <div class="muted" style="font-weight:800">Nalezené obory</div>
          ${progHtml || `<div class="muted" style="margin-top:.4rem">Nenalezeny žádné obory.</div>`}
        </div>
        <div style="margin-top:.9rem; display:flex; gap:.6rem; flex-wrap:wrap">
          ${urlHtml}
        </div>
      </div>
    `;
  }

  function ensureResultsUI(outEl) {
    if (!outEl) return null;

    const existing = outEl.querySelector('[data-role=skoly-results-wrap]');
    if (existing) {
      return {
        wrap: existing,
        listEl: existing.querySelector('[data-role=skoly-list]'),
        topPager: existing.querySelector('[data-role=skoly-pager][data-pos=top]'),
        bottomPager: existing.querySelector('[data-role=skoly-pager][data-pos=bottom]')
      };
    }

    const wrap = document.createElement('div');
    wrap.setAttribute('data-role', 'skoly-results-wrap');

    const makePager = (pos) => {
      const right =
        pos === 'top'
          ? `
        <div class="pager__right" style="align-items:flex-start">
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:.35rem">
            <div class="count-pill">Školy: <b data-role="skoly-count">–</b></div>
            <div style="display:flex; align-items:center; gap:.5rem">
              <span class="pager__label">Na stránce</span>
              <select class="select" data-role="skoly-page-size" aria-label="Počet škol na stránce">
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="30" selected>30</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="all">Vše</option>
              </select>
            </div>
          </div>
        </div>
      `
          : '';

      return `
        <div class="pager" data-role="skoly-pager" data-pos="${pos}">
          <div class="pager__left">
            <button class="btn btn--ghost" data-role="skoly-page-prev" type="button" aria-label="Předchozí stránka">←</button>
            <div class="pager__info" data-role="skoly-page-info">Stránka 1/1</div>
            <button class="btn btn--ghost" data-role="skoly-page-next" type="button" aria-label="Další stránka">→</button>
          </div>
          ${right}
        </div>
      `;
    };

    wrap.innerHTML = `
      ${makePager('top')}
      <div data-role="skoly-list"></div>
      ${makePager('bottom')}
    `;

    outEl.appendChild(wrap);

    return {
      wrap,
      listEl: wrap.querySelector('[data-role=skoly-list]'),
      topPager: wrap.querySelector('[data-role=skoly-pager][data-pos=top]'),
      bottomPager: wrap.querySelector('[data-role=skoly-pager][data-pos=bottom]')
    };
  }

  function scrollResultsToTop(outEl) {
    if (!outEl) return;

    // Prefer scrolling to the filter form (requested), not just the pager.
    const section = outEl.closest('section') || document;
    const form = section.querySelector('[data-role=skoly-form]');
    const fallback = outEl.querySelector('[data-role=skoly-pager][data-pos=top]') || outEl;
    const target = form || fallback;

    const header = document.querySelector('.site-header');
    const headerH = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    const pad = 12;

    requestAnimationFrame(() => {
      const rect = target.getBoundingClientRect();
      const top = rect.top + window.scrollY - headerH - pad;
      const y = Math.max(0, Math.floor(top));
      try {
        window.scrollTo({ top: y, behavior: 'smooth' });
      } catch {
        window.scrollTo(0, y);
      }
    });
  }

  async function init() {
    const form = document.querySelector('[data-role=skoly-form]');
    const qEl = document.querySelector('input[data-role=skoly-q]');
    const krajEl = document.querySelector('select[data-role=skoly-kraj]');
    const formaEl = document.querySelector('select[data-role=skoly-forma]');
    const ukEl = document.querySelector('select[data-role=skoly-ukonceni]');
    const statusEl = document.querySelector('[data-role=skoly-status]');
    const outEl = document.querySelector('[data-role=skoly-results]');

    if (!statusEl || !outEl) return;

    statusEl.textContent = 'Načítám databázi škol…';

    let data;
    try {
      data = await fetchJSON('data/skoly_index.json');
    } catch (e) {
      statusEl.textContent = 'Nepodařilo se načíst lokální data škol.';
      return;
    }

    const schools = Array.isArray(data?.schools) ? data.schools : [];

    const ui = ensureResultsUI(outEl);
    const listEl = ui?.listEl || outEl;

    // Build filter options from data
    const krajMap = new Map();
    const formaMap = new Map();
    const ukMap = new Map();

    for (const s of schools) {
      const addr = s?.adresa || {};
      if (addr?.krajId) {
        const label = addr.kraj || shortId(addr.krajId);
        krajMap.set(String(addr.krajId), String(label));
      }
      for (const p of s?.programs || []) {
        if (p?.forma) formaMap.set(String(p.forma), labelForma(p.forma));
        if (p?.ukonceni) ukMap.set(String(p.ukonceni), labelUkonceni(p.ukonceni));
      }
    }

    const krajOpts = [...krajMap.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'cs'));

    const formaOpts = [...formaMap.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'cs'));

    const ukOpts = [...ukMap.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'cs'));

    setSelectOptions(krajEl, buildOptionList(krajOpts, { emptyLabel: 'Všechny kraje' }));
    setSelectOptions(formaEl, buildOptionList(formaOpts, { emptyLabel: 'Všechny formy studia' }));
    setSelectOptions(ukEl, buildOptionList(ukOpts, { emptyLabel: 'Všechna ukončení' }));

    statusEl.textContent = `Načteno: ${schools.length} škol / ${Number(data?.count_programs || 0)} oborů.`;

    const state = {
      page: 1,
      pageSize: 30
    };

    let lastKey = '';
    let lastHits = [];

    const criteriaKey = () => {
      const q = normalizeKey(String(qEl?.value || '').trim());
      const krajId = String(krajEl?.value || '').trim();
      const forma = String(formaEl?.value || '').trim();
      const ukonceni = String(ukEl?.value || '').trim();
      return JSON.stringify([q, krajId, forma, ukonceni]);
    };

    const computeHits = () => {
      const qRaw = String(qEl?.value || '').trim();
      const q = normalizeKey(qRaw);
      const tokens = q.split(' ').filter(Boolean);

      const krajId = String(krajEl?.value || '').trim();
      const forma = String(formaEl?.value || '').trim();
      const ukonceni = String(ukEl?.value || '').trim();

      const hits = [];

      for (const s of schools) {
        if (krajId && String(s?.adresa?.krajId || '') !== krajId) continue;

        const schoolMatch = !tokens.length
          ? true
          : tokens.every((t) => String(s.nk || '').includes(t) || String(s.ak || '').includes(t));

        const matchedPrograms = [];
        for (const p of s?.programs || []) {
          if (forma && String(p.forma || '') !== forma) continue;
          if (ukonceni && String(p.ukonceni || '') !== ukonceni) continue;

          if (!tokens.length) {
            matchedPrograms.push(p);
            continue;
          }

          const target = String(p.nk || '') + ' ' + normalizeKey(p.code || '');
          const ok = tokens.every((t) => target.includes(t));
          if (ok) matchedPrograms.push(p);
        }

        if (!matchedPrograms.length && !schoolMatch) continue;

        const score = (matchedPrograms.length ? 10 : 0) + (schoolMatch ? 3 : 0);
        hits.push({ s, programs: matchedPrograms, score });
      }

      hits.sort((a, b) => b.score - a.score || String(a.s?.name || '').localeCompare(String(b.s?.name || ''), 'cs'));

      return hits;
    };

    const renderPage = ({ scrollTop = false } = {}) => {
      const hits = lastHits;

      const pageSizeRaw = state.pageSize;
      const size = pageSizeRaw === 'all' ? hits.length : Number(pageSizeRaw || 30);
      const safeSize = Number.isFinite(size) && size > 0 ? size : 30;
      const totalPages = Math.max(1, Math.ceil(hits.length / safeSize));
      state.page = Math.min(Math.max(1, Number(state.page || 1)), totalPages);

      const from = (state.page - 1) * safeSize;
      const to = from + safeSize;
      const pageHits = pageSizeRaw === 'all' ? hits : hits.slice(from, to);

      // Update count pill (top pager)
      outEl
        .querySelectorAll('[data-role=skoly-count]')
        .forEach((el) => (el.textContent = String(hits.length)));

      if (!hits.length) {
        statusEl.textContent = 'Nic nenalezeno. Zkuste kratší dotaz (např. „nástavba“, „svářeč“, „Plzeň“).';
        if (listEl) listEl.innerHTML = '';
      } else {
        // Keep status line empty (requested); paging info is in pager.
        statusEl.textContent = '';
        const html = pageHits
          .map((h) => createResultCard(h.s, h.programs.length ? h.programs : h.s.programs || []))
          .join('');
        if (listEl) listEl.innerHTML = html;
      }

      // pager UI update
      outEl
        .querySelectorAll('[data-role=skoly-page-info]')
        .forEach((el) => (el.textContent = `Stránka ${state.page}/${Math.max(1, totalPages)}`));

      outEl
        .querySelectorAll('button[data-role=skoly-page-prev]')
        .forEach((btn) => (btn.disabled = state.page <= 1 || totalPages <= 1));
      outEl
        .querySelectorAll('button[data-role=skoly-page-next]')
        .forEach((btn) => (btn.disabled = state.page >= totalPages || totalPages <= 1));

      const desired = String(state.pageSize || '30');
      outEl.querySelectorAll('select[data-role=skoly-page-size]').forEach((sel) => {
        if (String(sel.value) !== desired) sel.value = desired;
      });

      if (scrollTop) scrollResultsToTop(outEl);
    };

    const runSearch = ({ resetPage = false } = {}) => {
      const key = criteriaKey();
      const changed = key !== lastKey;
      if (changed) {
        lastKey = key;
        lastHits = computeHits();
      }
      if (resetPage || changed) state.page = 1;
      renderPage({ scrollTop: false });
    };

    // pager handlers
    outEl?.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;

      if (t.matches('button[data-role=skoly-page-prev]')) {
        state.page = Math.max(1, Number(state.page || 1) - 1);
        renderPage({ scrollTop: true });
        return;
      }
      if (t.matches('button[data-role=skoly-page-next]')) {
        state.page = Number(state.page || 1) + 1;
        renderPage({ scrollTop: true });
        return;
      }
    });

    outEl?.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLSelectElement)) return;
      if (!t.matches('select[data-role=skoly-page-size]')) return;
      const val = String(t.value || '30');
      state.pageSize = val === 'all' ? 'all' : Number(val) || 30;
      state.page = 1;
      renderPage({ scrollTop: true });
    });

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch({ resetPage: true });
    });

    qEl?.addEventListener('input', () => {
      // light debounce without timers: only run when query is reasonably long
      if (String(qEl.value || '').trim().length >= 3) runSearch({ resetPage: true });
    });
    krajEl?.addEventListener('change', () => runSearch({ resetPage: true }));
    formaEl?.addEventListener('change', () => runSearch({ resetPage: true }));
    ukEl?.addEventListener('change', () => runSearch({ resetPage: true }));

    // initial view
    runSearch({ resetPage: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
