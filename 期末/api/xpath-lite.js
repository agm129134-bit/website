// 【總說明】api/xpath-lite.js：自己手寫的「迷你 HTML 解析器 + 迷你 XPath 引擎」，不依賴任何套件。
// 為什麼要自己寫？Kazumi（動漫 App）的規則用 XPath 描述「資料在網頁的哪裡」，
// 但 Node.js 沒有內建 DOM / XPath（瀏覽器才有），又要維持「零依賴」，所以自己做一個夠用的版本。
// 被 api/custom-rules.js 使用：parseHtml 把網頁文字變成樹狀結構，select 系列函式用 XPath 在樹上找東西。
// 整體分三大塊（看下面的分隔線）：
//  1. HTML 解析：把 HTML 字串 -> 節點樹（每個節點有 type / tag / attrs / children / parent）
//  2. XPath 解析：把 XPath 字串 -> tokenize 切成詞 -> parseXPath 用「遞迴下降」建成語法樹 (AST)
//  3. XPath 求值：走訪 AST，在節點樹上找出符合的節點
// 節點種類：'doc' 文件根、'el' 元素、'text' 文字、'attr' 屬性（XPath 的 @href 會暫時產生這種節點）。
/**
 * Web Library - 零依賴 HTML 解析 + XPath 子集 (給 Kazumi 風格自訂規則使用)
 *
 * 支援：
 *   路徑    /a/b  //a  ./a  .//a  ..  .  *  text()  node()  @attr  @*
 *   述詞    [2] [last()] [position()<3] [@class] [@id="x"] [contains(@class,'x')]
 *           [starts-with(@href,'/')] [text()='x'] [not(...)] and / or  比較運算 = != < > <= >=
 *   函式    contains starts-with ends-with not normalize-space string-length last position text count
 *   聯集    a | b
 * 查詢在某個節點上執行時 (例如 searchList 的每一項)，開頭的 "//" 只往該節點底下找 (含自身)，
 * 和 Kazumi 的 xpath_selector 行為一致；開頭的 "/" 代表該節點的子節點。
 */

// 第一部分：HTML 解析。下面幾個集合是處理 HTML 的特殊規則。
// ==================== HTML 解析 ====================
// VOID_TAGS：空元素（沒有結束標籤，如 <br> <img>），遇到就不用放進堆疊等待關閉。
// RAW_TEXT_TAGS：裡面的內容當純文字，不能再解析標籤（如 <script> 裡的 < 不是標籤）。
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']);
// AUTO_CLOSE：HTML 允許省略結束標籤，例如 <li>A<li>B 第二個 li 出現時前一個要自動關閉。
// 格式「新標籤: [要被它自動關閉的舊標籤們]」。瀏覽器會這樣做，XPath 規則是照瀏覽器結果寫的，所以要模仿。
// 開啟某標籤時，若目前開啟中的元素是這些標籤，先自動關閉 (近似 HTML5 的隱含結束標籤)
const AUTO_CLOSE = {
    li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'], optgroup: ['optgroup', 'option'],
    tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], thead: ['tbody', 'tfoot'], tbody: ['thead', 'tbody', 'tfoot'], tfoot: ['thead', 'tbody'],
    rt: ['rt', 'rp'], rp: ['rt', 'rp']
};
// P_CLOSERS：這些區塊標籤出現時，會自動關閉前面還沒關的 <p>（HTML5 規則）。
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
// SCOPE_BOUNDARY：自動關閉時的「邊界」，往上找舊標籤時碰到這些容器就停，避免把外層的 li / td 誤關。
// 這些容器是 li / td 等隱含關閉的「邊界」，不會跨過去關
const SCOPE_BOUNDARY = new Set(['ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'dl', 'select', 'div', 'body', 'html']);

// 常見的 HTML 命名實體對照表（&amp; -> & 等）。
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…',
    mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', times: '×', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•'
};

// decodeEntities(s)：把文字裡的實體碼還原。支援 &名稱; 、&#十進位; 、&#x十六進位; 。
// 正規表示式 /&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi 的意思：& 開頭，後面是十六進位 / 十進位數字 / 英文名稱，分號可省略。
// 不認識的實體保持原樣。
function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            try { return String.fromCodePoint(code); } catch (_) { return m; }
        }
        const v = NAMED_ENTITIES[e.toLowerCase()];
        return v !== undefined ? v : m;
    });
}

