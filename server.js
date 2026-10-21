// server.js - 課堂練習伺服器 (專屬開原本的 Bootstrap5)
var express = require("express");
var server = express();

server.use(express.static(__dirname + "/Bootstrap5")); // 指定靜態檔案目錄為 Bootstrap5

server.get("/*splat", function(req, res) {
    res.send("Page not found", 404);
});

server.listen(8080);
console.log("Express run on port: 8080 (Bootstrap5 課堂練習)");
// run: node server.js
// browser: http://localhost:8080
