import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/[...slug].js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const server = http.createServer((req, res) => {
  // Ensure res.status method exists (used by API handler)
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Handle CORS preflight globally if needed
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-admin');
    res.statusCode = 204;
    res.end();
    return;
  }

  // Handle API and Health endpoints
  if (pathname.startsWith('/api/') || pathname === '/health') {
    let bodyData = '';
    req.on('data', (chunk) => {
      bodyData += chunk;
    });
    req.on('end', async () => {
      if (bodyData) {
        try {
          req.body = JSON.parse(bodyData);
        } catch {
          req.body = bodyData;
        }
      } else {
        req.body = {};
      }
      try {
        await handler(req, res);
      } catch (err) {
        console.error('API Handler Error:', err);
        if (!res.headersSent) {
          res.status(500).setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
        }
      }
    });
    return;
  }

  // Serve static files from /public
  let filePath = path.join(__dirname, 'public', pathname);
  if (pathname === '/' || pathname === '') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else if (pathname === '/admin' || pathname === '/admin/') {
    filePath = path.join(__dirname, 'public', 'admin.html');
  } else if (pathname === '/studio' || pathname === '/studio/') {
    filePath = path.join(__dirname, 'public', 'studio.html');
  } else if (pathname === '/pricing' || pathname === '/pricing/') {
    filePath = path.join(__dirname, 'public', 'pricing.html');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const altPath = filePath + '.html';
      if (fs.existsSync(altPath)) {
        filePath = altPath;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Doom AI Cinema Studio running at http://localhost:${PORT}`);
  console.log(`   - Home:      http://localhost:${PORT}/`);
  console.log(`   - Studio:    http://localhost:${PORT}/studio`);
  console.log(`   - Pricing:   http://localhost:${PORT}/pricing`);
  console.log(`   - Admin:     http://localhost:${PORT}/admin\n`);
});