// makeEl(tag, attrs, parent)：建立一個元素節點物件。
function makeEl(tag, attrs, parent) {
    return { type: 'el', tag, attrs, children: [], parent };
}

// parseAttrs(src)：把標籤內的屬性字串（如 class="a" href='/x' disabled）解析成物件。
// 正規表示式分三種值寫法：雙引號、單引號、無引號。屬性名稱轉小寫；重複的屬性只取第一個（和瀏覽器一致）。
function parseAttrs(src) {
    const attrs = {};
    const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = m[1].toLowerCase();
        if (name in attrs) continue;
        attrs[name] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '');
    }
    return attrs;
}

// HEAD_TAGS：這些標籤屬於 <head> 區。
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'script', 'style', 'base', 'noscript', 'template', 'basefont', 'bgsound']);

// parseHtml(html)：核心函式。參數 html 字串；回傳文件根節點 (type:'doc')。永遠不丟錯，壞掉的 HTML 也盡量容忍。
// 做法是「堆疊 (stack)」：遇到開始標籤就建立元素並 push，遇到結束標籤就 pop 回到對應元素，
// 目前堆疊最上層就是「現在在哪個元素裡面」。
function parseHtml(html) {
    const root = { type: 'doc', tag: '#document', attrs: {}, children: [], parent: null };
    const stack = [root];
    const cur = () => stack[stack.length - 1];
    const len = html.length;
    let i = 0;

    // 補上 html / head / body 結構：很多網站省略 <body>，但 XPath（例如 //body/div[2]）是照瀏覽器 DOM 寫的，
    // 所以要自己補齊，位置索引才會和瀏覽器一致。下面 ensureHtml / ensureBody / placeTag 負責這件事。
    // 近似 HTML5 的 html/head/body 結構：head 裡出現 div 之類的標籤時，瀏覽器會關掉 head 把它移到 body
    // (網站常見寫法，不處理的話 //div[2] 這類位置索引會和瀏覽器 / Kazumi 不一致)
    let htmlEl = null, headEl = null, bodyEl = null, headClosed = false;
    const ensureHtml = () => {
        if (!htmlEl) { htmlEl = makeEl('html', {}, root); root.children.push(htmlEl); }
        if (!stack.includes(htmlEl)) { stack.length = 1; stack.push(htmlEl); }
        return htmlEl;
    };
    const ensureBody = () => {
        if (bodyEl) return;
        ensureHtml();
        stack.length = 2; // 關掉 head
        headClosed = true;
        bodyEl = makeEl('body', {}, htmlEl);
        htmlEl.children.push(bodyEl);
        stack.push(bodyEl);
    };
    // placeTag(tag, attrs)：決定標籤放在 head 還是 body，或是 html/head/body 本身。
    // 回傳 true 表示這個標籤已被結構處理掉，主迴圈不用再建立元素。
    // 回傳 true 代表這個標籤已經被結構處理吃掉，不用再建立元素
    const placeTag = (tag, attrs) => {
        if (tag === 'html') {
            if (htmlEl) { Object.assign(htmlEl.attrs, { ...attrs, ...htmlEl.attrs }); return true; }
            ensureHtml(); Object.assign(htmlEl.attrs, attrs); return true;
        }
        if (tag === 'head') {
            if (headEl || bodyEl) return true;
            ensureHtml();
            headEl = makeEl('head', attrs, htmlEl); htmlEl.children.push(headEl); stack.push(headEl);
            return true;
        }
        if (tag === 'body') {
            if (bodyEl) { Object.assign(bodyEl.attrs, { ...attrs, ...bodyEl.attrs }); return true; }
            ensureBody(); Object.assign(bodyEl.attrs, attrs); return true;
        }
        if (bodyEl) return false;
        if (HEAD_TAGS.has(tag) && !headClosed) {
            if (!headEl) placeTag('head', {});
            if (!stack.includes(headEl)) { stack.length = 2; stack.push(headEl); }
            return false;
        }
        ensureBody();
        return false;
    };

    // pushText(text)：新增文字節點。只有空白且還沒進 body 的就忽略；相鄰的文字會合併成同一個節點。
    const pushText = (text) => {
        if (!text) return;
        if (!bodyEl && /\S/.test(text) && !(headEl && stack.includes(headEl) && stack.length > 3)) ensureBody();
        if (!bodyEl && !/\S/.test(text)) return;
        const parent = cur();
        const last = parent.children[parent.children.length - 1];
        if (last && last.type === 'text') last.text += decodeEntities(text);
        else parent.children.push({ type: 'text', text: decodeEntities(text), parent });
    };

    // closeTo(tag)：遇到結束標籤時，從堆疊上往下找最近的同名元素並關到那裡；找不到就忽略（容錯）。
    const closeTo = (tag) => {
        for (let k = stack.length - 1; k > 0; k--) {
            if (stack[k].tag === tag) { stack.length = k; return true; }
        }
        return false;
    };

    // 主迴圈：用 i 當游標掃過整份 HTML。每圈：找下一個 '<'，前面的是文字；然後判斷是
    //  註解 <!-- -->、<!DOCTYPE> 或 <? ?>、結束標籤 </x>、還是開始標籤 <x ...>。
    while (i < len) {
        const lt = html.indexOf('<', i);
        if (lt === -1) { pushText(html.slice(i)); break; }
        if (lt > i) pushText(html.slice(i, lt));
        i = lt;

        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            i = end === -1 ? len : end + 3;
            continue;
        }
        if (html[i + 1] === '!' || html[i + 1] === '?') {
            const end = html.indexOf('>', i);
            i = end === -1 ? len : end + 1;
            continue;
        }
        if (html[i + 1] === '/') {
            const m = /^<\/\s*([a-zA-Z][\w:-]*)[^>]*>/.exec(html.slice(i, i + 200));
            if (!m) { pushText('<'); i++; continue; }
            const tag = m[1].toLowerCase();
            if (tag === 'br') { if (!bodyEl) ensureBody(); cur().children.push(makeEl('br', {}, cur())); }
            else if (tag === 'head') { if (headEl && stack.includes(headEl)) { stack.length = stack.indexOf(headEl); headClosed = true; } }
            else if (tag === 'body' || tag === 'html') { /* 和瀏覽器一樣忽略，後面的內容仍算 body */ }
            else closeTo(tag);
            i += m[0].length;
            continue;
        }

        const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 100));
        if (!m) { pushText('<'); i++; continue; }
        // 找標籤結尾的 '>'：要略過引號裡面的 '>'（例如 title="a>b"），所以用 quote 變數記錄目前是否在引號內。
        // 找標籤結尾 (略過引號內的 >)
        let j = i + m[0].length;
        let quote = null;
        while (j < len) {
            const c = html[j];
            if (quote) { if (c === quote) quote = null; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '>') break;
            j++;
        }
        const tag = m[1].toLowerCase();
        const rawAttrs = html.slice(i + m[0].length, j);
        const selfClosing = /\/\s*$/.test(rawAttrs);
        i = j + 1;
        if (placeTag(tag, parseAttrs(rawAttrs))) continue;

        // 套用 AUTO_CLOSE 與 P_CLOSERS 規則：往上找可被新標籤隱含關閉的舊標籤，碰到邊界就停。
        // 隱含結束標籤
        if (AUTO_CLOSE[tag]) {
            for (let k = stack.length - 1; k > 0; k--) {
                const t = stack[k].tag;
                if (AUTO_CLOSE[tag].includes(t)) { stack.length = k; break; }
                if (SCOPE_BOUNDARY.has(t)) break;
            }
        }
        if (P_CLOSERS.has(tag)) {
            for (let k = stack.length - 1; k > 0; k--) {
                const t = stack[k].tag;
                if (t === 'p') { stack.length = k; break; }
                if (SCOPE_BOUNDARY.has(t) || t === 'li' || t === 'td' || t === 'th') break;
            }
        }
        // 瀏覽器遇到 <table><tr> 會自動補 <tbody>，XPath 通常寫 table/tbody/tr，所以也要補。
        // 瀏覽器會在 table 直接包 tr 時補上 tbody，XPath 規則通常是照瀏覽器 DOM 寫的
        if (tag === 'tr' && cur().tag === 'table') {
            const tbody = makeEl('tbody', {}, cur());
            cur().children.push(tbody);
            stack.push(tbody);
        }

        const el = makeEl(tag, parseAttrs(rawAttrs), cur());
        cur().children.push(el);

        // 空標籤或自我關閉的 <x/> 不放進堆疊；但 <script/> 這類不算（HTML 裡 script 不能自閉）。
        if (VOID_TAGS.has(tag) || selfClosing && !RAW_TEXT_TAGS.has(tag)) continue;

        // script / style / textarea 等：用結束標籤的正規表示式找到結尾，中間整段當純文字，不解析裡面的標籤。
        if (RAW_TEXT_TAGS.has(tag)) {
            const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
            const rest = html.slice(i);
            const cm = closeRe.exec(rest);
            const content = cm ? rest.slice(0, cm.index) : rest;
            if (content) el.children.push({ type: 'text', text: tag === 'script' || tag === 'style' ? content : decodeEntities(content), parent: el });
            i += cm ? cm.index + cm[0].length : rest.length;
            continue;
        }
        stack.push(el);
    }

    // 替每個節點編號 order（文件中出現的先後）。聯集 a | b 的結果要「去重並依文件順序排序」，靠它排序。
    // 標記文件順序 (聯集去重排序用)
    let order = 0;
    const walk = (n) => { n.order = order++; if (n.children) n.children.forEach(walk); };
    walk(root);
    return root;
}

