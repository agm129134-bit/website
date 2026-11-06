/**
 * Web Library - 跨電腦雲端同步、NeDB 資料庫與 Bangumi 雙向同步核心模組
 * 採用 nedb-promises 嵌入式 NoSQL 資料庫 + Node.js 原生 Crypto 加鹽安全雜湊
 * 支援多帳號伺服器端資料庫持久化、無明文密碼儲存與即時雙向狀態同步
 */
const https = require('https');
const {
    accountsDb,
    bookmarksDb,
    bookshelfDb,
    musicDb,
    hashPassword,
    verifyPassword
} = require('./db');

// 統一設置 CORS 與 JSON 回應
function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, PUT, DELETE');
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

// 安全純化使用者名稱，避免路徑穿越並統一小寫
function sanitizeUsername(username) {
    if (!username) return 'default';
    const clean = username.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '').trim().toLowerCase();
    return clean || 'default';
}

// 記憶當前伺服器中最後活躍登入的使用者（供 Tampermonkey 快捷收藏自動動態歸屬）
let _currentSessionUser = 'jyun';

async function getDefaultActiveUser() {
    if (_currentSessionUser && _currentSessionUser !== 'default' && _currentSessionUser !== '期末展示學生' && _currentSessionUser !== '訪客') {
        return _currentSessionUser;
    }
    try {
        const acc = await accountsDb.findOne({ username: 'jyun' });
        if (acc) return 'jyun';
        const first = await accountsDb.findOne({});
        if (first) return first.username;
    } catch (e) {}
    return 'default';
}

// 解析請求所屬帳號：展示/預設帳號歸屬至目前活躍使用者，真實帳號則記為最後活躍者；回傳純化後名稱
async function resolveRequestUser(candidate) {
    const defaultUser = await getDefaultActiveUser();
    let username = candidate || defaultUser;
    if ((username === '期末展示學生' || username === 'default') && defaultUser !== 'default') {
        username = defaultUser;
    } else if (username && username !== 'default' && username !== '期末展示學生' && username !== '訪客') {
        _currentSessionUser = sanitizeUsername(username);
    }
    return sanitizeUsername(username);
}

// 讀取 user 參數：優先 query，其次 POST/DELETE body
async function readUserParam(req, query) {
    if (query.user) return query.user;
    if (req.method === 'POST' || req.method === 'DELETE') {
        const body = await parseRequestBody(req);
        return body.user || body.username;
    }
    return undefined;
}

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
 * 處理跨電腦同步、NeDB 資料庫與 Bangumi 雙向同步路由
 */
