# Web Library 完整重建規格書（給本地 AI 一次完成用）

> 版本：2026-11-18｜整理來源：Antigravity 對話「Website Final Project Design」（約 17,500 步，含 90 份 Qwen 任務回報）、Antigravity 規劃檔（`project_plan_web_library.md`、`project_architecture_and_feature_summary.md`、`tasks.json`、`prompt_tasks.txt`）、Claude Code 23 個工作階段（11/04–11/16）、`WORK_LOG.md`、`TASK_HANDOFF_TO_CLAUDE.md`、`docs/qa-report-8095-2026-11-16.md`，以及目前 `main` 分支的程式碼。
>
> **怎麼用**：把第 0 節的「一次性總指令」整段貼給本地 AI（Qwen／DeepSeek／Antigravity 等），並把這份檔案當成附件或 context file 一起給它。第 1–10 節是規格本體，第 11 節是驗收清單，附錄是你下過的指令跟 AI 協作紀錄，供 AI 了解「為什麼這樣設計」。

---

## 0. 一次性總指令（直接複製貼上）

```text
你是資深全端工程師。請依照附件《Web Library 完整重建規格書》從零建立一個可執行的網站專案，
所有回覆、程式註解、介面文字一律使用「繁體中文（台灣用語）」，不要出現簡體字或中國用語（例如「視頻」要寫「影片」）。

【硬性限制】
1. 後端：Node.js（20 以上）原生 http 模組寫 server.js，不用 Express；唯一的 npm 依賴是 nedb-promises。
2. 資料庫：NeDB（data/*.db），密碼用 crypto.scrypt 加鹽雜湊，不准存明文。
3. 前端：原生 HTML + Bootstrap 5.3.3 + Bootstrap Icons + GSAP 3.12.5（CDN），遊戲專區用 Vue 3（js/vendor/vue.global.prod.js）。
4. 不使用 localStorage 存使用者資料；登入者資料一律存伺服器（NeDB），訪客只存 sessionStorage。
   唯一例外：「記住登入狀態 30 天」的 token。
5. 原始碼裡不能寫死任何個人帳號、密碼或個資；預設帳號一律叫 guest；擁有者帳號只從環境變數 OWNER_USER 讀。
6. 所有預設內容（預設歌曲、預設小說、預設漫畫）都留空，不要塞範例資料；只有遊戲專區有規格書列出的預設卡片。
7. 同一份程式碼要能同時跑兩處：node server.js 在 8090（展示用），Docker 對外 8095→容器 8090（擁有者私用），兩邊資料分開。

【工作方式】
- 依規格書第 11 節的「里程碑 M1→M9」分批做，一次只做一個里程碑；每做完一個就：
  (a) node --check 所有 .js；(b) 啟動 8090 用瀏覽器實際點過該里程碑的功能；(c) 對照驗收清單打勾；
  (d) 沒問題才 git commit（訊息用繁體中文），再做下一個。
- 遇到規格沒寫清楚的地方，選最簡單、最不會出 bug 的做法，並在 docs/decisions.md 記下理由。
- 不要執行 docker compose down -v（會刪資料）；不要把 data/*.db、.env 加進 git。
- 第 9 節「踩過的坑」是過去真的發生過的 bug，實作時要主動避開。
- 全部完成後，做一次全站自我審查：安全（第 7 節）、RWD（375 / 768 / 1440 / 1920 / iPhone Duo）、深色模式、SPA 換頁、guest 與登入帳號兩種身分。
```

---

## 1. 專案總覽

| 項目 | 內容 |
|---|---|
| 名稱 | 個人化網頁收藏圖書館（Web Library）＋ ACG 媒體專區 ＋ 篡改猴快速收藏插件 |
| 用途 | 網站系統設計期末專題；之後也要能開放給其他人使用 |
| 解決的痛點 | 書籤雜亂、跨裝置不同步、難分類與預覽；把追番、看漫畫、看小說、聽音樂、遊戲攻略集中在同一個站 |
| 頁面 | `login.html`（登入/註冊/忘記密碼）、`index.html`（圖書館主頁）、`acg.html`（ACG 專區） |
| 換頁 | SPA 無縫換頁（`seamlessNavigateTo`），音樂不中斷 |
| 語言 | 繁體中文（台灣用語） |

---

## 2. 技術棧

| 層級 | 技術 | 備註 |
|---|---|---|
| 後端 | Node.js 原生 `http` + 模組化路由 `api/*.js` | 一開始用 Express，後來為了 Render/老師範例改來改去，**最終定案：原生 http**，入口 `server.js` |
| 資料庫 | `nedb-promises`（NeDB） | 老師上課教的；取代早期的 `data/*.json` |
| 密碼 | `crypto.scrypt` 加鹽雜湊 | |
| 前端框架 | 原生 JS（非模組化，全域 `window.xxx` 函式）+ Bootstrap 5.3.3 | 若重建可拆模組，但功能與 DOM id 要對得上 |
| 動畫 | GSAP 3.12.5 | 主頁、ACG、登入頁、書架、關於頁、輪播圖 |
| 視覺特效 | React Bits 風格的 Spotlight 聚光燈卡片、Border Glow 邊框微光（用原生 JS/CSS 實作，可在設定開關） | |
| 遊戲專區 | Vue 3 global build（`js/vendor/vue.global.prod.js`） | |
| 影音 | hls.js（m3u8）、Bilibili 內嵌、彈幕引擎自製 | |
| 電子書 | JSZip（解析 EPUB），TXT 章節切分 | 本機上傳的小說存 IndexedDB |
| 瀏覽器插件 | Tampermonkey userscript `tampermonkey/web-library.user.js`（目前 v1.9.0） | |
| 部署 | Docker（`node:20-alpine`）、docker compose、GitHub（私人 repo 備份） | |

