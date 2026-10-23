/**
 * Web Library - 跨電腦雲端同步與 Bangumi 雙向同步核心模組
 * 採用 Node.js 原生環境 (CommonJS, http, https, fs, path, url)
 * 零依賴、免裝 npm 套件！支援多帳號伺服器端持久化與 Bangumi 雙向狀態更新
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');

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

// 安全純化使用者名稱，避免路徑穿越
function sanitizeUsername(username) {
    if (!username) return 'default';
    const clean = username.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '').trim();
    return clean || 'default';
}

// 取得使用者儲存檔案路徑
function getUserFilePath(username) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const safeUser = sanitizeUsername(username);
    return path.join(DATA_DIR, `bookmarks_${safeUser}.json`);
}

// 轉發請求至 Bangumi 官方 API (避開瀏覽器 CORS 限制)
function forwardToBangumi(apiPath, method, token, bodyData = null) {
    return new Promise((resolve, reject) => {
        const payloadStr = bodyData ? JSON.stringify(bodyData) : null;
        const options = {
            hostname: 'api.bgm.tv',
            path: apiPath,
            method: method,
            headers: {
                'User-Agent': 'WebLibrary-ACG-Client/2.0 (https://github.com/web-library)',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
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
        // 1. 跨電腦書籤收藏同步端點 /api/user/bookmarks
        // ==========================================
        if (pathname === '/api/user/bookmarks') {
            // GET: 從伺服器拉取該帳號最新收藏
            if (req.method === 'GET') {
                const username = query.user || 'default';
                const filePath = getUserFilePath(username);

                if (!fs.existsSync(filePath)) {
                    return sendJson(res, 200, {
                        success: true,
                        user: sanitizeUsername(username),
                        count: 0,
                        bookmarks: [],
                        isNewUser: true,
                        message: '伺服器端暫無該帳號資料'
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

            // POST: 將客戶端收藏寫入伺服器端檔案
            else if (req.method === 'POST') {
                const body = await parseRequestBody(req);
                const username = body.user || query.user || 'default';
                const bookmarks = body.bookmarks;

                if (!Array.isArray(bookmarks)) {
                    return sendJson(res, 400, { success: false, error: '請提供有效的 bookmarks 陣列' });
                }

                const filePath = getUserFilePath(username);
                const record = {
                    user: sanitizeUsername(username),
                    count: bookmarks.length,
                    updatedAt: new Date().toISOString(),
                    bookmarks: bookmarks
                };

                fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');

                return sendJson(res, 200, {
                    success: true,
                    user: sanitizeUsername(username),
                    count: bookmarks.length,
                    savedAt: record.updatedAt
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

            // Bangumi API: PATCH /v0/users/-/collections/{subject_id} 或 POST /v0/users/-/collections/{subject_id}
            const result = await forwardToBangumi(`/v0/users/-/collections/${subjectId}`, 'POST', token, payload);
            return sendJson(res, result.statusCode, {
                success: result.statusCode >= 200 && result.statusCode < 300,
                status: result.statusCode,
                data: result.data
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
