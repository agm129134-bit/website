# 【總說明】Dockerfile 是「做出容器映像檔 (image) 的食譜」。
# 配合 docker-compose.yml 使用：compose 會呼叫這份檔案 build 映像，再把它跑成容器。
# 映像的內容 = Node.js 20 + 本專案原始碼 + 依賴套件；啟動時執行 node server.js。
# 每一行指令會產生一層 (layer)，Docker 會快取沒變動的層，所以指令順序有講究（見下方 COPY package）。
# ============================================================
# Web Library - Dockerfile
# 輕量級 Node.js 20 Alpine 鏡像 (極速啟動、免外掛套件、無依賴)
# ============================================================

# FROM：指定基底映像。node:20-alpine = 內建 Node 20 的 Alpine Linux（體積很小，約 100MB 內）。
FROM node:20-alpine

# 設定容器環境為生產環境
# ENV：設定容器內的環境變數。NODE_ENV=production 讓 Node 以正式環境模式執行。
ENV NODE_ENV=production
# PORT 是 server.js 讀的環境變數，決定伺服器監聽哪個埠。
ENV PORT=8090

# 建立專案工作目錄
# WORKDIR：之後的指令都在容器內 /app 這個資料夾執行（不存在會自動建立）。
WORKDIR /app

# 複製依賴描述清單並安裝生產依賴 (包含 nedb-promises)
# 先只複製 package.json（和 lock 檔）再 npm install：
# 只要依賴沒變，下次 build 就能直接用快取，不用重新下載套件，build 會快很多。
COPY package*.json ./
# RUN：在 build 階段執行指令。--omit=dev 表示只裝正式執行需要的套件，不裝開發用的。
RUN npm install --omit=dev

# 複製專案原始碼至容器
# 把專案其餘檔案複製進容器的 /app（會受 .dockerignore 影響，被忽略的檔案不會進去）。
COPY . .

# 建立資料持久化存儲目錄 (用戶帳號、書籤 JSON 儲存區)
# 建立 data 資料夾，放資料庫檔案（帳號、書籤等）。
RUN mkdir -p /app/data

# 暴露服務埠號 (已更改為 8090 避免衝突)
# EXPOSE：宣告容器內服務用 8090 埠。這只是「文件說明」，真正對外開放要靠 compose 的 ports 或 docker run -p。
EXPOSE 8090

# 定義持久化卷（確保更新或重啟容器時書籤與帳號資料永不丟失）
# VOLUME：把 /app/data 標為資料卷，資料存在容器之外，重建 / 更新容器時不會消失。
VOLUME ["/app/data"]

# 啟動 Node.js 原生伺服器
# CMD：容器啟動時要執行的指令，這裡就是用 node 跑 server.js（整個網站的入口）。
CMD ["node", "server.js"]
