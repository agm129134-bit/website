# 開源小說方案調查報告（中文簡繁／日文網路小說）

調查日期：2026-11-13。數字（星數、最後推送日、授權）皆於當日以 `gh api` / `npm view` 實際查詢。

## 0. 調查方式與限制（請先看）

- **dsh 用法**：dsh 不在 PATH，實際位於 `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，用法為 `& dsh.cmd --profile headless "<任務>"`。
- 第 1～5 節是在 dsh 缺金鑰時，由我直接用 GitHub／npm 查證寫成。之後使用者在自己的 PowerShell 視窗設好 `DEEPSEEK_API_KEY`，dsh 跑出初稿，**第 6 節是 dsh 初稿與我的核對結果**。
- 踩到的坑：用管線送中文提示給 `-` 會卡住；改用純英文提示當參數傳入才成功（並要求以繁體中文回答）。
- 未修改專案任何既有檔案、未 commit。

## 1. 本專案現況（整合評估基準）

- [`js/app.js:8894`](../js/app.js) 的 `NOVEL_SOURCES` 目前只有 `syosetu`（小説家になろう）與 `kakuyomu`（カクヨム）。
- [`api/novel.js`](../api/novel.js)：每個書源是一個物件，介面為 `search(q)`、`chapters(novelId)`、`content(novelId, chapterId)`，另有 `validNovelId`。路由為 `/api/novel/search|chapters|content`，失敗時回 `unavailable:true`。**新增書源只要再寫一個同介面的物件。**
- [`api/custom-rules.js`](../api/custom-rules.js)：目前只有動畫（Kazumi 規則格式）與漫畫的「URL 模板 + XPath」規則，**沒有小說**。底層是 `safe-fetch.js`（防 SSRF）+ `xpath-lite.js`（自製 XPath 子集）。
- 依賴只有 `nedb-promises`，專案偏好零依賴。這會影響下方「整合難易度」的判斷。

## 2. 方案總表

| # | 名稱 | 連結 | 授權 | 星數 | 最後推送 | 語言 | 整合難度 | 一句話建議 |
|---|------|------|------|------|----------|------|----------|------------|
| A | Legado 書源規則格式（LegadoTeam 延續版） | https://github.com/LegadoTeam/legado | GPL-3.0 | 1.9k | 2026-11-11 | 簡中為主 | 中高 | 只借鑑規則格式；不要搬程式碼 |
| A' | gedoor/legado（原版） | https://github.com/gedoor/legado | 倉庫已清空，無 LICENSE 檔 | 47.3k | 2026-05-27 | 簡中 | — | 原倉庫只剩 README 與公告，來源碼已撤；以 LegadoTeam 版為準 |
| B | work_crawler（CeJS） | https://github.com/kanasimi/work_crawler | BSD-3-Clause（見 package.json） | 4.4k | 2026-10-12 | 繁中、簡中、日、英 | 中 | 站點腳本最全，可當「參考實作」 |
| C | lightnovel-crawler（lncrawl） | https://github.com/lncrawl/lightnovel-crawler | GPL-3.0 | 2.7k | 2026-11-11 | 多語，含 ja、zh | 高（Python） | 不建議整合，只當站點清單參考 |
| D | XIU2/Yuedu 書源合集 | https://github.com/XIU2/Yuedu | GPL-3.0 | 12.7k | 2026-08-14 | 簡中 | 中 | 現成書源 JSON，需寫轉換器 |
| E | Mihon / keiyoushi 擴充模式 | https://github.com/mihonapp/mihon、https://github.com/keiyoushi/extensions-source | Apache-2.0 | 25.3k / 4.9k | 2026-11-12 / 2026-11-13 | 多語，以漫畫為主 | 高（Kotlin/Android） | 概念可借鑑，無法在 Node 使用 |
| F | TheBraveChair 多站下載器 | https://github.com/TheBraveChair/syosetu-kakuyomu-novelup-alphapolis-novelpia-downloader | MIT | 33 | 2026-01-23 | 日、韓 | 低（JS，只參考） | 可參考 NovelUp、Alphapolis 的抓取邏輯 |
| G | 59naga/naroujs | https://github.com/59naga/naroujs | 無 LICENSE（待確認） | 13 | 2023-03-07 | 日 | 低 | 太舊，本專案已自行實作なろう API，不需要 |
| H | cessen/syosetu2ebook | https://github.com/cessen/syosetu2ebook | GPL-3.0 | 23 | 2026-10-18 | 日 | 不適用（Rust） | 僅供參考 |
| I | PixivSource（Legado 書源） | https://github.com/DowneyRem/PixivSource | 無 LICENSE | 1.1k | 2026-11-03 | 日、中 | 中 | Pixiv 小說來源，可做新書源 |
| J | EPUB：@lingo-reader/epub-parser | https://www.npmjs.com/package/@lingo-reader/epub-parser | MIT | — | 2026-04（v0.4.6） | 通用 | 低 | 純 JS，支援 EPUB2/3 |
| K | EPUB：epub2 | https://www.npmjs.com/package/epub2 | ISC | — | 2023-09（v3.0.2） | 通用 | 低 | 穩定但久未更新 |
| L | EPUB：julien-c/epub | https://github.com/julien-c/epub | 倉庫有 LICENSE（GitHub 判為 NOASSERTION，需自行確認） | 367 | 2026-11-13 | 通用 | 低 | 輕量老牌解析器 |
| M | foliate-js | https://github.com/johnfactotum/foliate-js | MIT | 1.2k | 2026-05-01 | 通用，含縱書 | 中（瀏覽器端） | 前端渲染 EPUB 的首選 |
| N | epub.js | https://github.com/futurepress/epub.js | 倉庫有 license 檔（NOASSERTION；實為 BSD 系，需確認） | 7.0k | 2026-03-24 | 通用 | 中（瀏覽器端） | 知名但較舊 |
| O | 編碼與解析輔助 | iconv-lite（MIT，2026-11）、jschardet（0BSD，2026-10）、cheerio（MIT，2026-07）、linkedom（ISC，2026-11）、mozilla/readability（Apache-2.0，11.5k★） | 見左 | — | 近期 | — | 低 | TXT 編碼偵測、HTML 轉正文的標準積木 |

> 未能確認的欄位已標「待確認」。其他 Legado 相容實作（如 legado-with-MD3、legado-E、Legado-Harmony）皆為 Android／鴻蒙 App，與 Node 整合無關，因此未逐一列入。

## 3. 各方向分析

### 3.1 閱讀器／書源引擎

**Legado 規則格式（A）**
- 規則可用 JSOUP（CSS 類）、XPath、JSONPath、正則與內嵌 JavaScript。內嵌 JS 靠 Rhino 執行，這部分在 Node 重做代價很高，也有安全風險。
- 原始 `gedoor/legado` 倉庫目前已清空（只剩 README 與公告圖），延續版在 `LegadoTeam/legado`（GPL-3.0）。**是 Android 專案，無法直接在 Node 使用。**
- 本專案的 `custom-rules.js` 已有「URL 模板 + XPath」引擎，等於已經具備 Legado 規則的核心子集。把它擴充出 `novel` 種類是最自然的路線。需要新增的欄位大致為：`searchURL`、`searchList`、`searchName`、`searchResult`、`chapterList`、`chapterResult`、`contentXPath`。
- **風險**：GPL-3.0 若複製程式碼會傳染；只借鑑「規則格式的想法」不受限。
- 簡中站書源（D：Yuedu 等）多半依賴 JS 規則與 `@css:` 語法，直接匯入成功率有限，需要寫轉換器並接受只支援子集。

**Mihon／Tachiyomi 擴充模式（E）**
- 模式是「每個站一個外掛，統一實作 popular／search／detail／chapter／page 介面」，Apache-2.0。與本專案 `SOURCES` 物件結構幾乎同構，**概念已經在用**。但程式碼是 Kotlin／Android，無法重用。
- 結論：不需引入，現有架構已是同一思路。

### 3.2 日文來源

- **小説家になろう**：官方有 API（`api.syosetu.com/novelapi/api/`），本專案已在用。第三方 npm 套件（G，naroujs）2023 起未更新，沒有引入價值。
- **カクヨム**：沒有官方 API，現行做法是解析頁面內嵌的 Next.js 資料，已實作。
- **ハーメルン、アルファポリス**：`work_crawler` 的 `novel.ja-JP/` 內有 `Hameln.js`、`AlphaPolis.js`、`kakuyomu.js`、`yomou.js`（成為小説家になろう系）、`noc.js`、`mnlt.js`。它是 JS 實作，可讀其解析邏輯後自行改寫成本專案的書源物件。F 專案也含 NovelUp、Alphapolis 的抓取邏輯。
- 其他 Python／Rust／Pascal 套件（narou.rb 615★ 等）是下載器，無法直接嵌入。

### 3.3 中文小說來源

- `work_crawler` 的 `novel.cmn-Hans-CN/` 有 biqu 系、69shu、piaotian、quanben、qidian 等簡中站腳本；`book.cmn-Hant-TW/` 有繁中站。**這是開源、可讀、JS 的最完整站點清單。**
- 專案既有註解提到舊書源（wenku8、bilinovel、piaotia、ixdzs）已移除，原因多半是站點反爬或不穩。簡中盜版站的失效率高、版權風險也高，**不建議預設內建**，建議走「使用者自訂規則」，由使用者自行負責。
- 可自架的 Node 後端：本次沒有找到維護良好、可直接嵌入、且授權乾淨的 Node 小說後端。work_crawler 本身偏向「下載到本機」的 CLI／Electron 工具，不是服務。這點誠實列為**待查**，不硬湊候選。

### 3.4 EPUB／TXT 解析與章節切分

- **EPUB 解析（後端）**：`@lingo-reader/epub-parser`（MIT，2026 仍在更新）最合適。`epub2`（ISC）穩定但 2023 後無更新。專案若堅持零依賴，EPUB 本質是 ZIP + XML，可用自寫 ZIP 讀取 + `xpath-lite.js` 解析 `container.xml` 與 `content.opf`，約 150 行；不過 ZIP 的 deflate 可用 Node 內建 `zlib` 處理。
- **EPUB 渲染（前端）**：`foliate-js`（MIT）支援縱書與日文排版，對日本小説最合適；`epub.js` 較老。
- **TXT**：需要編碼偵測（`jschardet`，0BSD）與轉碼（`iconv-lite`，MIT）。Big5／GBK／Shift_JIS 是常見來源編碼。章節切分用正則即可，不需要套件，例如：
  - 中文：`/^\s*第[零一二三四五六七八九十百千萬\d]+[章回節卷集部].*$/m`
  - 日文：`/^\s*(第[\d一二三四五六七八九十百]+[話章節]|プロローグ|エピローグ).*$/m`
- 繁簡轉換（若要）：OpenCC 有 JS 版（`opencc-js`），本次未逐項核對，列為**待查**。

## 4. 前 3 名推薦

### 🥇 第 1 名：把「自訂規則」擴充出小說種類（借鑑 Legado 規則格式，自行實作）
- **做法**：在 `api/custom-rules.js` 新增 `NOVEL_FIELDS`（搜尋、目錄、正文三組 XPath）與 `novelSearch/novelChapters/novelContent`，路由由 `api/novel.js` 接手，前端 `NOVEL_SOURCES` 動態加入使用者規則。
- **理由**：零新依賴；複用已有的 `safe-fetch`（防 SSRF）與 `xpath-lite`；使用者自己掌握規則與風險，專案不內建盜版站；同一套規則 UI 與同步機制（`api/sync.js`）可直接沿用。
- **成本**：中。主要是前端規則編輯器的小說欄位與規則範例。
- **授權**：只借鑑格式概念，不複製 GPL 程式碼，無傳染風險。

### 🥈 第 2 名：用 work_crawler（BSD-3）當「日文站點參考實作」，補 ハーメルン／アルファポリス 書源
- **做法**：閱讀 `novel.ja-JP/Hameln.js`、`AlphaPolis.js`，在 `api/novel.js` 依既有 `search/chapters/content` 介面各新增一個書源物件。
- **理由**：這些是合法公開的作者投稿站，沒有版權灰色問題；BSD-3 允許參考與改寫（保留版權聲明）；比起 npm 上停滯的套件品質高。
- **成本**：每個書源約半天，主要在各站的頁面結構與年齡確認（ハーメルン、18 禁站需要 cookie）處理。
- **風險**：站方改版即失效，需要像現有書源一樣維持 `unavailable` 降級處理。

### 🥉 第 3 名：EPUB 匯入／閱讀，後端 `@lingo-reader/epub-parser`（MIT）+ 前端 `foliate-js`（MIT）
- **做法**：新增「本機 EPUB／TXT 匯入」：後端解析章節清單與正文；TXT 走 `jschardet` + `iconv-lite` + 上述正則切章。前端日文可用 `foliate-js` 做縱書。
- **理由**：讓小說區不只依賴線上站，使用者自己的書也能讀；授權都是 MIT；與第 1、2 名互不衝突。
- **成本**：中。若要守住零依賴，可只做 TXT（`iconv-lite`＋`jschardet` 兩個小依賴）或自寫 EPUB 讀取。
- **注意**：專案會首度新增 npm 依賴，需與主對話確認是否接受（目前只有 `nedb-promises`）。

### 不建議
- **直接整合 Legado／LegadoTeam**：Android／Kotlin，GPL-3.0 有傳染性。
- **lncrawl（Python，GPL-3.0）**：語言與授權都不合；只可當站點清單參考。
- **Mihon／keiyoushi**：Kotlin／Android，且主要是漫畫；概念已被現有書源架構涵蓋。
- **內建簡中盜版站**：失效率高且有版權風險，改走使用者自訂規則。

## 5. 待查與後續

1. 設定 `DEEPSEEK_API_KEY` 後，用 dsh 以同一提示再跑一次，與本報告交叉比對有無遺漏。
2. 待查：OpenCC JS 版的現況；可自架的 Node 小說後端（本次沒找到）。
3. 以下授權 GitHub 未自動辨識，若要實際引用程式碼請先人工讀 LICENSE：`epub.js`、`julien-c/epub`、`naroujs`、`PixivSource`、`gedoor/legado`（倉庫已清空）。
4. 如決定做第 1 名，建議先請主對話確認 `custom-rules.js` 的欄位白名單與前端規則 UI 的改動範圍。


## 6. dsh（DeepSeek V4.1 Flash）初稿交叉比對

dsh 初稿存於 `C:\Users\user\AppData\Local\Temp\dshwork\out_en_clean.txt`（專案外）。以下為我逐項用 `gh api`／`npm view` 核對的結果（2026-11-13）。

### 6.1 dsh 新找到、第一版漏掉的項目

| 專案 | 授權 | 星數 | 最後推送 | 核對結果 |
|------|------|------|----------|----------|
| [hectorqin/reader](https://github.com/hectorqin/reader) | AGPL-3.0 | 11.1k | 2026-11-13 | 屬實：`server/` 是 TypeScript（Node），Docker 自架。**但它現在是本地書庫／影音庫**：EPUB、TXT（含編碼識別與章節推斷）、OPDS，README 沒有線上書源功能。dsh 推測的 Legado 相容性未證實 |
| [talebook/talebook](https://github.com/talebook/talebook) | BSD-2-Clause | 5.9k | 2026-11-01 | 屬實：README 寫明有「Legado 風格書源解析引擎」，但是 Python 後端 |
| [lnreader/lnreader-plugins](https://github.com/lnreader/lnreader-plugins) | MIT | 372 | 2026-11-13 | 屬實：每個小說站是一個 TypeScript 外掛，有統一介面，**最接近本專案 `SOURCES` 物件的現成參考** |
| [lnreader/lnreader](https://github.com/lnreader/lnreader) | MIT | 3.0k | 2026-11-13 | 屬實（Android／React Native） |
| [IReaderorg/IReader](https://github.com/IReaderorg/IReader) | Apache-2.0 | 995 | 2026-11-13 | 屬實（Android／Desktop） |
| [Kototoro-app/Kototoro](https://github.com/Kototoro-app/Kototoro) | Apache-2.0 | 686 | 2026-11-13 | 屬實（Android） |
| [kodjodevf/mangayomi](https://github.com/kodjodevf/mangayomi) | Apache-2.0 | 4.5k | 2026-11-13 | 屬實（Dart） |
| [freeok/so-novel](https://github.com/freeok/so-novel) | AGPL-3.0 | 9.0k | 2026-10-26 | 屬實（Java，簡中多站下載，規則式） |
| npm `epub` | MIT | — | 2026-02（v2.1.1） | 屬實；**要求 Node >= 22.6** |
| npm `chardet` | MIT | — | 2026-06（v2.2.0） | 屬實；可取代 `jschardet` |
| npm `epub-gen-memory` | MIT | 60★ | 2024-07 | 屬實；用於「產生」EPUB，本專案閱讀用不到 |

### 6.2 dsh 說法與實際不符，已更正

- **`hectorqin/reader` 不是線上書源引擎**（見上）。dsh 把它放在「中文書源」第一名並不恰當，適合的角色是「本地 EPUB／TXT 書庫」的參考實作。
- **`@tomisakae/syosetu-api`**：npm 為 ISC，但 repo 0★、無 LICENSE，且只發佈一次（2025-06）。本專案已有自己的なろう實作，不採用。
- **`kakuyomub`**：dsh 說 PyPI 為 MIT，但 repo 本身沒有授權檔；不引用其程式碼。
- **`LegadoTeam/Legado-Tauri`**：repo 沒有授權檔（dsh 說 MIT 僅來自文件站），視為授權不明。
- **`zsyo/go-novel`**：僅 34★，不列入推薦。
- 第一版報告中的 `LegadoTeam/legado` 是 GPL-3.0 的延續版，dsh 未列出；`work_crawler` 兩邊結論一致（BSD-3、含 Hameln／Kakuyomu／Syosetu）。

### 6.3 對前 3 名推薦的影響

結論不變，只做兩處補強：

1. **第 1 名（自訂規則擴充出小說種類）**：新增參考對象 `lnreader-plugins`（MIT）。它的「每站一個外掛、統一 search／detail／chapter／content 介面」與本專案的書源物件幾乎同構，可直接對照欄位設計。
2. **第 3 名（EPUB／TXT 匯入）**：新增參考實作 `hectorqin/reader`（AGPL-3.0）。它的 TXT 編碼識別與章節推斷做法可**閱讀、不可複製**（AGPL 有傳染性）。npm 套件選項更新為 `epub`（MIT，需 Node >= 22.6）或 `@lingo-reader/epub-parser`（MIT，無此限制）；請先確認本專案實際的 Node 版本再選。

### 6.4 仍待查

- `hectorqin/reader` 是否另有線上書源功能（程式碼搜尋 `bookSourceUrl` 有 1 筆符合，用途未查）。
- 可自架、且可被 Node 呼叫的線上小說書源後端：兩邊都沒找到成熟選項。
- OpenCC JS 版現況。
