// server.js - 網站系統設計 Express 伺服器
var express = require("express");
var path = require("path");
var server = express();

// 支援解析 JSON 請求體 (提供 Tampermonkey 油猴外掛 API 使用)
server.use(express.json());

// 跨域設定 (CORS)
server.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// 指定靜態檔案目錄為「期未」專案目錄 (讓圖書館首頁直接在 http://localhost:8080 運行)
server.use(express.static(path.join(__dirname, "期未")));

// 保留舊的 Bootstrap5 練習目錄 (輸入 http://localhost:8080/Bootstrap5/ 仍可訪問)
server.use("/Bootstrap5", express.static(path.join(__dirname, "Bootstrap5")));

// 首頁路由 (明確導向期未個人網頁圖書館)
server.get("/", function(req, res) {
    res.sendFile(path.join(__dirname, "期未", "index.html"));
});

// ACG 專頁捷徑路由
server.get("/acg", function(req, res) {
    res.sendFile(path.join(__dirname, "期未", "acg.html"));
});

// 聯絡頁面 (保留原範例)
server.get("/contact", function(req, res) {
    res.send("This is about page");
});

// 簡易書籤 API (接收 Tampermonkey 篡改猴一鍵收藏)
let sharedBookmarks = [];
server.post("/api/bookmarks", function(req, res) {
    const bookmark = req.body;
    if (bookmark && bookmark.title && bookmark.url) {
        sharedBookmarks.unshift(bookmark);
        console.log(`[API 收到新收藏] ${bookmark.title} (${bookmark.url})`);
        return res.json({ success: true, message: "已成功收錄至伺服器！", bookmark });
    }
    res.status(400).json({ success: false, error: "無效的書籤資料" });
});

server.get("/api/bookmarks", function(req, res) {
    res.json({ success: true, bookmarks: sharedBookmarks });
});

const PORT = 8080;
server.listen(PORT, function() {
    console.log(`Express run on port: ${PORT}`);
    console.log(`\n======================================================`);
    console.log(` 🚀 首頁 (個人圖書館): http://localhost:${PORT}`);
    console.log(` 🎬 ACG 專區:        http://localhost:${PORT}/acg.html`);
    console.log(` 📂 原 Bootstrap5:    http://localhost:${PORT}/Bootstrap5/`);
    console.log(`======================================================\n`);
});