---

## 3. 目錄結構

```text
期末/
├── server.js              # 原生 http：靜態檔白名單、API 派發、安全標頭、速率限制、例外防線
├── package.json           # 依賴只有 nedb-promises；scripts.start = node server.js
├── Dockerfile / docker-compose.yml / .dockerignore / .env.example
├── index.html  acg.html  login.html  favicon.svg  favicon.ico
├── css/style.css
├── js/
│   ├── app.js             # 全站主邏輯（書籤、SPA、劇院、彈幕、漫畫、小說、音樂、通知、設定）
│   ├── acg.js             # ACG 專區（輪播、每週時間表、Bangumi fallback）— 必須是獨立檔，不能寫在 acg.html 內嵌 script
│   ├── custom-rules.js    # 自訂來源規則 UI（含「給 AI 的規則生成指令」）
│   └── vendor/vue.global.prod.js
├── api/
│   ├── db.js              # NeDB 集合初始化、預設 guest／demo 帳號
│   ├── auth.js            # token 發放、驗證（X-WL-Token）、撤銷
│   ├── sync.js            # 帳號、書籤、書架、音樂、遊戲、自訂規則、Bangumi 代理、截圖上傳
│   ├── kazumi.js          # 動畫搜尋/選集/播放解析、彈幕、串流代理、自訂規則
│   ├── manga.js           # 漫畫搜尋/章節/圖片、圖片防盜鏈代理、自訂規則
│   ├── novel.js           # 日本小說（syosetu、kakuyomu）、自訂規則
│   ├── custom-rules.js    # 使用者自訂規則的伺服器端執行器
│   ├── xpath-lite.js      # 給規則用的輕量 XPath
│   ├── safe-fetch.js      # 對外抓取的 SSRF 防護（擋內網、IPv4 相容 IPv6、6to4、Teredo）
│   ├── docker.js          # Docker 狀態與一鍵操作（只有 OWNER_USER 能用）
│   └── game-defaults.js   # 遊戲專區預設卡片
├── rules/AGE.json  rules/7sefun.json   # Kazumi 格式內建規則
├── tampermonkey/web-library.user.js
├── images/  (kazumi_logo.png、tachimanga_logo.png、docker_logo.png)
├── data/    (*.db，不進 git)
└── docs/
```

---

## 4. 資料模型（NeDB）

| 檔案 | 集合 | 主要欄位 |
|---|---|---|
| `accounts.db` | 帳號 | `username`（唯一，長度上限）、`passwordHash`、`salt`、`nickname`、`avatar`（預設頭像 id 或 `data:image`）、`defaultSort`、`defaultCategory`、`spotlightPref`、`darkMode`、`createdAt` |
| `sessions.db` | 登入憑證 | `tokenHash`（只存雜湊）、`user`、`expiresAt`（30 天） |
| `bookmarks.db` | 書籤 | `user`、`id`、`title`、`url`（只收 http/https）、`category`（webpage / video / anime / manga / novel / resource / note）、`description`、`cover`、`favicon`、`tags[]`、`pinned`、`clicks`（從 0 起算）、`createdAt`、`updatedAt` |
| `bookshelf.db` | 書架 | `user`、`manga[]`、`novel[]`、`mangaHistory[]`（最多 20 筆）、`animeHistory[]` |
| `music.db` | 音樂庫 | `user`、`tracks[]`（`id`、`title`、`artist`、`cover`、`src`、`duration` 秒） |
| `games.db` | 遊戲專區 | `type: 'default' | 'user'`、`user`、卡片欄位（`title`、`url`、`badge`、`tags`、`desc`、`openInNewTab`） |
| `data/uploads/` | 篡改猴截圖 | 檔名綁使用者 |
| 自訂來源規則 | 存在帳號資料下（`/api/user/custom-rules`），每條規則記錄 `owner` |

規則：刪帳號時要連同書籤、書架、音樂、遊戲卡片、頭像、session 一起刪，避免同名新帳號「繼承」舊資料。

---

## 5. 後端 API

所有帳號相關 API 需帶 `X-WL-Token`；伺服器**只用 token 決定是誰**，不相信 `?user=` 或 body 的 `user`。沒帶有效 token 的寫入一律 401。

