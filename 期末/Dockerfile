# ============================================================
# Web Library - Dockerfile
# 輕量級 Node.js 20 Alpine 鏡像 (極速啟動、免外掛套件、無依賴)
# ============================================================

FROM node:20-alpine

# 設定容器環境為生產環境
ENV NODE_ENV=production
ENV PORT=8090

# 建立專案工作目錄
WORKDIR /app

# 複製專案原始碼至容器
COPY . .

# 建立資料持久化存儲目錄 (用戶帳號、書籤 JSON 儲存區)
RUN mkdir -p /app/data

# 暴露服務埠號 (已更改為 8090 避免衝突)
EXPOSE 8090

# 定義持久化卷（確保更新或重啟容器時書籤與帳號資料永不丟失）
VOLUME ["/app/data"]

# 啟動 Node.js 原生伺服器
CMD ["node", "server.js"]
