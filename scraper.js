const { chromium } = require('playwright-core');

const MIN_RATING = 3.5;
const MIN_REVIEWS = 50;
const FRANCHISE_RE = /(1-800|got.?junk|keyme|mr\.?\s?(handyman|rooter|electric|appliance)|the maids|molly maid|maidpro|merry maids|servpro|stanley steemer|roto.?rooter|college hunks|two men and a truck|kaminskiy|ace handyman|handyman connection|benjamin franklin plumbing|one hour (heating|air)|aire serv|rainbow (restoration|international)|puroclean|servicemaster|chem.?dry|coit|tru.?green|lawn doctor|weed man|davey tree|savatree|monster tree|junk king|junkluggers|window genie|men in kilts|shack shine|bath fitter|re.?bath|california closets|closet factory|precision (garage|door)|overhead door|a1 garage|pop.?a.?lock|jiffy lube|midas|meineke|maaco|christian brothers automotive|grease monkey|valvoline|firestone|goodyear|les schwab|rolling suds|handyman matters|neighborly|mosquito (joe|squad)|pest authority|orkin|terminix|aptive|moxie pest)/i;

async function countSameName(page, name) {
  const q = encodeURIComponent(`"${name}"`);
  await page.goto(`https://www.google.com/maps/search/${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const onPlacePage = await page.evaluate(() => !document.querySelector('div[role="feed"]'));
  if (onPlacePage) return 1;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = await page.$$eval('div[role="feed"] .Nv2PK', cards =>
    cards.map(c => c.querySelector('.qBF1Pd')?.textContent?.trim()
      || c.querySelector('a.hfpxzc')?.getAttribute('aria-label') || ''));
  return names.filter(n => norm(n) === norm(name)).length || 1;
}

async function loadResults(page, target) {
  let last = 0, stagnant = 0;
  while (true) {
    const count = await page.$$eval('div[role="feed"] .Nv2PK', c => c.length);
    if (count >= target || stagnant >= 3) return count;
    const ended = await page.evaluate(() => {
      const f = document.querySelector('div[role="feed"]');
      if (!f) return true;
      f.scrollTo(0, f.scrollHeight);
      return /reached the end/i.test(f.innerText);
    });
    if (ended) return count;
    await page.waitForTimeout(900);
    stagnant = count === last ? stagnant + 1 : 0;
    last = count;
  }
}

// Core scan loop. `targetLeads` makes it lead-driven: it sweeps city-by-city,
// niche-by-niche, and STOPS the moment it has found that many new businesses —
// returning exactly where it parked (cityIndex/nicheIndex) so the next run
// resumes mid-city without rescanning or skipping anything.
async function runScan({ niches, cities, maxPerNiche, onProgress, knownKeys = [], targetLeads = Infinity, startNiche = 0 }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  const leads = [];
  const seen = new Set(knownKeys.map(k => k.toLowerCase().trim()));
  const finite = Number.isFinite(targetLeads);
  const say = m => onProgress(finite ? `found ${leads.length}/${targetLeads} · ${m}` : m);
  let pos = { cityIndex: 0, nicheIndex: 0 };
  try {
    for (let ci = 0; ci < cities.length; ci++) {
      const city = cities[ci];
      for (let ni = ci === 0 ? startNiche : 0; ni < niches.length; ni++) {
        const niche = niches[ni];
        // park position = the NEXT (city, niche) to scan after this one
        pos = ni + 1 < niches.length ? { cityIndex: ci, nicheIndex: ni + 1 } : { cityIndex: ci + 1, nicheIndex: 0 };
        say(`Scanning "${niche}" in ${city}...`);
        const q = encodeURIComponent(`${niche} ${city}`);
        await page.goto(`https://www.google.com/maps/search/${q}`, { waitUntil: 'domcontentloaded' });
        try {
          await page.waitForSelector('div[role="feed"] .Nv2PK', { timeout: 15000 });
        } catch {
          say(`No results panel for "${niche}" in ${city}, skipping`);
          continue;
        }
        await loadResults(page, maxPerNiche);
        await page.waitForTimeout(600);
        const candidates = await page.$$eval('div[role="feed"] .Nv2PK', cards =>
          cards.map(card => {
            const link = card.querySelector('a.hfpxzc');
            const name = card.querySelector('.qBF1Pd')?.textContent?.trim()
              || link?.getAttribute('aria-label') || '';
            const starsLabel = card.querySelector('span[role="img"]')?.getAttribute('aria-label') || '';
            const rating = parseFloat((starsLabel.match(/(\d\.\d)/) || [])[1] || '') || null;
            const hasWebsite = !!card.querySelector('a[data-value="Website"]');
            const phone = ((card.innerText || '').match(/\(\d{3}\)\s?\d{3}-\d{4}/) || [null])[0];
            return { name, rating, hasWebsite, phone, href: link?.href || null };
          })
        );
        const key = n => `${n}|${city}`.toLowerCase().trim();
        const shortlist = candidates
          .slice(0, maxPerNiche)
          .filter(c => c.name && !c.hasWebsite && c.rating && c.rating >= MIN_RATING && c.href
            && !FRANCHISE_RE.test(c.name)
            && !seen.has(key(c.name)));
        for (const c of shortlist) {
          seen.add(key(c.name));
          say(`Checking "${c.name}" (${city})...`);
          await page.goto(c.href, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1500);
          const detail = await page.evaluate(() => {
            const text = document.body.innerText || '';
            const reviews = parseInt(((text.match(/([\d,]+)\s+reviews/i) || [])[1] || '').replace(/,/g, ''), 10) || 0;
            const phone = (text.match(/\(\d{3}\)\s?\d{3}-\d{4}/) || [null])[0];
            const addr = document.querySelector('button[data-item-id="address"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/, '') || null;
            const hasWebsite = !!document.querySelector('a[data-item-id="authority"]');
            return { reviews, phone, addr, hasWebsite };
          });
          if (detail.hasWebsite || detail.reviews < MIN_REVIEWS) continue;
          say(`Chain check "${c.name}"...`);
          const locations = await countSameName(page, c.name);
          if (locations >= 3) {
            say(`"${c.name}" looks like a chain (${locations} locations), skipping`);
            continue;
          }
          leads.push({
            name: c.name,
            rating: c.rating,
            reviews: detail.reviews,
            hasWebsite: false,
            phone: detail.phone || c.phone,
            address: detail.addr,
            niche, city
          });
          if (leads.length >= targetLeads) break; // got what George asked for
        }
        if (leads.length >= targetLeads) {
          return { leads, ...pos, done: false };
        }
      }
    }
    return { leads, cityIndex: cities.length, nicheIndex: 0, done: true };
  } finally {
    await browser.close();
  }
}

// Legacy shape: sweep everything given, return just the leads.
async function scanNiches(niches, cities, maxPerNiche, onProgress, knownKeys = []) {
  const r = await runScan({ niches, cities, maxPerNiche, onProgress, knownKeys });
  return r.leads;
}

module.exports = { scanNiches, runScan };