| 路由 | 用途 |
|---|---|
| `POST /api/user/register`、`/login`、`/logout` | 註冊、登入（發 token）、登出（撤銷 token） |
| `POST /api/user/reset-password` | 忘記密碼；只有 `ALLOW_PASSWORD_RESET=true` 才開放，否則一律回同一個 403 |
| `GET/POST /api/user/profile` | 暱稱、密碼、頭像、偏好（預設排序、預設分類、Spotlight、深色模式） |
| `POST /api/user/delete`、`/api/user/clear` | 刪除帳號、清空資料 |
| `GET/POST /api/user/bookmarks`、`/api/bookmarks` | 書籤同步；篡改猴寫入 |
| `POST /api/bookmarks/screenshot`、`GET /api/bookmarks/screenshot/:id` | 篡改猴截圖 |
| `GET/POST /api/user/bookshelf`、`/api/bookshelf` | 漫畫/小說書架、閱讀歷史 |
| `GET/POST /api/user/music`、`/api/user/music/search`、`/api/music*` | 音樂庫與線上搜尋（網易雲音樂搜尋→injahow meting 取完整音源；iTunes 備援） |
| `GET/POST /api/user/games` | 遊戲專區卡片（預設＋個人） |
| `GET/POST /api/user/custom-rules` | 自訂來源規則 |
| `GET /api/bangumi/search`、`/me`、`/collection`、`/episodes` | Bangumi 代理與雙向同步 |
| `GET /api/kazumi/search`、`/resolve`、`/rules`、`/rule-search`、`/rule-episodes`、`/rule-play`、`/stream-proxy`、`/danmaku`、`/bilibili-playurl`、`/api/kazumi/custom-*` | 動畫 |
| `GET /api/manga/search`、`/chapters`、`/pages`、`/proxy`、`/api/manga/custom-*` | 漫畫 |
| `GET /api/novel/search`、`/chapters`、`/content`、`/api/novel/custom-*` | 小說 |
| `GET /api/docker/status`、`POST /api/docker/action` | Docker 狀態/啟動/關閉/更新/移除（只限 OWNER_USER；未設定時停用） |

靜態檔只提供根目錄 `*.html / *.ico / *.svg` 與 `css/ js/ images/ tampermonkey/`，**絕不能把整個專案資料夾公開**（`data/`、`server.js`、`.env` 不可下載）。

---

## 6. 前端功能規格

### 6.1 登入頁 `login.html`
- 登入／註冊切換（GSAP 動畫）；註冊才會建帳號，登入不存在的帳號要報錯（不能「填新帳號就直接進去」）。
- 「記住登入狀態（30 天）」：勾選後重開瀏覽器免輸入帳密（存 token + `expiresAt`，各頁 authGuard 自動恢復；**不准在任何地方呼叫 `localStorage.clear()`**）。
- 訪客登入（guest）：資料只存本分頁 sessionStorage，並明確提示不會保存。
- 忘記密碼：獨立畫面（不能跑到註冊頁）、顯示密碼小眼睛要能用；若新密碼跟舊密碼一樣，顯示大字彩蛋「哈哈你用了相同的密碼」（個人資料改密碼也要有同樣彩蛋）。
- 不要有「快速展示帳號 / 管理員 / 學生」按鈕。
- 登入失敗訊息統一，不能讓人探測帳號是否存在；登入、註冊、忘記密碼同一 IP 10 分鐘最多 30 次。

### 6.2 主頁 `index.html`（圖書館）
- 分類 Pill：全部 / 一般網頁 / 影片 / 動畫 / 漫畫 / 小說 / 資源 / 筆記，附計數徽章；分類要明確（漫畫不能跑進動畫類）。動畫類卡片多一顆紅色「Kazumi 播放」按鈕。
- 搜尋（標題、網址、描述、標籤），按 `/` 聚焦；搜尋框放在直覺的位置。標籤晶片篩選（去掉前後空白）。
- 排序：最新、最多點擊、標題 A–Z、置頂優先；**任何排序都先排置頂**。預設排序與預設分類存在伺服器，重整後保留。
- 網格 ⟷ 列表切換（GSAP 平順動畫，不能卡、不能跑版）。
- CRUD 彈窗；「智慧辨識」只接受 http(s)；點「前往」累計點擊數。
- 有封面圖的卡片點封面可放大檢視；批量管理模式下點封面＝勾選、不開大圖、不重播整排進場動畫。
- 匯出/匯入 JSON（匯入要驗證欄位型別，0 筆不能顯示成功）。
- Bangumi 雙向同步：Access Token 驗證、類別（動畫/書籍/全部）、狀態（在看/想看/看過）、僅匯入 vs 雙向、衝突優先權；在看/看過標示要正確。
- 篡改猴導引彈窗（不需要 API Token 那一步）＋「模擬採集」（不可重複新增）。
- 導覽列：漢堡選單（Docker 選單、篡改猴、關於、深色模式等），縮窗時按鍵不能重疊；「關於」和「深色模式」按鈕放最右邊、名字旁。名字後面不要加「專案開發者」。
- 右上角頭像跟著使用者上傳的頭像變，跨裝置同步。
- 回到最上方按鈕（只在外層頁面出現）。
- Docker 選單：
  - 8090（展示）：顯示一鍵部署、啟動、關閉、更新容器、移除。
  - 8095（Docker 內）：沒有 Docker 操作，只顯示「🟢 容器運行中（In Docker）」和「前往 8090」，8090 沒開要顯示沒開；第一次開、從 ACG 切回來都要立刻顯示正確，不能卡在「檢查中」（前端 2.5 秒 AbortController、後端 2 秒 timeout）。

### 6.3 個人設定
- 修改暱稱、密碼（至少 3 字元）、頭像（預設徽章或自己上傳圖片）、偏好、Spotlight 開關（關掉後要真的沒效果，且**不能把頭像改回預設**）、刪除帳號（刪完回登入頁）。

