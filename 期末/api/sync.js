/**
 * 【檔案總說明】api/sync.js —— 帳號、雲端同步、音樂庫與 Bangumi 代理模組
 *
 * 這個模組負責什麼：
 *   1) 使用者帳號：註冊、登入、重設密碼、個人資料、刪除帳號（密碼用加鹽雜湊，不存明文）；
 *   2) 跨電腦雲端同步：書籤、立體書架（漫畫/小說）、自訂來源規則、音樂庫、遊戲專區，換電腦登入後資料還在；
 *   3) 快捷記事本截圖上傳 / 讀取（存成檔案）；
 *   4) 線上歌曲搜尋（網易雲，失敗時退回 iTunes）；
 *   5) Bangumi（動漫資料網站）的代理：瀏覽器直接呼叫會被 CORS 擋，所以由伺服器代為轉發。
 *
 * 怎麼被接上：server.js 的路由表中，網址以 /api/bookmarks、/api/user、/api/bookshelf、/api/bangumi、/api/music
 *   開頭的請求，都會交給本檔匯出的 handleSyncRoute。
 *
 * 主要 API 路由：
 *   /api/user/login | register | delete | clear | reset-password | profile
 *   /api/user/bookshelf（或 /api/bookshelf）、/api/user/custom-rules、/api/user/games
 *   /api/user/music（或 /api/music）、/api/music/search
 *   /api/bookmarks（或 /api/user/bookmarks）、/api/bookmarks/screenshot[/檔名]
 *   /api/bangumi/me | collection | search | episodes
 *
 * 資料從哪來往哪去：前端 JSON -> 本模組 -> db.js 的 NeDB 資料庫（accountsDb 帳號、bookmarksDb 書籤、
 *   bookshelfDb 書架、musicDb 音樂、gamesDb 遊戲），截圖則存在 data/uploads/ 資料夾。NeDB 是純 JavaScript 的嵌入式資料庫，
 *   資料存成檔案，不需要另外安裝資料庫伺服器。
 *
 * 身分驗證：登入 / 註冊成功時發一組登入憑證 (token，見 api/auth.js)，前端與 Tampermonkey 之後都在
 *   X-WL-Token 標頭帶上它。帳號相關路由一律用 token 查出「是誰」，請求裡的 user 參數不再採信；
 *   沒帶有效 token 回 401。訪客 (guest) 沒有 token，資料只留在瀏覽器，不寫伺服器。
 *
 * 同步衝突處理：這裡採「最後寫入者勝」——POST 時直接用客戶端傳來的整批資料覆蓋；
 *   只有少數情況會合併（例如 Tampermonkey 單筆收藏會依網址去重/更新，音樂單首依 id 去重）。
 */
/**
 * Web Library - 跨電腦雲端同步、NeDB 資料庫與 Bangumi 雙向同步核心模組
 * 採用 nedb-promises 嵌入式 NoSQL 資料庫 + Node.js 原生 Crypto 加鹽安全雜湊
 * 支援多帳號伺服器端資料庫持久化、無明文密碼儲存與即時雙向狀態同步
 */
// https：用來呼叫外部的 HTTPS API（Bangumi、網易雲、iTunes）。
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 從 db.js 取得五個資料表（accountsDb 等）與密碼雜湊 / 驗證工具。
const {
    accountsDb,
    bookmarksDb,
    bookshelfDb,
    musicDb,
    gamesDb,
    hashPassword,
    verifyPassword
} = require('./db');
// 登入憑證 (session token)：伺服器用它認人，不再相信請求裡寫的 user 參數
const { createSession, getSessionUser, revokeRequestSession, revokeUserSessions } = require('./auth');

// sendJson：統一的 JSON 回應函式。參數：res 回應物件、statusCode 狀態碼、payload 要回傳的物件。
// 加上 CORS 標頭（允許跨網域呼叫，Tampermonkey 腳本從別的網站呼叫時需要）。writableEnded 檢查避免重複回應。
// 統一設置 CORS 與 JSON 回應
function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WL-Token');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

// parseRequestBody：把 POST 請求的內容讀出來並解析成 JSON 物件。
// 為什麼包成 Promise：Node 的請求內容是「一塊一塊」(data 事件) 傳來的，必須等 end 事件才算收完，
// 包成 Promise 後就可以用 await 寫得像同步。超過 20MB 直接中斷，防止惡意灌爆記憶體；空內容回傳 {}。
// 讀取請求體 Body (Promise 封裝)
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 20 * 1024 * 1024) { // 限制 20MB
                req.destroy();
                reject(new Error('請求體過大'));
            }
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('JSON 格式解析失敗: ' + e.message));
            }
        });
        req.on('error', reject);
    });
}

// ==========================================
// 快捷記事本截圖存檔 (data/uploads/)
// 只接受 JPEG / PNG / WebP (以檔頭魔術數字判斷，不信任宣告的 MIME)，解碼後上限 3MB
// 檔名由伺服器隨機產生，讀取時以白名單正規式比對，杜絕路徑穿越
// ==========================================
// 截圖相關常數：存放資料夾、大小上限 3MB、合法檔名的正規表示式（32 個十六進位字 + 副檔名）、副檔名對應的 MIME 類型。
const SCREENSHOT_DIR = path.join(__dirname, '..', 'data', 'uploads');
const SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;
const SCREENSHOT_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const SCREENSHOT_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// detectImageExt：看檔案「開頭幾個位元組」(魔術數字) 判斷真正的圖片格式，回傳 jpg / png / webp，不是圖片回傳 null。
// 為什麼不信任使用者宣告的類型：宣告可以造假，檔案內容才騙不了人。JPEG 開頭 FF D8 FF；PNG 開頭 89 50 4E 47...；WebP 是 RIFF....WEBP。
function detectImageExt(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
}

// handleScreenshotUpload：處理 POST /api/bookmarks/screenshot。
// 請求 body：{ image: "data:image/png;base64,...." }。成功回應：{ success:true, path, bytes }；
// 錯誤：超過 3MB 回 413、格式錯誤回 400。
// 流程：邊收邊計算大小(過大立刻停止) -> 解析 JSON -> 用 regex 驗證是 base64 圖片 -> 轉成二進位 Buffer -> 檢查大小與真實格式
//       -> 用隨機檔名存檔(避免被猜到、也避免覆蓋)。
async function handleScreenshotUpload(req, res) {
    // base64 約膨脹 4/3，再留一點 JSON 外殼空間；超過就直接斷線，不讀進記憶體
    const maxBody = Math.ceil(SCREENSHOT_MAX_BYTES * 4 / 3) + 4096;
    let raw = '';
    try {
        raw = await new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on('data', chunk => {
                size += chunk.length;
                if (size > maxBody) {
                    // 停止讀取，先回 413 再斷線 (立即 destroy 會讓客戶端收不到錯誤訊息)
                    // 超過上限時先暫停讀取並移除監聽，稍後回覆 413；若馬上 destroy，客戶端會連錯誤訊息都收不到。
                    req.pause();
                    req.removeAllListeners('data');
                    reject(new Error('too_large'));
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    } catch (e) {
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.destroy());
        return sendJson(res, 413, { success: false, error: '截圖超過 3MB 上限' });
    }

    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) {
        return sendJson(res, 400, { success: false, error: 'JSON 格式錯誤' });
    }
    // 嚴格比對 dataURL 格式：只允許 jpeg/png/webp，且內容只能是 base64 合法字元，可擋掉奇怪的輸入。
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
    if (!m) return sendJson(res, 400, { success: false, error: '只接受 JPEG / PNG / WebP 的 base64 dataURL' });

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > SCREENSHOT_MAX_BYTES) {
        return sendJson(res, 413, { success: false, error: '截圖超過 3MB 上限' });
    }
    const ext = detectImageExt(buf);
    if (!ext) return sendJson(res, 400, { success: false, error: '檔案內容不是有效的圖片' });

    // 檔名由伺服器產生 16 個隨機位元組轉十六進位 (32 字元)，使用者無法自訂檔名，因此不可能做路徑穿越攻擊。
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    await fs.promises.mkdir(SCREENSHOT_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(SCREENSHOT_DIR, name), buf);
    // 回傳相對路徑：網站與 API 同源，本機 8090 與 Docker 8095 都能直接顯示
    return sendJson(res, 200, { success: true, path: '/api/bookmarks/screenshot/' + name, bytes: buf.length });
}

