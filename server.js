const http = require('http');
const fs = require('fs');
const path = require('path');
const { scanNiches, runScan } = require('./scraper');

const PORT = 3777;
const ROOT = __dirname;
const MONEY_ROOT = path.join(ROOT, '..'); // ~/Projects/money — custom builds live here, one folder per business
const LEADS_FILE = path.join(ROOT, 'leads.json');
const CITIES_FILE = path.join(ROOT, 'cities.json'); // 937 US cities (25k-300k pop), state-hopping order
const ROAM_FILE = path.join(ROOT, 'roam.json'); // cursor: how far through the country we've swept

// Same default sweep as the UI's full-sweep mode — the roam endpoint needs it server-side.
const NICHES = ['handyman', 'tree service', 'fence company', 'landscaping', 'house cleaning', 'gutter cleaning', 'pressure washing', 'mobile detailing', 'pool cleaning', 'junk removal', 'painter', 'plumber', 'electrician', 'roofer', 'concrete contractor', 'appliance repair', 'locksmith', 'pest control', 'window cleaning', 'moving company'];

let scanStatus = { running: false, message: 'idle' };

function loadRoam() {
  try { return JSON.parse(fs.readFileSync(ROAM_FILE, 'utf8')); } catch { return { cursor: 0 }; }
}
function saveRoam(r) {
  fs.writeFileSync(ROAM_FILE, JSON.stringify(r));
}
function loadCities() {
  try { return JSON.parse(fs.readFileSync(CITIES_FILE, 'utf8')); } catch { return []; }
}