### 6.4 ACG 專區 `acg.html`
- 本日新番輪播圖（GSAP；深色模式下左右箭頭要看得到）＋每週放送時間表。Bangumi 載入鏈：24h sessionStorage 快取 → 官方 API → CORS 代理 → 過期快取 → 精選離線清單（只放今天那欄，其他天「點此重試」）。從主頁 SPA 切進來不用 F5 就要出現。
- 右上角選單在窄螢幕變漢堡（或小圓球）。
- **Kazumi 動漫劇院**
  - 來源：AGE（agedm.io）、7sefun（含 dp.no3acg.com 解析）、Girigirilove（`m3u8.girigirilove.com/api.php/Vod/get_list` 與 `get_detail`，MacCMS 格式 `$$$` 分來源、`#` 分集、`名稱$網址`，要能抓到所有集數）、Bilibili、自訂規則。
  - 待命狀態：中間搜尋框可以點、可以打字；不要一打開就寫入歷史，只有真的播放（動畫、YouTube、Bilibili）才記錄；歷史紀錄用小按鈕開懸浮視窗，記錄「動畫完整名稱」而不是搜尋字，存伺服器、重開還在。
  - 播放器：視窗夠大（注意 RWD），非全螢幕時下方控制列要能自動隱藏不擋畫面；暫停後點畫面可繼續；進度條不能消失；保留上下黑邊但不要過大；第三方 iframe 盡量只留影片本體。
  - 彈幕：彈彈play（`DANDANPLAY_APP_ID/SECRET`）＋ Bilibili（`order=dm`、**無上限**）；`clearAllDanmakuState()` 關閉時徹底清除；暫停/繼續（空白鍵）、時間軸滑桿、0/25/50/75% 跳轉、±10 秒、方向鍵 ±5 秒、點側欄時間戳跳轉；第 1 集也要比對標題避免配錯；搜尋去掉「第二季」等季數。
  - 播影片或動畫時音樂自動暫停（且暫停鍵圖示要變成「播放」）。
  - 375px 下控制列換行、時間軸獨佔一行。
- **Tachimanga 條漫閱覽器**：來源包子漫畫（baozimh / webmota）、拷貝漫畫（mangacopy），兩邊同名作品都顯示並標記來源；章節依 `section_slot/chapter_slot` 排序；圖片走 `/api/manga/proxy` 繞防盜鏈；閱讀歷史不只最後一筆（最多 20 筆，存伺服器）。
- **沉浸小說閱讀器**：只要日本小說（小説家になろう syosetu API、カクヨム kakuyomu），不要中國小說；可上傳 EPUB/TXT（存 IndexedDB），「搜尋結果」與「自行上傳」分開，上傳的書點了直接開不要再去搜尋；主題羊皮紙 / 純白 / 暗黑三種下的文字、按鈕、關閉鈕都要看得清楚；A-/A+ 字級；章節切分要濾掉正文句（長度 > 40 或句中有。，；且「第X章」後沒接分隔符）。
- **立體書架（漫畫、小說共用設計）**：不要預設陳列；收藏直接放進書架，不放主頁圖書館；滑鼠滑過書本有 3D 抽書起伏＋相鄰琴鍵波浪＋書本打開的感覺（不要右邊書籤）；書本要排成一直線；**畫面右下角固定一個垃圾桶**，把書拖進去刪除，放開處出現慢速灰燼粉末特效；垃圾桶只在漫畫/小說書架待命畫面顯示，進閱讀器（瀑布流、正文、目錄）就隱藏；書架跨裝置同步。
- **遊戲專區（Vue 3）**：預設卡片每個帳號都有，個人新增的卡片各自獨立存 `games.db`；點進 wiki 的介面 RWD 要做好；功能列縮放樣式跟動畫區一樣（小圓球）。預設卡片見 `api/game-defaults.js`，至少包含：Chaldea 迦勒底、Mooncell FGO Wiki、GameKee 魔法紀錄（gamekee.com/mfme）、game8 madoka-exedra、AstroDX 譜面資源庫（adxdls.saop.cc，用來試聽/下載 maimai 譜面）、bilibili fx-simple 小遊戲、「強風大背頭」（itch.io，說明寫節奏獨立小遊戲；會拒絕 iframe 的要 `openInNewTab`）。不要原神、星穹鐵道。
- **自訂來源規則**：動畫（Kazumi 規則 JSON 格式，可參考「Kazumi 自定義規則懶人版」）、漫畫、小說都能自訂；主頁外面也有入口按鈕；提供「給 AI 的規則生成指令」讓使用者複製去叫別的 AI 產生規則 JSON；規則記錄 owner，登出清除。

### 6.5 音樂庫（動態島）
- 名稱就叫「音樂庫」；頂部 iPhone 動態島樣式：沒播放時半透明（opacity 約 0.42，可看到後方內容），播放時完整顯示；閒置在 375px 時縮成圖示靠右，不蓋品牌字。
- 點一下：開新頁面式的選歌介面（Apple Watch 風格瀑布流封面，滑過顯示歌名）；長按：原位調整音樂。
- 線上搜尋歌曲（顯示正確且一致的完整時長，不能只有 30 秒試聽）、收藏後放進瀑布流；**不要預設歌、不要搜尋推薦標籤**；不要用 Bangumi 的東西。
- 循環 / 隨機 / 單曲循環三種模式（切換不要跳通知，以免把音樂介面關掉）。
- 預設音量 50%；主頁與 ACG 來回切換音樂不中斷；只有正在播音樂時切頁才顯示「無縫切換」通知；同時只能有一個音訊物件（不能跟預設音樂重疊）；不要用「過濾特定歌」的程式碼當解法。
- 不要 Apple logo。

