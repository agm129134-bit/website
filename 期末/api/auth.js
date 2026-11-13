// 【總說明】api/auth.js：登入憑證 (session token) 管理。
// 為什麼需要：以前伺服器只看前端給的 ?user= 決定要讀寫哪個帳號，任何人改個參數就能讀寫、甚至刪掉別人的帳號。
// 現在改成：登入 / 註冊成功時由伺服器產生一組隨機 token 發給前端，之後每個帳號相關請求都要在
// X-WL-Token 標頭帶上它，伺服器「用 token 查出是誰」，不再相信請求裡寫的帳號名稱。
//  - token 是 32 個隨機位元組 (64 個十六進位字)，猜不到。
//  - 資料庫 (data/sessions.db) 只存 token 的 SHA-256 雜湊，就算資料庫檔案外洩也拿不到可用的 token。
//  - 有效期限 30 天（和登入頁「記住我」一致）；登出、刪除帳號、改密碼時會撤銷。
//  - 用自訂標頭而不是 Authorization：Bangumi 代理路由用 Authorization 傳 Bangumi 的 token，避免兩者混在一起。
//    也因為不是 cookie，別的網站無法冒用（瀏覽器不會自動帶上），不必另外防 CSRF。
const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const sessionsDb = Datastore.create({ filename: path.join(DATA_DIR, 'sessions.db'), autoload: true });
sessionsDb.ensureIndex({ fieldName: 'tokenHash', unique: true }).catch(() => {});

// 前端與 Tampermonkey 腳本放 token 的標頭名稱（Node 會把標頭名稱轉成小寫）
const TOKEN_HEADER = 'x-wl-token';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const TOKEN_RE = /^[a-f0-9]{64}$/;

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

// 啟動時順手清掉過期的憑證，資料庫不會一直長大
sessionsDb.remove({ expiresAt: { $lt: Date.now() } }, { multi: true }).catch(() => {});

// createSession(username)：登入成功後呼叫，產生新 token 並存雜湊；回傳 token 原文（只在這次回應給前端）。
async function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    await sessionsDb.insert({ tokenHash: hashToken(token), username, createdAt: now, expiresAt: now + SESSION_TTL_MS });
    return token;
}

// readToken(req)：從標頭取出 token，格式不對就當沒帶。
function readToken(req) {
    const raw = String(req.headers[TOKEN_HEADER] || '').trim().toLowerCase();
    return TOKEN_RE.test(raw) ? raw : '';
}

// getSessionUser(req)：用請求帶的 token 查出帳號名稱；沒帶、查不到或過期都回傳 null。
async function getSessionUser(req) {
    const token = readToken(req);
    if (!token) return null;
    const doc = await sessionsDb.findOne({ tokenHash: hashToken(token) });
    if (!doc) return null;
    if (doc.expiresAt < Date.now()) {
        await sessionsDb.remove({ _id: doc._id }, {});
        return null;
    }
    return doc.username;
}

// revokeRequestSession(req)：登出時撤銷這次請求帶的 token。
async function revokeRequestSession(req) {
    const token = readToken(req);
    if (token) await sessionsDb.remove({ tokenHash: hashToken(token) }, {});
}

// revokeUserSessions(username, keepReq)：撤銷某帳號的所有 token（刪帳號、重設密碼）。
// 有給 keepReq 時保留該請求自己的 token（改密碼的人不會被自己登出）。
async function revokeUserSessions(username, keepReq = null) {
    const keep = keepReq ? readToken(keepReq) : '';
    const query = keep ? { username, tokenHash: { $ne: hashToken(keep) } } : { username };
    await sessionsDb.remove(query, { multi: true });
}

module.exports = {
    TOKEN_HEADER,
    createSession,
    getSessionUser,
    revokeRequestSession,
    revokeUserSessions
};