// serveScreenshot：處理 GET /api/bookmarks/screenshot/檔名，把截圖檔回傳給瀏覽器。
// 先用白名單正規式驗證檔名(只能是 32 字十六進位 + 副檔名)，所以 "../" 之類的路徑穿越字串一律 404。
// 回應帶一年的快取(檔名是隨機且內容不變)與 nosniff(禁止瀏覽器猜類型)，並用 stream 邊讀邊送，不佔記憶體。
function serveScreenshot(name, res) {
    if (!SCREENSHOT_NAME_RE.test(name)) return sendJson(res, 404, { success: false, error: '找不到截圖' });
    const file = path.join(SCREENSHOT_DIR, name);
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return sendJson(res, 404, { success: false, error: '找不到截圖' });
        res.writeHead(200, {
            'Content-Type': SCREENSHOT_MIME[name.split('.').pop()],
            'Content-Length': st.size,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(file).pipe(res);
    });
}

// sanitizeUsername：清理帳號名稱，只留英數、底線、減號、中文，並轉小寫；空的就用 default。
// 用途：帳號名稱會拿來當資料庫查詢條件與路徑的一部分，先過濾可避免特殊字元造成注入或路徑穿越。
// 安全純化使用者名稱，避免路徑穿越並統一小寫
function sanitizeUsername(username) {
    if (!username) return 'default';
    const clean = username.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '').trim().toLowerCase();
    return clean || 'default';
}

// 訪客 / 示範用的特殊名稱：這些身分不寫伺服器
const GUEST_NAMES = new Set(['guest', '訪客', 'default']);

// requireUser：帳號相關路由的守門員。用 X-WL-Token 標頭查出登入者並確認帳號還存在；
// 失敗就直接回 401 並回傳 null（呼叫端看到 null 就 return）。
// 請求裡的 ?user= 或 body.user 一律忽略，所以不能讀寫別人的帳號。
async function requireUser(req, res) {
    const username = await getSessionUser(req);
    if (username && await accountsDb.findOne({ username })) return username;
    sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '尚未登入或登入已失效，請重新登入' });
    return null;
}

// publicUser：登入 / 註冊回應給前端的帳號資料（不含密碼雜湊）
function publicUser(acc) {
    return {
        username: acc.username,
        name: acc.name || acc.username,
        role: acc.role || '一般會員',
        avatar: acc.avatar || 'default',
        bio: acc.bio || '',
        sortPref: acc.sortPref || 'clicks',
        themePref: acc.themePref || 'dark'
    };
}

// saveMusicTracks：把整份曲目清單存回資料庫並回傳更新時間。
// upsert:true 的意思是「有就更新、沒有就新增」；$set 只改指定欄位。
// 覆寫使用者音樂庫並回傳更新時間
async function saveMusicTracks(user, tracks) {
    const updatedAt = new Date().toISOString();
    await musicDb.update(
        { user },
        { $set: { user, count: tracks.length, tracks, updatedAt } },
        { upsert: true }
    );
    return updatedAt;
}

// forwardToBangumi：用 Node 內建 https 模組呼叫 Bangumi 官方 API（伺服器對伺服器，不受瀏覽器 CORS 限制）。
// 參數：apiPath 路徑、method HTTP 方法、token 使用者的 Access Token（放進 Authorization: Bearer 標頭）、bodyData 要送的 JSON。
// 回傳 Promise：{ statusCode, data }；若回應不是 JSON 則回 { statusCode, raw }；網路錯誤 reject，10 秒逾時也 reject。
// 對方回的狀態碼原樣交給呼叫者判斷，所以這個函式本身不會因為 404 而丟錯。
// 轉發請求至 Bangumi 官方 API (避開瀏覽器 CORS 限制)
function forwardToBangumi(apiPath, method, token, bodyData = null) {
    return new Promise((resolve, reject) => {
        const payloadStr = bodyData ? JSON.stringify(bodyData) : null;
        const headers = {
            'User-Agent': 'WebLibrary-ACG-Client/2.0 (https://github.com/web-library)',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
        if (token && typeof token === 'string' && token.trim()) {
            headers['Authorization'] = `Bearer ${token.trim()}`;
        }
        const options = {
            hostname: 'api.bgm.tv',
            path: apiPath,
            method: method,
            headers: headers,
            timeout: 10000
        };

        if (payloadStr) {
            options.headers['Content-Length'] = Buffer.byteLength(payloadStr);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = data ? JSON.parse(data) : {};
                    resolve({ statusCode: res.statusCode, data: json });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, raw: data });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('連線至 Bangumi 官方 API 超時'));
        });

        if (payloadStr) req.write(payloadStr);
        req.end();
    });
}

// tokenToUsernameMap：用 Map 當記憶體快取，記住「某個 token 對應哪個 Bangumi 使用者名稱」。
// 為什麼要快取：很多 Bangumi 介面需要使用者名稱，但前端只傳 token，每次都問官方 /v0/me 太慢，也浪費 API 額度。
// 記憶體快取：Token 對應之 Bangumi 使用者名稱
const tokenToUsernameMap = new Map();
// resolveUsernameFromToken：用 token 換使用者名稱（先查快取，沒有才問官方）；查不到回傳 null。失敗時靜默吞掉錯誤。
async function resolveUsernameFromToken(token) {
    if (!token) return null;
    if (tokenToUsernameMap.has(token)) return tokenToUsernameMap.get(token);
    try {
        const meRes = await forwardToBangumi('/v0/me', 'GET', token);
        if (meRes.statusCode === 200 && meRes.data && (meRes.data.username || meRes.data.id)) {
            const username = String(meRes.data.username || meRes.data.id);
            tokenToUsernameMap.set(token, username);
            return username;
        }
    } catch(e) {}
    return null;
}

// ===== 以下是路由總入口 =====
// handleSyncRoute：本模組所有請求都先進來這裡，依 pathname（路徑）與 req.method（GET/POST...）一個一個 if 比對，
// 命中就處理並 return；全部沒命中最後回 404。沒有回傳值，結果直接寫入 res。
// 整個函式包在 try/catch 裡，資料庫或網路出錯會統一變成 500 JSON 回應，不會讓伺服器崩潰。
/**
 * 處理跨電腦同步、NeDB 資料庫與 Bangumi 雙向同步路由
 */