// 節點工具：取文字 / 型別轉換（XPath 的值可能是節點陣列、字串、數字、布林）。
// ==================== 節點工具 ====================
// textContent(n)：取得節點底下所有文字（遞迴），但略過 script / style 裡的程式碼。
function textContent(n) {
    if (!n) return '';
    if (n.type === 'text') return n.text;
    if (n.type === 'attr') return n.value;
    let s = '';
    for (const c of n.children || []) {
        if (c.type === 'text') s += c.text;
        else if (c.type === 'el' && c.tag !== 'script' && c.tag !== 'style') s += textContent(c);
    }
    return s;
}

// stringValue(v)：轉成字串。節點陣列取第一個節點的文字（XPath 規定），布林轉 'true'/'false'。
function stringValue(v) {
    if (Array.isArray(v)) return v.length ? textContent(v[0]) : '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    return v == null ? '' : String(v);
}

// toBool(v)：轉布林。節點陣列有東西就是 true；數字非 0 非 NaN 是 true；字串非空是 true。
function toBool(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
    if (typeof v === 'string') return v.length > 0;
    return !!v;
}

// toNumber(v)：轉數字，空字串回傳 NaN。
function toNumber(v) {
    const s = stringValue(v).trim();
    return s === '' ? NaN : Number(s);
}

