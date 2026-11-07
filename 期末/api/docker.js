// 【總說明】api/docker.js：讓網頁上的「Docker 管理」按鈕可以控制本專案的容器。
// server.js 把所有 /api/docker 開頭的請求交給這裡的 handleDockerRoute。
// 提供兩個 API：
//  - GET  /api/docker/status  查詢容器狀態（有沒有建立、是否運行中）
//  - POST /api/docker/action  執行 up / update / start / stop / restart / down
// 原理：用 Node 的 child_process.exec 在伺服器上執行 "docker compose ..." 指令，把輸出回傳給前端。
// 安全重點：action 只接受白名單裡的值（switch 比對），不會把使用者輸入直接拼進指令，避免命令注入。
/**
 * Docker 控制模組 - 提供前端一鍵部署、啟動、關閉、重啟與移除容器 API
 * 顯式指定 -p web-library 專案名稱，徹底杜絕 Windows 中文目錄名 (期末) 引發之 "project name must not be empty" 錯誤！
 * 支援容器環境感知 (In-Container Awareness)，優雅處理沙盒隔離與指令指引
 */
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// 專案根目錄，docker compose 要在這裡執行才找得到 docker-compose.yml。
const ROOT_DIR = path.resolve(__dirname, '..');
// 所有 compose 指令的共同開頭。-p 明確指定專案名稱 web-library：
// 因為資料夾叫「期末」（中文），docker 自動推導專案名會失敗，所以手動指定。
const COMPOSE_BASE = 'docker compose -p web-library';
// /.dockerenv 這個檔案只有在 Docker 容器裡才存在，用它判斷「現在是不是跑在容器內」。
// 容器內沒辦法控制宿主機的 Docker，所以後面會改成回傳操作說明。
const IS_IN_CONTAINER = fs.existsSync('/.dockerenv');

