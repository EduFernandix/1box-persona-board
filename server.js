// 1Box Persona Board — tiny server: static page + JSON API, data in one file on a volume.
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA = path.join(DATA_DIR, 'board.json');
const PUB = path.join(__dirname, 'public');
const MAX_COMMENTS = 5000, MAX_TEXT = 2000, MAX_NAME = 60;
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = { reviews: {}, comments: {} };
try { state = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (_) {}
let writing = Promise.resolve();
function save() { writing = writing.then(() => fs.promises.writeFile(DATA + '.tmp', JSON.stringify(state)).then(() => fs.promises.rename(DATA + '.tmp', DATA))).catch(e => console.error('save', e)); return writing; }
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.js': 'text/javascript' };
const ASSET = /^[a-z0-9_-]{1,40}$/i, STATUS = new Set(['pending', 'approved', 'adjust', 'redo']);
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); }); }
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') { const comments = {}; for (const [k, v] of Object.entries(state.comments)) { const { tokenHash, ...pub } = v; comments[k] = pub; } return json(res, 200, { reviews: state.reviews, comments }); }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      const b = await body(req); const asset = clean(b.asset, 40), status = clean(b.status, 20);
      if (!ASSET.test(asset) || !STATUS.has(status)) return json(res, 400, { error: 'bad request' });
      state.reviews[asset] = { status, by: clean(b.by, MAX_NAME), updatedAt: new Date().toISOString() };
      await save(); return json(res, 200, { ok: true, review: state.reviews[asset] });
    }
    if (url.pathname === '/api/comment' && req.method === 'POST') {
      const b = await body(req); const asset = clean(b.asset, 40), text = clean(b.text, MAX_TEXT), author = clean(b.author, MAX_NAME), token = clean(b.token, 64);
      if (!ASSET.test(asset) || !text) return json(res, 400, { error: 'bad request' });
      if (Object.keys(state.comments).length >= MAX_COMMENTS) return json(res, 507, { error: 'comment limit reached' });
      const id = crypto.randomBytes(8).toString('hex');
      state.comments[id] = { asset, text, author: author || 'Someone', tokenHash: token ? crypto.createHash('sha256').update(token).digest('hex') : null, createdAt: new Date().toISOString() };
      await save(); const { tokenHash, ...pub } = state.comments[id]; return json(res, 200, { ok: true, id, comment: pub });
    }
    const m = url.pathname.match(/^\/api\/comment\/([a-f0-9]{16})$/);
    if (m && req.method === 'DELETE') {
      const b = await body(req); const c = state.comments[m[1]]; if (!c) return json(res, 404, { error: 'not found' });
      const h = b.token ? crypto.createHash('sha256').update(clean(b.token, 64)).digest('hex') : null;
      if (!c.tokenHash || h !== c.tokenHash) return json(res, 403, { error: 'only the author can delete this comment' });
      delete state.comments[m[1]]; await save(); return json(res, 200, { ok: true });
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
