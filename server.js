// 1Box Persona Board — tiny server: static page + JSON API, data in one file on a volume.
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA = path.join(DATA_DIR, 'board.json');
const PUB = path.join(__dirname, 'public');
const MAX_COMMENTS = 5000, MAX_TEXT = 2000, MAX_NAME = 60;
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = { reviews: {}, comments: {} };
function load() { try { const s = JSON.parse(fs.readFileSync(DATA, 'utf8')); if (s && s.reviews && s.comments) state = s; } catch (_) {} return state; }
load();
let writing = Promise.resolve();
const clients = new Set();
function publicState() { const comments = {}; for (const [k, v] of Object.entries(state.comments)) { const { tokenHash, ...pub } = v; comments[k] = pub; } return { reviews: state.reviews, comments }; }
function broadcast() { const data = 'event: state\ndata: ' + JSON.stringify(publicState()) + '\n\n'; for (const res of clients) { try { res.write(data); } catch (_) { clients.delete(res); } } }
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (_) { clients.delete(res); } } }, 20000);
// every write: re-read the file (source of truth), apply the change, write atomically, then push to clients
function mutate(fn) { const p = writing.then(async () => { load(); const out = fn(state); await fs.promises.writeFile(DATA + '.tmp', JSON.stringify(state)); await fs.promises.rename(DATA + '.tmp', DATA); broadcast(); return out; }); writing = p.catch(e => console.error('save', e)); return p; }
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.js': 'text/javascript' };
const ASSET = /^[a-z0-9_-]{1,40}$/i, STATUS = new Set(['pending', 'approved', 'adjust', 'redo']);
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); }); }
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
let lastSize = -1; setInterval(() => { try { const st = fs.statSync(DATA); const sig = st.size + ':' + st.mtimeMs; if (sig !== lastSize) { lastSize = sig; load(); broadcast(); } } catch (_) {} }, 2000);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') { load(); return json(res, 200, publicState()); }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
      load(); res.write('retry: 2000\n\n'); res.write('event: state\ndata: ' + JSON.stringify(publicState()) + '\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      const b = await body(req); const asset = clean(b.asset, 40), status = clean(b.status, 20);
      if (!ASSET.test(asset) || !STATUS.has(status)) return json(res, 400, { error: 'bad request' });
      const review = await mutate(st => { st.reviews[asset] = { status, by: clean(b.by, MAX_NAME), updatedAt: new Date().toISOString() }; return st.reviews[asset]; });
      return json(res, 200, { ok: true, review });
    }
    if (url.pathname === '/api/comment' && req.method === 'POST') {
      const b = await body(req); const asset = clean(b.asset, 40), text = clean(b.text, MAX_TEXT), author = clean(b.author, MAX_NAME), token = clean(b.token, 64);
      if (!ASSET.test(asset) || !text) return json(res, 400, { error: 'bad request' });
      const id = crypto.randomBytes(8).toString('hex');
      const out = await mutate(st => { if (Object.keys(st.comments).length >= MAX_COMMENTS) return null;
        st.comments[id] = { asset, text, author: author || 'Someone', tokenHash: token ? crypto.createHash('sha256').update(token).digest('hex') : null, createdAt: new Date().toISOString() };
        const { tokenHash, ...pub } = st.comments[id]; return pub; });
      if (!out) return json(res, 507, { error: 'comment limit reached' });
      return json(res, 200, { ok: true, id, comment: out });
    }
    const m = url.pathname.match(/^\/api\/comment\/([a-f0-9]{16})$/);
    if (m && req.method === 'DELETE') {
      const b = await body(req); const h = b.token ? crypto.createHash('sha256').update(clean(b.token, 64)).digest('hex') : null;
      const r = await mutate(st => { const c = st.comments[m[1]]; if (!c) return 404; if (!c.tokenHash || h !== c.tokenHash) return 403; delete st.comments[m[1]]; return 200; });
      if (r === 404) return json(res, 404, { error: 'not found' }); if (r === 403) return json(res, 403, { error: 'only the author can delete this comment' });
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // static
    let p = decodeURIComponent(url.pathname); if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(PUB, p)); if (!file.startsWith(PUB)) return json(res, 403, { error: 'forbidden' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log('persona board on', PORT, 'data', DATA));
