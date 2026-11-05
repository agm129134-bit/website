# 代碼瘦身與重構優化報表

- 日期：2026-11-05
- 分支：`refactor/code-slimming`（以 `main` @ `288d56f` 為基準，共 9 個 commit，`main` 未被改動）
- 合併方式：確認無誤後執行 `git checkout main && git merge refactor/code-slimming`

---

## 一、優化前後行數對比

| 檔案 | 優化前 (行) | 優化後 (行) | 增減 | 優化前 (bytes) | 優化後 (bytes) |
|---|---:|---:|---:|---:|---:|
| `js/app.js` | 16,155 | 13,664 | **−2,491** | 472,883 | 458,916 |
| `api/sync.js` | 1,028 | 999 | −29 | 49,344 | 47,340 |
| `server.js` | 139 | 128 | −11 | 5,810 | 5,368 ※ |
| `css/style.css` | 4,774 | 4,386 | **−388** | 120,245 | 110,496 |
| `index.html` | 5,117 | 5,114 | −3 | 199,919 | 199,739 |
| `login.html` | 852 | 838 | −14 | 41,800 | 41,441 |
| `acg.html` | 3,148 | 2,475 | **−673** | 197,817 | 163,809 |
| **合計** | **31,213** | **27,604** | **−3,609 (−11.6%)** | **1,087,818** | **1,027,109 (−5.6%)** |

※ `server.js` 原為 CRLF 換行，已統一為 LF（Git `autocrlf=true` 會自動處理），位元組差異部分來自於此。

---

## 二、主要重構與瘦身項目

### 1. `js/app.js`（核心業務邏輯）

**死代碼與過渡殘留移除**
- 刪除 12 個沒有任何地方呼叫的 `window.*` 包裝函式或別名：`switchEpisode`、`jumpToDanmakuPercent`、`openDanmakuListModal`、`promptDandanplayConfig`、`setupBookshelfTrashBin`、`quickSearchNovel`、`onNovelSourceChanged`、`quickKazumiSearch`、`addMangaSearchResultToLibrary`、`resumeAnimeHistory`（「向下相容」殘留）、`clearAnimeHistory`、`deleteCustomGame`。
- 刪除 8 行多餘的 `window.X = X`。頂層 `function` 宣告本來就是全域屬性，這些賦值不會產生任何效果（`toggleIslandPlayMode`、`showToast`、`applyThemeMode` 等）。
- 刪除會遞迴呼叫自己的 `function onFullscreenMouseMove` 影子宣告（執行時一定會被覆蓋），以及空的 `DEFAULT_BOOKMARKS`、`DEFAULT_SEED_TRACKS`。
- 刪除**被遮蔽的舊版書架實作**：第二組 `getNovelBookshelf` / `saveNovelBookshelf`（sessionStorage 加假資料過濾）放在 `if (!window.X)` 守衛裡，因為前面已經定義過，所以從來不會執行。
- 刪除只寫入、從不讀取的全域變數：`window.currentKazumiEpTitle`、`window.currentDanmakuList`、`probeRes`、`islandPointerStartTime`、`indicatorEl`。
- 刪除上一版移除 Web Audio 後殘留的 `stopWebAudioFallback` 呼叫（該函式已不存在）。
- 刪除兩個打向**不存在的後端路由**的請求：`/api/bookmarks/sync`、`/api/bookmarks/add`。這兩個路由一定回 404，且錯誤被吞掉；實際的持久化本來就經由 `saveToStorage → syncToServer` 完成。
- 修正重複的寫法：`sessionStorage.getItem("currentUser") || sessionStorage.getItem("currentUser")`（共 3 處）。
- 移除 37 個永遠成立的 `typeof X === "function"` 守衛。被守衛的都是會被提升的頂層函式（`showToast` ×26、`renderBookmarks`、`startFsIdleTimer`…），連同後面永遠執行不到的 `alert()` 備援分支一起移除。

**DRY 共用 Helper（檔案頂部新增「共用工具函式」區塊）**