// 第二部分：XPath 詞法分析 (tokenize)。把 "//div[@class='a']/a" 切成一個個「詞」(token)。
// ==================== XPath 詞法 ====================
// tokenize(expr)：回傳 token 陣列，每個 token 形如 {t:類型, v:值}，類型有 str(字串)、op(符號)、num(數字)、name(名稱)。
// 先試兩字元符號（// != <= >= .. ::），再試單一字元符號；數字和名稱用正規表示式匹配。無法辨識的字元丟錯。
function tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const c = expr[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '"' || c === "'") {
            const end = expr.indexOf(c, i + 1);
            if (end === -1) throw new Error('XPath 字串缺少結尾引號');
            tokens.push({ t: 'str', v: expr.slice(i + 1, end) });
            i = end + 1;
            continue;
        }
        const two = expr.slice(i, i + 2);
        if (['//', '!=', '<=', '>=', '..', '::'].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
        if ('/[]()@,|=<>*.+-'.includes(c)) {
            if (c === '.' && /\d/.test(expr[i + 1] || '')) { /* 小數 */ }
            else { tokens.push({ t: 'op', v: c }); i++; continue; }
        }
        const num = /^\d+(\.\d+)?|^\.\d+/.exec(expr.slice(i));
        if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
        const name = /^[a-zA-Z_][\w.-]*(:[a-zA-Z_][\w.-]*)?/.exec(expr.slice(i));
        if (name) { tokens.push({ t: 'name', v: name[0] }); i += name[0].length; continue; }
        throw new Error(`XPath 無法辨識的字元「${c}」`);
    }
    return tokens;
}

