#!/usr/bin/env node
'use strict';
// 現金收支登記 — Mac mini 後端（Node 內建模組，無框架）。路徑前綴 /cashbook
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createAuth, ensureAdminInit } = require('./auth');
const { createActions } = require('./actions');
const health = require('./health');

const PHOTO_RE = /^\/cashbook\/photo\/([0-9a-f]{32})\.jpg$/;

function makeApp(cfg, opts) {
  opts = opts || {};
  const now = opts.now || (() => new Date());
  const log = opts.log || ((s) => console.log(s));
  const db = opts.db || openDb(cfg.DATA_DIR, now);
  ensureAdminInit(db, cfg);
  const auth = createAuth(db, now);
  const actions = createActions({ db, cfg, now, auth, writePhoto: opts.writePhoto, log });
  const photoDir = path.join(cfg.DATA_DIR, 'photos');

  const cors = (req) => {
    const o = req.headers.origin;
    return o && cfg.ALLOW_ORIGIN.includes(o)
      ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' } : {};
  };
  function send(res, status, obj, headers) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }, headers || {}));
    res.end(body);
  }
  // 讀 body；超過上限回 null（把剩餘資料丟掉，不累積記憶體）
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length']);
      const chunks = []; let size = 0; let over = Number.isFinite(len) && len > limit;
      req.on('data', (c) => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; } else chunks.push(c); });
      req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  const clientIp = (req) => {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim() || '?';
    return (req.socket && req.socket.remoteAddress) || '?';
  };
  // access log：只有時間、action、ok/錯誤碼、耗時毫秒。不記通行碼、不記 body
  const access = (t0, action, out) => log(`${now().toISOString()} ${action} ${out.ok ? 'ok' : out.error} ${Date.now() - t0}ms`);

  async function handle(req, res) {
    const t0 = Date.now();
    const url = String(req.url || '').split('?')[0];
    const ch = cors(req);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, ch); return res.end(); }
      if (req.method === 'POST' && url === '/cashbook/api') {
        const buf = await readBody(req, cfg.MAX_BODY_BYTES);
        if (buf === null) { const out = { ok: false, error: 'TOO_LARGE' }; send(res, 413, out, ch); return access(t0, 'api:?', out); }
        let body = null;
        try { body = JSON.parse(buf.toString('utf8')); } catch (e) { /* 下面回 BAD_INPUT */ }
        const out = body ? actions.dispatch(body, clientIp(req)) : { ok: false, error: 'BAD_INPUT' };
        send(res, 200, out, ch);
        return access(t0, 'api:' + (body && typeof body.action === 'string' ? body.action.slice(0, 20) : '?'), out);
      }
      if (req.method === 'GET' && url === '/cashbook/health') {
        const out = health.collect(db, cfg, now);
        send(res, 200, out, ch);
        return access(t0, 'health', { ok: true });
      }
      if (req.method === 'GET') {
        const m = PHOTO_RE.exec(url);
        if (m) {
          let buf = null;
          try { buf = fs.readFileSync(path.join(photoDir, m[1] + '.jpg')); } catch (e) { /* 沒有就 404 */ }
          if (buf) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            res.end(buf);
            return access(t0, 'photo', { ok: true });
          }
        }
      }
      const out = { ok: false, error: 'NOT_FOUND' };
      send(res, 404, out, ch);
      access(t0, 'notfound', out);
    } catch (e) {
      const out = { ok: false, error: 'SERVER_ERROR' };
      try { send(res, 200, out, ch); } catch (e2) { /* 連線已斷 */ }
      log(`${now().toISOString()} error SERVER_ERROR ${Date.now() - t0}ms`);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return {
    server, db, cfg,
    listen(port, host) { return new Promise((r) => server.listen(port === undefined ? cfg.PORT : port, host || cfg.BIND, () => r(server.address()))); },
    close() { return new Promise((r) => server.close(() => { try { db.close(); } catch (e) { /* 已關 */ } r(); })); }
  };
}

module.exports = { makeApp };

if (require.main === module) {
  const cfg = loadConfig();
  const app = makeApp(cfg);
  app.listen().then((a) => console.log(`cashbook server listening on ${a.address}:${a.port}, data=${cfg.DATA_DIR}`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
