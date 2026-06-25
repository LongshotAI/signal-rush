#!/usr/bin/env node
/**
 * Signal Rush — Zero-Dependency Reverse Proxy
 * 
 * Proxies all HTTP traffic from :8080 → :8720 (economy service).
 * No external packages needed — uses only Node.js built-in http module.
 * 
 * Handles: landing page, login, signup, portal, mini-app, API, static files.
 * 
 * Usage: node scripts/reverse-proxy.js
 * 
 * For production (port 80/443):
 *   sudo setcap 'cap_net_bind_service=+ep' $(which node)
 *   Then change PROXY_PORT to 80 (or 443 with SSL)
 */

const http = require('http');

const PROXY_PORT = parseInt(process.env.PROXY_PORT) || 8080;
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT) || 8720;

const server = http.createServer((req, res) => {
  // Health check endpoint (don't proxy)
  if (req.url === '/proxy-health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      proxy: true,
      target: `${TARGET_HOST}:${TARGET_PORT}`,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Build proxy request options
  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`,
    },
  };

  // Create upstream request
  const proxyReq = http.request(options, (proxyRes) => {
    // Copy response headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // Pipe response body
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[proxy error] ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Service unavailable',
        detail: 'Economy service is not running on port ' + TARGET_PORT,
        hint: 'Start it with: node economy/service.js',
      }));
    }
  });

  // Pipe request body to upstream
  req.pipe(proxyReq, { end: true });
});

// Handle client errors
server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Signal Rush — Reverse Proxy');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Listening:  http://0.0.0.0:${PROXY_PORT}`);
  console.log(`  Target:     http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`  Health:     http://localhost:${PROXY_PORT}/proxy-health`);
  console.log('');
  console.log('  Routes served:');
  console.log('    /                  → Landing page');
  console.log('    /portal/*          → Advertiser portal + API');
  console.log('    /mini-app/*        → Telegram mini-app (game)');
  console.log('    /portal/signup     → Account creation');
  console.log('    /portal/login      → Account login');
  console.log('═══════════════════════════════════════════════════');
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down proxy...`);
  server.close(() => {
    console.log('Proxy stopped.');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