| 新 Helper | 取代的重複代碼 |
|---|---|
| `escapeHtml()` | 從第 10,000 多行移到檔首統一管理，並刪除 `acg.html` 中多餘的預載備援版本 |
| `formatMmSs(sec)` | `formatDanmakuMinSec`、`formatDanmakuSeconds`、兩份內嵌 `formatSec`，共 4 份「MM:SS」實作 |
| `genId(prefix, len, ts)` | 5 處手寫的 `"bm_" + Date.now() + "_" + Math.random()…` 時間戳 ID |
| `stripWatchStatusTags()` + `WATCH_STATUS_TAGS` | 3 份各 15–18 行的 Bangumi 觀看狀態標籤清單 |
| `renderNovelParagraphs()` | 2 份小說段落渲染加自訂字色套用 |
| `resolveBookshelfUser()` | 書架上傳/下載同步中重複的帳號解析 |
| `bindBookshelfDrag()` | 漫畫/小說書架兩份一樣的「拖曳到垃圾桶」事件綁定 |
| `getTheaterViewState()` | 3 份「劇院是否開啟 / 是否全螢幕」判斷 |

**空白與排版（每一步都比對過語法樹，結果完全相同）**
- 物件字面值、函式參數、鏈式呼叫內的無意義空行：336 行。
- 區塊開頭/結尾空行 33 行、重複空行、行尾空白。
- HTML 模板字串內的純空白行：1,340 行。已確認沒有 `<pre>`/`<textarea>`，所以渲染結果不變。
- 註解與它說明的程式碼之間的空行：294 行；章節橫幅註解內的空行：54 行。

### 2. `acg.html`
- **刪除 659 行內嵌的 3D 書架模組重複副本**（get/save、渲染、垃圾桶、粉末特效、收藏切換等 17 個函式）。改以 `app.js` 為唯一來源。
  - 比對後確認 `app.js` 版本在行為上是超集；而且「從首頁 SPA 切到 ACG」時，原本就是 `app.js` 版本在跑。
- 只存在於 `acg.html` 的 `toggleCurrentMangaToBookshelf` 移到 `app.js`。這順便修好一個既有 bug：從首頁 SPA 切到 ACG 後，「收進書架」按鈕原本會呼叫到 `undefined`。
- 刪除空的 `#mobileTopToastContainer` 容器（沒有任何 JS 會寫入它）以及行尾空白。

### 3. `api/sync.js`
- `resolveRequestUser()` 取代 5 份一樣的「展示帳號/預設帳號歸屬加最後活躍使用者記錄」區塊。
- `readUserParam()` 取代 `/api/user/delete` 與 `/api/user/clear` 重複的參數解析。
- `saveMusicTracks()` 取代音樂庫新增與刪除中重複的 NeDB upsert。

### 4. `server.js`
- 5 段複製貼上的 `if (req.url.startsWith(...)) return handler(...)` 改成 `API_ROUTES` 對照表加一個迴圈。

### 5. `css/style.css`
- 刪除 69 個不可能匹配任何元素的選擇器：舊版手機 toast 整組（`mobile-top-toast`、`toast-swipe-*`…）、`offcanvas` 抽屜、舊版翻書 Modal（`book-page-*`）、已移除的 Modal ID 等，並清掉因此變成孤兒的區段註解。
- 刪除 43 條一定會被後方「同情境、同選擇器、同屬性」規則覆蓋的宣告（例如 `.spotlight-card`、`.border-glow`、`.modal-dialog-theater` 的重複區塊）。
- 290 個縮排混亂的節點統一為 2 空白（CSS 語法樹完全相同）。

### 6. `login.html` / `index.html`
- `login.html` 原本 CRLF 與 LF 混用（386/852 行是 CRLF），已統一為 LF。
- 刪除 `login.html` 中沒被使用的 `escapeHtml`。
- 清除行尾空白、壓縮連續空行（排除 `<pre>`/`<textarea>`）。

---

## 三、驗證方式（確保功能零破壞）

