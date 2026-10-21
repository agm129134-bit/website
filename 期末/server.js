/**
 * Web Library - Node.js 本地靜態伺服器
 * 採用 Node.js 原生模組 (http, fs, path, child_process)，零依賴、免裝 npm 套件！
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 8080;
const ROOT_DIR = __dirname;

// 常用 MIME 類型對照表
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4'
};

const server = http.createServer((req, res) => {
    // 取得乾淨路徑並防止目錄穿越漏洞
    let reqUrl = decodeURI(req.url.split('?')[0]);
    let safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
    
    // 首頁預設導向 index.html
    if (safePath === '/' || safePath === '\\') {
        safePath = '/index.html';
    }

    const filePath = path.join(ROOT_DIR, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <!DOCTYPE html>
                <html lang="zh-Hant">
                <head><meta charset="UTF-8"><title>404 找不到檔案</title></head>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h2>404 找不到該頁面或資源</h2>
                    <p style="color: #64748b;">請求路徑: <code>${reqUrl}</code></p>
                    <a href="/" style="color: #2563eb; text-decoration: none;">← 回到圖書館首頁</a>
                </body>
                </html>
            `);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });

        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    const localUrl = `http://localhost:${PORT}`;
    console.log(`\n======================================================`);
    console.log(` 🚀 Web Library 個人圖書館本地伺服器已成功啟動！`);
    console.log(` 📡 訪問網址: ${localUrl}`);
    console.log(` 🌐 ACG 專頁: ${localUrl}/acg.html`);
    console.log(` ⌨️  關閉方式: 在終端機按下 Ctrl + C`);
    console.log(`======================================================\n`);

    // 自動開啟預設瀏覽器 (支援 Windows / macOS / Linux)
    const openCommand = process.platform === 'win32' ? `start ${localUrl}` : (process.platform === 'darwin' ? `open ${localUrl}` : `xdg-open ${localUrl}`);
    exec(openCommand, () => {});
});
