(function () {
  const KNOWN = new Set(['auto', 'agri', 'gastro']);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, String(v));
      }
    }
    if (Array.isArray(children)) children.forEach((c) => node.appendChild(c));
    else if (typeof children === 'string') node.textContent = children;
    return node;
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
    const host = document.getElementById('obory-dalsi');
    if (!host) return;

    const data = await loadCategories();
    const cats = Array.isArray(data?.categories) ? data.categories : [];

    const extra = cats.filter((c) => c && !KNOWN.has(String(c.tag)));
    if (!extra.length) {
      host.appendChild(el('div', { class: 'muted col-12' }, 'Zatím nejsou přidané žádné další profese.'));
      return;
    }

    extra
      .sort((a, b) => String(a.label || a.tag).localeCompare(String(b.label || b.tag), 'cs'))
      .forEach((c) => {
        const tag = String(c.tag || '').trim();
        if (!tag) return;
        const label = String(c.label || tag);
        const prefixes = Array.isArray(c.isco_prefixes) ? c.isco_prefixes : [];
        const subtitle = prefixes.length ? `CZ‑ISCO: ${prefixes.join(' / ')}` : 'CZ‑ISCO: —';

        const card = el('div', { class: 'card col-4' }, [
          el('h3', null, label),
          el('p', { class: 'muted' }, subtitle),
          el('div', { style: 'margin-top: .9rem' }, [
            el('a', { class: 'btn btn--primary', href: `obor.html?tag=${encodeURIComponent(tag)}` }, 'Otevřít obor')
          ])
        ]);
        host.appendChild(card);
      });
  }

  main();
})();
