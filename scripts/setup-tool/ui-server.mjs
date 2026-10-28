// Loopback-only server for the setup window. Nothing secret is served: it exposes the engine's progress and nothing else.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setupCopy, pickLanguage } from './copy.mjs';

const TYPES = { '/': ['ui.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/ui.js': ['ui.js', 'application/javascript; charset=utf-8'], '/logo.png': ['logo.png', 'image/png'] };

export function createUiServer({ engine, assets, onClose = () => {} }) {
  const token = randomBytes(24).toString('base64url');
  const server = createServer(async (req, res) => {
    const origin = `127.0.0.1:${server.address().port}`;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (req.headers.host !== origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { ok: false });
    const url = new URL(req.url, 'http://' + origin);
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)scb_setup=([A-Za-z0-9_-]{32})(?:;|$)/)?.[1];
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('k') === token) res.setHeader('Set-Cookie', `scb_setup=${token}; HttpOnly; SameSite=Strict; Path=/`);
    else if (cookie !== token) return send(403, { ok: false });
    if (req.method === 'GET' && TYPES[url.pathname]) {
      const [name, type] = TYPES[url.pathname];
      res.writeHead(200, { 'Content-Type': type });
      return res.end(name === 'logo.png' ? Buffer.from(assets[name], 'base64') : assets[name]);
    }
    const view = () => ({ ok: true, state: engine.snapshot(), copy: setupCopy(pickLanguage(url.searchParams.get('lang') || 'en')) });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, view());
    if (req.method !== 'POST' || !['/api/retry', '/api/close'].includes(url.pathname) || req.headers['x-scb-setup'] !== '1'
      || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(403, { ok: false });
    if (url.pathname === '/api/retry') { void engine.retry(); return send(200, view()); }
    send(200, { ok: true }); setTimeout(onClose, 50);
  });
  return {
    server, token,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/?k=${token}`))),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
