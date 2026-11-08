// 【總說明】api/db.js：整個網站的「資料庫層」。
// 用 NeDB（純 JavaScript 的嵌入式 NoSQL，資料存成 data/ 底下的 .db 文字檔，不用另外裝資料庫軟體）。
// 其他檔案（主要是 api/sync.js）require 這支檔案來取得各集合 (collection) 並讀寫資料。
// 這裡提供：
//  1. 四個集合：accounts（帳號）、bookmarks（書籤）、bookshelf（書架）、music（音樂庫）
//  2. 密碼雜湊 hashPassword / 驗證 verifyPassword（密碼不會明文存）
//  3. autoMigrate：第一次啟動時，把舊的 JSON 檔自動匯入資料庫、並建立預設帳號
// 資料夾位置：專案根目錄/data（Docker 內是 /app/data，用 volume 保存）。
/**
 * Web Library - NeDB 嵌入式非同步資料庫核心模組 (nedb-promises)
 * 支援多集合管理 (accounts, bookmarks, bookshelf)、加鹽雜湊密碼安全防護與自動資料遷移
 */
const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 資料目錄：本檔在 api/ 底下，所以 '..' 往上一層再進 data。
const DATA_DIR = path.join(__dirname, '..', 'data');
// 第一次執行時 data 資料夾可能不存在，先建立（recursive 代表連父層一起建）。
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Datastore.create 建立一個集合，對應一個檔案；autoload:true 代表建立時就把檔案讀進記憶體。
// Schema（每筆文件的欄位）：
//  - accounts : username(唯一)、password(雜湊後)、name、role、avatar、bio、sortPref、themePref、createdAt、updatedAt
//  - bookmarks: user(唯一)、count、bookmarks[]（每位使用者一份文件，書籤陣列放在裡面）、updatedAt
//  - bookshelf: user(唯一)、manga[]、novel[]、updatedAt
//  - music    : user(唯一)、（音樂庫內容，由 sync.js 決定欄位）
// 建立四個獨立的 NoSQL 集合
const accountsDb = Datastore.create({ filename: path.join(DATA_DIR, 'accounts.db'), autoload: true });
const bookmarksDb = Datastore.create({ filename: path.join(DATA_DIR, 'bookmarks.db'), autoload: true });
const bookshelfDb = Datastore.create({ filename: path.join(DATA_DIR, 'bookshelf.db'), autoload: true });
const musicDb = Datastore.create({ filename: path.join(DATA_DIR, 'music.db'), autoload: true });

// ensureIndex + unique:true：同一個 username / user 不能有兩筆，等於資料庫層的「不可重複」限制，
// 同時加快用這個欄位查詢。.catch(() => {}) 是索引已存在或建立失敗時不要讓程式崩潰。
// 建立唯一索引以加速查詢並防範重複資料
accountsDb.ensureIndex({ fieldName: 'username', unique: true }).catch(() => {});
bookmarksDb.ensureIndex({ fieldName: 'user', unique: true }).catch(() => {});
bookshelfDb.ensureIndex({ fieldName: 'user', unique: true }).catch(() => {});
musicDb.ensureIndex({ fieldName: 'user', unique: true }).catch(() => {});

// 下面兩個函式處理密碼安全：資料庫裡絕對不存明文密碼。
// ==========================================
// 密碼加鹽安全雜湊 (Salted Hash via Node.js Native Crypto scrypt)
// ==========================================
// hashPassword(password)：把密碼轉成可安全儲存的字串。
//  參數：password 明文密碼；回傳："scrypt:鹽:雜湊值"（空密碼回傳空字串）。
//  原理：隨機產生 16 bytes 的「鹽 (salt)」再用 scrypt（刻意很慢的雜湊演算法）算出 64 bytes 雜湊。
//  加鹽的好處：就算兩個人密碼一樣，存出來的結果也不同，駭客無法用現成的彩虹表反查。
function hashPassword(password) {
    if (!password) return '';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
}

// verifyPassword(password, storedHash)：登入時檢查密碼對不對。
//  參數：password 使用者輸入的明文；storedHash 資料庫裡存的字串。回傳 true / false。
//  做法：取出當初的鹽，用同樣方式重算雜湊，再和存的比對。
function verifyPassword(password, storedHash) {
    if (!storedHash || !password) return false;
    // 相容性支援：若舊資料庫中存在早期明文密碼，進行安全比對
    // 不是以 scrypt: 開頭就代表是很早期的明文密碼，下面直接比較字串（舊資料相容用）。
    if (!storedHash.startsWith('scrypt:')) {
        return password === storedHash;
    }
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const originalHash = parts[2];
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    // timingSafeEqual 是「固定時間比對」，不會因為前幾個字元就不同而提早結束，
    // 可防止攻擊者用回應時間差一點一點猜出雜湊（計時攻擊）。長度不同會丟錯，所以包 try/catch 回傳 false。
    try {
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
    } catch (e) {
        return false;
    }
}