### 6.6 通知系統
- 全站通知從畫面上方中間的動態島彈出（不要右下角，會擋按鈕），上滑或點擊可滑掉，滑掉後音樂功能恢復；文字長度自適應。ACG 專區也要有同樣通知。

### 6.7 關於網頁（📖 按鈕）
- 內容：網頁用途、更新說明（版本演進 1.0→3.0）、用了哪些技術（Bangumi、Kazumi、Tachimanga、Legado、GSAP、React Bits 風格特效、NeDB、Docker…，每個附 logo 與跳轉按鈕；Bangumi 跳轉 API 說明頁）、未來更新（可空）。
- 呈現：好幾張獨立飄浮書頁分散擺放（大小一致，切換不抽動）。按下一頁：最上面白色頁往**隨機方向**大幅飛遠，底下半透明毛玻璃頁回正並漸變成白色；上一頁：從剛才飛出去的方向慢慢飛回來（不是倒放）。動畫偏慢、優雅；最後一頁再按下一頁回到第一頁（無限翻頁）。
- 不要那兩句誇張文案（「無法跨裝置即時同步…」「每一次造訪…視覺享受」），標題排版要好看，中間不要有一條擋住。

### 6.8 深色模式
- 全站完整套用（不是只改一點）；文字要清楚；左上角 logo、輪播箭頭、小說區都要看得到。

### 6.9 RWD
- 375 / 768 / 992 / 1440 / 1920 都要正常，按鍵不能重疊。
- iPhone Duo：內螢幕 1878×2670 px（CSS 約 626×890，DPR 3）才觸發特殊版面（功能列移到右邊之類的雙屏最佳化，不要虛擬鉸鏈）；外螢幕沿用一般手機版。

### 6.10 篡改猴腳本
- 右下角半透明懸浮球（可在選單隱藏）、`Alt+B` 開收藏對話框（放畫面中間）；自動抓標題、網址、`og:image`（B 站封面要能抓到）、智慧預設分類。
- `Alt+N` 快捷記事本：打字後存進圖書館（筆記類），可選擇附上當前畫面截圖；記事本也放畫面中間。
- 不需要 API Token：收藏存到「在該網站登入過的帳號」的 token；訪客收藏改複製到剪貼簿。
- 伺服器選擇：8090 和 8095 都開 → 送 8090；只開 8095 → 送 8095；設定面板可填自訂伺服器（優先）。

---

## 7. 安全規格（開放給別人用前必須具備）

