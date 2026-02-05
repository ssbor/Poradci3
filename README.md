# MPSV Monthly Build – GitHub Pages

Automatické měsíční stažení a zpracování datasetu MPSV (volná místa) → malé JSONy pro frontend.

## Složky
- `tools/build-daily.js` – stream parser (Node 20+)
- `.github/workflows/daily-build.yml` – měsíční build + Pages deploy
- `public/index.html` – fungující UI napojené na `public/data/*.json`
- `public/ssbor-ukazka-3obory-fetch.html` – vaše stránka s doplněným fetch loaderem

## Nasazení
1. Nahrajte vše do GitHub repozitáře (branch `main`).
2. V **Settings → Pages** zvolte deploy přes GitHub Actions.
3. V **Actions** spusťte workflow *Daily MPSV Data Build* (Run workflow).
4. Po doběhu bude web dostupný v GitHub Pages (viz *Deployments*).

## Lokální náhled
```bash
npm install
npm run build    # vytvoří public/data/*.json
npm start        # http://localhost:8000
```

## Úprava kategorií (filtrování profesí)
Upravte soubor `tools/mpsv-categories.json`:
- `isco_prefixes` – seznam prefixů CZ-ISCO (matchuje se podle začátku čísel)
- `keywords` – volitelně fallback přes text v názvu profese

Skript načítá konfiguraci z `tools/mpsv-categories.json` (lze přepsat env `MPSV_CATEGORIES`).

### Jak přidat další profese (nejjednodušší postup)
1. Přidejte novou kategorii do `tools/mpsv-categories.json` (nový klíč/tag + `label` + `isco_prefixes`).
2. Spusťte `npm run build`.
3. Na webu se automaticky objeví v sekci „Další profese“ na `index.html`.

Technicky:
- Build vytváří `public/data/categories.json` (seznam dostupných kategorií).
- Pro nové profese už nemusíte vyrábět nové HTML stránky: použije se univerzální `public/obor.html?tag=...`.
