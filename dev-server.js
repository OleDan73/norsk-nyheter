// Local test server: serves index.html and /api/news without the Vercel CLI.
const http = require('http');
const fs = require('fs');
const path = require('path');
const news = require('./api/news');

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/news')) return news(req, res);
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.statusCode = 404;
    res.end('Not found');
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