// autoMigrate：舊版本是用 JSON 檔存資料，新版改用 NeDB。這個函式在啟動時自動轉移，
// 讓使用者不用手動搬資料。只在「集合是空的」時才匯入，所以重複執行不會重複塞資料。
// ==========================================
// 自動無縫遷移 (從現有 JSON 檔案自動匯入 NeDB，密碼自動升級加鹽加密)
// ==========================================
// 旗標：確保整個程式生命週期只執行一次遷移（避免重複觸發）。
let _isMigrated = false;
// autoMigrate()：非同步函式（用 await 等資料庫操作）。無參數、無回傳值；
// 任何錯誤都在最外層 try/catch 印出，不會讓伺服器啟動失敗。
async function autoMigrate() {
    if (_isMigrated) return;
    _isMigrated = true;

    try {
        // 步驟 1 帳號：若 accounts 是空的且存在 accounts.json 就逐筆匯入；
        // username 統一轉小寫去空白；密碼若還不是 scrypt 格式就順便升級成雜湊。
        // 1. 遷移帳號 accounts.json
        const accountsCount = await accountsDb.count({});
        const accountsJsonPath = path.join(DATA_DIR, 'accounts.json');
        if (accountsCount === 0 && fs.existsSync(accountsJsonPath)) {
            const raw = fs.readFileSync(accountsJsonPath, 'utf8');
            const accounts = JSON.parse(raw || '[]');
            for (const acc of accounts) {
                if (acc.username) {
                    const u = acc.username.toLowerCase().trim();
                    const rawPwd = acc.password || crypto.randomBytes(12).toString('hex');
                    const securedPwd = rawPwd.startsWith('scrypt:') ? rawPwd : hashPassword(rawPwd);
                    await accountsDb.insert({
                        username: u,
                        password: securedPwd,
                        name: acc.name || acc.username,
                        role: acc.role || '使用者',
                        avatar: acc.avatar || 'default',
                        bio: acc.bio || '',
                        sortPref: acc.sortPref || 'clicks',
                        themePref: acc.themePref || 'dark',
                        createdAt: acc.createdAt || new Date().toISOString(),
                        updatedAt: acc.updatedAt || new Date().toISOString()
                    });
                }
            }
            console.log(`[NeDB] 成功自動遷移 ${accounts.length} 筆帳號至 accounts.db (密碼全面升級加鹽加密)`);
        } else if (accountsCount === 0) {
            // 沒有舊 JSON 檔、資料庫也空 -> 第一次啟動，建立一個訪客性質的示範帳號 demo（不綁任何真人身分）。
            // 不用 "guest"：前端把 guest 當成「訪客模式」，資料不會同步到伺服器。
            // 密碼來自環境變數 DEFAULT_ADMIN_PASSWORD；沒設定就隨機產生並只印在伺服器 log（避免把密碼寫死在原始碼）。
            const initPwd = process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
            const now = new Date().toISOString();
            await accountsDb.insert([
                { username: 'demo', password: hashPassword(initPwd), name: '訪客示範', role: '示範帳號', avatar: 'default', bio: '系統自動建立的示範帳號', createdAt: now, updatedAt: now }
            ]);
            if (!process.env.DEFAULT_ADMIN_PASSWORD) console.log(`[NeDB] 已建立預設示範帳號 demo，初始密碼: ${initPwd}`);
        }

        // 步驟 2 書籤：讀 data/ 底下所有 bookmarks_使用者.json，用 update + upsert:true 寫入
        // （upsert = 有就更新、沒有就新增）。單一檔案壞掉只略過該檔，不影響其他。
        // 2. 遷移書籤 bookmarks_*.json
        const bookmarksCount = await bookmarksDb.count({});
        if (bookmarksCount === 0 && fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.startsWith('bookmarks_') && file.endsWith('.json')) {
                    try {
                        const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
                        const parsed = JSON.parse(raw);
                        const username = (parsed.user || file.replace('bookmarks_', '').replace('.json', '')).toLowerCase().trim();
                        const bookmarks = Array.isArray(parsed) ? parsed : (parsed.bookmarks || []);
                        await bookmarksDb.update(
                            { user: username },
                            { $set: { user: username, count: bookmarks.length, bookmarks, updatedAt: parsed.updatedAt || new Date().toISOString() } },
                            { upsert: true }
                        );
                    } catch (e) {}
                }
            }
            console.log(`[NeDB] 成功自動遷移書籤至 bookmarks.db`);
        }

        // 步驟 3 書架：做法同書籤，檔名是 bookshelf_使用者.json，欄位是漫畫 manga 與小說 novel。
        // 3. 遷移立體書架 bookshelf_*.json
        const bookshelfCount = await bookshelfDb.count({});
        if (bookshelfCount === 0 && fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.startsWith('bookshelf_') && file.endsWith('.json')) {
                    try {
                        const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
                        const parsed = JSON.parse(raw);
                        const username = (parsed.user || file.replace('bookshelf_', '').replace('.json', '')).toLowerCase().trim();
                        await bookshelfDb.update(
                            { user: username },
                            { $set: { user: username, manga: parsed.manga || [], novel: parsed.novel || [], updatedAt: parsed.updatedAt || new Date().toISOString() } },
                            { upsert: true }
                        );
                    } catch (e) {}
                }
            }
            console.log(`[NeDB] 成功自動遷移立體書架至 bookshelf.db`);
        }
    } catch (err) {
        console.error('[NeDB Auto-Migrate Error]:', err.message);
    }
}

// 模組被 require 時就自動跑一次遷移（不等待結果，背景進行）。
// 立即觸發一次自檢與遷移
autoMigrate();

// 對外匯出：四個集合與密碼、遷移相關函式，給 api/sync.js 等模組使用。
module.exports = {
    accountsDb,
    bookmarksDb,
    bookshelfDb,
    musicDb,
    hashPassword,
    verifyPassword,
    autoMigrate
};
