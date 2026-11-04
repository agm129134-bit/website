# 📋 Web Library 專案交接封包 (Task Handoff Packet for Claude Code)

> **交接目標**：無縫移交至 **Claude Code Desktop (Claude Opus 5.5)** 接續進行專案維護與代碼精簡優化。  
> **工作目錄**：`F:\網站系統設計\website\期末`  
> **當前分支**：`refactor/code-slimming`  
> **生成時間**：2026-11-05  

---

## 🏛️ 專案架構概覽 (System Architecture)

- **後端架構**：Node.js 原生 HTTP 伺服器 (`server.js`) + 模組化 API 路由 (`api/`)
  - `server.js`：靜態檔案伺服器、API 路由派發、NeDB 資料庫載入
  - `api/docker.js`：本機 Docker 狀態監控與生命週期控制（已加入 2000ms exec 超時保護）
  - `api/music.js`：網易雲音樂搜尋、試聽與收藏 NeDB 持久化
  - `api/bangumi.js`：動漫放送資訊與第三方鏡像代理
  - `api/auth.js`：使用者帳號註冊、scrypt 雜湊加密認證
  - `data/*.db`：NeDB 輕量資料庫檔案 (`accounts.db`, `bookmarks.db`, `music.db` 等)
- **前端架構**：無框架原生 Modern Web (SPA 動態切頁 + GSAP 動畫 + Bootstrap 5.3)
  - `index.html`：圖書館主頁（書籤收藏管理、全局快捷搜尋、動態島音樂懸浮控制器）
  - `acg.html`：ACG 影音媒體中心（Bangumi 當日熱門輪播、本季每週放送時間表、條漫/小說立體書架）
  - `login.html`：登入與註冊頁面（支援 30 天免登入持久化、訪客通道）
  - `js/app.js`：全站主要邏輯管理器（SPA 無縫導航 `seamlessNavigateTo`、音樂播放器、書籤 CRUD）
  - `js/acg.js`：**（新模組）** ACG 專區專屬邏輯（輪播圖載入、Bangumi 日曆多通道 fallback、GSAP 物理動效）

---

## ✅ 目前已完成之修復清單 (Completed Fixes in this Branch)

1. **記住登入狀態 (30 天) 持久化修復**：
   - 修正登入時記住狀態被 `localStorage.clear()` 誤清的問題，將過期時間設定為 30 天並在各頁面 AuthGuard 中自動驗證復原。
2. **音樂播放器重疊播放與時長顯示不同步**：
   - 統一音訊物件為單例實例，切換歌曲時確保舊音訊暫停並銷毀；統一計算精確秒數，解決搜尋介面與收藏庫時長不一致。
3. **SPA 切換回主頁後右上角個人頭像消失**：
   - `seamlessNavigateTo` 切回 `index.html` 時，補齊調用 `updateUI()` 與 `updateNavUserAvatar()`，自動復原使用者自訂頭像與名稱。
4. **主頁書籤統計卡片與分類標籤顯示 0**：
   - 在 `renderBookmarks()` 與 `seamlessNavigateTo` 中深度連動 `updateStats()`，保證數據即時響應。
5. **Docker 狀態檢測持續卡在「檢查中...」**：
   - 後端 `api/docker.js` 加入 `timeout: 2000` 逾時控制。
   - 前端 `checkDockerStatus` 加入 `AbortController` (2.5 秒超時中斷)，逾時優雅回退為離線標記。
6. **點開 ACG 專區輪播圖與每週時間表空白、需手動 F5 刷新**：
   - **根因**：原 ACG 邏輯皆寫在 `acg.html` 的內嵌 `<script>` 中，從首頁 SPA 切換進入時，瀏覽器因 HTML5 安全規範不會執行注入的 script，導致 `window.initAcgPageCarousel` 等函式未載入。
   - **修復**：將 ACG 邏輯抽離至獨立模組 [`js/acg.js`](file:///F:/網站系統設計/website/期末/js/acg.js)，並在 `index.html` 與 `acg.html` 同步載入，使 SPA 換頁時能即時自動呼叫 `initAcgPageCarousel(true)` 與 `loadAcgPageCalendar()`。

---

## ⚠️ 重要約束與開發鐵律 (Core Constraints)

1. **嚴禁自行上傳至 Docker 容器**：
   - 使用者明確要求「改好不要自己上傳到docker上」，**切勿執行任何 `docker cp`、`docker restart` 或自動部署指令**。
2. **保持 NeDB 資料庫結構相容**：
   - 切勿破壞 `data/*.db` 的資料庫格式，避免使用者已收藏之書籤或帳號資料丟失。
3. **語法安全檢驗**：
   - 每次修改後請執行 `node -c js/app.js` 與 `node -c js/acg.js`，確保 0 語法錯誤。

---

## 🎯 建議 Claude Code 接續推進之任務 (Next Actionable Tasks)

1. **全專案代碼精簡與通讀優化（Code Slimming & Dead Code Removal）**：
   - 檢查 `js/app.js` 與 HTML 檔案中的冗餘空白行、註解掉的除錯代碼、無效的 CSS 樣式。
   - 精簡舊有的暫存變數與未使用的輔助函式。
2. **多端與極端網路環境下的容錯測試**：
   - 驗證在離線或 Bangumi API 超時時，Fallback 備用資料庫是否流暢載入。
3. **常態化 Commit 記錄**：
   - 每完成一個子模組的精簡，使用 Conventional Commits 進行 Git 提交。
