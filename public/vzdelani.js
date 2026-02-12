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
      denni: 'Denní',
      komb: 'Kombinované',
      dalk: 'Dálkové',
      vecer: 'Večerní'
    };
    return m[k] || k;
  }

  function labelUkonceni(id) {
    const k = shortId(id);
    if (!k) return '';
    const m = {
      vyuc: 'Výuční list',
      stzk: 'Maturita',
      prij: 'Přijímací zkoušky',
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

    const runSearch = () => {
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

      const limited = hits.slice(0, 30);
      outEl.innerHTML = '';

      if (!limited.length) {
        statusEl.textContent = 'Nic nenalezeno. Zkuste kratší dotaz (např. „nástavba“, „svářeč“, „Plzeň“).';
        return;
      }

      statusEl.textContent = `Nalezeno: ${hits.length} škol (zobrazuju ${limited.length}).`;

      const html = limited
        .map((h) => createResultCard(h.s, h.programs.length ? h.programs : h.s.programs || []))
        .join('');
      outEl.innerHTML = html;
    };

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch();
    });

    qEl?.addEventListener('input', () => {
      // light debounce without timers: only run when query is reasonably long
      if (String(qEl.value || '').trim().length >= 3) runSearch();
    });
    krajEl?.addEventListener('change', runSearch);
    formaEl?.addEventListener('change', runSearch);
    ukEl?.addEventListener('change', runSearch);

    // initial view
    runSearch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
