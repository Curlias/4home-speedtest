const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RESULTS = process.env.RESULTS_PATH || path.join(__dirname, 'results.jsonl');
const INDEX = fs.readFileSync(path.join(__dirname, 'public/index.html'));
const LOGO = fs.readFileSync(path.join(__dirname, 'public/logo.svg'));
// Where this server actually runs (egress IP geolocation), shown as "<city> · 4HOME" and on the map.
let serverLoc = null;
async function whereAmI() {
  if (serverLoc) return serverLoc;
  try {
    const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
    const [lat, lon] = (r.loc || '').split(',').map(Number);
    if (r.city && Number.isFinite(lat)) serverLoc = { city: r.city, region: r.region, country: r.country, lat, lon };
  } catch {}
  return serverLoc; // null → retried on the next request
}
whereAmI();
const serverName = () => serverLoc ? `${serverLoc.city} · 4HOME` : '4HOME';
const CHUNK = crypto.randomBytes(1 << 20); // random = incompressible
const MAX_DOWN = 100 << 20, MAX_UP = 100 << 20;

// Ports worth knowing from the ISP side: exposed services, CPE management, CGNAT hints
const PORTS = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 53: 'DNS', 80: 'HTTP', 443: 'HTTPS',
  445: 'SMB', 554: 'RTSP (cámaras)', 1723: 'PPTP', 3389: 'RDP', 5060: 'SIP',
  7547: 'TR-069 (CPE)', 8080: 'HTTP alt', 8291: 'Winbox MikroTik', 8443: 'HTTPS alt',
};

function clientIp(req) {
  const ip = (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  return ip.replace(/^::ffff:/, '');
}

function probe(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = state => { s.destroy(); resolve(state); };
    s.setTimeout(timeout, () => done('filtrado'));
    s.once('connect', () => done('abierto'));
    s.once('error', e => done(e.code === 'ECONNREFUSED' ? 'cerrado' : 'filtrado'));
  });
}

// ponytail: in-memory per-IP limiter, resets on restart; fine for one instance
const lastScan = new Map();

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function ensureResultsDir() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }

    if (url.pathname === '/logo.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      return res.end(LOGO);
    }

    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, server: serverName() });
    }

    if (url.pathname === '/__down') {
      let left = Math.min(Math.max(0, +url.searchParams.get('bytes') || 0), MAX_DOWN);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': left, 'Cache-Control': 'no-store', 'Content-Encoding': 'identity' });
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, CHUNK.length);
          left -= n;
          if (!res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n))) return res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }

    if (url.pathname === '/__up' && req.method === 'POST') {
      let size = 0;
      req.on('data', c => { size += c.length; if (size > MAX_UP) req.destroy(); });
      req.on('end', () => json(res, 200, { bytes: size }));
      return;
    }

    if (url.pathname === '/api/ip') {
      const loc = await whereAmI();
      return json(res, 200, { ip, v6: ip.includes(':'), server: serverName(), serverLoc: loc });
    }

    if (url.pathname === '/api/ports') {
      // Only ever scans the requester's own IP.
      const now = Date.now();
      if (now - (lastScan.get(ip) || 0) < 30_000) return json(res, 429, { error: 'Espera 30 s entre escaneos' });
      lastScan.set(ip, now);
      const entries = await Promise.all(Object.entries(PORTS).map(async ([p, name]) => ({ port: +p, name, state: await probe(ip, +p) })));
      return json(res, 200, { ip, ports: entries });
    }

    if (url.pathname === '/api/result' && req.method === 'POST') {
      const data = JSON.parse(await readBody(req, 64 << 10));
      const id = crypto.randomBytes(4).toString('hex').toUpperCase();
      const rec = { id, at: new Date().toISOString(), ip, ua: req.headers['user-agent'], data };
      ensureResultsDir();
      fs.appendFileSync(RESULTS, JSON.stringify(rec) + '\n');
      return json(res, 200, { id });
    }

    const m = url.pathname.match(/^\/api\/result\/([0-9A-F]{8})$/);
    if (m) {
      // ponytail: linear scan of a jsonl file; move to SQLite when it gets big
      const line = fs.existsSync(RESULTS) && fs.readFileSync(RESULTS, 'utf8').split('\n').find(l => l.includes(`"id":"${m[1]}"`));
      return line ? json(res, 200, JSON.parse(line)) : json(res, 404, { error: 'No encontrado' });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`4HOME speedtest en http://localhost:${PORT}`));