async function handleSyncRoute(req, res) {
    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    try {
        // ==========================================
        // 0. 取得本機已存在的所有使用者帳號清單 /api/user/list (NeDB 查詢)
        // ==========================================
        if (pathname === '/api/user/list') {
            try {
                const accounts = await accountsDb.find({});
                const userList = accounts.map(a => a.username).filter(Boolean);
                if (!userList.includes('jyun')) userList.unshift('jyun');
                return sendJson(res, 200, { success: true, users: userList });
            } catch (e) {
                return sendJson(res, 200, { success: true, users: ['jyun'] });
            }
        }

        // ==========================================
        // 0.1 使用者登入驗證端點 /api/user/login (NeDB + 加鹽雜湊驗證，拒絕明文)
        // ==========================================
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

            // 若舊密碼為早期明文，在此登入成功瞬間自動平滑升級為加鹽雜湊
            if (acc.password && !acc.password.startsWith('scrypt:')) {
                await accountsDb.update({ username }, { $set: { password: hashPassword(password), updatedAt: new Date().toISOString() } });
                console.log(`[NeDB Security] 帳號 ${username} 密碼已自動平滑升級為加鹽雜湊`);
            }

            _currentSessionUser = username;

            return sendJson(res, 200, {
                success: true,
                message: '登入驗證成功',
                user: {
                    username: acc.username,
                    name: acc.name || acc.username,
                    role: acc.role || '一般會員',
                    avatar: acc.avatar || 'default',
                    bio: acc.bio || '',
                    sortPref: acc.sortPref || 'clicks',
                    themePref: acc.themePref || 'dark'
                }
            });
        }

        // ==========================================
        // 0.2 使用者註冊端點 /api/user/register (NeDB 加鹽雜湊存儲)
        // ==========================================
        if (pathname === '/api/user/register' && req.method === 'POST') {
            const body = await parseRequestBody(req);
            const username = sanitizeUsername(body.username || '');
            const password = String(body.password || '').trim();
            const name = String(body.name || username).trim();
            const role = String(body.role || '一般會員').trim();

            if (!username || username.length < 2) {
                return sendJson(res, 400, { success: false, error: '帳號至少需 2 個字元' });
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
            _currentSessionUser = username;

            return sendJson(res, 200, {
                success: true,
                message: '註冊成功！密碼已安全加密儲存於 NeDB 資料庫。',
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
        if (pathname === '/api/user/delete') {
            const username = await readUserParam(req, query);
            if (!username) {
                return sendJson(res, 400, { success: false, error: '缺少 user 參數' });
            }

            const cleanUser = sanitizeUsername(username);
            await accountsDb.remove({ username: cleanUser }, { multi: true });
            await bookmarksDb.remove({ user: cleanUser }, { multi: true });
            await bookshelfDb.remove({ user: cleanUser }, { multi: true });

            return sendJson(res, 200, {
                success: true,
                user: cleanUser,
                message: `帳號 [${cleanUser}] 及其在 NeDB 資料庫中的所有資料已安全刪除！`
            });
        }

        // ==========================================
        // 0.6 清空使用者帳號書籤 /api/user/clear (NeDB 書籤重設)
        // ==========================================
        if (pathname === '/api/user/clear') {
            const username = await readUserParam(req, query);
            if (!username) {
                return sendJson(res, 400, { success: false, error: '缺少 user 參數' });
            }

            const cleanUser = sanitizeUsername(username);
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

            let acc = await accountsDb.findOne({ username });
            let isSamePassword = false;

            if (acc) {
                isSamePassword = verifyPassword(newPassword, acc.password);
                await accountsDb.update(
                    { username },
                    { $set: { password: hashPassword(newPassword), updatedAt: new Date().toISOString() } }
                );
            } else {
                await accountsDb.insert({
                    username: username,
                    password: hashPassword(newPassword),
                    name: username,
                    role: '註冊使用者',
                    avatar: 'default',
                    bio: '',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }

            return sendJson(res, 200, {
                success: true,
                user: username,
                samePassword: isSamePassword,
                isSamePassword: isSamePassword,
                message: isSamePassword
                    ? '哈哈！你輸入了跟先前一模一樣的密碼！系統已為您完成密碼確認重設。'
                    : '密碼已成功以加鹽雜湊演算法加密並重設！請使用新密碼登入。'
            });
        }

        // ==========================================
        // 0.8 個人資料取得與更新 /api/user/profile (NeDB 操作，安全過濾密碼)
        // ==========================================
        if (pathname === '/api/user/profile') {
            if (req.method === 'GET') {
                const defaultUser = await getDefaultActiveUser();
                const username = sanitizeUsername(query.user || query.username || defaultUser);
                const acc = await accountsDb.findOne({ username }) || {
                    username: username,
                    name: username,
                    role: '使用者',
                    avatar: 'default',
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

            if (req.method === 'POST') {
                const body = await parseRequestBody(req);
                const username = sanitizeUsername(body.username || body.user || '');
                if (!username) {
                    return sendJson(res, 400, { success: false, error: '缺少帳號 username' });
                }

                let acc = await accountsDb.findOne({ username });
                if (!acc) {
                    acc = { username: username, password: '', name: username, role: '使用者', avatar: 'default', bio: '' };
                    await accountsDb.insert(acc);
                }

                const updates = { updatedAt: new Date().toISOString() };

                // 若要修改密碼，需比對舊密碼
                if (body.newPassword && body.newPassword.trim()) {
                    const newPw = body.newPassword.trim();
                    const oldPw = (body.oldPassword || '').trim();
                    if (acc.password && !verifyPassword(oldPw, acc.password)) {
                        return sendJson(res, 400, { success: false, error: '原登入密碼不正確，無法修改密碼！' });
                    }
                    updates.password = hashPassword(newPw); // 加鹽加密儲存
                }

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
        if (pathname === '/api/user/bookshelf' || pathname === '/api/bookshelf') {
            // GET: 從 NeDB 拉取該帳號最新漫畫與小說立體書架
            if (req.method === 'GET') {
                const safeUser = await resolveRequestUser(query.user || query.username);

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
                const body = await parseRequestBody(req);
                const safeUser = await resolveRequestUser(body.user || body.username || query.user);

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
        if (pathname === '/api/user/custom-rules') {
            if (req.method === 'GET') {
                const safeUser = await resolveRequestUser(query.user || query.username);
                const record = await bookshelfDb.findOne({ user: safeUser });
                return sendJson(res, 200, {
                    success: true,
                    user: safeUser,
                    rules: record && Array.isArray(record.customRules) ? record.customRules : [],
                    updatedAt: (record && record.customRulesUpdatedAt) || null
                });
            }
            if (req.method === 'POST') {
                const body = await parseRequestBody(req);
                const safeUser = await resolveRequestUser(body.user || body.username || query.user);
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
        // 0.95 個人 Apple Watch 音樂庫管理 /api/user/music (NeDB 存取)
        // ==========================================
        if (pathname === '/api/user/music' || pathname === '/api/music') {
            const safeUser = await resolveRequestUser(query.user || query.username);

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
                const targetUser = sanitizeUsername(body.user || body.username || safeUser);
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
                const targetUser = sanitizeUsername(query.user || safeUser);
                const trackId = query.id || query.trackId;
                const record = await musicDb.findOne({ user: targetUser });
                let tracks = record && Array.isArray(record.tracks) ? [...record.tracks] : [];

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
        if ((pathname === '/api/music/search' || pathname === '/api/user/music/search') && req.method === 'GET') {
            const keyword = (query.q || query.term || query.keyword || '').trim();
            if (!keyword) {
                return sendJson(res, 400, { success: false, error: '請輸入欲搜尋之歌曲或歌手關鍵字' });
            }

            try {
                // 優先使用網易雲/Meting 開源音訊引擎取得 3~5 分鐘完整歌曲 MP3 原曲
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

                                    // 智能排序：優先將開放完整串流音軌 (fee === 0 或 fee === 8) 排在前面，避免 VIP 限制導致被截斷為 30 秒試聽
                                    const songs = [...rawSongs].sort((a, b) => {
                                        const aFree = (a.fee === 0 || a.fee === 8) ? 0 : 1;
                                        const bFree = (b.fee === 0 || b.fee === 8) ? 0 : 1;
                                        return aFree - bFree;
                                    });

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
        // 1. 跨電腦書籤收藏同步端點 /api/user/bookmarks 與 Tampermonkey 收藏端點 /api/bookmarks (NeDB 存取)
        // ==========================================
        if (pathname === '/api/user/bookmarks' || pathname === '/api/bookmarks') {
            // GET: 從 NeDB 拉取該帳號最新收藏
            if (req.method === 'GET') {
                const safeUser = await resolveRequestUser(query.user);

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
                const body = await parseRequestBody(req);
                const safeUser = await resolveRequestUser(body.user || query.user);

                const existing = await bookmarksDb.findOne({ user: safeUser }) || { bookmarks: [] };
                let bookmarksList = Array.isArray(existing.bookmarks) ? existing.bookmarks : [];

                if (Array.isArray(body.bookmarks)) {
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

module.exports = {
    handleSyncRoute
};
