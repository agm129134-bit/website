# 工作日誌：Web Library 期末專案

> 2026-11-05 · 與 Claude Code 的整段對話整理
> 從 antigravity 交接過來（`TASK_HANDOFF_TO_CLAUDE.md`）。**以這份日誌為準**；交接檔有過時或錯誤的內容（見文末「交接檔勘誤」）。

---

## 一、現在的系統長怎樣（重要設定）

| 項目 | 現況 |
|---|---|
| 本機開發 | `node server.js` → **http://localhost:8090**，資料在 `期末/data/` |
| Docker | `docker compose up -d --build` → **http://localhost:8095**，資料在具名 volume **`web-library_web-library-data`** |
| 兩邊資料 | **各自獨立、不互通**（可以同時開，不會互相覆蓋） |
| GitHub | `agm129134-bit/website`，已改為 **Private** |
| 使用者資料 | `data/*.db`、`accounts.json`、`bookmarks_*.json`、`bookshelf_*.json` **不進 git**（`.gitignore`） |
| 篡改猴腳本 | v1.6.3：每次先送 8090，連不上才送 8095 |
| 訪客登入 | 書籤、音樂只存在該分頁的 sessionStorage，不寫伺服器 |

### 常用指令

```bash
# Docker 重建（資料不會丟）
cd "F:/網站系統設計/website/期末" && docker compose up -d --build

# 備份 Docker 裡的資料
docker cp web-library:/app/data ./data-backup

# 語法檢查
node -c js/app.js && node -c js/acg.js && node -c server.js
```

### ⚠️ 不要做的事

- **不要 `docker compose down -v`**：`-v` 會刪掉 Docker 的資料 volume。
- **不要 checkout `e60b712` 以前的舊 commit**：舊 commit 還有追蹤 `data/*.db`，可能蓋掉本機資料庫。
- **不要讓 Docker 改回掛載 `./data`**：本機 server 與 Docker 同時寫同一份 NeDB 會互相覆蓋。
- 這台電腦的 Docker Desktop **看不到新建的 Windows 資料夾**（新 bind mount 會是空的），要新增掛載請用具名 volume。

---

## 二、這次做了什麼（依時間）

### 1. Bangumi 離線備用資料精簡（PR #1 內）
- `FALLBACK_BANGUMI_ITEMS` 只留畫面真的會用到的欄位（77 → 21 行），刪掉沒人讀的 `window.FALLBACK_BANGUMI_ITEMS`。
- 時間表請求鏈：24h 快取 → 官方 API → CORS 代理 → 過期快取 → 精選清單。
- 快取用 **sessionStorage**（你指定不要 localStorage）。
- 完全離線時精選清單只放在「今天」那一欄，其他天顯示「點此重試」。
- 首頁的時間表 modal 改共用同一套 fallback。

### 2. ACG 輪播圖變成巨大圖片（PR #1 內）
- **原因**：`seamlessNavigateTo` 只換 `<body>`，`acg.html` `<head>` 裡約 470 行 CSS 沒帶過去。
- **修法**：切頁時同步頁面的 `<head><style>`（標記 `data-page-style`），離開時移除。

### 3. 上 GitHub / Docker、合併
- PR #1：整個 `refactor/code-slimming` 分支合進 `main`（精簡 −4971 行）。
- 合併前發現並處理：
  - `data/accounts.json` 有 **明文密碼**（admin / student / jyun）在公開 repo → 停止追蹤使用者資料。
  - `api/db.js` 寫死 jyun 的預設密碼 → 改成環境變數 `DEFAULT_ADMIN_PASSWORD`，未設定則隨機產生並只印在 server log。
- Repo 改為 **Private**。

### 4. 🚨 書籤被清空事件（PR #2）
- **現象**：jyun 的 65 個書籤變 0。
- **原因**：新分頁初始化時，`loadFromStorage()` 在知道登入者之前就呼叫 `saveToStorage()`，排了一次以預設帳號 `jyun` 上傳空清單；我測試時用「訪客登入」觸發了它。
- **處理**：從 07:44 的最新版本還原 65 筆；修正為「知道登入者前絕不上傳」，訪客不寫伺服器。

### 5. 8090 / 8095 資料分開（PR #3）
- 原本 Docker 掛載 `./data`，與本機 server 共用 → NeDB 多程序會互相覆蓋。
- 試過新資料夾 `./data-docker`，但 Docker Desktop 看不到新資料夾 → 改用**具名 volume**，從 `./data` 複製一份種子資料。

### 6. 篡改猴路由（PR #4）
- 舊版會「記住上次成功的網址」，只開過一次 8095 就一直送 8095。
- 現在：**兩邊都開 → 8090；只開 8095 → 8095**；設定面板填自訂伺服器仍優先。
- 版本 1.6.3。**需要手動更新 Chrome 裡安裝的腳本**。

### 7. 全專案檢查（PR #5）
檢查項目：所有 JS 與 HTML 內嵌 script 語法、133 個 onclick 等事件處理函式都存在、getElementById 的 null 防護、所有 GET API 與靜態檔、瀏覽器實測（訪客 / jyun、SPA 切頁、輪播、時間表、console 錯誤）。