| 驗證項目 | 方法 | 結果 |
|---|---|---|
| 語法 | 每一步都跑 `node --check`：app.js、api/*.js、server.js、tampermonkey；HTML 內嵌腳本用 acorn 解析 | ✅ 全部 0 SyntaxError |
| 純空白類變更 | acorn 語法樹比對（忽略位置資訊） | ✅ 完全相同 |
| 未定義變數回歸 | ESLint `no-undef` / `no-unused-vars`，與 `main` 比對 | ✅ 65 → 57 筆，沒有新增（剩下的都是透過 `window.X` 呼叫的合法全域函式） |
| CSS 視覺 | 無頭 Chrome 比對 index/acg/login 所有元素與 `::before`/`::after` 的 computed style（亮色、暗色、Modal 開啟） | ✅ 0 差異 |
| 後端 API | 在隔離副本上同時啟動原版與新版伺服器，用 curl 逐一比對書籤、書架、音樂、清除、刪除、404、靜態檔回應 | ✅ 除時間戳外完全一致 |
| 前端行為 | 無頭 Chrome smoke test：首頁、ACG、登入頁、SPA 雙向切換、播放模式、主題、Toast、書架收藏/拖曳、小說段落、劇院狀態、訪客登入 | ✅ 0 個 pageerror |

> 所有測試都在 `%TEMP%` 的**隔離副本**中進行，沒有寫入專案的 `data/` 資料庫。

---

## 四、行為上的細微變化（均屬一致化或修正）

1. **直接開啟 `acg.html` 時**，書架改用 `app.js` 的較新版本。這和「從首頁切換過去」看到的一致：
   - 小說書房的空狀態多一顆「上傳本機小說」按鈕，文案也是新版。
   - 收藏目前小說時會保留原始 `source`，不再固定寫成 `"online"`。
2. `toggleCurrentMangaToBookshelf` 在 SPA 切換後也能用了（原本是 `undefined`）。
3. 執行 Bangumi 批次同步（`triggerBangumiUserSync`）時，舊的 `#在看/在讀` 這類帶 `#` 的標籤也會一起清掉，和另外兩處的清理行為一致。
4. `formatMmSs(NaN)` 回傳 `00:00`。原本 `formatDanmakuMinSec(NaN)` 會顯示 `NaN:NaN`。
5. 不再送出那兩個必定 404 的書籤請求，所以收藏提示會立即出現，不用等請求失敗。

---

## 五、刻意保留 / 建議後續處理

| 項目 | 說明 | 建議 |
|---|---|---|
| Bangumi 每日新番時刻表 (`openBangumiCalendar`、`#bangumiCalendarModal`) | `index.html` 內有完整的 Modal 與程式碼，但**沒有任何按鈕會開啟它** | 這是完整功能而不是過渡殘留，所以沒有刪。請決定要加上入口按鈕，還是整組移除（JS 約 160 行，另有 HTML Modal） |
| `index.html` / `acg.html` 的 `authGuard` 內嵌腳本重複 | 必須在 `<head>` 同步執行，才能在畫面渲染前完成跳轉 | 為了效能保留內嵌（抽成外部檔會多一個阻塞請求） |
| SPA 切換到 ACG 後輪播不初始化 | `seamlessNavigateTo` 會呼叫 `initAcgPageCarousel` / `initAcgTabs`，但它們只定義在 `acg.html` 內嵌腳本，從首頁 SPA 進入時不存在（`initAcgTabs` 在任何地方都沒有定義） | 既有問題。建議把 ACG 輪播模組也搬進 `app.js` |
| ⚠️ 登入頁「相同密碼彩蛋 → 直接幫我登入」 | 會用「忘記密碼」表單裡輸入的任何帳號名（預設 `jyun`）直接寫入登入 session | **安全疑慮**，建議改為由後端驗證後才建立 session |
| ⚠️ 後端信任客戶端傳入的 `user` 參數 | `/api/bookmarks`、`/api/user/bookshelf`、`/api/user/delete` 等沒有任何身分驗證 | 期末展示可接受；若要對外部署，建議加上 session token |
| `loadFromStorage` 中的 `bm_1` 假資料清除、`api/db.js` 的 JSON → NeDB 遷移 | 屬於資料遷移邏輯，舊環境仍可能用到 | 保留；確認所有部署都已遷移後可以刪除 |
