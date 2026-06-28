// mini-app-server.js — serves static files + proxies API to economy service
const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname, 'telegram-mini-app');
const ECONOMY_URL = 'http://127.0.0.1:8725';
const PORT = 8080;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Proxy API calls to economy service
  if (req.url.startsWith('/api/') || req.url.startsWith('/internal/') || req.url.startsWith('/telegram/')) {
    const target = ECONOMY_URL + req.url;
    const proxyReq = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:8725' }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end('Economy service unavailable');
    });
    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  
  // Prevent path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      filePath = path.join(STATIC_DIR, 'index.html');
      fs.readFile(filePath, (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2);
        }
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[MiniApp] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[MiniApp] Proxying /api/ to ${ECONOMY_URL}`);
});
