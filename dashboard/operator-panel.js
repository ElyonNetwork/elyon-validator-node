// v7.8.0 — Operator Panel (port 4000)
//
// Simplified panel for end users that want to join the network as a node
// operator. Hardcoded to https://admintestnet.elyon.network — no admin URL
// input, no chain creation, no PoS conversion. Three tabs only: Explorer,
// Join Network, Node Info. Apple.com visual style.
//
// This Express app runs in the SAME Node process as the main dashboard
// (server.js). It proxies most API calls to the local port-3000 backend.
// Wallet authentication is MetaMask-style (eth_requestAccounts) — the
// user signs a nonce to log in instead of typing an admin password.
//
// v7.11.16 — exports a `wireRoutes(app, ctx)` helper so the main port-3000
// server can mount the same three API endpoints (/api/operator/config,
// /api/proxy/*, /api/admin-proxy/*) under its own router. That lets
// /node (served from :3000) talk to its backend without the browser
// needing :4000 to be reachable.

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

// v7.35 — ADMIN_URL env override. Server-side fetches to the admin (bootstrap,
// relayer-attestation forwarding) must bypass Cloudflare Bot Fight Mode, which
// 403s machine-to-machine requests to the CF-proxied hostname. Point this at
// the admin's raw origin (e.g. http://72.144.161.171:3000) so the operator can
// reach it directly. Falls back to the public hostname when unset.
const DEFAULT_ADMIN_URL = process.env.ADMIN_URL || 'https://admintestnet.elyon.network';
const OPERATOR_PORT     = parseInt(process.env.OPERATOR_PANEL_PORT || '4000', 10);

function wireRoutes(app, ctx) {
  const { localApiPort = 3000 } = ctx || {};

  app.get('/api/operator/config', (req, res) => {
    res.json({
      adminUrl: DEFAULT_ADMIN_URL,
      localApiBase: '',
      version: process.env.IMAGE_VERSION || 'dev',
    });
  });

  app.all('/api/proxy/*', async (req, res) => {
    const upstreamPath = req.url.replace(/^\/api\/proxy/, '');
    const url = `http://127.0.0.1:${localApiPort}${upstreamPath}`;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      const opts = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        opts.body = JSON.stringify(req.body || {});
      }
      const r = await fetch(url, opts);
      const text = await r.text();
      res.status(r.status);
      try { res.json(JSON.parse(text)); }
      catch { res.type('text/plain').send(text); }
    } catch (e) {
      res.status(502).json({ error: 'upstream unreachable: ' + e.message });
    }
  });

  app.all('/api/admin-proxy/*', async (req, res) => {
    const upstreamPath = req.url.replace(/^\/api\/admin-proxy/, '');
    const url = DEFAULT_ADMIN_URL.replace(/\/+$/, '') + upstreamPath;
    try {
      const opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        opts.body = JSON.stringify(req.body || {});
      }
      const r = await fetch(url, opts);
      const text = await r.text();
      res.status(r.status);
      try { res.json(JSON.parse(text)); }
      catch { res.type('text/plain').send(text); }
    } catch (e) {
      res.status(502).json({ error: 'admin node unreachable: ' + e.message });
    }
  });
}

function init(ctx) {
  const { log = console.log } = ctx || {};
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public', 'operator')));
  wireRoutes(app, ctx);
  app.listen(OPERATOR_PORT, '0.0.0.0', () => {
    log(`  Operator panel: http://0.0.0.0:${OPERATOR_PORT}  (defaults to admin ${DEFAULT_ADMIN_URL})`);
  });
}

module.exports = { init, wireRoutes };
