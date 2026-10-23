/**
 * Web Library - 期末專案專屬本地伺服器
 * 採用 Node.js 原生模組 (http, fs, path, child_process)，零依賴、免裝 npm 套件！
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { handleKazumiRoute } = require('./api/kazumi');
const { handleMangaRoute } = require('./api/manga');
const { handleNovelRoute } = require('./api/novel');
const { handleSyncRoute } = require('./api/sync');

// 期末專案使用 8000 端口（避開 Open WebUI 的 3000 與課堂的 8080）
let currentPort = process.env.PORT || 8000;
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
    // 優先攔截 /api/kazumi 動漫後端模組路由
    if (req.url.startsWith('/api/kazumi')) {
        return handleKazumiRoute(req, res);
    }

    // 攔截 /api/manga Tachimanga 條漫後端模組路由
    if (req.url.startsWith('/api/manga')) {
        return handleMangaRoute(req, res);
    }

    // 攔截 /api/novel Legado 沉浸小說後端模組路由
    if (req.url.startsWith('/api/novel')) {
        return handleNovelRoute(req, res);
    }

    // 攔截 /api/user 與 /api/bangumi 跨裝置同步與雙向同步路由
    if (req.url.startsWith('/api/user') || req.url.startsWith('/api/bangumi')) {
        return handleSyncRoute(req, res);
    }

    // 取得乾淨路徑並防止目錄穿越漏洞
    let reqUrl = decodeURI(req.url.split('?')[0]);
    let safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
    
    // 首頁預設導向 login.html（第一頁：必須先登入才能進主頁）
    if (safePath === '/' || safePath === '\\') {
        safePath = '/login.html';
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

// 啟動伺服器函數
function startServer(port) {
    server.listen(port, () => {
        const localUrl = `http://localhost:${port}`;
        console.log(`\n======================================================`);
        console.log(` 🚀 【期末專案】Web Library 個人圖書館已成功啟動！`);
        console.log(` 📡 訪問網址: ${localUrl}`);
        console.log(` 🎬 ACG 專區: ${localUrl}/acg.html`);
        console.log(` ⌨️  關閉方式: 在終端機按下 Ctrl + C`);
        console.log(`======================================================\n`);

        // 自動開啟預設瀏覽器 (支援 Windows / macOS / Linux)
        const openCommand = process.platform === 'win32' ? `start ${localUrl}` : (process.platform === 'darwin' ? `open ${localUrl}` : `xdg-open ${localUrl}`);
        exec(openCommand, () => {});
    });
}

// 端口被佔用時自動順延偵測 (防 EADDRINUSE 崩潰)
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ 端口 ${currentPort} 已被其他程式佔用，自動嘗試切換至 ${Number(currentPort) + 1}...`);
        currentPort = Number(currentPort) + 1;
        startServer(currentPort);
    } else {
        console.error('伺服器發生異常:', err);
    }
});

// 啟動執行
startServer(currentPort);