async function handleSyncRoute(req, res) {
    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;
    // 把網址 ?a=1&b=2 轉成物件 { a:"1", b:"2" }，後面用 query.user 這樣取值。
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    // CORS 預檢請求：瀏覽器跨網域送 POST/PUT 前會先問「可以嗎」，這裡回 204 並列出允許的方法與標頭。
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WL-Token'
        });
        return res.end();
    }

    try {
        // （原本的 GET /api/user/list 會列出所有帳號名稱，登入頁早已不用，且會洩漏其他使用者，已移除。）

        // ==========================================
        // 0.1 使用者登入驗證端點 /api/user/login (NeDB + 加鹽雜湊驗證，拒絕明文)
        // ==========================================
        // POST /api/user/login —— 登入驗證。請求 body：{ username, password }。
        // 流程：純化帳號 -> 查資料庫 -> verifyPassword 比對雜湊 -> 成功回傳使用者資料(不含密碼)。
        // 錯誤：缺欄位 400；帳號不存在或密碼錯 401（訊息刻意模糊，不讓人猜出帳號是否存在）。
        if (pathname === '/api/user/login' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const username = sanitizeUsername(body.username || body.user || '');
            const password = String(body.password || '').trim();

            if (!username || !password) {
                return sendJson(res, 400, { success: false, error: '請輸入帳號與密碼' });
            }

            const acc = await accountsDb.findOne({ username });
            if (!acc) {
                return sendJson(res, 401, { success: false, error: '帳號不存在或密碼錯誤' });
            }

            const isValid = verifyPassword(password, acc.password);
            if (!isValid) {
                return sendJson(res, 401, { success: false, error: '帳號或密碼不正確' });
            }

            // 向下相容：如果資料庫裡還是舊版的明文密碼(不是以 scrypt: 開頭)，登入成功當下就自動換成加鹽雜湊，使用者完全不用做任何事。
            // 若舊密碼為早期明文，在此登入成功瞬間自動平滑升級為加鹽雜湊
            if (acc.password && !acc.password.startsWith('scrypt:')) {
                await accountsDb.update({ username }, { $set: { password: hashPassword(password), updatedAt: new Date().toISOString() } });
                console.log(`[NeDB Security] 帳號 ${username} 密碼已自動平滑升級為加鹽雜湊`);
            }

            // 發給前端登入憑證；之後的帳號相關請求都要帶它 (X-WL-Token 標頭)
            const token = await createSession(username);

            return sendJson(res, 200, {
                success: true,
                message: '登入驗證成功',
                token,
                user: publicUser(acc)
            });
        }

        // ==========================================
        // 0.2 使用者註冊端點 /api/user/register (NeDB 加鹽雜湊存儲)
        // ==========================================
        // POST /api/user/register —— 註冊新帳號。請求 body：{ username, password, name?, role? }。
        // 驗證：帳號至少 2 字元、密碼至少 3 字元、帳號不可重複，否則 400。
        // 存入資料庫前密碼一定先 hashPassword（scrypt 加鹽雜湊）；回應也不會把密碼傳回去。
        if (pathname === '/api/user/register' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const username = sanitizeUsername(body.username || '');
            const password = String(body.password || '').trim();
            const name = String(body.name || username).trim();
            const role = String(body.role || '一般會員').trim();

            if (!username || username.length < 2) {
                return sendJson(res, 400, { success: false, error: '帳號至少需 2 個字元' });
            }
            // guest / 訪客 / default 是訪客身分專用名稱，不能註冊成真帳號
            if (GUEST_NAMES.has(username)) {
                return sendJson(res, 400, { success: false, error: '此帳號名稱為系統保留，請選擇其他帳號' });
            }
            if (!password || password.length < 3) {
                return sendJson(res, 400, { success: false, error: '密碼至少需 3 個字元' });
            }

            const exist = await accountsDb.findOne({ username });
            if (exist) {
                return sendJson(res, 400, { success: false, error: '該帳號名稱已存在，請選擇其他帳號' });
            }

            const newUser = {
                username,
                password: hashPassword(password), // 絕不儲存明文密碼！
                name: name || username,
                role: role,
                avatar: 'default',
                bio: '探索個人化網頁圖書館',
                sortPref: 'newest',
                themePref: 'dark',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await accountsDb.insert(newUser);
            // 註冊完直接登入，所以也發登入憑證
            const token = await createSession(username);

            return sendJson(res, 200, {
                success: true,
                message: '註冊成功！密碼已安全加密儲存於 NeDB 資料庫。',
                token,
                user: {
                    username: newUser.username,
                    name: newUser.name,
                    role: newUser.role,
                    avatar: newUser.avatar
                }
            });
        }

        // ==========================================
        // 0.5 刪除使用者帳號及其所有雲端書籤 /api/user/delete (NeDB 同步清理)
        // ==========================================
        // POST /api/user/delete —— 刪除「目前登入的」帳號及該帳號的所有書籤、書架、音樂、遊戲資料。
        // 帳號由登入憑證決定，網址或 body 寫別人的帳號也沒用；沒帶有效憑證回 401。
        // remove 的 multi:true 表示符合條件的紀錄全部刪除，而不是只刪第一筆。
        if (pathname === '/api/user/delete' && req.method === 'POST') {
            const cleanUser = await requireUser(req, res);
            if (!cleanUser) return;

            await accountsDb.remove({ username: cleanUser }, { multi: true });
            await bookmarksDb.remove({ user: cleanUser }, { multi: true });
            await bookshelfDb.remove({ user: cleanUser }, { multi: true });
            await musicDb.remove({ user: cleanUser }, { multi: true }); // 音樂庫也要刪，否則同名新帳號會繼承舊歌單
            await gamesDb.remove({ type: 'user', user: cleanUser }, { multi: true }); // 避免同名新帳號繼承舊卡片
            await revokeUserSessions(cleanUser); // 所有裝置（含 Tampermonkey）的登入憑證一併作廢

            return sendJson(res, 200, {
                success: true,
                user: cleanUser,
                message: `帳號 [${cleanUser}] 及其在 NeDB 資料庫中的所有資料已安全刪除！`
            });
        }

        // ==========================================
        // 0.6 清空使用者帳號書籤 /api/user/clear (NeDB 書籤重設)
        // ==========================================
        // /api/user/clear —— 只清空該帳號的書籤(保留帳號)。作法是把 bookmarks 設成空陣列，upsert 確保沒有紀錄時也會建立。
        if (pathname === '/api/user/clear' && req.method === 'POST') {
            const cleanUser = await requireUser(req, res);
            if (!cleanUser) return;
            await bookmarksDb.update(
                { user: cleanUser },
                { $set: { user: cleanUser, count: 0, bookmarks: [], updatedAt: new Date().toISOString() } },
                { upsert: true }
            );

            return sendJson(res, 200, {
                success: true,
                user: cleanUser,
                count: 0,
                message: `帳號 [${cleanUser}] 的書籤已自 NeDB 資料庫成功清空！`
            });
        }

        // ==========================================
        // 0.7 忘記密碼與重設密碼 /api/user/reset-password (加鹽雜湊更新)
        // ==========================================
        // POST /api/user/reset-password —— 忘記密碼。body：{ username, newPassword }。
        // 這個網站沒有 Email / 簡訊可以驗證「你真的是本人」，若開放任何人輸入帳號就改密碼，等於誰都能搶走別人的帳號。
        // 所以規則是：
        //  1. 新密碼剛好就是目前的密碼 → 等於證明知道密碼（和登入一樣），回傳 isSamePassword 與登入憑證（登入頁的彩蛋）；
        //  2. 新密碼不同 → 只有伺服器設定 ALLOW_PASSWORD_RESET=true 時才真的改（給信任的私人環境救急），
        //     改完撤銷該帳號所有登入憑證；沒設定就回 403，請使用者登入後到個人設定改密碼或聯絡管理員。
        //  帳號不存在不會再自動建立帳號（要建立請走註冊）。
        if (pathname === '/api/user/reset-password' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const username = sanitizeUsername(body.username || body.user || '');
            const newPassword = String(body.newPassword || body.password || '').trim();

            if (!username || GUEST_NAMES.has(username)) {
                return sendJson(res, 400, { success: false, error: '請提供欲重設之使用者帳號' });
            }
            if (!newPassword || newPassword.length < 3) {
                return sendJson(res, 400, { success: false, error: '新密碼至少需 3 個字元' });
            }

            const acc = await accountsDb.findOne({ username });
            if (!acc) {
                return sendJson(res, 400, { success: false, error: '帳號不存在，請先註冊' });
            }

            if (verifyPassword(newPassword, acc.password)) {
                const token = await createSession(username);
                return sendJson(res, 200, {
                    success: true,
                    user: publicUser(acc),
                    token,
                    samePassword: true,
                    isSamePassword: true,
                    message: '哈哈！你輸入了跟先前一模一樣的密碼！系統已為您完成密碼確認重設。'
                });
            }

            const allowReset = /^(1|true|yes)$/i.test(String(process.env.ALLOW_PASSWORD_RESET || '').trim());
            if (!allowReset) {
                return sendJson(res, 403, {
                    success: false,
                    error: '此伺服器未開放自助重設密碼（沒有 Email 驗證，開放會讓任何人改掉別人的密碼）。請登入後到個人設定修改，或聯絡網站管理員。'
                });
            }

            await accountsDb.update(
                { username },
                { $set: { password: hashPassword(newPassword), updatedAt: new Date().toISOString() } }
            );
            await revokeUserSessions(username); // 舊憑證全部作廢，避免原本登入的人繼續使用

            return sendJson(res, 200, {
                success: true,
                user: username,
                samePassword: false,
                isSamePassword: false,
                message: '密碼已成功以加鹽雜湊演算法加密並重設！請使用新密碼登入。'
            });
        }

        // POST /api/user/logout —— 登出：撤銷這次請求帶的登入憑證（沒帶也回成功，讓前端照常清本機資料）。
        if (pathname === '/api/user/logout' && req.method === 'POST') {
            await revokeRequestSession(req);
            return sendJson(res, 200, { success: true });
        }

        // ==========================================
        // 0.8 個人資料取得與更新 /api/user/profile (NeDB 操作，安全過濾密碼)
        // ==========================================
        // /api/user/profile —— 個人資料。GET 讀取、POST 更新。回應只挑選要公開的欄位，所以絕對不會把密碼雜湊傳給前端。
        if (pathname === '/api/user/profile') {
            // GET：只能讀「目前登入者」自己的資料（?username= 會被忽略），沒帶有效憑證回 401。
            if (req.method === 'GET') {
                const username = await requireUser(req, res);
                if (!username) return;
                const acc = await accountsDb.findOne({ username });
                return sendJson(res, 200, {
                    success: true,
                    profile: {
                        username: acc.username,
                        name: acc.name || acc.username,
                        role: acc.role || '使用者',
                        avatar: acc.avatar || 'default',
                        bio: acc.bio || '',
                        sortPref: acc.sortPref || 'clicks',
                        themePref: acc.themePref || 'dark',
                        defaultSort: acc.defaultSort || null,
                        defaultCategory: acc.defaultCategory || null,
                        spotlightPref: typeof acc.spotlightPref === 'boolean' ? acc.spotlightPref : null
                    }
                });
            }

            // POST：更新目前登入者自己的資料；body 裡的 username 會被忽略。
            if (req.method === 'POST') {
                const username = await requireUser(req, res);
                if (!username) return;
                const body = await parseRequestBody(req);
                const acc = await accountsDb.findOne({ username });

                const updates = { updatedAt: new Date().toISOString() };

                // POST：只有帶 newPassword 才會改密碼，而且必須先通過舊密碼驗證，防止別人趁你沒登出亂改。
                // 若要修改密碼，需比對舊密碼
                if (body.newPassword && body.newPassword.trim()) {
                    const newPw = body.newPassword.trim();
                    const oldPw = (body.oldPassword || '').trim();
                    if (acc.password && !verifyPassword(oldPw, acc.password)) {
                        return sendJson(res, 400, { success: false, error: '原登入密碼不正確，無法修改密碼！' });
                    }
                    updates.password = hashPassword(newPw); // 加鹽加密儲存
                    // 改密碼後，其他裝置的登入憑證全部作廢（保留這次請求自己的，不會把自己登出）
                    await revokeUserSessions(username, req);
                }

                // 只更新「有帶進來」的欄位（!== undefined 判斷），沒帶的欄位維持原值，所以前端可以只送想改的部分。
                if (body.name !== undefined) updates.name = String(body.name).trim();
                if (body.bio !== undefined) updates.bio = String(body.bio).trim();
                if (body.avatar !== undefined) updates.avatar = String(body.avatar).trim();
                if (body.sortPref !== undefined) updates.sortPref = String(body.sortPref).trim();
                if (body.themePref !== undefined) updates.themePref = String(body.themePref).trim();
                // 首頁偏好 (預設排序 / 預設分類 / Spotlight 特效)，跨分頁與重新登入都要保留
                if (body.defaultSort !== undefined) updates.defaultSort = String(body.defaultSort).trim();
                if (body.defaultCategory !== undefined) updates.defaultCategory = String(body.defaultCategory).trim();
                if (body.spotlightPref !== undefined) updates.spotlightPref = !!body.spotlightPref;

                await accountsDb.update({ username }, { $set: updates });
                const updatedAcc = await accountsDb.findOne({ username });

                return sendJson(res, 200, {
                    success: true,
                    message: '個人設定與資料已成功儲存至 NeDB 資料庫！',
                    profile: {
                        username: updatedAcc.username,
                        name: updatedAcc.name,
                        role: updatedAcc.role,
                        avatar: updatedAcc.avatar,
                        bio: updatedAcc.bio,
                        sortPref: updatedAcc.sortPref,
                        themePref: updatedAcc.themePref,
                        defaultSort: updatedAcc.defaultSort || null,
                        defaultCategory: updatedAcc.defaultCategory || null,
                        spotlightPref: typeof updatedAcc.spotlightPref === 'boolean' ? updatedAcc.spotlightPref : null
                    }
                });
            }
        }

        // ==========================================
        // 0.9 跨裝置立體書架同步端點 /api/user/bookshelf 與 /api/bookshelf (NeDB 存取)
        // ==========================================
        // /api/user/bookshelf（或 /api/bookshelf）—— 同步漫畫、小說的立體書架。
        // GET：取回該帳號的書架；POST：存入書架。每個帳號在 bookshelfDb 只有一筆紀錄（用 user 欄位當鍵）。
        if (pathname === '/api/user/bookshelf' || pathname === '/api/bookshelf') {
            // GET: 從 NeDB 拉取該帳號最新漫畫與小說立體書架
            if (req.method === 'GET') {
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;

                const record = await bookshelfDb.findOne({ user: safeUser });
                if (!record) {
                    return sendJson(res, 200, {
                        success: true,
                        user: safeUser,
                        manga: [],
                        novel: [],
                        mangaHistory: [],
                        isNew: true,
                        message: '帳號尚無 NeDB 立體書架存檔'
                    });
                }

                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    manga: Array.isArray(record.manga) ? record.manga : [],
                    novel: Array.isArray(record.novel) ? record.novel : [],
                    mangaHistory: Array.isArray(record.mangaHistory) ? record.mangaHistory : [],
                    updatedAt: record.updatedAt || null
                });
            }
            // POST: 將客戶端立體書架 (條漫與沉浸小說) 寫入 NeDB
            else if (req.method === 'POST') {
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;
                const body = await parseRequestBody(req);

                // POST 合併策略：body 有帶陣列才覆蓋，沒帶就保留資料庫原本的值。
                // 好處：只更新漫畫的請求不會把小說清空。這也是「最後寫入者勝」的欄位級版本。
                const existing = await bookshelfDb.findOne({ user: safeUser }) || { manga: [], novel: [] };
                let manga = Array.isArray(body.manga) ? body.manga : (existing.manga || []);
                let novel = Array.isArray(body.novel) ? body.novel : (existing.novel || []);
                // 漫畫閱讀歷史 (最多 20 筆)；沒帶這個欄位的請求保留原值
                const mangaHistory = Array.isArray(body.mangaHistory) ? body.mangaHistory.slice(0, 20) : (existing.mangaHistory || []);
                const updatedAt = new Date().toISOString();

                await bookshelfDb.update(
                    { user: safeUser },
                    { $set: { user: safeUser, manga, novel, mangaHistory, updatedAt } },
                    { upsert: true }
                );

                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    mangaCount: manga.length,
                    novelCount: novel.length,
                    savedAt: updatedAt,
                    message: '立體書架收藏已成功同步至 NeDB 資料庫！'
                });
            }
        }

        // ==========================================
        // 0.92 ACG 自訂來源規則 (動畫 Kazumi 規則 / 漫畫 XPath 規則 / 搜尋跳轉) /api/user/custom-rules
        // 存在 bookshelf.db 同一筆使用者紀錄的 customRules 欄位，不影響既有書架資料
        // ==========================================
        // /api/user/custom-rules —— 同步使用者自訂的 ACG 來源規則。GET 讀、POST 存。
        // 安全限制：規則必須是陣列、最多 200 條、單條序列化後不超過 16KB，避免有人塞入超大資料拖垮資料庫。
        if (pathname === '/api/user/custom-rules') {
            if (req.method === 'GET') {
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;
                const record = await bookshelfDb.findOne({ user: safeUser });
                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    rules: record && Array.isArray(record.customRules) ? record.customRules : [],
                    updatedAt: (record && record.customRulesUpdatedAt) || null
                });
            }
            if (req.method === 'POST') {
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;
                const body = await parseRequestBody(req);
                if (!Array.isArray(body.rules)) return sendJson(res, 400, { success: false, error: 'rules 必須是陣列' });
                if (body.rules.length > 200) return sendJson(res, 400, { success: false, error: '自訂規則最多 200 條' });
                const rules = body.rules.filter(r => r && typeof r === 'object' && JSON.stringify(r).length <= 16 * 1024);
                const updatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : new Date().toISOString();
                await bookshelfDb.update(
                    { user: safeUser },
                    { $set: { user: safeUser, customRules: rules, customRulesUpdatedAt: updatedAt } },
                    { upsert: true }
                );
                return sendJson(res, 200, { success: true, user: safeUser, count: rules.length, updatedAt });
            }
        }

        // ==========================================
        // 0.93 ACG 遊戲專區與攻略庫 /api/user/games (NeDB 存取)
        // 預設卡片 (type: 'default') 全站共用，依 order 排序；
        // 自訂卡片與隱藏清單 (type: 'user') 每個帳號獨立儲存，換電腦可同步；
        // 訪客 (guest / 訪客 / 沒帶 user) 不存伺服器，直接回傳預設卡
        // ==========================================
        if (pathname === '/api/user/games') {
            if (req.method === 'GET') {
                // 先查 gamesDb.find({ type: 'default' })，依 order 排序，每筆去掉 _id、type、order 欄位 → defaults
                const defaultDocs = await gamesDb.find({ type: 'default' });
                defaultDocs.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
                const defaults = defaultDocs.map(doc => {
                    const item = { ...doc };
                    delete item._id;
                    delete item.type;
                    delete item.order;
                    return item;
                });

                // 有帶有效登入憑證才回傳該帳號的自訂卡片；訪客 / 沒登入只拿預設卡（不回 401，預設卡是公開的）
                const safeUser = await getSessionUser(req);
                if (!safeUser) {
                    return sendJson(res, 200, {
                        success: true,
                        defaults,
                        custom: [],
                        hidden: []
                    });
                }

                const record = await gamesDb.findOne({ type: 'user', user: safeUser });
                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    defaults,
                    custom: record && Array.isArray(record.custom) ? record.custom : [],
                    hidden: record && Array.isArray(record.hidden) ? record.hidden : [],
                    updatedAt: (record && record.updatedAt) || null
                });
            }

            if (req.method === 'POST') {
                // 必須登入（訪客沒有登入憑證 → 401，訪客資料本來就不寫伺服器）
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;
                const body = await parseRequestBody(req);

                // custom 必須是陣列且 ≤ 100 筆，hidden 必須是陣列且 ≤ 100 筆，否則 400
                if (!Array.isArray(body.custom) || body.custom.length > 100) {
                    return sendJson(res, 400, { success: false, error: 'custom 必須是陣列且不得超過 100 筆' });
                }
                if (!Array.isArray(body.hidden) || body.hidden.length > 100) {
                    return sendJson(res, 400, { success: false, error: 'hidden 必須是陣列且不得超過 100 筆' });
                }

                // custom 每筆重新組裝白名單欄位（不要直接存 body 原物件）
                // { id: String, title: String, url: String, badge: String, badgeClass: String, tags: 字串陣列(最多 20 個), desc: String, isCustom: true }
                // 字串截長度（title/badge ≤ 100、desc ≤ 500、url ≤ 2000、badgeClass ≤ 200、每個 tag ≤ 40）
                // url 必須以 http:// 或 https:// 開頭，否則該筆丟掉；title 空的丟掉；id 空的丟掉
                const custom = [];
                for (const rawItem of body.custom) {
                    if (!rawItem || typeof rawItem !== 'object') continue;

                    const id = String(rawItem.id || '').trim();
                    const title = String(rawItem.title || '').trim();
                    const url = String(rawItem.url || '').trim();

                    if (!id || !title) continue;
                    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;

                    const badge = String(rawItem.badge || '').trim().slice(0, 100);
                    const badgeClass = String(rawItem.badgeClass || '').trim().slice(0, 200);
                    const desc = String(rawItem.desc || '').trim().slice(0, 500);

                    let tags = [];
                    if (Array.isArray(rawItem.tags)) {
                        tags = rawItem.tags
                            .map(t => String(t || '').trim().slice(0, 40))
                            .filter(Boolean)
                            .slice(0, 20);
                    }

                    const cleanCard = {
                        id: id.slice(0, 100),
                        title: title.slice(0, 100),
                        url: url.slice(0, 2000),
                        badge,
                        badgeClass,
                        tags,
                        desc,
                        isCustom: true
                    };
                    if (rawItem.openInNewTab) cleanCard.openInNewTab = true;
                    custom.push(cleanCard);
                }

                // hidden 只留字串、每個 ≤ 100 字
                const hidden = body.hidden
                    .map(h => String(h || '').trim().slice(0, 100))
                    .filter(Boolean);

                const updatedAt = new Date().toISOString();

                await gamesDb.update(
                    { type: 'user', user: safeUser },
                    { $set: { type: 'user', user: safeUser, custom, hidden, updatedAt } },
                    { upsert: true }
                );

                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    customCount: custom.length,
                    hiddenCount: hidden.length,
                    updatedAt
                });
            }
        }

        // ==========================================
        // 0.95 個人 Apple Watch 音樂庫管理 /api/user/music (NeDB 存取)
        // ==========================================
        // /api/user/music（或 /api/music）—— 個人音樂庫。GET 取清單、POST 新增或整批覆寫、DELETE 刪單曲或清空。
        if ((pathname === '/api/user/music' || pathname === '/api/music') && ['GET', 'POST', 'DELETE'].includes(req.method)) {
            // 音樂庫一律屬於登入者本人（?user= / body.user 會被忽略）
            const safeUser = await requireUser(req, res);
            if (!safeUser) return;

            // 1. GET: 取得目前使用者收藏的所有音樂曲目清單
            if (req.method === 'GET') {
                const record = await musicDb.findOne({ user: safeUser });
                const tracks = record && Array.isArray(record.tracks) ? record.tracks : [];
                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    count: tracks.length,
                    tracks: tracks,
                    updatedAt: record ? record.updatedAt : null
                });
            }

            // 2. POST: 收藏新曲目或覆寫儲存整個音樂庫
            if (req.method === 'POST') {
                const body = await parseRequestBody(req);
                const targetUser = safeUser;
                const record = await musicDb.findOne({ user: targetUser });
                let tracks = record && Array.isArray(record.tracks) ? [...record.tracks] : [];

                if (Array.isArray(body.tracks)) {
                    tracks = body.tracks;
                } else if (body.track && (body.track.title || body.track.name)) {
                    const t = body.track;
                    const newTrack = {
                        id: t.id || `track_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                        title: t.title || t.name || '未命名音樂',
                        artist: t.artist || t.singer || 'ACG 經典',
                        cover: t.cover || t.image || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&q=80',
                        src: t.src || t.audioUrl || '',
                        bgmId: t.bgmId || null,
                        duration: t.duration || 0,
                        addedAt: new Date().toISOString()
                    };

                    // 去重：用 bgmId、id、或「歌名+歌手」判斷是不是同一首歌。已存在就合併更新，沒有才放到清單最前面(unshift)。
                    const existingIndex = tracks.findIndex(item =>
                        (newTrack.bgmId && item.bgmId === newTrack.bgmId) ||
                        (newTrack.id && item.id === newTrack.id) ||
                        (item.title === newTrack.title && item.artist === newTrack.artist)
                    );

                    if (existingIndex >= 0) {
                        tracks[existingIndex] = { ...tracks[existingIndex], ...newTrack, updatedAt: new Date().toISOString() };
                    } else {
                        tracks.unshift(newTrack);
                    }
                }

                const updatedAt = await saveMusicTracks(targetUser, tracks);

                return sendJson(res, 200, {
                    success: true,
                    user: targetUser,
                    count: tracks.length,
                    tracks: tracks,
                    savedAt: updatedAt,
                    message: '音樂庫已成功同步至 NeDB 資料庫！'
                });
            }

            // 3. DELETE: 刪除指定的收藏歌曲或清空
            if (req.method === 'DELETE') {
                const targetUser = safeUser;
                const trackId = query.id || query.trackId;
                const record = await musicDb.findOne({ user: targetUser });
                let tracks = record && Array.isArray(record.tracks) ? [...record.tracks] : [];

                // 有帶 id 就只移除那一首；沒帶就清空全部。同時比對 id 與 bgmId，所以兩種編號都能刪。
                if (trackId) {
                    tracks = tracks.filter(t => t.id !== trackId && String(t.bgmId) !== String(trackId));
                } else {
                    tracks = [];
                }

                await saveMusicTracks(targetUser, tracks);

                return sendJson(res, 200, {
                    success: true,
                    user: targetUser,
                    count: tracks.length,
                    tracks: tracks,
                    message: trackId ? '已自 NeDB 音樂庫移除該曲目' : '音樂庫已成功清空'
                });
            }
        }

        // ==========================================
        // 0.96 開源線上歌曲即時搜尋端點 /api/music/search?q=... (完整長度原曲 3-5 分鐘、高清封面與正版串流音訊)
        // ==========================================
        // GET /api/music/search?q=關鍵字 —— 線上搜歌。回應：{ success, keyword, count, tracks:[{ id, title, artist, album, cover, src, duration, isFull }] }。
        // 策略：先查網易雲音樂(可播完整曲)；結果為空或失敗時改用 iTunes(只有 30 秒試聽)當備援。缺關鍵字 400。
        if ((pathname === '/api/music/search' || pathname === '/api/user/music/search') && req.method === 'GET') {
            const keyword = (query.q || query.term || query.keyword || '').trim();
            if (!keyword) {
                return sendJson(res, 400, { success: false, error: '請輸入欲搜尋之歌曲或歌手關鍵字' });
            }

            try {
                // 優先使用網易雲/Meting 開源音訊引擎取得 3~5 分鐘完整歌曲 MP3 原曲
                // 用 Promise 包住 https.get 的 callback 風格 API，所有失敗情況都 resolve([]) 而不是 reject，讓外層能乾淨地走備援流程。
                const neteaseUrl = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=15`;

                let tracks = [];
                try {
                    const fetchRes = await new Promise((resolve, reject) => {
                        const netReq = https.get(neteaseUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Referer': 'https://music.163.com'
                            },
                            timeout: 7000
                        }, (nRes) => {
                            let rawData = '';
                            nRes.on('data', chunk => rawData += chunk);
                            nRes.on('end', async () => {
                                try {
                                    const json = JSON.parse(rawData);
                                    const rawSongs = (json.result && Array.isArray(json.result.songs)) ? json.result.songs : [];
                                    if (rawSongs.length === 0) return resolve([]);

                                    // 排序：fee 為 0 或 8 的歌可以免費播完整首，優先排前面；fee=1 是 VIP 限定，只能試聽 30 秒，排後面。
                                    // 智能排序：優先將開放完整串流音軌 (fee === 0 或 fee === 8) 排在前面，避免 VIP 限制導致被截斷為 30 秒試聽
                                    const songs = [...rawSongs].sort((a, b) => {
                                        const aFree = (a.fee === 0 || a.fee === 8) ? 0 : 1;
                                        const bFree = (b.fee === 0 || b.fee === 8) ? 0 : 1;
                                        return aFree - bFree;
                                    });

                                    // 搜尋結果沒有好的封面，所以再用一次批次查詢，把多首歌的 id 一次送出(省請求)，建立 id -> 封面網址 的對照表 coverMap。
                                    // 批次取得真實專輯高清封面 (透過 /api/song/detail 批次端點)
                                    const songIds = songs.map(s => s.id);
                                    let coverMap = {};
                                    try {
                                        const detailUrl = `https://music.163.com/api/song/detail/?ids=%5B${songIds.join(',')}%5D`;
                                        const detailJson = await new Promise(resD => {
                                            https.get(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 }, rD => {
                                                let dData = '';
                                                rD.on('data', c => dData += c);
                                                rD.on('end', () => {
                                                    try { resD(JSON.parse(dData)); } catch(e) { resD(null); }
                                                });
                                            }).on('error', () => resD(null));
                                        });

                                        if (detailJson && Array.isArray(detailJson.songs)) {
                                            detailJson.songs.forEach(item => {
                                                if (item.album && item.album.picUrl) {
                                                    coverMap[item.id] = item.album.picUrl.replace(/^http:/, 'https:');
                                                }
                                            });
                                        }
                                    } catch(e) {}

                                    // 整理成前端統一格式。封面 http 轉 https（避免混合內容被瀏覽器擋）；src 用 meting 代理服務取得真實音檔網址。
                                    const formatted = songs.map(s => {
                                        const songId = s.id;
                                        // 優先使用真實專輯封面，次之歌手圖，最後兜底高品質音樂封面
                                        const rawCover = coverMap[songId] ||
                                            (s.album && s.album.picUrl ? s.album.picUrl.replace(/^http:/, 'https:') : '') ||
                                            (s.artists && s.artists[0] && s.artists[0].img1v1Url ? s.artists[0].img1v1Url.replace(/^http:/, 'https:') : '');

                                        const finalCover = (rawCover && !rawCover.includes('5639395138885805')) ? rawCover : 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&q=80';
                                        const artistName = s.artists && s.artists.length > 0 ? s.artists.map(a => a.name).join(' / ') : '未知歌手';
                                        const isVipRestricted = (s.fee === 1);
                                        const actualDuration = isVipRestricted ? 30 : (s.duration ? Math.round(s.duration / 1000) : 0);

                                        return {
                                            id: 'net_' + songId,
                                            title: s.name,
                                            artist: artistName,
                                            album: s.album ? s.album.name : '',
                                            cover: finalCover,
                                            src: `https://api.injahow.cn/meting/?server=netease&type=url&id=${songId}`,
                                            duration: actualDuration,
                                            isFull: !isVipRestricted
                                        };
                                    });
                                    resolve(formatted);
                                } catch (e) {
                                    resolve([]);
                                }
                            });
                        });
                        netReq.on('error', () => resolve([]));
                        netReq.on('timeout', () => { netReq.destroy(); resolve([]); });
                    });

                    if (fetchRes && fetchRes.length > 0) {
                        tracks = fetchRes;
                    }
                } catch (netErr) {
                    console.warn('[Netease Search Fallback to iTunes]:', netErr.message);
                }

                // 若網易雲無結果，則使用 iTunes API 作為容錯備援
                if (tracks.length === 0) {
                    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&media=music&entity=song&limit=15`;
                    const itunesRes = await new Promise((resolve) => {
                        const iReq = https.get(itunesUrl, {
                            headers: { 'User-Agent': 'Mozilla/5.0' },
                            timeout: 6000
                        }, (resI) => {
                            let data = '';
                            resI.on('data', c => data += c);
                            resI.on('end', () => {
                                try {
                                    const json = JSON.parse(data);
                                    const results = json.results || [];
                                    const formatted = results.map(item => ({
                                        id: 'itunes_' + item.trackId,
                                        title: item.trackName,
                                        artist: item.artistName,
                                        album: item.collectionName || '',
                                        cover: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
                                        src: item.previewUrl,
                                        duration: 30,
                                        isFull: false
                                    }));
                                    resolve(formatted);
                                } catch(e) { resolve([]); }
                            });
                        });
                        iReq.on('error', () => resolve([]));
                        iReq.on('timeout', () => { iReq.destroy(); resolve([]); });
                    });
                    tracks = itunesRes;
                }

                return sendJson(res, 200, {
                    success: true,
                    keyword,
                    count: tracks.length,
                    tracks
                });
            } catch (err) {
                console.error('[Online Music Search Error]:', err.message);
                return sendJson(res, 500, {
                    success: false,
                    error: '線上歌曲搜尋服務異常: ' + err.message
                });
            }
        }

        // ==========================================
        // 0.9 快捷記事本截圖：上傳存成檔案 (避免把 dataURL 塞進 NeDB)，再以網址讀回
        // ==========================================
        // 截圖：POST 上傳存檔、GET 讀取。圖檔放在資料夾而不是資料庫，因為 dataURL 動輒數百 KB，塞進 NeDB 會讓資料庫變肥變慢。
        // 上傳要登入（避免任何人灌檔案塞爆硬碟）；讀取不用，因為 <img> 無法帶標頭，檔名本身是猜不到的隨機字串
        if (pathname === '/api/bookmarks/screenshot' && req.method === 'POST') {
            if (!await requireUser(req, res)) return;
            return await handleScreenshotUpload(req, res);
        }
        if (pathname.startsWith('/api/bookmarks/screenshot/') && req.method === 'GET') {
            return serveScreenshot(pathname.slice('/api/bookmarks/screenshot/'.length), res);
        }

        // ==========================================
        // 1. 跨電腦書籤收藏同步端點 /api/user/bookmarks 與 Tampermonkey 收藏端點 /api/bookmarks (NeDB 存取)
        // ==========================================
        // /api/user/bookmarks（或 /api/bookmarks）—— 書籤雲端同步，也是 Tampermonkey 腳本一鍵收藏的入口。
        // GET：取回該帳號書籤；POST 有兩種用法：(1) body.bookmarks 陣列 = 整批覆蓋；(2) 單筆 = 新增/更新一筆。
        if (pathname === '/api/user/bookmarks' || pathname === '/api/bookmarks') {
            // GET: 從 NeDB 拉取該帳號最新收藏
            if (req.method === 'GET') {
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;

                const record = await bookmarksDb.findOne({ user: safeUser });
                if (!record) {
                    return sendJson(res, 200, {
                        success: true,
                        user: safeUser,
                        count: 0,
                        bookmarks: [],
                        isNewUser: true,
                        message: '帳號尚無 NeDB 書籤存檔'
                    });
                }

                const bookmarks = Array.isArray(record.bookmarks) ? record.bookmarks : [];
                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    count: bookmarks.length,
                    bookmarks: bookmarks,
                    updatedAt: record.updatedAt || null
                });
            }
            // POST: 將客戶端收藏寫入 NeDB
            else if (req.method === 'POST') {
                const safeUser = await requireUser(req, res);
                if (!safeUser) return;
                const body = await parseRequestBody(req);

                const existing = await bookmarksDb.findOne({ user: safeUser }) || { bookmarks: [] };
                let bookmarksList = Array.isArray(existing.bookmarks) ? existing.bookmarks : [];

                if (Array.isArray(body.bookmarks)) {
                    // 整批模式：逐筆重新整理欄位(補預設值、去空白)，不信任前端傳來的格式。id 沒給就用時間戳自動產生。
                    // 整批覆蓋更新
                    bookmarksList = body.bookmarks.map((b, idx) => ({
                        id: b.id || ('bm_' + (Date.now() + idx)),
                        title: (b.title || '未命名網頁').trim(),
                        url: (b.url || '').trim(),
                        category: b.category || 'web',
                        tags: Array.isArray(b.tags) ? b.tags : (b.tags ? [b.tags] : []),
                        cover: b.cover || b.coverUrl || '',
                        desc: b.desc || b.description || '',
                        pinned: !!b.pinned,
                        clicks: typeof b.clicks === 'number' ? b.clicks : 0,
                        createdAt: b.createdAt || new Date().toISOString()
                    }));
                } else {
                    // 單筆模式：用「網址」判斷是否已收藏過；有就更新(保留原本其他欄位)，沒有就加到最前面。這就是少數的合併情況，避免重複收藏。
                    // Tampermonkey 單筆快速收藏
                    const bm = body.bookmark || body;
                    if (!bm.url && !bm.title) {
                        return sendJson(res, 400, { success: false, error: '請提供有效的書籤資料 (缺少 url 或 title)' });
                    }

                    const newBm = {
                        id: bm.id || ('bm_' + Date.now()),
                        title: (bm.title || '未命名網頁').trim(),
                        url: (bm.url || '').trim(),
                        category: bm.category || 'web',
                        tags: Array.isArray(bm.tags) ? bm.tags : (bm.tags ? [bm.tags] : []),
                        cover: bm.cover || bm.coverUrl || '',
                        desc: bm.desc || bm.description || '',
                        pinned: !!bm.pinned,
                        clicks: 0,
                        createdAt: bm.createdAt || new Date().toISOString()
                    };

                    const existIdx = bookmarksList.findIndex(b => b.url === newBm.url);
                    if (existIdx >= 0) {
                        bookmarksList[existIdx] = { ...bookmarksList[existIdx], ...newBm };
                    } else {
                        bookmarksList.unshift(newBm);
                    }
                }

                const updatedAt = new Date().toISOString();
                await bookmarksDb.update(
                    { user: safeUser },
                    { $set: { user: safeUser, count: bookmarksList.length, bookmarks: bookmarksList, updatedAt } },
                    { upsert: true }
                );

                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    count: bookmarksList.length,
                    savedAt: updatedAt,
                    message: '書籤已成功儲存並同步至 NeDB 資料庫！'
                });
            }
        }
        // ==========================================
        // ===== Bangumi 代理區：以下端點都只是「轉發」，真正資料在 Bangumi 官方。回應格式統一為 { success, status, data }。
        // 使用者的 Access Token 由前端傳來(body、query 或 Authorization 標頭)，伺服器不儲存。
        // 2. Bangumi 雙向同步代理端點
        // ==========================================
        // POST /api/bangumi/me —— 驗證 Token 是否有效。body：{ token }。成功回傳 Bangumi 使用者資料；失敗原樣回傳官方狀態碼。
        // A. 驗證使用者 Access Token /api/bangumi/me
        else if (pathname === '/api/bangumi/me' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const token = (body.token || '').trim();
            if (!token) return sendJson(res, 400, { success: false, error: '請提供 Bangumi Access Token' });

            const result = await forwardToBangumi('/v0/me', 'GET', token);
            if (result.statusCode === 200) {
                return sendJson(res, 200, { success: true, user: result.data });
            } else {
                return sendJson(res, result.statusCode, { success: false, error: 'Token 驗證失敗', details: result.data });
            }
        }
        // POST /api/bangumi/collection —— 設定某作品的收藏狀態。body：{ token, subjectId, type, rating?, comment?, username? }。
        // type 1想看 2看過 3在看 4擱置 5拋棄。username 沒給就用 token 向官方反查；實在查不到用 "-" 代表「目前登入者」。
        // B. 變更收藏狀態 /api/bangumi/collection (想看/看過/在看/擱置/拋棄)
        else if (pathname === '/api/bangumi/collection' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const token = (body.token || '').trim();
            const subjectId = body.subjectId;
            const statusType = parseInt(body.type || '3', 10);
            const rating = body.rating ? parseInt(body.rating, 10) : undefined;
            const comment = body.comment || undefined;

            if (!token) return sendJson(res, 400, { success: false, error: '缺少 Bangumi Access Token' });
            if (!subjectId) return sendJson(res, 400, { success: false, error: '缺少 subjectId' });

            const payload = { type: statusType };
            if (rating) payload.rate = rating;
            if (comment) payload.comment = comment;

            let username = (body.username || '').trim();
            if (!username && token) {
                username = await resolveUsernameFromToken(token);
            }
            const userEndpoint = username ? encodeURIComponent(username) : '-';
            const result = await forwardToBangumi(`/v0/users/${userEndpoint}/collections/${subjectId}`, 'POST', token, payload);
            return sendJson(res, result.statusCode, {
                success: result.statusCode >= 200 && result.statusCode < 300,
                status: result.statusCode,
                data: result.data
            });
        }
        // GET /api/bangumi/collection?subjectId= —— 查詢某作品的收藏狀態。官方回 404 代表「還沒收藏」，這不算錯誤，轉成 type:0 讓前端好處理。
        // B-2. 查詢指定作品的收藏狀態 /api/bangumi/collection?subjectId=... (GET)
        else if (pathname === '/api/bangumi/collection' && req.method === 'GET') {
            const token = (query.token || (req.headers['authorization'] || '').replace('Bearer ', '')).trim();
            const subjectId = query.subjectId;
            let username = (query.username || '').trim();

            if (!token && !username) return sendJson(res, 400, { success: false, error: '缺少 Bangumi Access Token 或 username' });
            if (!subjectId) return sendJson(res, 400, { success: false, error: '缺少 subjectId' });

            if (!username && token) {
                username = await resolveUsernameFromToken(token);
            }
            if (!username) {
                return sendJson(res, 400, { success: false, error: '無法識別 Bangumi 使用者名稱' });
            }

            const result = await forwardToBangumi(`/v0/users/${encodeURIComponent(username)}/collections/${subjectId}`, 'GET', token);
            if (result.statusCode === 404) {
                return sendJson(res, 200, {
                    success: true,
                    status: 200,
                    data: { type: 0, status: 'uncollected' }
                });
            }
            return sendJson(res, result.statusCode, {
                success: result.statusCode >= 200 && result.statusCode < 300,
                status: result.statusCode,
                data: result.data || { type: 0 }
            });
        }
        // GET /api/bangumi/search?q=&type= —— 搜尋作品。官方回傳格式可能是 {list:[]} 或直接陣列，這裡兩種都接，再統一包成 data.data。
        // B-3. 關鍵字搜尋作品取得 Bangumi Subject /api/bangumi/search?q=...&type=... (GET)
        else if (pathname === '/api/bangumi/search' && req.method === 'GET') {
            const token = (query.token || (req.headers['authorization'] || '').replace('Bearer ', '')).trim();
            const q = query.q || '';
            const type = query.type || '2';
            if (!q) return sendJson(res, 400, { success: false, error: '缺少關鍵字 q' });

            const searchPath = `/search/subject/${encodeURIComponent(q)}?type=${encodeURIComponent(type)}&responseGroup=small`;
            const result = await forwardToBangumi(searchPath, 'GET', token || null);

            let list = [];
            if (result.data && Array.isArray(result.data.list)) {
                list = result.data.list;
            } else if (Array.isArray(result.data)) {
                list = result.data;
            }

            return sendJson(res, result.statusCode, {
                success: result.statusCode >= 200 && result.statusCode < 300,
                status: result.statusCode,
                data: { data: list }
            });
        }
        // POST /api/bangumi/episodes —— 更新觀看進度。兩種方式：
        //   帶 episodeId：用 PUT 標記單一集數的狀態；帶 watchedEpisodes：用 PATCH 一次設定已看到第幾集。兩者都沒帶回 400。
        // C. 更新追番 / 閱讀集數進度 /api/bangumi/episodes
        else if (pathname === '/api/bangumi/episodes' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const token = (body.token || '').trim();
            const subjectId = body.subjectId;
            const episodeId = body.episodeId;
            const epType = parseInt(body.type || '2', 10);

            if (!token) return sendJson(res, 400, { success: false, error: '缺少 Bangumi Access Token' });
            if (!subjectId) return sendJson(res, 400, { success: false, error: '缺少 subjectId' });

            let result;
            if (episodeId) {
                result = await forwardToBangumi(`/v0/users/-/collections/${subjectId}/episodes/${episodeId}`, 'PUT', token, { type: epType });
            } else if (body.watchedEpisodes !== undefined) {
                result = await forwardToBangumi(`/v0/users/-/collections/${subjectId}`, 'PATCH', token, {
                    ep_status: parseInt(body.watchedEpisodes, 10)
                });
            } else {
                return sendJson(res, 400, { success: false, error: '請提供 episodeId 或 watchedEpisodes' });
            }

            return sendJson(res, result.statusCode, {
                success: result.statusCode >= 200 && result.statusCode < 300,
                status: result.statusCode,
                data: result.data
            });
        }
        else {
            return sendJson(res, 404, { success: false, error: '找不到該同步 API 端點' });
        }
    } catch (err) {
        console.error('[Sync API Error]:', err.message);
        return sendJson(res, 500, { success: false, error: err.message });
    }
}

// 只匯出 handleSyncRoute 這個函式，server.js 用 require 取得後掛到路由表。
module.exports = {
    handleSyncRoute
};
