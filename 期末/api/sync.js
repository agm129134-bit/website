/**
 * Web Library - 跨電腦雲端同步與 Bangumi 雙向同步核心模組
 * 採用 Node.js 原生環境 (CommonJS, http, https, fs, path, url)
 * 零依賴、免裝 npm 套件！支援多帳號伺服器端持久化與 Bangumi 雙向狀態更新
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

// 取得與持久化系統帳號清單 (支援多使用者檔案持久化，解決 getAccountsList is not defined 致命錯誤)
function getAccountsList() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        const defaults = [
            { username: 'admin', password: '123456', name: '管理員 (Admin)', role: '系統管理員', avatar: 'default', bio: '系統全域管理員' },
            { username: 'student', password: 'web2026', name: '學生 (Student)', role: '學生研究員', avatar: 'geek-cat', bio: '探索個人化網頁圖書館' },
            { username: 'jyun', password: '123', name: 'Jyun', role: '核心開發者', avatar: 'cyber', bio: '專案核心作者' }
        ];
        try {
            fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
        } catch (e) {}
        return defaults;
    }
    try {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        return [];
    }
}

function saveAccountsList(accounts) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}


// 統一設置 CORS 與 JSON 回應
function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, PUT');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

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

// 安全純化使用者名稱，避免路徑穿越並統一小寫以支援跨平台 (Linux/Docker) 檔案系統
function sanitizeUsername(username) {
    if (!username) return 'default';
    const clean = username.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '').trim().toLowerCase();
    return clean || 'default';
}

// 取得使用者儲存檔案路徑 (支援跨平台大小寫自動相容，確保 Linux / Docker 下 Jyun 與 jyun 100% 互通)
function getUserFilePath(username) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const safeUser = sanitizeUsername(username);
    const directPath = path.join(DATA_DIR, `bookmarks_${safeUser}.json`);
    if (fs.existsSync(directPath)) return directPath;

    // 遍歷比對 (忽略大小寫以防舊檔案保留大寫)
    try {
        const files = fs.readdirSync(DATA_DIR);
        const matched = files.find(f => f.toLowerCase() === `bookmarks_${safeUser}.json`);
        if (matched) return path.join(DATA_DIR, matched);
    } catch (e) {}

    return directPath;
}

// 記憶當前伺服器中最後活躍登入的使用者（供 Tampermonkey 快捷收藏自動動態歸屬）
let _currentSessionUser = 'jyun';

// 取得當前伺服器中已存在的活躍使用者（供 Tampermonkey 快捷收藏自動歸屬）
function getDefaultActiveUser() {
    if (_currentSessionUser && _currentSessionUser !== 'default' && _currentSessionUser !== '期末展示學生' && _currentSessionUser !== '訪客') {
        return _currentSessionUser;
    }
    try {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            const userFiles = files.filter(f => f.startsWith('bookmarks_') && f.endsWith('.json'));
            if (userFiles.length > 0) {
                // 優先使用非 default 的實體帳號（如 jyun）
                const nonDefault = userFiles.find(f => !f.includes('default') && !f.includes('期末展示學生'));
                const chosen = nonDefault || userFiles[0];
                return chosen.replace('bookmarks_', '').replace('.json', '');
            }
        }
    } catch (e) {}
    return 'default';
}

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

// 記憶體快取：Token 對應之 Bangumi 使用者名稱
const tokenToUsernameMap = new Map();
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

/**
 * 處理跨電腦同步與 Bangumi 雙向同步路由
 */
