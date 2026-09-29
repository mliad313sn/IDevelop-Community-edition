'use strict';
// Minimal static server for previewing QA-TEST-PLAN.html (no deps).
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 8077;
http.createServer((req, res) => {
    let f = req.url === '/' ? '/QA-TEST-PLAN.html' : req.url;
    const p = path.join(__dirname, decodeURIComponent(f.split('?')[0]));
    fs.readFile(p, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('not found');
        }
        const ext = path.extname(p).toLowerCase();
        const ct =
            ext === '.html' ? 'text/html' : ext === '.json' ? 'application/json' : 'text/plain';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
    });
}).listen(PORT, () => console.log('QA preview on http://localhost:' + PORT));
