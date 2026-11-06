/**
 * Web Library - 期末專案專屬本地伺服器
 * 採用 Node.js 原生模組 (http, fs, path, child_process)，零依賴、免裝 npm 套件！
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 讀取 .env（若存在）。機密一律放 .env / 環境變數，不寫進原始碼
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* 沒有 .env 就用系統環境變數 */ }
const { handleKazumiRoute } = require('./api/kazumi');
const { handleMangaRoute } = require('./api/manga');
const { handleNovelRoute } = require('./api/novel');
const { handleSyncRoute } = require('./api/sync');
const { handleDockerRoute } = require('./api/docker');

// 期末專案使用 8090 端口（避開 8000、3000 與課堂的 8080，避免端口衝突）
let currentPort = process.env.PORT || 8090;
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

// API 路由前綴對照表 (依序比對，命中即交由對應模組處理)
const API_ROUTES = [
    [['/api/kazumi'], handleKazumiRoute], // 動漫後端模組
    [['/api/manga'], handleMangaRoute],   // Tachimanga 條漫
    [['/api/novel'], handleNovelRoute],   // Legado 沉浸小說
    // 跨裝置同步、Bangumi 雙向同步、音樂庫與 Tampermonkey 收藏
    [['/api/bookmarks', '/api/user', '/api/bookshelf', '/api/bangumi', '/api/music'], handleSyncRoute],
    [['/api/docker'], handleDockerRoute]  // 容器管理與一鍵部署
];

// 只對外提供前端資源：根目錄的 html/ico/svg 與下列資料夾；data/、api/、server.js 等一律不給
const PUBLIC_DIRS = ['css', 'js', 'images', 'tampermonkey'];
function isPublicFile(rel) {
    const parts = rel.split('/');
    return parts.length === 1 ? /\.(html|ico|svg)$/i.test(rel) : PUBLIC_DIRS.includes(parts[0]);
}

const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const server = http.createServer((req, res) => {
    for (const [prefixes, handler] of API_ROUTES) {
        if (prefixes.some(p => req.url.startsWith(p))) return handler(req, res);
    }

    // 取得乾淨路徑並防止目錄穿越漏洞 (格式錯誤的 %xx 會讓 decodeURI 拋錯，必須攔下否則整個伺服器崩潰)
    let reqUrl;
    try {
        reqUrl = decodeURI(req.url.split('?')[0]);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('400 Bad Request');
    }
    let safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
    
    // 首頁預設導向 login.html（第一頁：必須先登入才能進主頁）
    if (safePath === '/' || safePath === '\\') {
        safePath = '/login.html';
    }

    // 瀏覽器圖示請求智慧對應 (解決 Docker 容器環境下 /favicon.ico 404 造成標籤頁破圖)
    if (safePath === '/favicon.ico' || safePath === '\\favicon.ico') {
        const icoExists = fs.existsSync(path.join(ROOT_DIR, 'favicon.ico'));
        if (!icoExists && fs.existsSync(path.join(ROOT_DIR, 'favicon.svg'))) {
            safePath = '/favicon.svg';
        }
    }

    const filePath = path.join(ROOT_DIR, safePath);
    const relPath = path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
    const isPublic = !relPath.startsWith('..') && isPublicFile(relPath);

    fs.stat(filePath, (err, stats) => {
        if (!isPublic || err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <!DOCTYPE html>
                <html lang="zh-Hant">
                <head><meta charset="UTF-8"><title>404 找不到檔案</title></head>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h2>404 找不到該頁面或資源</h2>
                    <p style="color: #64748b;">請求路徑: <code>${escapeHtml(reqUrl)}</code></p>
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
        if (!process.env.PORT && !process.env.RENDER) { exec(openCommand, () => {}); }
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
