// SKU Compositor — zero-dependency Node server
// Serves the frontend and proxies: Azure OpenAI image edits, image fetching (CORS), TinyPNG compression.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Invalid data URL');
  return { type: m[1] || 'application/octet-stream', buf: Buffer.from(m[3], m[2] ? 'base64' : 'utf8') };
}

// ---- API handlers ----

// GET /api/fetch-image?url=<encoded> — proxy remote images so the canvas isn't tainted and CORS doesn't block.
async function handleFetchImage(req, res, urlObj) {
  const target = urlObj.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return sendJSON(res, 400, { error: 'Provide a valid http(s) url param' });
  try {
    const upstream = await fetch(target, { redirect: 'follow' });
    if (!upstream.ok) return sendJSON(res, 502, { error: `Upstream ${upstream.status} for ${target}` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    sendJSON(res, 502, { error: `Failed to fetch image: ${e.message}` });
  }
}

// POST /api/generate — { endpoint, apiKey, prompt, images: [dataURL, ...] }
// Calls Azure OpenAI /openai/v1/images/edits with model gpt-image-2, background auto, quality low.
async function handleGenerate(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }

  const { endpoint, apiKey, prompt, images, quality = 'low', background = 'auto' } = body || {};
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return sendJSON(res, 400, { error: 'Missing/invalid Azure endpoint' });
  if (!apiKey) return sendJSON(res, 400, { error: 'Missing Azure API key' });
  if (!prompt) return sendJSON(res, 400, { error: 'Missing prompt' });
  if (!Array.isArray(images) || images.length === 0) return sendJSON(res, 400, { error: 'No images provided' });

  // Accept either a bare resource URL or a full API URL pasted from the Azure portal —
  // keep only the origin, then append the edits path.
  const url = new URL(endpoint).origin + '/openai/v1/images/edits';
  const fd = new FormData();
  fd.append('model', 'gpt-image-2');
  fd.append('prompt', prompt);
  fd.append('background', background);
  fd.append('quality', quality);
  images.forEach((dataUrl, i) => {
    const { buf } = dataUrlToBuffer(dataUrl);
    fd.append('image[]', new Blob([buf], { type: 'image/png' }), `image_${i}.png`);
  });

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 2000) }; }
    if (!upstream.ok) {
      const msg = json?.error?.message || json?.error || `Azure returned ${upstream.status}`;
      console.error(`[generate] Azure error ${upstream.status} from ${url}:`, text.slice(0, 1000));
      return sendJSON(res, upstream.status, { error: msg });
    }
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) return sendJSON(res, 502, { error: 'Azure response missing image data' });
    sendJSON(res, 200, { b64 });
  } catch (e) {
    sendJSON(res, 502, { error: `Azure request failed: ${e.message}` });
  }
}

// POST /api/compress — raw PNG body, header x-tinify-key. Returns compressed image bytes.
async function handleCompress(req, res) {
  const key = req.headers['x-tinify-key'];
  if (!key) return sendJSON(res, 400, { error: 'Missing x-tinify-key header' });
  let png;
  try { png = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  if (!png.length) return sendJSON(res, 400, { error: 'Empty body' });

  const auth = 'Basic ' + Buffer.from('api:' + key).toString('base64');
  try {
    const shrink = await fetch('https://api.tinify.com/shrink', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const meta = await shrink.json().catch(() => ({}));
    if (!shrink.ok) {
      console.error(`[compress] TinyPNG error ${shrink.status}:`, JSON.stringify(meta).slice(0, 500));
      return sendJSON(res, shrink.status, { error: meta?.message || `TinyPNG returned ${shrink.status}` });
    }
    const outUrl = shrink.headers.get('location') || meta?.output?.url;
    if (!outUrl) return sendJSON(res, 502, { error: 'TinyPNG response missing output URL' });
    const dl = await fetch(outUrl, { headers: { 'Authorization': auth } });
    if (!dl.ok) return sendJSON(res, 502, { error: `TinyPNG download failed (${dl.status})` });
    const buf = Buffer.from(await dl.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Input-Size': String(png.length),
      'X-Output-Size': String(buf.length),
    });
    res.end(buf);
  } catch (e) {
    sendJSON(res, 502, { error: `TinyPNG request failed: ${e.message}` });
  }
}

// ---- Static files ----
function serveStatic(req, res, urlObj) {
  let p = decodeURIComponent(urlObj.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (urlObj.pathname === '/api/fetch-image' && req.method === 'GET') return await handleFetchImage(req, res, urlObj);
    if (urlObj.pathname === '/api/generate' && req.method === 'POST') return await handleGenerate(req, res);
    if (urlObj.pathname === '/api/compress' && req.method === 'POST') return await handleCompress(req, res);
    if (req.method === 'GET') return serveStatic(req, res, urlObj);
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`SKU Compositor running at http://localhost:${PORT}`);
});