// Shared by manual scans and roam: merge found leads into the book, dedupe by name+phone.
function mergeLeads(found) {
  const leads = loadLeads();
  let added = 0;
  for (const f of found) {
    const key = (f.name + (f.phone || '')).toLowerCase();
    if (leads.some(l => (l.name + (l.phone || '')).toLowerCase() === key)) continue;
    leads.push({ id: Date.now() + '-' + added, status: 'new', addedAt: new Date().toISOString(), ...f });
    added++;
  }
  saveLeads(leads);
  return added;
}

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch { return []; }
}
function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
  }

  if (req.method === 'GET' && url.pathname === '/api/leads') {
    return json(res, 200, { leads: loadLeads(), scan: scanStatus });
  }

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    if (scanStatus.running) return json(res, 409, { error: 'scan already running' });
    const { niches, cities, max } = await readBody(req);
    if (!Array.isArray(niches) || !niches.length || !Array.isArray(cities) || !cities.length) {
      return json(res, 400, { error: 'niches[] and cities[] required' });
    }
    const maxPerNiche = Math.max(1, Math.min(120, parseInt(max, 10) || 20));
    scanStatus = { running: true, message: 'starting...' };
    json(res, 200, { started: true });
    try {
      const found = await scanNiches(niches, cities, maxPerNiche, m => (scanStatus.message = m),
        loadLeads().map(l => `${l.name}|${l.city || ''}`));
      const added = mergeLeads(found);
      scanStatus = { running: false, message: `done — ${added} new lead(s)` };
    } catch (e) {
      scanStatus = { running: false, message: 'error: ' + e.message };
    }
    return;
  }

  // Roam: find the NEXT N qualifying BUSINESSES, then STOP. George picks N —
  // the machine sweeps the national city list (resuming exactly where it
  // parked, even mid-city) only until it has found that many, never more.
  if (req.method === 'POST' && url.pathname === '/api/roam') {
    if (scanStatus.running) return json(res, 409, { error: 'scan already running' });
    const body = await readBody(req);
    const target = Math.max(1, Math.min(50, parseInt(body.count, 10) || 5));
    const MAX_CITIES_PER_RUN = 40; // dry-patch safety: never sweep more than this in one go
    const allCities = loadCities();
    if (!allCities.length) return json(res, 500, { error: 'cities.json missing' });
    const roam = loadRoam();
    if (roam.cursor >= allCities.length) return json(res, 200, { done: true, message: 'whole country swept — cursor at the end' });
    const batch = allCities.slice(roam.cursor, roam.cursor + MAX_CITIES_PER_RUN).map(c => `${c.city}, ${c.state}`);
    scanStatus = { running: true, message: `found 0/${target} · starting at ${batch[0]}...` };
    json(res, 200, { started: true, target });
    try {
      const r = await runScan({
        niches: NICHES, cities: batch, maxPerNiche: 20, targetLeads: target,
        startNiche: roam.niche || 0,
        onProgress: m => (scanStatus.message = m),
        knownKeys: loadLeads().map(l => `${l.name}|${l.city || ''}`),
      });
      const added = mergeLeads(r.leads);
      roam.cursor += r.cityIndex;
      roam.niche = r.nicheIndex;
      saveRoam(roam);
      const parked = allCities[roam.cursor];
      scanStatus = {
        running: false,
        message: added >= target
          ? `done — ${added} new business(es) · parked at ${parked ? parked.city + ', ' + parked.state : 'the end'}`
          : `found ${added}/${target} in a ${batch.length}-city stretch — hit the per-run limit, scan again to keep going`,
      };
    } catch (e) {
      scanStatus = { running: false, message: 'scan error: ' + e.message };
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/roam') {
    const allCities = loadCities();
    const roam = loadRoam();
    const next = allCities[roam.cursor];
    return json(res, 200, {
      cursor: roam.cursor, total: allCities.length, midCity: (roam.niche || 0) > 0,
      next: next ? `${next.city}, ${next.state}` : null,
    });
  }

  // Build = open a workspace: makes ~/Projects/money/<business-name>/ where the
  // custom site gets built by hand. Idempotent — an existing folder is fine.
  if (req.method === 'POST' && url.pathname === '/api/build') {
    const { id } = await readBody(req);
    const leads = loadLeads();
    const lead = leads.find(l => l.id === id);
    if (!lead) return json(res, 404, { error: 'lead not found' });
    const slug = lead.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return json(res, 400, { error: 'name yields empty folder name' });
    try {
      fs.mkdirSync(path.join(MONEY_ROOT, slug), { recursive: true });
      lead.site = slug;
      lead.custom = true;
      saveLeads(leads);
      return json(res, 200, { ok: true, slug });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/email') {
    const { id, email } = await readBody(req);
    const leads = loadLeads();
    const lead = leads.find(l => l.id === id);
    if (!lead) return json(res, 404, { error: 'lead not found' });
    const e = String(email || '').trim();
    if (e && !e.includes('@')) return json(res, 400, { error: 'not an email' });
    lead.email = e; // empty string clears it
    saveLeads(leads);
    return json(res, 200, { ok: true });
  }

  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
  };

  // Serve sites so George can preview them right from the dashboard:
  // /sites/<slug>/ = old template demos, /money/<slug>/ = custom builds.
  if (req.method === 'GET' && (url.pathname.startsWith('/sites/') || url.pathname.startsWith('/money/'))) {
    const custom = url.pathname.startsWith('/money/');
    const rel = decodeURIComponent(url.pathname.replace(/^\/(sites|money)\//, '')).replace(/\.\./g, '');
    let file = custom ? path.join(MONEY_ROOT, rel) : path.join(ROOT, 'sites', rel);
    if (custom && path.resolve(file) === path.resolve(MONEY_ROOT)) { res.writeHead(404); return res.end('pick a folder'); }
    if (!path.extname(file)) file = path.join(file, 'index.html');
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(body);
    } catch {
      res.writeHead(404); return res.end(custom ? 'nothing here yet — the folder is waiting for its site' : 'site not built yet');
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/status') {
    const { id, status } = await readBody(req);
    const leads = loadLeads();
    const lead = leads.find(l => l.id === id);
    if (!lead) return json(res, 404, { error: 'lead not found' });
    lead.status = status;
    saveLeads(leads);
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`Lead finder running at http://localhost:${PORT}`));