// 第三部分：XPath 語法分析，使用「遞迴下降」：每個運算優先順序一個函式，由低到高層層呼叫。
// 優先順序（低到高）：or -> and -> 比較(= != < ...) -> 加減 -> 聯集(|) -> 路徑/函式/字面值。
// 這樣 a or b and c 會自然變成 a or (b and c)。輸出是 AST（用 {k:'種類', ...} 描述的樹）。
// ==================== XPath 語法 (遞迴下降) ====================
// parseXPath(expr)：字串 -> AST。p 是目前讀到第幾個 token。
// peek 看某個位置的 token，isOp/isName 判斷是否為某符號 / 名稱，expectOp 要求下一個必須是某符號否則丟錯。
function parseXPath(expr) {
    const tokens = tokenize(expr);
    let p = 0;
    const peek = (o = 0) => tokens[p + o];
    const isOp = (v, o = 0) => peek(o) && peek(o).t === 'op' && peek(o).v === v;
    const isName = (v, o = 0) => peek(o) && peek(o).t === 'name' && peek(o).v === v;
    const expectOp = (v) => { if (!isOp(v)) throw new Error(`XPath 預期「${v}」`); p++; };

    function parseOr() {
        let left = parseAnd();
        while (isName('or')) { p++; left = { k: 'or', a: left, b: parseAnd() }; }
        return left;
    }
    function parseAnd() {
        let left = parseCmp();
        while (isName('and')) { p++; left = { k: 'and', a: left, b: parseCmp() }; }
        return left;
    }
    function parseCmp() {
        let left = parseAdd();
        while (peek() && peek().t === 'op' && ['=', '!=', '<', '>', '<=', '>='].includes(peek().v)) {
            const op = tokens[p++].v;
            left = { k: 'cmp', op, a: left, b: parseAdd() };
        }
        return left;
    }
    function parseAdd() {
        let left = parseUnion();
        while (isOp('+') || isOp('-')) {
            const op = tokens[p++].v;
            left = { k: 'arith', op, a: left, b: parseUnion() };
        }
        return left;
    }
    function parseUnion() {
        let left = parsePathExpr();
        while (isOp('|')) { p++; left = { k: 'union', a: left, b: parsePathExpr() }; }
        return left;
    }
    // parsePathExpr：最底層的運算元：字串/數字常數、負號、括號、函式呼叫（如 contains(...)），否則當成路徑。
    // text() / node() 看起來像函式但其實是「節點測試」，所以特別排除。
    function parsePathExpr() {
        const t = peek();
        if (!t) throw new Error('XPath 運算式不完整');
        if (t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
        if (t.t === 'num') { p++; return { k: 'lit', v: t.v }; }
        if (t.t === 'op' && t.v === '-') { p++; return { k: 'arith', op: '-', a: { k: 'lit', v: 0 }, b: parsePathExpr() }; }
        if (t.t === 'op' && t.v === '(') {
            p++;
            const inner = parseOr();
            expectOp(')');
            return maybeFilter(inner);
        }
        // 函式呼叫 (排除 text() / node() 這類節點測試)
        if (t.t === 'name' && isOp('(', 1) && !['text', 'node', 'comment'].includes(t.v)) {
            const name = t.v;
            p += 2;
            const args = [];
            if (!isOp(')')) {
                args.push(parseOr());
                while (isOp(',')) { p++; args.push(parseOr()); }
            }
            expectOp(')');
            return maybeFilter({ k: 'fn', name, args });
        }
        return parseLocationPath();
    }
    // maybeFilter(base)：處理「括號或函式後面接 [述詞] 或 /路徑」的情況，例如 (//a)[1]/b。
    function maybeFilter(base) {
        const preds = [];
        while (isOp('[')) { p++; preds.push(parseOr()); expectOp(']'); }
        if (preds.length) base = { k: 'filter', base, preds };
        if (isOp('/') || isOp('//')) {
            const rel = parseLocationPath(true);
            return { k: 'chain', base, rel };
        }
        return base;
    }
    // parseLocationPath：解析路徑 a/b//c。每個 '//' 等於插入一個 descendant-or-self::node() 步驟（所有後代）。
    // absolute 表示以 / 開頭。回傳 {k:'path', absolute, steps[]}。
    function parseLocationPath(continuation = false) {
        const steps = [];
        let absolute = false;
        if (!continuation && (isOp('/') || isOp('//'))) absolute = true;
        let first = true;
        while (true) {
            let sep = null;
            if (isOp('/') || isOp('//')) { sep = tokens[p++].v; }
            else if (!first) break;
            if (sep === '//') steps.push({ axis: 'descendant-or-self', test: { type: 'node' }, preds: [] });
            // 單獨的 "/" 代表根
            if (sep === '/' && first && !continuation && (!peek() || peek().t === 'op' && [']', ')', '|', ','].includes(peek().v))) break;
            steps.push(parseStep());
            first = false;
        }
        return { k: 'path', absolute, steps };
    }
    // parseStep：解析路徑中的一步，包含：. (自己)、.. (父)、@屬性、軸::名稱、* 、text()、元素名稱，以及後面的 [述詞]。
    // step = { axis(方向), test(要什麼節點), preds(篩選條件) }。
    function parseStep() {
        if (isOp('.')) { p++; return { axis: 'self', test: { type: 'node' }, preds: [] }; }
        if (isOp('..')) { p++; return { axis: 'parent', test: { type: 'node' }, preds: [] }; }
        let axis = 'child';
        if (isOp('@')) { p++; axis = 'attribute'; }
        else if (peek() && peek().t === 'name' && isOp('::', 1)) { axis = tokens[p].v; p += 2; }
        let test;
        const t = peek();
        if (t && t.t === 'op' && t.v === '*') { p++; test = { type: 'any' }; }
        else if (t && t.t === 'name' && isOp('(', 1) && ['text', 'node', 'comment'].includes(t.v)) {
            p += 2; expectOp(')');
            test = { type: t.v };
        } else if (t && t.t === 'name') { p++; test = { type: 'name', name: t.v.toLowerCase() }; }
        else throw new Error('XPath 缺少節點名稱');
        const preds = [];
        while (isOp('[')) { p++; preds.push(parseOr()); expectOp(']'); }
        return { axis, test, preds };
    }

    const ast = parseOr();
    if (p < tokens.length) throw new Error(`XPath 多餘的內容「${tokens[p].v}」`);
    return ast;
}

// 第四部分：XPath 求值。拿 AST 去節點樹上實際找東西。
// ==================== XPath 求值 ====================
// axisNodes(node, axis)：給定一個節點與「軸」(方向)，回傳該方向上的所有節點。
// 支援：child 子、self 自己、parent 父、attribute 屬性（臨時產生 attr 節點）、descendant 後代、ancestor 祖先、
// following/preceding-sibling 後/前面的同層兄弟。不支援的軸丟錯。
function axisNodes(node, axis) {
    const out = [];
    const kids = (n) => (n.children || []).filter(c => c.type === 'el' || c.type === 'text');
    switch (axis) {
        case 'child': return kids(node);
        case 'self': return [node];
        case 'parent': return node.parent ? [node.parent] : [];
        case 'attribute':
            if (node.type !== 'el') return [];
            return Object.keys(node.attrs).map(name => ({ type: 'attr', name, value: node.attrs[name], parent: node, order: node.order + 0.5 }));
        case 'descendant':
        case 'descendant-or-self': {
            if (axis === 'descendant-or-self') out.push(node);
            const walk = (n) => { for (const c of kids(n)) { out.push(c); if (c.type === 'el') walk(c); } };
            walk(node);
            return out;
        }
        case 'ancestor':
        case 'ancestor-or-self': {
            if (axis === 'ancestor-or-self') out.push(node);
            let n = node.parent;
            while (n) { out.push(n); n = n.parent; }
            return out;
        }
        case 'following-sibling':
        case 'preceding-sibling': {
            if (!node.parent) return [];
            const sib = kids(node.parent);
            const idx = sib.indexOf(node);
            return axis === 'following-sibling' ? sib.slice(idx + 1) : sib.slice(0, idx).reverse();
        }
        default: throw new Error(`不支援的 XPath 軸 ${axis}`);
    }
}

// matchTest(n, test, axis)：檢查節點是否符合節點測試（名稱相同 / 任何元素 * / text() / node()）。
function matchTest(n, test, axis) {
    switch (test.type) {
        case 'node': return true;
        case 'text': return n.type === 'text';
        case 'comment': return false;
        case 'any': return axis === 'attribute' ? n.type === 'attr' : n.type === 'el';
        case 'name': return axis === 'attribute' ? n.type === 'attr' && n.name === test.name : n.type === 'el' && n.tag === test.name;
        default: return false;
    }
}

// uniqSorted(nodes)：去除重複節點並依文件順序排序（XPath 結果必須無重複且有順序）。屬性節點是臨時產生的，用「父節點 order + 屬性名」當唯一鍵。
function uniqSorted(nodes) {
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
        const key = n.type === 'attr' ? n.parent : n;
        const id = n.type === 'attr' ? `${n.parent.order}@${n.name}` : n;
        if (n.type === 'attr' ? seen.has(id) : seen.has(key)) continue;
        seen.add(n.type === 'attr' ? id : key);
        out.push(n);
    }
    return out.sort((a, b) => a.order - b.order);
}