1. Token 驗證（`X-WL-Token`，30 天，資料庫只存雜湊；登出、改密碼、刪帳號時撤銷）。
2. 速率限制：登入、註冊、忘記密碼同 IP 10 分鐘 30 次。
3. XSS：所有 `innerHTML` 插入的變數用 `escapeHtml()`；`onclick` 字串參數用 `jsArg()`（`JSON.stringify` + escapeHtml）；頭像只收預設 id 或 `data:image`；匯入資料前後端都做型別轉換、只收 http(s) 網址。
4. SSRF：所有伺服器對外抓取經 `safe-fetch.js`，擋私有 IP、localhost、IPv4 相容 IPv6、6to4、Teredo。
5. 例外防線：畸形 Host 標頭、畸形 URL（`/%E0%A4%A`）不能讓程序崩潰（回 400）；`unhandledRejection` 防線；錯誤不洩漏內部訊息。
6. 標頭：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`。
7. 404 頁面跳脫網址（防反射型 XSS）。
8. 靜態檔白名單（見第 5 節）。
9. 原始碼沒有個人資料；`.env`、`data/` 不進 git；Docker 管理只限 OWNER_USER。

---

## 8. 部署與環境

| 項目 | 8090（展示） | 8095（私用） |
|---|---|---|
| 啟動 | `node server.js` | `docker compose up -d --build` |
| 資料 | `./data/` | 具名 volume `web-library-data` 掛 `/app/data` |
| 擁有者 | 不設（只有 guest／demo） | `.env` 的 `DOCKER_OWNER_USER` → 容器 `OWNER_USER` |

`.env.example`：`PORT`、`DEFAULT_ADMIN_PASSWORD`（空的話隨機產生只印一次 log）、`DOCKER_OWNER_USER`、`ALLOW_PASSWORD_RESET`、`DANDANPLAY_APP_ID`、`DANDANPLAY_APP_SECRET`、`COPYMANGA_TOKEN`。`server.js` 自己讀 `.env`。

常用：

```bash
docker compose up -d --build          # 重建，資料不會丟
docker cp web-library:/app/data ./data-backup   # 備份
node --check js/app.js && node --check js/acg.js && node --check server.js
```

禁止：`docker compose down -v`；讓 Docker 掛載 `./data`（NeDB 不能兩個程序同時寫）；把使用者資料提交進 git。限制 RAM 可在 compose 加 `mem_limit`。

---

## 9. 踩過的坑（實作時主動避開）

| 現象 | 根因 | 正確做法 |
|---|---|---|
| 輪播、時間表全空、按鈕全部沒反應 | `app.js` 函式外殘留 `return` → SyntaxError 整支腳本不跑 | 每次修改跑 `node --check` |
| 從主頁切到 ACG，輪播/時間表空白要 F5 | SPA 注入的 inline `<script>` 不會執行 | ACG 邏輯放獨立 `js/acg.js`，兩頁都載入，換頁後主動呼叫 init |
| ACG 輪播圖變巨大 | 換頁只換 `<body>`，`<head><style>` 沒帶過去 | 換頁時同步頁面 style（標 `data-page-style`），離開時移除 |
| ACG 切回主頁按鍵全失效、頭像消失、統計顯示 0 | 事件只在首次載入綁定 | 換頁後重綁 `setupEventListeners()`、`updateUI()`、`updateNavUserAvatar()`、`updateStats()`；全域監聽先移除再綁 |
| 劇院彈幕/影片事件在 SPA 換頁後失效 | 同上 | `initTheaterControls()` 換頁後重綁 |
| 登入者書籤被清空（65→0） | 初始化時在知道登入者前就上傳空清單 | 確認身分前絕不上傳；訪客不寫伺服器 |
| 刪掉的書籤又復活 | localStorage／伺服器同步與 focus 事件競爭 | 切回分頁時若本機沒有未上傳的改動，以伺服器為準 |
| 重置帳號後書籤又被帶回 | 預設書籤種子 | 不要預設書籤 |
| 個人偏好重整後重置 | 偏好只存 sessionStorage，伺服器忽略欄位 | 伺服器儲存並回傳偏好 |
| 偏好被存到一個誤建的 admin 帳號 | 找不到帳號就預設 admin | 一律用 `state.currentUser`，找不到就是 guest |
| 記住登入 30 天無效 | 某處 `localStorage.clear()` | 刪掉；authGuard 讀 token 復原 |
| 書架防抖共用，漫畫變更遺失 | 漫畫與小說共用一個 debounce 計時器 | 各自獨立計時器 |
| 8090 與 8095 資料互相覆蓋 | 共用 `./data` | Docker 改具名 volume |
| 篡改猴一直送 8095 | 記住上次成功網址 | 每次先試 8090，失敗才 8095 |
| 批量管理一直閃 | 每勾一張就整排重畫＋重播進場動畫 | 只就地更新被點的卡片 |
| 拷貝漫畫點開都是包子資源 | 同名去重只留包子 | 兩邊都顯示並標記來源 |
| 7sefun 部分集數黑屏 | 舊解析站失效、CDN 防盜鏈 | 改用 dp.no3acg.com 解析＋備援線路＋串流代理 |
| Girigirilove 搜不到 | acgnx 302 + Cloudflare 403 | 改用 girigirilove 官方 api.php |
| AGE 音量調不了 | 跨網域 iframe 無法用 JS 控音量 | 能拿到 m3u8 就用自己的 `<video>`＋hls.js 播 |
| 漫畫歷史備援封面 SyntaxError | inline onerror 字串跳脫錯 | 改用 `window.getMangaHistoryFallbackCover()` |
| 多層 Modal 按 ESC 全關 | Bootstrap 預設行為 | 記錄開啟順序，只關最上層；開場動畫中按 ESC 等 shown 後再關 |
| Docker 狀態一直「檢查中」 | `docker` 指令卡住 | 前後端都加逾時 |
| Render 部署 `Cannot find module 'express'` | 沒裝依賴 | 最終改原生 http，只依賴 nedb-promises（Render 只是測試，可忽略） |

---

## 10. 使用者偏好與開發鐵律

- 繁體中文、台灣用語；說明不要太專業。
- 「分批做、多多檢查、做完一個確認沒問題再做下一個」。
- 修完要用瀏覽器實際打開 8090 測，不能只看程式碼。
- 不要預設內容（歌曲、小說、漫畫、書籤）。
- 不要 localStorage（除記住登入 token）。
- 不要用「過濾特定項目」這種治標程式碼。
- 原始碼不留個資；預設帳號 guest；8090 展示、8095 私用。
- 程式碼要有詳細中文註解（要能跟老師解釋）；但刪掉多餘空白行、死碼、重置資料庫後就沒用的過渡程式碼。
- 版本控制：每批完成 commit；確認沒問題可以 push 到 GitHub 並重建 8095 Docker。
- 用量快滿時（5 小時用量剩 10%）停下來，寫筆記，排程等用量恢復再繼續。

---

## 11. 里程碑與驗收清單

| 里程碑 | 內容 | 驗收（全部通過才進下一個） |
|---|---|---|
| **M1 後端骨架** | `server.js`、`api/db.js`、`api/auth.js`、`.env` 讀取、靜態白名單、安全標頭、例外防線 | `node server.js` 起在 8090；`/data/accounts.db`、`/server.js` 下載不到；`Host: a b` 不崩潰 |
| **M2 帳號** | `login.html`、註冊/登入/登出/訪客/記住 30 天/忘記密碼彩蛋、速率限制 | 不存在帳號無法登入；勾記住後關瀏覽器重開免登入；無 token 寫入回 401 |
| **M3 圖書館主頁** | 書籤 CRUD、分類、搜尋、排序、網格/列表、封面放大、批量、匯出匯入、個人設定、頭像、偏好 | 重整後偏好保留；兩個瀏覽器同帳號同步；匯入惡意 JSON 不會 XSS |
| **M4 SPA＋通知＋深色＋RWD** | `seamlessNavigateTo`、動態島通知、深色模式、漢堡選單、iPhone Duo、回到頂部 | 主頁⇄ACG 來回 5 次所有按鍵、頭像、統計、時間表都正常；375/1920 無重疊 |
| **M5 ACG 專區＋劇院** | 輪播、時間表 fallback、Kazumi 劇院、彈幕、歷史 | 拔網路時時間表顯示精選清單；AGE/7sefun/Girigirilove 各播一集；暫停/跳轉彈幕同步 |
| **M6 漫畫、小說、書架** | 條漫閱覽器、小說閱讀器、上傳 EPUB/TXT、3D 書架、垃圾桶灰燼 | 拷貝與包子同名都出現；上傳 TXT 目錄章節正確；垃圾桶只在書架顯示 |
| **M7 音樂庫** | 動態島播放器、搜尋、收藏、三種模式、影音互斥 | 完整長度播放；切頁不中斷；播動畫時自動暫停且圖示正確 |
| **M8 遊戲專區＋自訂規則＋關於** | Vue 遊戲區、自訂規則＋AI 指令、關於飄浮書頁 | 新帳號看得到預設卡片、個人卡片不互通；用 AI 指令產生的規則能搜到真實網站 |
| **M9 篡改猴＋Docker＋總檢** | userscript（Alt+B、Alt+N、截圖、8090/8095 路由）、Dockerfile、compose、Docker 選單、全站安全/RWD 總檢 | 8095 只顯示「容器運行中」；篡改猴收藏進正確帳號；第 7 節逐項通過 |

---

## 附錄 A：你下過的指令（依時間整理）

### A-1 Antigravity 時期（10/21 – 11/04，對話「Website Final Project Design」）
1. **立項**：期末專題做「網頁收藏圖書館 + 篡改猴快速收藏」，三大分類、會員、CRUD、智慧爬取 og:image。（Antigravity 產出企劃書）
2. **ACG 專區**：加 Kazumi 動漫劇院、Tachimanga 條漫、Legado 小說、Bangumi 雙向同步、彈幕（暫停凍結、跳轉同步、B 站彈幕 2000 條→後來改無上限）。
3. **影音修正（多輪 /qwen-worker）**：觀看記錄紅字看不到、「視頻」改台灣用法、YouTube 非全螢幕滑鼠控音量、動畫音量、黑邊過大但保留、歷史記錄改小按鈕懸浮視窗、ACG 右上角做 RWD 漢堡、7sefun 黑屏、劇院待命搜尋按不了、控制列擋畫面、AGE 音量。
4. **內容調整**：遊戲預設換掉原神/鐵道（GameKee 魔法紀錄、bilibili 小遊戲、強風大背頭、unityroom），名稱與說明修正；小說可上傳電子書；漫畫歷史不只最後一筆；CopyManga 章節失敗、兩邊同名都顯示。
5. **期末提報**：做 PPT、內文不要太專業、確認 Bangumi/Kazumi/Tachimanga API 說明。
6. **GSAP**：先加 ACG，再加主頁、登入頁、書架、網格/列表切換、輪播圖。
7. **帳號**：加註冊、debug「有帳號卻說沒帳號」、展示帳號只留管理員/學生→後來全刪、刪除帳號、重複帳號清理、重置帳號會帶回書籤（刪不掉）、匯入 JSON 失敗 debug。
8. **書架**：漫畫/小說改書架樣式可收藏、不要預設陳列、3D 抽書起伏＋波浪、像圖三那樣打開書、書排成一直線、叉叉難點→改右下角垃圾桶＋灰燼粉末（慢、在放開處）、只在漫畫/小說頁顯示、跨裝置同步。
9. **Docker**：問能否部署→改端口避免衝突→主頁漢堡選單一鍵部署/啟動/關閉/移除/更新容器→8095 只顯示「容器運行中＋前往 8090」→RAM 限制與關閉指令、安全性問題。
10. **個人資料與忘記密碼**：忘記密碼＋相同密碼大字報彩蛋、修改名字/密碼、上傳頭像、頭像同步右上角、Spotlight 關閉不能重設頭像。
11. **視覺**：Spotlight Card、Border Glow（參考 B 站影片）、深色模式（不要只做一點）、遊戲區 RWD 統一（小圓球）、劇院放大、iPhone Duo 1878×2670 適配、不要虛擬鉸鏈。
12. **關於網頁**：書頁翻頁（多輪調整：飄浮分散、飛出隨機方向、飛遠、慢、從飛出方向飛回、同大小、無限翻頁、logo＋跳轉、文案刪減、版本 1.0→3.0）。
13. **通知**：改成手機式從上方中間彈出、上滑滑掉→後來改從動態島出現。
14. **資料庫**：試 Render 部署→改 nedb-promises、密碼加密、不要 localStorage；把 server.js 改回老師的寫法；請 AI 當老師講解 NeDB、body-parser、增刪查改、動態網頁，做成教學檔（`網站系統設計_全端開發與NeDB核心教學指南.md`）。
15. **清理**：刪管理員/學生帳號、刪 API Token、「動漫與資源」只留資源、AstroDX 校正、Girigirilove 修搜尋與集數。
16. **音樂庫**：調查開源網頁音樂播放器→動態島＋Apple Watch 瀑布流→長按調音/點一下選歌→刪預設歌→線上搜尋＋收藏→名稱「音樂庫」→完整長度、三種循環模式、時長一致、預設音量 50%、播影片自動暫停、切頁不中斷、記住登入 30 天、封面、圖示錯誤。
17. **轉交**：「給 claude 寫」、Claude 預設用 Opus 5.5、全專案通讀精簡、最後產出 `TASK_HANDOFF_TO_CLAUDE.md` 交接到 Claude Code。

### A-2 Claude Code 時期（11/04 – 11/16）
| 日期 | 指令重點 |
|---|---|
| 11/04–05 | 接手交接檔、全專案精簡（−4,971 行）、不要 localStorage、上 GitHub＋Docker、repo 改私人、修書籤被清空、8090/8095 資料分開、篡改猴路由、全專案檢查寫工作日誌、偏好重整重置、頭像不見、ACG 切回按鍵失效、漫畫歷史、批量管理閃爍、音樂通知、收藏分類重新設計、Bangumi 狀態標示、小說只留日本小說、整體簡約風、RWD、iPhone Duo（參考蘋果仁文章，功能列移右邊） |
| 11/06 | 動畫/漫畫自訂規則（參考 Kazumi 規則懶人版）、通知自適應長度、回到頂部按鈕、平行多 agent、repo 改公開並刪明文密碼歷史、篡改猴記事本＋截圖、刪 API Token |
| 11/07 | 全部程式碼加詳細中文註解（要能跟老師說明）、彈幕改無上限、講解爬蟲原理 |
| 11/08 | 做宣傳影片（自主創作、成品放桌面）、刪帳號回登入頁、同名新帳號不繼承頭像、清 .db、自動建立的帳號改成 guest 類 |
| 11/13 | 遊戲區改 Vue.js、預設卡片每帳號都有＋個人卡片獨立存 .db、原始碼只留 guest、擁有者用環境變數、伺服器 token 驗證＋XSS 修正、動畫進度條消失/暫停點畫面/歷史名稱/歷史重開消失、8095 首次顯示錯誤、紀錄改存伺服器、用 dsh 調查開源小說方案、自訂規則的 AI 指令功能、dmmiku 實測 |
| 11/14 | 審查 dsh 的改動（書架垃圾桶只在書架顯示、ESC 多層 Modal、SPA popstate、靈動島擋按鈕、小說假章節、漫畫備援封面） |
| 11/16 | 用代理完整測 8095（4 代理分區 QA）、先修高再修低、分工給 Antigravity、安全測試、更新 QA 報告 |
| 11/18 | 整理本規格書 |

---

## 附錄 B：AI 協作紀錄（Antigravity → Qwen、Claude、dsh）

### B-1 qwen-worker 工作流（你要求 Antigravity 做的 skill）
你給的需求：讓 Antigravity 每次先叫本地 Qwen 27B 起草→Antigravity 審查→沒問題才回覆；上下文太長自動分批；結束回報「用時、tokens、模型、任務狀態、傳給 Qwen 的 Prompt、Qwen 架構設計、Antigravity 實作與除錯成果、具體重構步驟」；回答完清 VRAM；Gemini 判斷要不要自己改；Qwen 與 Gemini 多輪交叉檢查；偵測 GitHub 專案、完成後自動 commit/push、出問題可從備份還原；回覆裡加「回覆你的區域」；可以隨時改叫 Claude。

設定（`~/.gemini/config/skills/qwen-worker/config.json` 摘要）：Ollama `127.0.0.1:11434`、預設模型 `Cyber-Qwen-27B-Full:latest`、`num_ctx` 4096、超過 3,500 字元切塊（2,500 字＋300 重疊）、一批最多 2 個任務、跑完清 VRAM、自動 commit/push、LLM 與 ComfyUI 顯存互斥、說「不要用 qwen」就跳過。

### B-2 Qwen 任務統計（從 90 份「Qwen 27B 任務執行指標回報」解析）
| 執行者 | 次數 |
|---|---|
| Cyber-Qwen-27B:latest | 44 |
| Cyber-Qwen-27B-Full:latest | 16 |
| qwen3.8-flash-next-iq3_s | 5 |
| qwen2.5-coder:14b | 1 |
| Qwen 2.5 27B（舊稱） | 2 |
| Gemini 3.8 Flash 直修／未調用 Qwen | 約 22 |

有記錄時間的單次生成約 250–300 秒、輸出上限 2,048 tokens（`num_ctx` 小，所以大任務都要拆）。代表性任務：主頁加動畫分類＋Kazumi 播放鈕、移除寫死的特定作品預設值、Tachimanga 完整搜尋選集、書籤刪除後復活的競爭條件分析、播放器與彈幕同步、B 站封面抓取、7 項劇院修正、垃圾桶視口固定、Bangumi fallback、通知改上方動態島、NeDB 遷移與加鹽雜湊、移除展示帳號、AstroDX/Girigirilove、Favicon＋動態島音樂、音樂庫清空預設、SPA 切頁生命週期與 Docker 狀態排查。

**經驗**：Qwen 擅長單一明確的小任務草稿；跨檔案、跨 SPA 生命週期的 bug，Qwen 常給出看似合理但沒修到根因的答案，需要審查者實際開瀏覽器驗證。給本地 AI 下指令時，一次一個里程碑、附檔名與函式名、附驗收步驟，效果最好。

### B-3 Claude Code 時期的分工
- Antigravity CLI（`agy.exe -p "..." --mode accept-edits`）：依規格檔寫程式，Claude 審查與瀏覽器測試（headless agy 不能跑 shell 指令）。
- dsh（DeepSeek v4.1 flash CLI）：小說開源方案調查（`docs/novel-oss-research.md`）、書架垃圾桶等修改，Claude 再審查修正。
- Claude 子代理：平行 QA（帳號、首頁、ACG、API 四區）、程式碼審查、Playwright 實測。
