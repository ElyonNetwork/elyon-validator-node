// v7.8.0 — Simple Admin Panel (port 5000)
//
// Minimal admin view for the admin node — only the four tabs the user
// asked for: Explorer, Nodes, Send Default Token, Staking Packages.
// Everything else (PoS conversion, APOS deployment, package creation,
// etc.) stays on the full admin at port 3000. Apple.com visual style.
//
// v7.11.16 — exports a `wireConfigRoute(app)` helper so the main
// port-3000 server can mount /api/simple-admin/config under its own
// router. /api/proxy/* is intentionally NOT shared with the main app
// because operator-panel.js already registers an identical handler
// there — duplicating the route on the same Express instance would
// just shadow it. The simple-admin HTML is happy with whichever
// /api/proxy handler answers first.

'use strict';

const express = require('express');
const path    = require('path');

const SIMPLE_ADMIN_PORT = parseInt(process.env.SIMPLE_ADMIN_PORT || '5000', 10);

function wireConfigRoute(app) {
  app.get('/api/simple-admin/config', (req, res) => {
    res.json({
      localApiBase: '',
      version: process.env.IMAGE_VERSION || 'dev',
    });
  });
}

function init(ctx) {
  const { localApiPort = 3000, log = console.log } = ctx || {};
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public', 'simple-admin')));
  wireConfigRoute(app);

  // Standalone :5000 server has its own /api/proxy/* (the main :3000
  // app uses operator-panel's identical handler).
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

  app.listen(SIMPLE_ADMIN_PORT, '0.0.0.0', () => {
    log(`  Simple admin:   http://0.0.0.0:${SIMPLE_ADMIN_PORT}  (proxy → :${localApiPort})`);
  });
}

module.exports = { init, wireConfigRoute };