// applyPreds(nodes, preds)：套用述詞 [ ... ] 篩選。對每個節點求值，並帶上 pos(第幾個) 與 size(總數)。
// 結果若是數字（如 [2]）代表「位置等於該數字」；否則轉成布林判斷。
function applyPreds(nodes, preds) {
    for (const pred of preds) {
        const size = nodes.length;
        nodes = nodes.filter((n, idx) => {
            const v = evalExpr(pred, { node: n, pos: idx + 1, size });
            return typeof v === 'number' ? v === idx + 1 : toBool(v);
        });
    }
    return nodes;
}

// evalSteps(start, steps)：從起點集合出發，一步一步走：每步對集合內每個節點取軸上的節點 -> 過濾 -> 套述詞，再合併去重排序。
function evalSteps(start, steps) {
    let set = start;
    for (const step of steps) {
        const next = [];
        for (const ctx of set) {
            let cands = axisNodes(ctx, step.axis).filter(n => matchTest(n, step.test, step.axis));
            if (step.preds.length) cands = applyPreds(cands, step.preds);
            next.push(...cands);
        }
        set = uniqSorted(next);
    }
    return set;
}

// compare(op, a, b)：XPath 比較。任一邊可能是節點集合：只要「存在一組」值滿足就算 true（XPath 的規定）。
// 有一邊是數字就用數值比較，否則用字串比較。
function compare(op, a, b) {
    const cmp = (x, y) => {
        switch (op) {
            case '=': return x === y;
            case '!=': return x !== y;
            case '<': return Number(x) < Number(y);
            case '>': return Number(x) > Number(y);
            case '<=': return Number(x) <= Number(y);
            case '>=': return Number(x) >= Number(y);
        }
        return false;
    };
    const vals = (v) => Array.isArray(v) ? v.map(textContent) : [v];
    const useNum = typeof a === 'number' || typeof b === 'number';
    for (const x of vals(a)) for (const y of vals(b)) {
        if (useNum ? cmp(Number(x), Number(y)) : cmp(String(x), String(y))) return true;
    }
    return false;
}

