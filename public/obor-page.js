(function () {
  function getTagFromUrl() {
    const sp = new URLSearchParams(location.search);
    return String(sp.get('tag') || '').trim();
  }

  function safeText(el, txt) {
    if (!el) return;
    el.textContent = txt;
  }

  function hashColor(tag) {
    // Deterministic accent from tag (simple hash)
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return {
      start: `hsla(${hue}, 85%, 45%, .95)`,
      end: `hsla(${(hue + 22) % 360}, 85%, 52%, .95)`
    };
  }

  async function loadCategories() {
    try {
      const res = await fetch(`data/categories.json?_=${Date.now()}`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async function main() {
    const tag = getTagFromUrl();
    if (!tag) {
      // fallback: if no tag, show gastro as a friendly default
      location.replace('obor.html?tag=gastro');
      return;
    }

    const categories = await loadCategories();
    const cat = Array.isArray(categories?.categories)
      ? categories.categories.find((c) => String(c.tag) === tag)
      : null;

    const label = String(cat?.label || tag);
    const isco = Array.isArray(cat?.isco_prefixes) && cat.isco_prefixes.length
      ? cat.isco_prefixes.join(' / ')
      : null;

    document.title = `${label} – nabídky práce (SŠ Bor)`;

    safeText(document.querySelector('[data-role=obor-title]'), label);

    safeText(document.querySelector('[data-role=obor-sub]'), `Možnosti uplatnění · ${label}`);
    safeText(document.querySelector('[data-role=obor-tag]'), isco ? `CZ‑ISCO ${isco}` : 'CZ‑ISCO');

    // Hero gradient
    const hero = document.querySelector('[data-role=hero]');
    if (hero) {
      const c = hashColor(tag);
      hero.style.background = `linear-gradient(120deg, ${c.start} 0%, ${c.end} 100%)`;
    }

    // Wire data-target attributes for JobsLive
    const regionSel = document.querySelector('select[data-role=region]');
    if (regionSel) regionSel.setAttribute('data-target', tag);
    const loadBtn = document.querySelector('button[data-role=load]');
    if (loadBtn) loadBtn.setAttribute('data-target', tag);

    const filtersHost = document.querySelector('[data-role="filters-host"]');
    if (filtersHost) filtersHost.setAttribute('data-target', tag);

    if (window.JobsLive && typeof window.JobsLive.initOborPage === 'function') {
      window.JobsLive.initOborPage(tag, { enableFilters: true, filtersDefaultOpen: true });
    }
  }

  main();
})();