// handleDockerRoute(req, res)：Docker API 的總處理器。
//  參數：req 請求物件、res 回應物件。回傳值：無（直接用 res 寫出 JSON）。
//  流程：先處理 CORS / OPTIONS 預檢 -> 依 pathname 與 HTTP 方法分派到 status / action -> 都不符就回 404。
function handleDockerRoute(req, res) {
    // CORS 標頭：允許其他網域的網頁呼叫此 API。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 瀏覽器跨網域送 POST 前會先發 OPTIONS「預檢」請求問可不可以，回 204（成功但無內容）即可。
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // 用 URL 物件解析請求網址，才能拿到不含 ?query 的 pathname。
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 【GET /api/docker/status】查詢狀態。
    // 回傳 JSON：success、running(是否運行中)、exists(容器是否存在)、status(中文狀態)、details。
    // GET /api/docker/status
    if (pathname === '/api/docker/status' && req.method === 'GET') {
        // 在容器內：自己就是容器，直接回報運行中即可。
        // 若當前伺服器本身運行在 Docker 容器內，直接回報容器運作正常
        if (IS_IN_CONTAINER) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
                success: true,
                running: true,
                inContainer: true,
                status: '容器運行中 (In Docker)',
                details: '當前 Web Library 服務正於 Docker 容器內部獨立運行 (Node.js 20 Alpine)。'
            }));
        }

        // docker ps -a --filter name=web-library：列出名稱含 web-library 的容器（含已停止）。
        // timeout 2000 = 最多等 2 秒，避免 docker 沒啟動時卡住。
        // 若指令出錯（沒裝 Docker / Docker Desktop 沒開）-> 回報 success:false 但仍用 200，讓前端顯示文字訊息。
        exec('docker ps -a --filter "name=web-library" --format "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"', { cwd: ROOT_DIR, timeout: 2000 }, (err, stdout, stderr) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({
                    success: false,
                    running: false,
                    status: 'Docker 服務未啟動或未安裝',
                    error: err.message
                }));
            }

            // 判斷方式：輸出文字有 "up" 代表 Status 是 Up ...（運行中）；有輸出但沒 up 是已停止；沒輸出是還沒建立。
            const raw = stdout ? stdout.trim() : '';
            const isRunning = raw.toLowerCase().includes('up');
            const exists = raw.length > 0;

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: true,
                running: isRunning,
                exists: exists,
                status: isRunning ? '運行中 (Running)' : (exists ? '已停止 (Stopped)' : '未建立 (Not Built)'),
                details: raw || '尚未建立 web-library 容器'
            }));
        });
        return;
    }

    // 【POST /api/docker/action】執行操作。請求 body 為 JSON：{ "action": "up|update|start|stop|restart|down" }。
    // 回傳 JSON：success、action、command(實際執行的指令)、output(指令輸出)、error。
    // body 用事件分段接收（data 累加、end 時才處理），因為 POST 內容可能分多塊傳來。
    // POST /api/docker/action
    if (pathname === '/api/docker/action' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const action = data.action;

                // 在容器內無法真的操作宿主機，所以只回傳「請在本機終端機執行這行指令」的教學文字。
                // 若在容器內部發起 Docker 操作，提供安全指引（容器無法自我終結宿主進程）
                if (IS_IN_CONTAINER) {
                    const actionZh = {
                        up: '部署',
                        update: '更新與重新編譯',
                        start: '啟動',
                        stop: '關閉',
                        restart: '重啟',
                        down: '移除'
                    }[action] || action;

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({
                        success: true,
                        inContainer: true,
                        action: action,
                        command: `docker compose -p web-library ${(action === 'up' || action === 'update') ? 'up -d --build' : action}`,
                        output: `【Docker 安全沙盒提示】\n您當前正是透過此 Docker 容器在瀏覽本網頁。\n依據容器安全隔離標準，容器內部無法反向終止宿主機（Windows）上的 Docker 進程。\n\n如需${actionZh}此容器，請在 Windows 本機終端機中執行：\n  docker compose -p web-library ${(action === 'up' || action === 'update') ? 'up -d --build' : action}\n\n或直接在 Docker Desktop 應用程式介面中點擊 Stop / Restart 按鍵即可。`,
                        error: null
                    }));
                }

                // 依 action 組出要執行的指令。只有這幾個白名單值有效，其他一律回 400（無效指令），這就是防命令注入的關鍵。
                // up / update 都是 up -d --build：重新建置映像並背景啟動。
                let cmd = '';
                switch (action) {
                    case 'up':
                    case 'update':
                        cmd = `${COMPOSE_BASE} up -d --build`;
                        break;
                    case 'start':
                        cmd = `${COMPOSE_BASE} start`;
                        break;
                    case 'stop':
                        cmd = `${COMPOSE_BASE} stop`;
                        break;
                    case 'restart':
                        cmd = `${COMPOSE_BASE} restart`;
                        break;
                    case 'down':
                        cmd = `${COMPOSE_BASE} down`;
                        break;
                    default:
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        return res.end(JSON.stringify({ success: false, message: '無效的 Docker 操作指令' }));
                }

                // 真正執行 docker 指令（沒設 timeout，因為 build 可能要好幾分鐘）。
                // stdout 與 stderr 合併當成輸出；err 有值代表指令失敗（success 就是 false）。
                exec(cmd, { cwd: ROOT_DIR }, (err, stdout, stderr) => {
                    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
                    const outputMsg = combined || (err ? err.message : '指令已成功派發完成');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        success: !err,
                        action: action,
                        command: cmd,
                        output: outputMsg,
                        error: err ? err.message : null
                    }));
                });
            } catch (err) {
                // 錯誤處理：body 不是合法 JSON 等意外錯誤 -> 回 500 與錯誤訊息。
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
        });
        return;
    }

    // 前面都沒命中 -> 回 404。
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: '找不到對應的 Docker API 路由' }));
}

// 匯出給 server.js 的 API_ROUTES 使用。
module.exports = { handleDockerRoute };