// 支援的 XPath 函式表，每個函式簽名 (ctx, ...引數)；ctx 含目前節點 node、位置 pos、總數 size。
// 沒給引數的 normalize-space() 等預設用目前節點。last() / position() 讀 ctx。
const FUNCS = {
    contains: (ctx, a, b) => stringValue(a).includes(stringValue(b)),
    'starts-with': (ctx, a, b) => stringValue(a).startsWith(stringValue(b)),
    'ends-with': (ctx, a, b) => stringValue(a).endsWith(stringValue(b)),
    not: (ctx, a) => !toBool(a),
    'normalize-space': (ctx, a) => stringValue(a === undefined ? [ctx.node] : a).replace(/\s+/g, ' ').trim(),
    'string-length': (ctx, a) => stringValue(a === undefined ? [ctx.node] : a).length,
    string: (ctx, a) => stringValue(a === undefined ? [ctx.node] : a),
    concat: (ctx, ...args) => args.map(stringValue).join(''),
    count: (ctx, a) => Array.isArray(a) ? a.length : 0,
    last: (ctx) => ctx.size,
    position: (ctx) => ctx.pos,
    true: () => true,
    false: () => false,
    number: (ctx, a) => toNumber(a === undefined ? [ctx.node] : a)
};

// evalExpr(ast, ctx)：依 AST 節點種類 (k) 遞迴求值。回傳可能是節點陣列、字串、數字或布林。
// 各 case：lit 常數、or/and 邏輯、cmp 比較、arith 加減、union 聯集、fn 函式、filter 述詞篩選、chain 串接路徑、path 路徑。
function evalExpr(ast, ctx) {
    switch (ast.k) {
        case 'lit': return ast.v;
        case 'or': return toBool(evalExpr(ast.a, ctx)) || toBool(evalExpr(ast.b, ctx));
        case 'and': return toBool(evalExpr(ast.a, ctx)) && toBool(evalExpr(ast.b, ctx));
        case 'cmp': return compare(ast.op, evalExpr(ast.a, ctx), evalExpr(ast.b, ctx));
        case 'arith': {
            const a = toNumber(evalExpr(ast.a, ctx)), b = toNumber(evalExpr(ast.b, ctx));
            return ast.op === '+' ? a + b : a - b;
        }
        case 'union': {
            const a = evalExpr(ast.a, ctx), b = evalExpr(ast.b, ctx);
            return uniqSorted([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
        }
        case 'fn': {
            const fn = FUNCS[ast.name];
            if (!fn) throw new Error(`不支援的 XPath 函式 ${ast.name}()`);
            return fn(ctx, ...ast.args.map(a => evalExpr(a, ctx)));
        }
        case 'filter': {
            const base = evalExpr(ast.base, ctx);
            return Array.isArray(base) ? applyPreds(base, ast.preds) : base;
        }
        case 'chain': {
            const base = evalExpr(ast.base, ctx);
            return Array.isArray(base) ? evalSteps(base, ast.rel.steps) : [];
        }
        case 'path': {
            // Kazumi 的慣例：在某個元素上執行查詢時，開頭的 / 或 // 都從「該元素」開始往下找，而不是從整份文件的根。
            // 在文件上查詢時從根開始；在元素上查詢時 (Kazumi 慣例) 開頭的 / 或 // 都從該元素開始
            return evalSteps([ctx.node], ast.steps);
        }
        default: throw new Error('XPath 求值錯誤');
    }
}

// 快取：同一個 XPath 字串只需要解析一次。compile(expr) 先查快取；超過 500 筆就整個清空（避免記憶體無限成長）。空字串丟錯。
const astCache = new Map();
function compile(expr) {
    const key = String(expr || '').trim();
    if (!key) throw new Error('XPath 不可為空');
    if (astCache.has(key)) return astCache.get(key);
    const ast = parseXPath(key);
    if (astCache.size > 500) astCache.clear();
    astCache.set(key, ast);
    return ast;
}

// select(context, expr)：對外主要函式。以 context 節點為起點執行 XPath，永遠回傳節點陣列
// （如果結果是字串 / 數字，就包成一個文字節點）。
/** 以 context 節點執行 XPath，回傳節點陣列 (非節點結果包成文字節點) */
function select(context, expr) {
    const ast = compile(expr);
    let v = evalExpr(ast, { node: context, pos: 1, size: 1 });
    // 備援：在元素上用絕對路徑查不到時，製造一個「虛擬父文件」把元素放進去再查一次，
    // 這樣規則第一步就是元素本身（例如清單項目本身就是 div）也能命中。
    // 在元素上查不到時，再試一次「第一步可以是元素自己」(例如項目本身就是規則裡的第一個 div)
    if (Array.isArray(v) && !v.length && context.type === 'el' && ast.k === 'path' && ast.absolute) {
        const virtual = { type: 'doc', tag: '#virtual', attrs: {}, children: [context], parent: null, order: context.order - 0.5 };
        v = evalExpr(ast, { node: virtual, pos: 1, size: 1 });
    }
    if (Array.isArray(v)) return v;
    return [{ type: 'text', text: stringValue(v), parent: null, order: 0 }];
}

// selectText(context, expr)：取文字。全是文字節點就串接；否則取第一個節點的文字。空白一律壓成單一空格並去頭尾。找不到回傳 ''。
/** 取第一個結果的文字 (多個 text() 節點會串接) */
function selectText(context, expr) {
    const nodes = select(context, expr);
    if (!nodes.length) return '';
    if (nodes.every(n => n.type === 'text')) return nodes.map(n => n.text).join('').replace(/\s+/g, ' ').trim();
    return textContent(nodes[0]).replace(/\s+/g, ' ').trim();
}

// selectLink(context, expr, attrs)：取連結網址。屬性節點直接取值；文字節點取內容；元素取 href（可用 attrs 指定別的屬性）；
// 元素本身沒有就往裡面找第一個 <a href>。找不到回傳 ''。
/** 取連結：屬性節點直接取值；元素取 href (沒有就往內找第一個 a[@href]) */
function selectLink(context, expr, attrs = ['href']) {
    const nodes = select(context, expr);
    for (const n of nodes) {
        if (n.type === 'attr') return n.value.trim();
        if (n.type === 'text') { const t = n.text.trim(); if (t) return t; continue; }
        for (const a of attrs) if (n.attrs && n.attrs[a]) return n.attrs[a].trim();
        const inner = select(n, './/a[@href]');
        if (inner.length) return inner[0].attrs.href.trim();
    }
    return '';
}

// 對外匯出：parseHtml 解析網頁；select / selectText / selectLink 查詢；textContent、compile 供其他模組使用。
module.exports = { parseHtml, select, selectText, selectLink, textContent, compile };