發現並修正：
- **🔴 伺服器把整個專案資料夾當公開目錄**：任何人可下載 `/data/accounts.db`（密碼雜湊）、所有書籤資料庫、`server.js` 原始碼 → 現在只提供根目錄 `*.html/ico/svg` 與 `css/ js/ images/ tampermonkey/`。
- **🔴 一個格式錯誤的網址（如 `/%E0%A4%A`）就能讓整個伺服器崩潰** → 改回 400。
- **🟠 404 頁面把網址原樣塞進 HTML**（反射型 XSS）→ 已跳脫。
- **🟠 音樂庫與頭像也有「預設 jyun」問題**：訪客或其他帳號登入會讀到 jyun 的音樂，之後一存檔就把 jyun 的歌複製進自己帳號 → 改為以登入身分為準，訪客音樂只留在本頁。

### 8. 個人偏好重整後重置、頭像選單不見（PR #7）
- **原因 1（我在 PR #2 造成的）**：個人資料視窗用 `sessionStorage.web_library_user` 判斷帳號、找不到就當 `admin`；PR #2 拿掉了初始化時寫入它的那段，於是 jyun 的修改被存進一個新建的 `admin` 帳號。
- **原因 2**：伺服器忽略 `defaultSort` / `defaultCategory`，偏好只存在 sessionStorage，新分頁就沒了。
- **修正**：初始化時記下已解析的登入身分；視窗用 `state.currentUser`；伺服器儲存並回傳 `defaultSort`、`defaultCategory`、`spotlightPref`，新分頁從伺服器載回；伺服器上的自訂頭像也會出現在下方頭像選單。
- **後續**：8090 要重啟 `node server.js` 才會用新的 `api/sync.js`；重啟後用 jyun 再存一次偏好。本機資料裡多了一個 08:44 被誤建、沒有密碼的 `admin` 帳號（待決定是否刪除）。

### 9. ACG 切回主頁按鍵失效（PR #9）
- `seamlessNavigateTo` 換上新的主頁 DOM，但 `setupEventListeners()` 只在第一次載入時跑 → 分類、搜尋、排序、視圖切換全失效。切回主頁時重綁；`/` 快捷鍵改為只綁一次並即時找搜尋框。

### 10. 漫畫歷史、批量管理、音樂通知（PR #10）
- **漫畫閱讀歷史重開就消失**：原本只存 sessionStorage。現在登入帳號存到伺服器 `bookshelf.mangaHistory`（最多 20 筆），進 ACG 時從伺服器載回；訪客仍只留在本分頁。歷史同步用獨立計時器（書架同步的計時器是共用的，會互相取消）。
- **批量管理一直閃**：每勾一張卡都整排重畫並重播 65 張卡的進場動畫。現在只就地更新被點的那張；進出批量模式不重播進場動畫，改成勾選框輕巧彈入、勾選時小小彈一下（尊重 `prefers-reduced-motion`）。
- **批量模式點封面會開大圖**：批量模式下封面不綁點擊，點封面＝勾選該卡；隱藏放大鏡圖示、游標改一般指標。
- **沒播音樂也跳「無縫切換（音樂持續播放）」**：改成只有正在播音樂時才顯示。

---

## 三、還沒做 / 待決定

- [ ] 重啟 8090 的 `node server.js`（PR #7 改了 `api/sync.js`），再用 jyun 存一次偏好。
- [x] 刪除本機 8090 資料裡被誤建的 `admin` 帳號（已刪，jyun 未受影響；備份在 `%TEMP%\accounts-before-admin-delete-085538.db`）。
- [x] 更新 Chrome 篡改猴腳本到 1.6.3。
- [ ] 明文密碼仍留在 git 歷史（repo 已私人化）。若這些密碼在別處也有用，**建議更換**。
- [ ] 若要給老師 / 同學看 repo：Settings → Collaborators 加人。
- [ ] 可清理的死碼：`searchKazumiAnime` 等 Kazumi 搜尋函式（對應的 UI 已移除，目前沒有呼叫點）。
- [ ] 伺服器端 `getDefaultActiveUser()` 仍會把「沒帶 user 的請求」歸給最後登入者或 jyun（篡改猴依賴這行為）；目前前端已不會再送出這種請求，但伺服器沒有登入驗證，任何人可帶 `?user=jyun` 讀寫，屬於設計上的限制。

---

## 四、交接檔勘誤（`TASK_HANDOFF_TO_CLAUDE.md`）

- 寫「嚴禁上傳 Docker」→ **已過時**，你已同意確認沒問題後可同步 Docker 與 GitHub。
- 寫 `api/bangumi.js` → **不存在**，Bangumi 路由在 `api/sync.js`。
- 寫 Docker 掛載 `./data` → **已改**為具名 volume。

---

## 五、PR 一覽

| PR | 內容 | 狀態 |
|---|---|---|
| #1 | 代碼精簡 + ACG SPA 修正 + 停止追蹤使用者資料 | ✅ 已合併 |
| #2 | 修正訪客登入清空 jyun 書籤 | ✅ 已合併 |
| #3 | Docker 改用獨立具名 volume | ✅ 已合併 |
| #4 | 篡改猴優先送 8090 | ✅ 已合併 |
| #5 | 伺服器檔案外洩 / 崩潰 / XSS + 音樂頭像身分修正 + 本日誌 | ✅ 已合併 |
| #6 | 日誌狀態更新 | ✅ 已合併 |
| #7 | 個人資料視窗改錯帳號 + 偏好存到伺服器 + 頭像選單 | ✅ 已合併 |
| #8 | 日誌更新 | ✅ 已合併 |
| #9 | ACG 切回主頁後按鍵失效 | ✅ 已合併 |
| #10 | 漫畫歷史存伺服器 + 批量管理不閃 / 封面不開大圖 + 音樂通知 | ✅ 已合併 |
