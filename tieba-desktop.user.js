// ==UserScript==
// @name         百度贴吧电脑版强制与移动自适应
// @namespace    tieba.desktop.enforcer
// @version      1.0
// @description  移动端访问百度贴吧时默认加载电脑版并修复窄屏布局，帖子页附带所属吧名片。公共领域发布（CC0）。
// @match        *://tieba.baidu.com/*
// @exclude      *://tieba.baidu.com/mo/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      tieba.baidu.com
// @noframes
// ==/UserScript==
(function () {
  'use strict';

  /**
   * 原理（已在 Kiwi Browser + Tampermonkey 上实测）：
   * 贴吧服务端根据 User-Agent 与客户端提示（Client Hints）决定下发手机版（wise）还是电脑版（pc）HTML。
   * 油猴脚本无法修改浏览器导航请求的 UA，但 GM_xmlhttpRequest 可以覆写 User-Agent 请求头。
   *
   * 流程：
   * 1. document-start 时先在【页面上下文】注入一个占位页（document.open/write），
   *    使原手机版页面的 JS 没有机会执行。
   * 2. 沙箱内用桌面 UA 抓取当前 URL，校验是 PC 版 HTML（含 /tb/pc/ 静态资源路径）后 document.write 整体替换。
   * 3. 页面上下文伪装 navigator.userAgent / userAgentData，防止 PC 版前端自我检测跳回手机版；
   *    注入 viewport 与响应式 CSS 激活窄屏自适应。
   * 4. 抓取失败时带标记重载一次，回退到原始手机版页面（仅试 2 次，防死循环）。
   */

  var DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  var MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  var PC_MARK = '/tb/pc/';          // PC 版 HTML 必然引用的静态资源路径
  var WISE_MARK_1 = 'wise-main';    // 手机版（wise）HTML 标记
  var WISE_MARK_2 = 'apple-itunes-app';
  var KEY_OFF = 'tbpc-off';         // 用户在本会话选择"回到手机版"
  var KEY_RETRY = 'tbpc-retries';   // 防止极端情况下无限重试
  var KEY_NOSTOP = 'tbpc-nostop';   // 抓取失败后的回退重载标记

  if (window.top !== window.self) return;

  /* ---------------- 工具 ---------------- */

  function isWiseHtml(html) {
    return html.indexOf(WISE_MARK_1) !== -1 || html.indexOf(WISE_MARK_2) !== -1;
  }

  function toast(msg, ms) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(0,0,0,.82);color:#fff;font:14px/1.6 sans-serif;padding:8px 16px;border-radius:8px;max-width:90vw;';
    (document.body || document.documentElement).appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 4000);
  }

  /* ---------------- 页面上下文伪装（阻止 PC 版 JS 跳回手机版） ---------------- */

  var spoofSource = function () {
    'use strict';
    var UA = '__UA__';
    try {
      var defs = {
        userAgent: function () { return UA; },
        appVersion: function () { return '5.0 (Windows NT 10.0; Win64; x64)'; },
        platform: function () { return 'Win32'; },
        maxTouchPoints: function () { return 0; }
      };
      var target = Navigator.prototype;
      Object.keys(defs).forEach(function (k) {
        try { Object.defineProperty(target, k, { get: defs[k], configurable: true }); } catch (e) { /* 忽略 */ }
      });
      try {
        var uad = {
          brands: [
            { brand: 'Chromium', version: '126' },
            { brand: 'Google Chrome', version: '126' },
            { brand: 'Not-A.Brand', version: '99' }
          ],
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: function () {
            return Promise.resolve({ architecture: 'x86', bitness: '64', model: '', platform: 'Windows', platformVersion: '15.0.0', uaFullVersion: '126.0.0.0' });
          },
          toJSON: function () { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; }
        };
        Object.defineProperty(target, 'userAgentData', { get: function () { return uad; }, configurable: true });
      } catch (e) { /* 忽略 */ }
    } catch (e) { /* 忽略 */ }
  }.toString().replace('__UA__', DESKTOP_UA);

  /**
   * 精灵图单例复位（页面上下文执行）。
   * 贴吧 PC 版的 svg-sprite-loader 用 window.__SVG_SPRITE__ 做单例，且 mount() 一旦
   * isMounted（= 节点已创建）就直接早返回，不会再往文档里挂。
   * 真机实测：同一页面会被【两份本脚本副本】先后 document.write（旧安装那份仍留着），
   * 第二次 write 时窗口上的旧实例节点已随旧文档一起销毁，站点脚本重新执行时复用该实例
   * → 挂载早退 → 236 个 symbol 一个不缺，但节点不在文档里，所有 <use> 引用断链，
   * 顶栏图标全部空白。每次重写前把单例复位，站点就会重建并重新挂载精灵图。
   * （本脚本内联在 <head> 最前面，先于站点任何脚本执行。） */
  var SPRITE_RESET_SRC = function () {
    'use strict';
    try { delete window.__SVG_SPRITE__; } catch (e) { /* 忽略 */ }
    try { window.__SVG_SPRITE__ = void 0; } catch (e) { /* 忽略 */ }
  }.toString();

  /* ---------------- 占位页（页面上下文执行：替换原 wise 文档，沙箱不受影响） ---------------- */

  var PLACEHOLDER_SRC = function () {
    'use strict';
    try {
      document.open();
      document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>百度贴吧</title>' +
        '<style>html,body{height:100%;margin:0;background:#f5f6f7;color:#333;font:15px/1.6 sans-serif;display:flex;align-items:center;justify-content:center;-webkit-user-select:none}@media (prefers-color-scheme:dark){html,body{background:#0b0b0b;color:#ddd}}</style>' +
        '</head><body><div>正在加载电脑版贴吧&#8230;</div></body></html>');
      document.close();
    } catch (e) { /* 忽略 */ }
  }.toString();

  var seized = false;
  function seizePage() {
    try {
      var s = document.createElement('script');
      s.textContent = '(' + PLACEHOLDER_SRC + ')();';
      (document.documentElement || document.head).appendChild(s);
      seized = true;
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 响应式 CSS ----------------
   * 设计原则：不覆盖站点布局，只修复它在"手机宽度"下失效的部分。
   * 下列规则全部来自在 412 CSS px 视口下的实测（Kiwi + 贴吧 PC 版 2026 页面快照）：
   *
   * A. 顶栏搜索框：站点 .search-mid 是 flex:1 且 min-width:0，窄屏时被右侧菜单挤到约 11px；
   *    其绝对定位子元素（.frs-search-tag 吧名标签、.login-guide-placeholder 提示文字）
   *    仍按自身宽度绘制，于是溢出并压住右侧按钮 —— 这就是"搜索栏和其它 UI 元素重叠"。
   * B. 内容容器：帖子页 .pb-page-wrapper .container 写死 min-width:473px，
   *    窄屏下容器宽 473px > 视口，右侧被 overflow:hidden 裁掉约 61~97px ——
   *    这同时造成"标题溢出屏幕"和回复框"发布键只显示一半"。
   * C. 帖子标题：.pb-title-wrap / .pb-title 为 nowrap，配合上面的 473px 容器被裁切。
   * D. 操作栏：.action-bar-warp .action-item-wrapper 写死 width:141px，多个并排即溢出视口；
   *    楼层页脚 .comment-desc-left/right 在窄屏把"第 N 楼/日期/地区"逐字换行。
   * E. 发帖弹层：.publisher-container 写死 min-width:545px，窄屏下整个弹层（含工具栏）
   *    溢出视口、右侧按钮被裁。
   *
   * 断点沿用站点自身的 1005px（单列窄屏布局）与 768px（手机宽度）。 */
  var RESPONSIVE_CSS = [
    'html{-webkit-text-size-adjust:100%;}',
    'body{overflow-x:hidden !important;margin:0;}',
    'pre,code{white-space:pre-wrap !important;word-break:break-word !important;}',

    /* --- 站点窄屏断点：去掉写死的桌面最小宽度，内容用满视口 ---
     * 注意：帖子页容器用左右 padding 缩进（站点 47px），吧页/主页用左右 margin 缩进（站点 36px）。
     * 对 margin 型容器绝不能改成 width:100%，否则会向右多出 36px 造成"信息流溢出屏幕"。 */
    '@media (max-width:1005px){',
    /* 帖子页（/p/）：padding 型缩进 */
    '  .pb-page-wrapper .container,.pc-pb-box .container{',
    '    min-width:0 !important;width:100% !important;max-width:100% !important;',
    '    box-sizing:border-box !important;padding-left:10px !important;padding-right:10px !important;',
    '  }',
    /* 吧页（/f?kw=）/ 主页（/）/ 个人中心：margin 型缩进。
     * 站点用固定/计算宽度，需同时 width:auto 才能真正用满视口。 */
    '  .frs-page-container,.site-group-container,.home-page-wrapper>.container,.user-information-wrapper,.usercenter-content-wrapper{',
    '    margin-left:10px !important;margin-right:10px !important;width:auto !important;',
    '  }',
    '  .pc-pb-box,.pb-page-wrapper,.frs-page-wrap,.frs-container,.home-page-wrapper{min-width:0 !important;}',
    /* 帖子页吸顶标题条：站点是 margin-left:36px + calc(100vw - 72px)，右侧留 72px 空档，
     * 内容滚动时会从空档穿出、与标题文字重叠（"导航栏过短"）。改为与容器同宽并给白底。 */
    '  .pc-pb-title,.pb-title-wrap{margin-left:0 !important;margin-right:0 !important;width:100% !important;max-width:100% !important;box-sizing:border-box !important;background-color:var(--cos-color-bg-raised,#fff) !important;padding-left:10px !important;padding-right:10px !important;}',
    /* 吧页吸顶标签栏：站点依赖滚动时动态加 .is-sticky 才给白底；本内核下该类不生效，
     * 导致标签栏透明、信息流从下方穿出（"导航栏不应无背景"）。直接给白底。 */
    '  .sticky-area{background-color:var(--cos-color-bg-raised,#fff) !important;}',
    '  .pb-title-wrap{min-width:0 !important;}',
    '  .pb-title{white-space:normal !important;word-break:break-word !important;}',
    '  .action-bar-warp{flex-wrap:wrap !important;height:auto !important;left:0 !important;}',
    '  .action-item-wrapper{width:auto !important;min-width:0 !important;flex:0 1 auto !important;}',
    '  .action-item{white-space:nowrap !important;}',
    '  .pc-pb-comments-desc{flex-wrap:wrap !important;}',
    '  .comment-desc-left,.comment-desc-right{flex-wrap:wrap !important;}',
    /* 顶栏与吸顶标题条之间不再出现 1px 亮线/色阶缝：顶栏与标题条同底色，并去掉顶栏下边框 */
    '  .top-nav-bar{background-color:var(--cos-color-bg-raised,#fff) !important;border-bottom-color:transparent !important;}',
    /* 顶栏(60px)与吸顶标题条是两个盒，DPR=2.75 下交界处会漏出 0.x px 的底下内容（一条亮缝）。
     * 顶栏层级(2000)高于标题条(201)，所以在顶栏下沿补 2px 同色不透明条，把缝盖死。 */
    '  .top-nav-bar::after{content:"";position:absolute;left:0;right:0;top:100%;height:3px;background:var(--cos-color-bg-raised,#fff);}',
    /* 帖内导航栏（全部回复/只看楼主/排序）：站点默认只在「向上滑」时给它 top+sticky-active，
     * 向下滑就溜走。这里改为始终吸顶，并贴在吸顶标题条下方（高度由脚本写入 --tbpc-title-h）。
     * -1.5px 是故意让它「上钻」进标题条底部，靠标题条(201)盖住重叠部分，消除 0.27px 漏缝。 */
    '  .pc-pb-reply-top{position:sticky !important;top:calc(var(--tbpc-title-h,51px) - 1.5px) !important;}',
    '}',

    /* --- 手机宽度：顶栏收敛，搜索框可正常键入 --- */
    '@media (max-width:768px){',
    '  .top-nav-bar{padding:0 8px !important;}',
    '  .home-left,.right-menu{flex:0 0 auto !important;}',
    /* 次要入口（下载客户端/游戏中心）窄屏隐藏；保留"消息/通知"按钮（.menu-item），
     * 功能与桌面端一致。隐藏对象用子元素选择器限定为 menu-list 里的两个 SPAN 弹层入口。 */
    '  .right-menu .menu-list>span{display:none !important;}',
    '  .search-mid{margin:0 8px !important;min-width:0 !important;flex:1 1 auto !important;}',
    /* 吧名标签在窄屏与搜索占位文字重叠，隐藏之（搜索仍限定在当前吧） */
    '  .search-mid .frs-search-tag{display:none !important;}',
    '  .search-mid .login-guide-placeholder{left:36px !important;right:64px !important;white-space:nowrap !important;overflow:hidden !important;text-overflow:ellipsis !important;}',
    '  .search-mid .search-box{padding-left:36px !important;}',
    /* 窄机身（如 393px）+ 未登录时的「登录」按钮固定 80px，会把搜索框挤到 ~95px；
     * 收窄按钮与间距，保证搜索框可用（登录态此处是 32px 头像，不受影响）。 */
    '  .user-or-login{margin-left:8px !important;}',
    '  .user-or-login .login-btn{width:auto !important;min-width:0 !important;padding-left:12px !important;padding-right:12px !important;}',
    /* 搜索建议下拉：宽度跟随搜索框，且不超出视口 */
    '  .search-list-wrapper{max-width:100vw !important;box-sizing:border-box !important;}',

    /* 搜索聚焦模式：搜索框获得焦点时隐藏右侧按钮组（+号/消息/头像），
     * 搜索框自动扩展到剩余宽度，建议下拉（宽度=搜索框宽）同步变宽；
     * 失焦/Esc/点建议跳转后自动还原。纯 CSS（:has + :focus-within，Chromium 105+），
     * 不隐藏汉堡键与 logo：保持搜索框左缘不动，避免"失焦先收缩导致点不中建议项"。 */
    '  .top-nav-bar:has(.search-box:focus-within) .right-menu{display:none !important;}',
    '  .top-nav-bar:has(.search-box:focus-within) .search-mid{flex:1 1 auto !important;margin:0 8px !important;}',
    /* 失焦后若建议下拉仍开着（如点搜索框边缘未跳转），按窄搜索框宽度显示会截断文字，
     * 与桌面端行为一致：失焦即隐藏，重新聚焦再出现。 */
    '  .search-mid:not(:has(.search-box:focus-within)) .search-list-wrapper{display:none !important;}',

    /* 发帖弹层：站点 .publisher-container 写死 min-width:545px，窄屏下整体溢出、
     * 工具栏第 4 个按钮被裁。放开最小宽度并约束不超出视口（内部均为流式宽度，随容器收缩）。
     * 连带修复收缩后暴露的三处：工具栏不换行改为收缩内边距（wrap 会因容器固定高而叠字）、
     * 表单标签禁止换行（防"展示范围"竖排）、下拉选择器允许收缩（防定宽 346px 再次溢出）。 */
    '  .publisher-warp .publisher-container{min-width:0 !important;width:100% !important;max-width:100vw !important;box-sizing:border-box !important;}',
    '  .publisher-warp .item-title{white-space:nowrap !important;flex:0 0 auto !important;}',
    '  .publisher-warp .pull-down-selector-warp{width:auto !important;flex:1 1 auto !important;min-width:0 !important;}',
    '  .publisher-warp .action-buttons{flex-wrap:nowrap !important;}',
    '  .publisher-warp .action-btn{min-width:0 !important;padding-left:4px !important;padding-right:4px !important;}',

    /* 发帖/回复等表单与弹层：工具栏可换行，标签不逐字竖排，整体不超出视口。
     * 仅调整"换行 / 最大宽度 / 盒模型"，不改动任何宽度与布局方向，属保守兜底。 */
    '  [class*="toolbar"],[class*="tool-bar"]{flex-wrap:wrap !important;}',
    '  [class*="form-item"],[class*="form_item"]{flex-wrap:wrap !important;}',
    '  [class*="form-item"]>[class*="label"],[class*="form-item"]>label{white-space:nowrap !important;flex:0 0 auto !important;}',
    '  [class*="dialog"],[class*="modal"],[class*="editor"]{max-width:100vw !important;box-sizing:border-box !important;}',
    /* 弹层以 translate(-50%,-50%) 垂直居中；当内容高于视口时顶部会被推出屏幕
     * （"编辑资料"顶部被裁）。用 max-height + 内部滚动把它拉回屏幕内。 */
    '  .dialog-wrapper-container{max-height:100vh !important;max-height:100dvh !important;overflow-y:auto !important;}',
    /* 输入框字数计数器（如 "9/10"）在窄屏被压成竖排，禁止换行并禁止收缩 */
    '  .t-input-word-limit{white-space:nowrap !important;flex:0 0 auto !important;}',
    '}',

    /* --- 图标"气泡"提示：全部隐藏（与断点无关） ---
     * 站点把顶栏提示做成 mouseenter 触发的小气泡：.toHome「前往贴吧主页」、
     * .toNav「导航栏」、.menu-text 菜单名。触屏点按会派发 mouseenter，却基本不再派发
     * mouseleave，于是气泡一直挂在图标下方（真机截图复现）。
     * .tooltip__popper 是站点通用 tooltip 组件，监听了 click，点图标即弹出带箭头的黑底方块。
     * 三者都只是提示层，隐藏不影响任何功能。 */
    '.top-nav-bar .home-left .tb-home .toHome,.top-nav-bar .home-left .tb-home .toNav,.top-nav-bar .menu-item .menu-text{display:none !important;}',
    '.tooltip__popper{display:none !important;}'
  ].join('\n');

  /* ---------------- 帖子内"本吧"卡片 样式 ---------------- */
  /* 颜色一律走站点 CSS 变量（亮/暗模式各有一套），带亮色回退，避免暗色模式下白底/白块 */
  var FORUM_CARD_CSS = [
    '#tbpc-forum-card{box-sizing:border-box;margin:12px 0 4px;padding:10px 12px;border:1px solid var(--cos-color-border-minor,#e6e7eb);border-radius:10px;background:var(--cos-color-bg-raised,#fff);font-size:13px;line-height:1.5;color:var(--cos-color-text,#333);cursor:pointer;-webkit-tap-highlight-color:transparent;}',
    '#tbpc-forum-card:hover{border-color:var(--cos-color-border-minor,#c9d3ea);}',
    '#tbpc-forum-card:active{background:var(--cos-button-color-bg,#f7f8fa);}',
    '#tbpc-forum-card .tbpc-fc-row1{display:flex;align-items:center;}',
    '#tbpc-forum-card .tbpc-fc-avatar{flex:0 0 auto;width:40px;height:40px;border-radius:9px;object-fit:cover;background:var(--cos-button-color-bg,#f2f3f5);}',
    '#tbpc-forum-card .tbpc-fc-main{flex:1 1 auto;min-width:0;margin-left:10px;}',
    '#tbpc-forum-card .tbpc-fc-name{display:block;font-size:15px;font-weight:600;color:var(--cos-color-text,#1a1a1a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#tbpc-forum-card .tbpc-fc-data{margin-top:2px;font-size:12px;color:var(--cos-color-text-minor,#909399);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#tbpc-forum-card .tbpc-fc-data span+span{margin-left:10px;}',
    '#tbpc-forum-card .tbpc-fc-arrow{flex:0 0 auto;margin-left:8px;color:var(--cos-color-text-minor,#c0c4cc);font-size:16px;line-height:1;}',
    '#tbpc-forum-card .tbpc-fc-meta{display:flex;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:12px;color:var(--cos-color-text-minor,#909399);}',
    '#tbpc-forum-card .tbpc-fc-meta>*{margin-right:12px;}',
    '#tbpc-forum-card .tbpc-fc-tag{padding:1px 6px;border-radius:4px;background:var(--cos-button-color-bg,#f2f3f5);color:var(--cos-color-text-minor,#666);}',
    '#tbpc-forum-card .tbpc-fc-desc{margin-top:6px;font-size:12px;color:var(--cos-color-text-minor,#666);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}'
  ].join('\n');

  /* ---------------- 手机版/电脑版切换 ----------------
   * 按用户要求放入脚本管理器菜单，不再在页面右下角浮动按钮（它会挡住内容）。 */

  var menuReady = false;

  function addFallbackButton() {
    // 仅当脚本管理器不支持菜单命令时，才用浮动按钮兜底
    if (document.getElementById('tbpc-mobile-btn')) return;
    var b = document.createElement('button');
    b.id = 'tbpc-mobile-btn';
    b.textContent = '📱 手机版';
    b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:var(--cos-color-bg-raised,#fff);border:1px solid var(--cos-color-border-minor,#ccc);color:var(--cos-color-text,#333);border-radius:16px;padding:6px 12px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.85;';
    b.addEventListener('click', function () {
      try { sessionStorage.setItem(KEY_OFF, '1'); } catch (e) { /* 忽略 */ }
      location.reload();
    });
    (document.body || document.documentElement).appendChild(b);
  }

  function registerMenu() {
    if (menuReady) return;
    menuReady = true;
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('📱 切换到手机版（本会话）', function () {
        try { sessionStorage.setItem(KEY_OFF, '1'); } catch (e) { /* 忽略 */ }
        location.reload();
      });
      GM_registerMenuCommand('💻 切换到电脑版', function () {
        try { sessionStorage.removeItem(KEY_OFF); } catch (e) { /* 忽略 */ }
        location.reload();
      });
    } else {
      addFallbackButton();
    }
  }

  /* ---------------- 帖子内"本吧"卡片 ----------------
   * 在帖子正文下方展示该帖所属吧的名片（头像/吧名/关注数/帖子数/建吧日期/分类/简介）。
   * 整张卡片可点击，点击后进入该吧主页。
   *
   * 数据来源：贴吧自身的移动页 /mo/q/frsinfo?kw=XXX（服务端渲染，页面内嵌 forum 对象，
   * 含 member_num/post_num/attrs.forum_ctime/forum_tag_info/card_p1{avatar,slogan,desc}）。
   * 该卡片只在帖子页（/p/）出现，且随 SPA 重新渲染自动补齐。 */

  var CARD_ID = 'tbpc-forum-card';

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function unescapeHtml(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function fmtCount(n) {
    n = parseInt(n, 10) || 0;
    if (n >= 10000) {
      var w = n / 10000;
      var s = w >= 100 ? String(Math.round(w)) : String(Math.round(w * 10) / 10);
      return s.replace(/\.0$/, '') + 'W';
    }
    return String(n);
  }

  /* 建吧日期按北京时间（UTC+8）换算 */
  function fmtDate(ts) {
    ts = parseInt(ts, 10);
    if (!ts) return '';
    var d = new Date((ts + 8 * 3600) * 1000);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getUTCFullYear() + '.' + p(d.getUTCMonth() + 1) + '.' + p(d.getUTCDate());
  }

  /* 从移动页 HTML 中取出 forum 对象（对象字面量，按花括号配对截取后 JSON.parse） */
  function extractForum(html) {
    var key = 'forum: {';
    var i = html.indexOf(key);
    if (i < 0) return null;
    var start = i + key.length - 1;
    var depth = 0, inStr = false, esc = false;
    for (var j = start; j < html.length; j++) {
      var c = html.charAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(html.slice(start, j + 1)); } catch (e) { return null; }
          }
        }
      }
    }
    return null;
  }

  function getForumNameFromPage() {
    var el = document.querySelector('.frs-search-tag .forum-name-main');
    if (el && el.textContent.trim()) return el.textContent.trim();
    var tag = document.querySelector('.frs-search-tag');
    if (tag) {
      var t = tag.textContent.replace(/[✕×\s]/g, '');
      if (t) return t.replace(/吧$/, '');
    }
    return '';
  }

  function getForumAvatarFromPage() {
    var img = document.querySelector('.frs-search-tag img');
    if (!img) return '';
    return img.getAttribute('data-src') || img.getAttribute('src') || '';
  }

  function forumUrl(kw) { return 'https://tieba.baidu.com/f?kw=' + encodeURIComponent(kw); }

  function gmGet(url, cb, headers) {
    GM_xmlhttpRequest({
      method: 'GET', url: url, headers: headers || {}, timeout: 15000,
      onload: function (r) { cb(r.status === 200 ? r.responseText : null); },
      onerror: function () { cb(null); },
      ontimeout: function () { cb(null); }
    });
  }

  function buildCard(kw) {
    var card = document.createElement('div');
    card.id = CARD_ID;
    card.setAttribute('data-kw', kw);
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    var av = getForumAvatarFromPage();
    card.innerHTML =
      '<div class="tbpc-fc-row1">' +
        '<img class="tbpc-fc-avatar" alt=""' + (av ? ' src="' + escapeHtml(av) + '"' : '') + '>' +
        '<div class="tbpc-fc-main">' +
          '<div class="tbpc-fc-name"></div>' +
          '<div class="tbpc-fc-data"></div>' +
        '</div>' +
        '<div class="tbpc-fc-arrow">›</div>' +
      '</div>' +
      '<div class="tbpc-fc-meta"></div>' +
      '<div class="tbpc-fc-desc" style="display:none"></div>';
    card.querySelector('.tbpc-fc-name').textContent = kw + '吧';
    var go = function () { location.href = forumUrl(kw); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    return card;
  }

  var forumInfoCache = {};
  var FORUM_INFO_TTL = 10 * 60 * 1000;

  function fetchForumInfo(kw, cb) {
    var hit = forumInfoCache[kw];
    if (hit && Date.now() - hit.t < FORUM_INFO_TTL) return cb(hit.v);
    gmGet('https://tieba.baidu.com/mo/q/frsinfo?kw=' + encodeURIComponent(kw), function (html) {
      if (!html) return cb(null);
      var f = extractForum(html);
      if (!f) return cb(null);
      var card = {};
      try { card = JSON.parse(unescapeHtml(f.attrs.card_p1.style_name)); } catch (e) { card = {}; }
      var tags = (f.attrs.forum_tag_info && f.attrs.forum_tag_info.static_tag) || [];
      var info = {
        fid: f.id, name: f.name, member_num: f.member_num, post_num: f.post_num,
        ctime: f.attrs.forum_ctime,
        tags: tags, avatar: card.avatar || '', slogan: card.slogan || '', desc: card.desc || ''
      };
      forumInfoCache[kw] = { t: Date.now(), v: info };
      cb(info);
    }, { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' });
  }

  function fillCard(card, kw, info) {
    var nameEl = card.querySelector('.tbpc-fc-name');
    var dataEl = card.querySelector('.tbpc-fc-data');
    var metaEl = card.querySelector('.tbpc-fc-meta');
    var descEl = card.querySelector('.tbpc-fc-desc');
    if (!nameEl) return;
    nameEl.textContent = ((info && info.name) || kw) + '吧';
    if (!info) return;
    if (info.avatar) {
      var img = card.querySelector('.tbpc-fc-avatar');
      img.src = info.avatar.replace(/^http:/, 'https:');
    }
    var parts = [];
    if (info.member_num != null) parts.push('<span>关注' + fmtCount(info.member_num) + '</span>');
    if (info.post_num != null) parts.push('<span>帖子' + fmtCount(info.post_num) + '</span>');
    dataEl.innerHTML = parts.join('');
    var meta = [];
    if (info.ctime) meta.push('<span>建吧日期：' + fmtDate(info.ctime) + '</span>');
    (info.tags || []).slice(0, 2).forEach(function (t) { meta.push('<span class="tbpc-fc-tag">' + escapeHtml(t) + '</span>'); });
    metaEl.innerHTML = meta.join('');
    var desc = info.desc || info.slogan || '';
    if (desc) { descEl.textContent = desc; descEl.style.display = ''; }
  }

  /* 把吸顶标题条的实际高度写进 CSS 变量，供帖内导航栏的吸顶偏移（top）使用 */
  function syncTitleHeight() {
    try {
      var t = document.querySelector('.pc-pb-title');
      if (!t) return;
      var h = Math.round(t.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--tbpc-title-h', h + 'px');
    } catch (e) { /* 忽略 */ }
  }
  /* 滚动/缩放时立刻重算（每帧最多一次），比 500ms 轮询更跟手，
   * 避免页面刚渲染完标题条高度还是旧值时，帖内导航栏贴错位置。 */
  var titleSyncQueued = false;
  function queueTitleSync() {
    if (titleSyncQueued) return;
    titleSyncQueued = true;
    requestAnimationFrame(function () {
      titleSyncQueued = false;
      syncTitleHeight();
    });
  }
  document.addEventListener('scroll', queueTitleSync, true);
  window.addEventListener('resize', queueTitleSync);

  function ensureForumCard() {
    var isThread = location.pathname.indexOf('/p/') === 0;
    var existing = document.getElementById(CARD_ID);
    if (!isThread) { if (existing) existing.remove(); return; }
    var kw = getForumNameFromPage();
    if (!kw) return;
    if (existing) {
      if (existing.getAttribute('data-kw') === kw && existing.parentNode) return;
      existing.remove();
    }
    var anchor = document.querySelector('.pc-pb-first-floor-interactive') || document.querySelector('.pb-content-wrap');
    if (!anchor || !anchor.parentNode) return;
    var card = buildCard(kw);
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
    fetchForumInfo(kw, function (info) { fillCard(card, kw, info); });
  }

  var cardTimer = null;
  function startForumCard() {
    if (cardTimer) return;
    cardTimer = setInterval(ensureForumCard, 1500);
    ensureForumCard();
  }

  /* 桌面版网站（Desktop site）提示：该模式会强制宽视口（~980）并整体缩放页面，
   * 破坏本脚本按 384~412px 设计的窄屏适配。检测到就提示一次（每会话）。 */
  function checkDesktopSiteMode() {
    try {
      if (sessionStorage.getItem('tbpc-dsmode') === '1') return;
      var sw = screen && screen.width ? screen.width : 0;
      if (sw && sw < 700 && window.innerWidth > 700) {
        sessionStorage.setItem('tbpc-dsmode', '1');
        toast('提示：浏览器「桌面版网站」已开启，建议关闭以获得最佳手机排版', 7000);
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- SVG 精灵图守卫 ----------------
   * 贴吧 PC 版的图标全部走内联 SVG 精灵图（<svg id="__SVG_SPRITE_NODE__"> 里几百个 <symbol>，
   * 页面通过 <use xlink:href="#add_post"> 之类引用）。实测两类故障：
   *  a) SPA 重新挂载后站点不再补注入 → 引用断链、顶栏图标全空；
   *  b) 同一页面被【两份本脚本副本】先后 document.write（真机实测：脚本被执行了两次），
   *     窗口上残留的 window.__SVG_SPRITE__ 实例 isMounted 已为 true，站点重新执行时
   *     mount() 早退 → symbol 全在但节点永不入档（由 SPRITE_RESET_SRC 从源头避免）。
   * 这里的轮询做三件事：站点节点在 → 缓存一份（只要 symbol 更全就更新缓存）；
   * 缺失 → 先用缓存补一份；没有缓存 → 注入页面上下文脚本，把残留实例的游离节点接回文档。 */
  var spriteCache = null;
  var spriteCacheSym = 0;
  var spriteTimer = null;
  var lastSpriteRepair = 0;

  /* 沙箱访问不到页面的 window，修复逻辑必须以 <script> 注入页面上下文执行 */
  var SPRITE_REPAIR_SRC = function () {
    'use strict';
    try {
      var T = window.__SVG_SPRITE__;
      if (!T || !T.node || !document.body) return false;
      if (document.getElementById('__SVG_SPRITE_NODE__')) return false;
      document.body.insertBefore(T.node, document.body.firstChild);
      return document.contains(T.node);
    } catch (e) { return false; }
  }.toString();

  function repairPageSprite() {
    try {
      var s = document.createElement('script');
      s.textContent = '(' + SPRITE_REPAIR_SRC + ')();';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* 忽略 */ }
  }

  function tickSprite() {
    try {
      syncTitleHeight();
      var cur = document.getElementById('__SVG_SPRITE_NODE__');
      if (cur) {
        var n = cur.querySelectorAll('symbol').length;
        if (n > 0 && n > spriteCacheSym) { spriteCache = cur.cloneNode(true); spriteCacheSym = n; }
        return;
      }
      if (spriteCache) {
        if (!document.getElementById('tbpc-svg-sprite')) {
          var c = spriteCache.cloneNode(true);
          c.id = 'tbpc-svg-sprite';
          c.setAttribute('aria-hidden', 'true');
          c.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
          (document.body || document.documentElement).appendChild(c);
        }
        return;
      }
      /* 无缓存可补：尝试把页面里那个"已创建但没挂上"的精灵图节点接回来（节流） */
      var now = Date.now();
      if (now - lastSpriteRepair > 1500) { lastSpriteRepair = now; repairPageSprite(); }
    } catch (e) { /* 忽略 */ }
  }

  function startSpriteGuard() {
    if (spriteTimer) return;
    spriteTimer = setInterval(tickSprite, 500);
    tickSprite();
  }

  /* ---------------- 主流程 ---------------- */

  function rewriteWithPC(pcHtml) {
    var inject =
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, minimum-scale=0.5, user-scalable=yes">' +
      '<script>(' + spoofSource + ')();</scr' + 'ipt>' +
      /* 先复位精灵图单例，防止上一份文档残留的实例让站点挂载早退（详见 SPRITE_RESET_SRC） */
      '<script>(' + SPRITE_RESET_SRC + ')();</scr' + 'ipt>' +
      '<style>' + RESPONSIVE_CSS + '\n' + FORUM_CARD_CSS + '</style>';
    var m = pcHtml.match(/<head[^>]*>/i);
    var out = m ? pcHtml.replace(m[0], m[0] + inject) : inject + pcHtml;
    document.open();
    document.write(out);
    document.close();
    startForumCard();
    checkDesktopSiteMode();
    startSpriteGuard();
    // 看门狗：若 PC 版前端脚本自我检测后跳回手机版，自动再转换一次（限 2 次）
    var watchdog = 0;
    var timer = setInterval(function () {
      if (++watchdog > 5) { clearInterval(timer); return; }
      var html = document.documentElement ? (document.documentElement.innerHTML || '') : '';
      if (html.length > 2000 && isWiseHtml(html)) {
        clearInterval(timer);
        recover('wise 回跳');
      }
    }, 2000);
  }

  /* 已占位/拦截但抓取失败：带 nostop 标记重载，回退到原始页面（限 2 次） */
  function recover(why) {
    var n = 0;
    try { n = parseInt(sessionStorage.getItem(KEY_RETRY) || '0', 10); } catch (e) { /* 忽略 */ }
    if (n < 2) {
      try {
        sessionStorage.setItem(KEY_RETRY, String(n + 1));
        sessionStorage.setItem(KEY_NOSTOP, '1');
      } catch (e) { /* 忽略 */ }
      location.reload();
    } else {
      toast('贴吧电脑版加载失败（' + why + '），仍显示原始页面');
    }
  }

  function fetchPCAndRewrite() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: location.href.split('#')[0],
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      timeout: 15000,
      onload: function (r) {
        var text = r.responseText || '';
        if (r.status === 200 && text.indexOf(PC_MARK) !== -1) {
          rewriteWithPC(text);
        } else if (seized) {
          recover('HTTP ' + r.status);
        } else {
          toast('贴吧电脑版加载失败（HTTP ' + r.status + '），仍显示原始页面');
        }
      },
      onerror: function () { if (seized) recover('网络错误'); else toast('网络错误，仍显示原始页面'); },
      ontimeout: function () { if (seized) recover('请求超时'); else toast('请求超时，仍显示原始页面'); }
    });
  }

  function main() {
    registerMenu();
    var off = false, nostop = false;
    try {
      off = sessionStorage.getItem(KEY_OFF) === '1';
      nostop = sessionStorage.getItem(KEY_NOSTOP) === '1';
      sessionStorage.removeItem(KEY_NOSTOP);
    } catch (e) { /* 忽略 */ }
    if (off) return;

    if (!nostop) seizePage();
    fetchPCAndRewrite();
  }

  main();
})();