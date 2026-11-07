// ==================== 【總說明】server.js 是整個網站的入口 ====================
// 這支檔案負責「啟動 HTTP 伺服器」，整體架構分成三塊：
//  1. 靜態檔案：瀏覽器要的 html / css / js / 圖片，由下面的 createServer 直接從硬碟讀出來回傳
//     （只開放白名單資料夾，data/、api/、server.js 本身不會被下載到）。
//  2. API 路由：網址以 /api/xxx 開頭的請求，不自己處理，而是依 API_ROUTES 表轉給 api/ 資料夾裡
//     對應的模組（kazumi=動漫、manga=條漫、novel=小說、sync=同步/書籤/音樂、docker=容器管理）。
//  3. 啟動流程：讀 .env -> 載入各 API 模組 -> 建立 server -> listen 監聽埠號
//     -> 成功就印網址並自動開瀏覽器；若埠號被佔用就自動 +1 換下一個埠。
// 資料儲存在 data/（由 api/db.js 管理），機密設定（密碼、金鑰）放 .env，不寫在程式碼裡。
// ================================================================
/**
 * Web Library - 期末專案專屬本地伺服器
 * 採用 Node.js 原生模組 (http, fs, path, child_process)，零依賴、免裝 npm 套件！
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// process.loadEnvFile 是 Node 內建功能，會把 .env 的 KEY=VALUE 塞進 process.env。
// 找不到 .env 會丟錯，所以用 try/catch 吞掉（例如 Docker 是用 environment 傳入的）。
// 注意：必須在 require 各 API 模組「之前」讀，因為模組載入時就可能要用到環境變數。
// 讀取 .env（若存在）。機密一律放 .env / 環境變數，不寫進原始碼
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* 沒有 .env 就用系統環境變數 */ }
const { handleKazumiRoute } = require('./api/kazumi');
const { handleMangaRoute } = require('./api/manga');
const { handleNovelRoute } = require('./api/novel');
const { handleSyncRoute } = require('./api/sync');
const { handleDockerRoute } = require('./api/docker');

// PORT 優先吃環境變數（Docker / 雲端平台會設定），沒有就用 8090。
// 期末專案使用 8090 端口（避開 8000、3000 與課堂的 8080，避免端口衝突）
let currentPort = process.env.PORT || 8090;
const ROOT_DIR = __dirname;

// MIME 類型：告訴瀏覽器這個檔案是什麼格式，瀏覽器才知道要當網頁、樣式還是圖片來處理。
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

// 路由表格式：[ [網址前綴們], 處理函式 ]。
// 請求網址用 startsWith 比對前綴，第一個命中的就把 (req, res) 整個交給該模組處理。
// API 路由前綴對照表 (依序比對，命中即交由對應模組處理)
const API_ROUTES = [
    [['/api/kazumi'], handleKazumiRoute], // 動漫後端模組
    [['/api/manga'], handleMangaRoute],   // Tachimanga 條漫
    [['/api/novel'], handleNovelRoute],   // Legado 沉浸小說
    // 跨裝置同步、Bangumi 雙向同步、音樂庫與 Tampermonkey 收藏
    [['/api/bookmarks', '/api/user', '/api/bookshelf', '/api/bangumi', '/api/music'], handleSyncRoute],
    [['/api/docker'], handleDockerRoute]  // 容器管理與一鍵部署
];

// 靜態檔案白名單（安全考量）：
//  - 根目錄只允許 .html / .ico / .svg
//  - 子資料夾只允許 css、js、images、tampermonkey
// 其餘（資料庫 data/、後端程式 api/、.env、server.js）一律回 404，避免被人直接下載。
// 參數 rel：相對於專案根目錄、用 / 分隔的路徑。回傳 true 代表可公開。
// 只對外提供前端資源：根目錄的 html/ico/svg 與下列資料夾；data/、api/、server.js 等一律不給
const PUBLIC_DIRS = ['css', 'js', 'images', 'tampermonkey'];
function isPublicFile(rel) {
    const parts = rel.split('/');
    return parts.length === 1 ? /\.(html|ico|svg)$/i.test(rel) : PUBLIC_DIRS.includes(parts[0]);
}

// 把 HTML 特殊字元換成實體碼，避免 404 頁面把使用者輸入的網址原樣印出而造成 XSS 攻擊。
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 每一個 HTTP 請求都會進來這個函式（req=請求、res=回應）。流程：
//  1. 先看是不是 API 路由，是就轉交給對應模組。
//  2. 否則當成靜態檔案：整理路徑 -> 檢查白名單 -> 讀檔回傳，找不到回 404。
const server = http.createServer((req, res) => {
    for (const [prefixes, handler] of API_ROUTES) {
        if (prefixes.some(p => req.url.startsWith(p))) return handler(req, res);
    }

    // （以下是上方說明的補充）decodeURI 把 %E4%B8%AD 之類還原成中文；網址格式錯誤會丟例外，
    // 這裡攔下並回 400，避免整個伺服器因為一個壞請求就當掉。
    // 取得乾淨路徑並防止目錄穿越漏洞 (格式錯誤的 %xx 會讓 decodeURI 拋錯，必須攔下否則整個伺服器崩潰)
    let reqUrl;
    try {
        reqUrl = decodeURI(req.url.split('?')[0]);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('400 Bad Request');
    }
    // path.normalize 會把 a/../b 化簡；再用正規表示式砍掉開頭的 ../ ，防止「目錄穿越」
    // （例如 /../../etc/passwd 想讀專案外的檔案）。後面還會再用 path.relative 二次確認。
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

    // 組出硬碟上的真實路徑，並算出相對路徑 relPath 拿去做白名單檢查。
    // relPath 以 .. 開頭代表跑出專案根目錄，直接視為不公開。
    const filePath = path.join(ROOT_DIR, safePath);
    const relPath = path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
    const isPublic = !relPath.startsWith('..') && isPublicFile(relPath);

    // 確認檔案存在且是「檔案」(不是資料夾)。不公開 / 不存在 / 不是檔案 -> 一律回同樣的 404，
    // 不洩漏檔案是否真的存在。
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

        // 依副檔名查 MIME；查不到就用 application/octet-stream（一般二進位）。
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        // 回 200 並加上 CORS 標頭（允許其他來源的網頁讀取，例如篡改猴腳本）。
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });

        // 用串流 (stream) 邊讀邊送，不會把整個大檔（如 mp4）一次塞進記憶體。
        fs.createReadStream(filePath).pipe(res);
    });
});

// startServer(port)：開始監聽指定埠號。參數 port 為埠號數字。
// 成功後印出網址，並在本機自動開啟預設瀏覽器（Windows 用 start、macOS 用 open、Linux 用 xdg-open）。
// 若有設 PORT（Docker/雲端）或 RENDER 環境變數就不開瀏覽器，因為伺服器上沒有螢幕。
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

// 錯誤處理：若錯誤是 EADDRINUSE（埠號已被別的程式用掉）就把埠號 +1 再試一次，
// 其他錯誤只印出來，不讓程式崩潰。
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

// 程式真正的起點：從 currentPort 開始啟動。
// 啟動執行
startServer(currentPort);