async function handleSyncRoute(req, res) {
    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH, PUT',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    try {
        // ==========================================
        // 0. 取得本機已存在的所有使用者帳號清單 /api/user/list
        // ==========================================
        if (pathname === '/api/user/list') {
            try {
                const userList = [];
                if (fs.existsSync(DATA_DIR)) {
                    const files = fs.readdirSync(DATA_DIR);
                    files.forEach(f => {
                        if (f.startsWith('bookmarks_') && f.endsWith('.json')) {
                            const u = f.replace('bookmarks_', '').replace('.json', '');
                            // 過濾帶有中文後綴的重複錯誤檔案
                            if (u && !u.includes('專案開發者') && !u.includes('測試帳號') && !userList.includes(u)) {
                                userList.push(u);
                            }
                        }
                    });
                }
                if (!userList.includes('jyun')) userList.unshift('jyun');
                return sendJson(res, 200, { success: true, users: userList });
            } catch (e) {
                return sendJson(res, 200, { success: true, users: ['jyun', 'test1', 'admin', 'student'] });
            }
        }

        // ==========================================
        // 0.5 刪除使用者帳號及其所有雲端書籤 /api/user/delete
        // ==========================================
        if (pathname === '/api/user/delete') {
            let username = query.user;
            if (!username && (req.method === 'POST' || req.method === 'DELETE')) {
                const body = await parseRequestBody(req);
                username = body.user || body.username;
            }
            if (!username) {
                return sendJson(res, 400, { success: false, error: '缺少 user 參數' });
            }

            const cleanUser = sanitizeUsername(username);
            const filePath = getUserFilePath(cleanUser);

            let deleted = false;
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    deleted = true;
                } catch (e) {
                    return sendJson(res, 500, { success: false, error: '刪除檔案失敗: ' + e.message });
                }
            }

            return sendJson(res, 200, {
                success: true,
                user: cleanUser,
                deletedFile: deleted,
                message: `帳號 [${cleanUser}] 及其伺服器端資料已成功刪除！`
            });
        }

        // ==========================================
        // 0.6 清空使用者帳號書籤 /api/user/clear
        // ==========================================
        if (pathname === '/api/user/clear') {
            let username = query.user;
            if (!username && (req.method === 'POST' || req.method === 'DELETE')) {
                const body = await parseRequestBody(req);
                username = body.user || body.username;
            }
            if (!username) {
                return sendJson(res, 400, { success: false, error: '缺少 user 參數' });
            }

            const cleanUser = sanitizeUsername(username);
            const filePath = getUserFilePath(cleanUser);

            const emptyData = {
                user: cleanUser,
                count: 0,
                bookmarks: [],
                updatedAt: new Date().toISOString()
            };
            try {
                fs.writeFileSync(filePath, JSON.stringify(emptyData, null, 2), 'utf-8');
            } catch (e) {
                return sendJson(res, 500, { success: false, error: '清空失敗: ' + e.message });
            }

            return sendJson(res, 200, {
                success: true,
                user: cleanUser,
                count: 0,
                message: `帳號 [${cleanUser}] 的書籤已自伺服器成功清空！`
            });
        }


        // ==========================================
        // 0.7 忘記密碼與重設密碼 /api/user/reset-password
        // ==========================================
        if (pathname === '/api/user/reset-password' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const username = sanitizeUsername(body.username || body.user || '');
            const newPassword = String(body.newPassword || body.password || '').trim();

            if (!username) {
                return sendJson(res, 400, { success: false, error: '請提供欲重設之使用者帳號' });
            }
            if (!newPassword || newPassword.length < 3) {
                return sendJson(res, 400, { success: false, error: '新密碼至少需 3 個字元' });
            }

            const accounts = getAccountsList();
            let acc = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
            let isSamePassword = false;

            if (acc) {
                isSamePassword = (acc.password === newPassword);
                acc.password = newPassword;
                acc.updatedAt = new Date().toISOString();
            } else {
                acc = {
                    username: username,
                    password: newPassword,
                    name: username,
                    role: '註冊使用者',
                    avatar: 'avatar-1',
                    bio: '',
                    createdAt: new Date().toISOString()
                };
                accounts.push(acc);
            }

            saveAccountsList(accounts);

            return sendJson(res, 200, {
                success: true,
                user: username,
                samePassword: isSamePassword,
                message: isSamePassword 
                    ? '哈哈！你輸入了跟先前一模一樣的密碼！系統已為您完成密碼確認重設。'
                    : '密碼已成功重設！請使用新密碼登入。'
            });
        }

        // ==========================================
        // 0.8 個人資料取得與更新 /api/user/profile
        // ==========================================
        if (pathname === '/api/user/profile') {
            if (req.method === 'GET') {
                const username = sanitizeUsername(query.user || query.username || getDefaultActiveUser());
                const accounts = getAccountsList();
                const acc = accounts.find(a => a.username.toLowerCase() === username.toLowerCase()) || {
                    username: username,
                    name: username,
                    role: '使用者',
                    avatar: 'avatar-1',
                    bio: '探索個人化網頁圖書館',
                    sortPref: 'clicks',
                    themePref: 'dark'
                };
                return sendJson(res, 200, {
                    success: true,
                    profile: {
                        username: acc.username,
                        name: acc.name || acc.username,
                        role: acc.role || '使用者',
                        avatar: acc.avatar || 'avatar-1',
                        bio: acc.bio || '',
                        sortPref: acc.sortPref || 'clicks',
                        themePref: acc.themePref || 'dark'
                    }
                });
            }

            if (req.method === 'POST') {
                const body = await parseRequestBody(req);
                const username = sanitizeUsername(body.username || body.user || '');
                if (!username) {
                    return sendJson(res, 400, { success: false, error: '缺少帳號 username' });
                }

                const accounts = getAccountsList();
                let acc = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
                if (!acc) {
                    acc = { username: username, password: '', name: username, role: '使用者' };
                    accounts.push(acc);
                }

                // 若要修改密碼，需比對舊密碼
                if (body.newPassword && body.newPassword.trim()) {
                    const newPw = body.newPassword.trim();
                    const oldPw = (body.oldPassword || '').trim();
                    if (acc.password && acc.password !== oldPw) {
                        return sendJson(res, 400, { success: false, error: '原登入密碼不正確，無法修改密碼！' });
                    }
                    acc.password = newPw;
                }

                if (body.name !== undefined) acc.name = String(body.name).trim();
                if (body.bio !== undefined) acc.bio = String(body.bio).trim();
                if (body.avatar !== undefined) acc.avatar = String(body.avatar).trim();
                if (body.sortPref !== undefined) acc.sortPref = String(body.sortPref).trim();
                if (body.themePref !== undefined) acc.themePref = String(body.themePref).trim();
                acc.updatedAt = new Date().toISOString();

                saveAccountsList(accounts);

                return sendJson(res, 200, {
                    success: true,
                    message: '個人設定與資料已成功儲存至伺服器！',
                    profile: {
                        username: acc.username,
                        name: acc.name,
                        role: acc.role,
                        avatar: acc.avatar,
                        bio: acc.bio,
                        sortPref: acc.sortPref,
                        themePref: acc.themePref
                    }
                });
            }
        }

        // ==========================================
        // 1. 跨電腦書籤收藏同步端點 /api/user/bookmarks 與 Tampermonkey 收藏端點 /api/bookmarks
        // ==========================================
        if (pathname === '/api/user/bookmarks' || pathname === '/api/bookmarks') {
            // GET: 從伺服器拉取該帳號最新收藏
            if (req.method === 'GET') {
                let username = query.user || getDefaultActiveUser();
                // 智慧帳號歸屬映射：若前端未登入或為展示帳號，自動對齊當前活躍實體帳號 (如 jyun)
                if ((username === '期末展示學生' || username === 'default') && getDefaultActiveUser() !== 'default') {
                    username = getDefaultActiveUser();
                } else if (username && username !== 'default' && username !== '期末展示學生' && username !== '訪客') {
                    _currentSessionUser = sanitizeUsername(username);
                }
                const filePath = getUserFilePath(username);

                if (!fs.existsSync(filePath)) {
                    // 全新或已刪除帳號預設為空書籤庫，絕不自動在磁碟建立幽靈檔案，亦不自動帶入其他帳號書籤
                    return sendJson(res, 200, {
                        success: true,
                        user: sanitizeUsername(username),
                        count: 0,
                        bookmarks: [],
                        isNewUser: true,
                        message: '帳號無伺服器端存檔'
                    });
                }

                try {
                    const fileContent = fs.readFileSync(filePath, 'utf-8');
                    const parsed = JSON.parse(fileContent);
                    const bookmarks = Array.isArray(parsed) ? parsed : (parsed.bookmarks || []);
                    return sendJson(res, 200, {
                        success: true,
                        user: sanitizeUsername(username),
                        count: bookmarks.length,
                        bookmarks: bookmarks,
                        updatedAt: parsed.updatedAt || null
                    });
                } catch (e) {
                    return sendJson(res, 500, { success: false, error: '檔案讀取失敗: ' + e.message });
                }
            }

            // POST: 將客戶端收藏寫入伺服器端檔案 (支援整包覆蓋與 Tampermonkey 單筆快速插入)
            else if (req.method === 'POST') {
                const body = await parseRequestBody(req);
                let username = body.user || query.user || getDefaultActiveUser();
                if ((username === '期末展示學生' || username === 'default') && getDefaultActiveUser() !== 'default') {
                    username = getDefaultActiveUser();
                } else if (username && username !== 'default' && username !== '期末展示學生' && username !== '訪客') {
                    _currentSessionUser = sanitizeUsername(username);
                }
                const filePath = getUserFilePath(username);

                let currentData = { user: sanitizeUsername(username), count: 0, bookmarks: [] };
                if (fs.existsSync(filePath)) {
                    try {
                        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                        currentData.bookmarks = Array.isArray(parsed) ? parsed : (parsed.bookmarks || []);
                    } catch (e) {}
                }

                if (Array.isArray(body.bookmarks)) {
                    // 情境 A: 前端整批雙向同步或覆蓋更新 (全面標準化所有欄位，確保 id 絕不缺失)
                    currentData.bookmarks = body.bookmarks.map((b, idx) => ({
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
                    // 情境 B: 篡改猴插件 (Tampermonkey) 單筆快速收藏
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

                    // 若已存在相同網址則更新，否則插在最前 (unshift)
                    const existIdx = currentData.bookmarks.findIndex(b => b.url === newBm.url);
                    if (existIdx >= 0) {
                        currentData.bookmarks[existIdx] = { ...currentData.bookmarks[existIdx], ...newBm };
                    } else {
                        currentData.bookmarks.unshift(newBm);
                    }
                }

                currentData.count = currentData.bookmarks.length;
                currentData.updatedAt = new Date().toISOString();
                currentData.user = sanitizeUsername(username);

                fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2), 'utf-8');

                return sendJson(res, 200, {
                    success: true,
                    user: currentData.user,
                    count: currentData.count,
                    savedAt: currentData.updatedAt,
                    message: '書籤已成功儲存並同步至 Web Library！'
                });
            }
        }

        // ==========================================
        // 2. Bangumi 雙向同步代理端點
        // ==========================================

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

        // B. 變更收藏狀態 /api/bangumi/collection (想看/看過/在看/擱置/拋棄)
        else if (pathname === '/api/bangumi/collection' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const token = (body.token || '').trim();
            const subjectId = body.subjectId;
            const statusType = parseInt(body.type || '3', 10); // 1:想看, 2:看過, 3:在看, 4:擱置, 5:拋棄
            const rating = body.rating ? parseInt(body.rating, 10) : undefined;
            const comment = body.comment || undefined;

            if (!token) return sendJson(res, 400, { success: false, error: '缺少 Bangumi Access Token' });
            if (!subjectId) return sendJson(res, 400, { success: false, error: '缺少 subjectId' });

            const payload = { type: statusType };
            if (rating) payload.rate = rating;
            if (comment) payload.comment = comment;

            // Bangumi API: POST /v0/users/{username}/collections/{subject_id}
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
                // 404 在 Bangumi 表示作品未被該使用者收藏
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

        // B-3. 關鍵字搜尋作品取得 Bangumi Subject /api/bangumi/search?q=...&type=... (GET)
        else if (pathname === '/api/bangumi/search' && req.method === 'GET') {
            const token = (query.token || (req.headers['authorization'] || '').replace('Bearer ', '')).trim();
            const q = query.q || '';
            const type = query.type || '2'; // 1: book, 2: anime
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

        // C. 更新追番 / 閱讀集數進度 /api/bangumi/episodes
        else if (pathname === '/api/bangumi/episodes' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const token = (body.token || '').trim();
            const subjectId = body.subjectId;
            const episodeId = body.episodeId;
            const epType = parseInt(body.type || '2', 10); // 2: 看過 / 1: 想看 / 3: 拋棄

            if (!token) return sendJson(res, 400, { success: false, error: '缺少 Bangumi Access Token' });
            if (!subjectId) return sendJson(res, 400, { success: false, error: '缺少 subjectId' });

            let result;
            if (episodeId) {
                // 單集更新: PUT /v0/users/-/collections/{subject_id}/episodes/{episode_id}
                result = await forwardToBangumi(`/v0/users/-/collections/${subjectId}/episodes/${episodeId}`, 'PUT', token, { type: epType });
            } else if (body.watchedEpisodes !== undefined) {
                // 批次進度更新: PATCH /v0/users/-/collections/{subject_id}
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

module.exports = {
    handleSyncRoute
};
