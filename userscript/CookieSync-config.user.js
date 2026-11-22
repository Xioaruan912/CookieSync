// ==UserScript==
// @name         CookieSync 配置同步
// @namespace    https://github.com/Xioaruan912/CookieSync
// @version      1.5.0
// @description  通过 WebDAV 同步网站名单和普通偏好
// @author       Xioaruan912
// @license      MIT
// @homepageURL  https://github.com/Xioaruan912/CookieSync/tree/tampermonkey
// @match        https://*/*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_info
// @grant        GM.getValue
// @grant        GM.listValues
// @grant        GM.getValues
// @grant        GM.setValues
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @grant        GM.xmlHttpRequest
// @connect      *
// @updateURL    https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js
// @downloadURL  https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js
// ==/UserScript==

(() => {
  'use strict';

  const fileName = 'CookieSync-config-v1.json';
  const connectionKey = 'webdav-connection';
  const intervalMs = 30 * 60 * 1000;
  const defaults = { theme: 'light', contextMenu: false, syncIntervalMinutes: 2 };
  const empty = () => ({ version: 1, rules: {}, preferences: {} });
  const object = value => value && typeof value === 'object' && !Array.isArray(value);

  function normalizeDomain(input) {
    const raw = input.trim();
    const invalid = () => new Error('请输入具体网站域名，例如 nodeseek.com');
    if (!raw || /[\s*@\\]/.test(raw)) throw invalid();
    let url;
    try {
      url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    } catch {
      throw invalid();
    }
    const domain = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        domain.length > 253 || !domain.includes('.') || /^\d+(?:\.\d+){3}$/.test(domain) ||
        !domain.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ||
        ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk', 'com.hk', 'com.tw'].includes(domain))
      throw invalid();
    return domain;
  }

  function validPreference(key, value) {
    if (key === 'theme') return ['light', 'dark', 'system'].includes(value);
    if (key === 'contextMenu') return typeof value === 'boolean';
    return key === 'syncIntervalMinutes' && Number.isInteger(value) && value >= 1 && value <= 60;
  }

  // Keep the same per-field revision ordering as the Chrome config channel.
  function merge(left, right) {
    const merged = empty();
    for (const group of ['rules', 'preferences']) {
      const isRule = group === 'rules';
      const field = isRule ? 'enabled' : 'value';
      for (const source of [left[group], right[group]]) {
        if (!object(source)) throw new Error('配置文件格式错误');
        for (const [key, entry] of Object.entries(source)) {
          if (!entry || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 1 ||
              typeof entry.revision !== 'string' || entry.revision.length < 1 || entry.revision.length > 80 ||
              (isRule ? normalizeDomain(key) !== key || typeof entry.enabled !== 'boolean' : !validPreference(key, entry.value)))
            throw new Error('配置项格式错误');
          const previous = merged[group][key];
          if (!previous || entry.updatedAt > previous.updatedAt || (entry.updatedAt === previous.updatedAt &&
              (entry.revision > previous.revision || (entry.revision === previous.revision &&
                (isRule ? !entry.enabled : String(entry.value) > String(previous.value))))))
            merged[group][key] = { [field]: entry[field], updatedAt: entry.updatedAt, revision: entry.revision };
        }
      }
    }
    if (Object.keys(merged.rules).length > 400) throw new Error('网站名单最多支持 400 条规则');
    merged.rules = Object.fromEntries(Object.entries(merged.rules).sort(([a], [b]) => a.localeCompare(b)));
    merged.preferences = Object.fromEntries(Object.keys(defaults).filter(key => merged.preferences[key])
      .map(key => [key, merged.preferences[key]]));
    if (JSON.stringify(merged).length > 100000) throw new Error('配置超过 100000 字符');
    return merged;
  }

  function decode(content) {
    if (content.length > 100000) throw new Error('远程配置过大');
    let value;
    try { value = JSON.parse(content); } catch { throw new Error('远程配置不是有效的 JSON'); }
    if (value?.version !== 1) throw new Error('远程配置版本不受支持');
    return merge(empty(), { ...value, preferences: value.preferences === undefined ? {} : value.preferences });
  }

  function webdavDirectory(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('请输入有效的 WebDAV 目录网址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('请填写最终 HTTPS 目录网址，账号和密码分别填写');
    return url;
  }

  function destination(connection) {
    const url = webdavDirectory(connection.url);
    if (!connection.username.trim() || connection.username.includes(':') || !connection.password)
      throw new Error('请填写 WebDAV 用户名和应用密码，用户名不能含冒号');
    url.pathname = url.pathname.replace(/\/?$/, '/') + fileName;
    return url.href;
  }

  async function request(connection, method, headers = {}, data) {
    const url = destination(connection);
    const bytes = new TextEncoder().encode(connection.username.trim() + ':' + connection.password);
    const authorization = 'Basic ' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    let response;
    let timer;
    try {
      const pending = GM.xmlHttpRequest({ method, url, data, anonymous: true, redirect: 'error', nocache: true,
        headers: { Authorization: authorization, ...headers } });
      response = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('timeout')); pending.abort(); }, 20000);
      })]);
    } catch {
      throw new Error('WebDAV 请求失败，请检查域名授权、网络及最终目录地址');
    } finally {
      clearTimeout(timer);
    }
    if (response.finalUrl !== url) throw new Error('WebDAV 地址发生重定向，请填写最终地址');
    return response;
  }

  const dataKey = connection => 'config:' + JSON.stringify([destination(connection), connection.username.trim()]);
  const withLock = action => navigator.locks.request('cookiesync-userscript-config', action);
  const cacheKey = connection => dataKey(connection) + ':remote-cache';
  const scheduleKey = connection => dataKey(connection) + ':schedule';
  const statusKey = connection => dataKey(connection) + ':status';

  const editPrefix = connection => dataKey(connection) + ':edit:';
  const editKey = (connection, group, name) => editPrefix(connection) + group + ':' + name;

  async function readConfig(connection) {
    const prefix = editPrefix(connection);
    const keys = (await GM.listValues()).filter(key => key.startsWith(prefix));
    const stored = await GM.getValues([dataKey(connection), cacheKey(connection), ...keys]);
    const edits = empty();
    for (const key of keys) {
      const [group, name] = key.slice(prefix.length).split(':');
      if (stored[key] !== undefined) edits[group][name] = stored[key];
    }
    const local = merge(stored[dataKey(connection)] ?? empty(), edits);
    const cached = stored[cacheKey(connection)] ?? empty();
    return merge(cached, local);
  }

  function statusText(status) {
    return status ? new Date(status.at).toLocaleString('zh-CN') + ' · ' + status.message : '尚未同步';
  }

  async function reportSync(connection) {
    let message;
    try {
      message = await syncConfig(connection);
    } catch (error) {
      await GM.setValue(statusKey(connection), { at: Date.now(), message: error.message, ok: false });
      throw error;
    }
    await GM.setValue(statusKey(connection), { at: Date.now(), message, ok: true });
    return message;
  }

  // GM storage is shared across sites, while Web Locks are scoped to an origin.
  // The shared claim coalesces restored tabs; conditional PUT handles any overlap.
  async function maybeSync() {
    const connection = await GM.getValue(connectionKey, null);
    if (!connection || connection.automatic === false) return;
    const key = scheduleKey(connection);
    const due = async () => {
      const last = await GM.getValue(key, null);
      const elapsed = Date.now() - (last?.at ?? 0);
      return !last || elapsed >= intervalMs || elapsed < 0;
    };
    if (!(await due())) return;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    await delay(150 + Math.random() * 250);
    if (!(await due())) return;
    const claim = { at: Date.now(), id: crypto.randomUUID() };
    await GM.setValue(key, claim);
    await delay(150);
    if ((await GM.getValue(key, null))?.id !== claim.id) return;
    const current = await GM.getValue(connectionKey, null);
    if (!current || current.automatic === false || dataKey(current) !== dataKey(connection)) return;
    await reportSync(current);
  }

  async function syncConfig(connection) {
    // Background tabs write only the remote cache. Explicit edits have their own journal.
    const key = cacheKey(connection);
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await request(connection, 'GET');
      if (![200, 404].includes(read.status)) throw new Error('WebDAV 读取失败（HTTP ' + read.status + '）');
      const remote = read.status === 404 ? empty() : decode(read.responseText);
      const local = merge(remote, await readConfig(connection));
      await GM.setValue(key, merge(remote, await GM.getValue(key, empty())));
      const content = JSON.stringify(local);
      if (content === JSON.stringify(remote)) return '已同步，远端无需写入';
      const etag = read.responseHeaders?.match(/^etag:[ \t]*([^\r\n]+)/im)?.[1].trim();
      if (read.status === 200 && !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag || ''))
        throw new Error('WebDAV 未提供强 ETag，本机修改已保存，远程文件未覆盖');
      const condition = read.status === 404 ? { 'If-None-Match': '*' } : { 'If-Match': etag };
      const write = await request(connection, 'PUT', { 'Content-Type': 'application/json; charset=utf-8', ...condition }, content);
      if (write.status >= 200 && write.status < 300) {
        await GM.setValue(key, merge(local, await GM.getValue(key, empty())));
        return '已合并并同步到 WebDAV';
      }
      if (write.status !== 412) throw new Error('WebDAV 写入失败（HTTP ' + write.status + '）');
    }
    throw new Error('WebDAV 配置发生冲突（HTTP 412），本机修改已保存，请稍后重新同步');
  }

  function revision(value, previous, field) {
    return { [field]: value, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1), revision: crypto.randomUUID() };
  }

  let panel;
  async function openPanel() {
    if (panel?.dialog.open) return;
    panel?.host.remove();
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(`
      :host { all: initial }
      dialog {
        --surface: #fdfcf9; --recess: #edeff3; --ink: #212a3c; --muted: #4f5d74;
        --line: #d6dce6; --field: #7f8ca3; --accent: #284e9a; --on-accent: #fff;
        --selected: #e0e8fa; --good: #276245; --warning: #795120; --error: #9b342e;
        --summary: #16243e; --summary-ink: #f7f9ff; --summary-muted: #c1cceb;
        width: min(760px, calc(100vw - 32px)); max-width: none;
        max-height: min(710px, calc(100dvh - 32px)); padding: 0; overflow: hidden;
        border: 0; border-radius: 16px; background: var(--surface); color: var(--ink);
        box-shadow: 0 20px 70px #101f3d52; color-scheme: light;
        font: 15px/1.55 "Instrument Sans", "Segoe UI", "Microsoft YaHei UI", sans-serif;
      }
      dialog[open] { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto }
      dialog::backdrop { background: #151d3294 }
      *, *::before, *::after { box-sizing: border-box }
      ::selection { color: var(--ink); background: var(--selected) }
      [hidden] { display: none !important }
      h2, h3, h4, p, dl, dd { margin: 0 }
      button, input, select { font: inherit; color: inherit }
      .top, footer {
        display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 24px;
      }
      .top { background: var(--recess) }
      .top h2 { font-size: 19px; font-weight: 750; letter-spacing: -.025em; line-height: 1.2 }
      .top p { font-size: 12px }
      nav { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--line);
        padding: 0; background: var(--recess) }
      button, input, select { min-height: 40px; border: 1px solid var(--field); border-radius: 7px;
        background: var(--surface); padding: 7px 12px; min-width: 0 }
      button { font-weight: 650; cursor: pointer }
      button:hover:enabled { background: var(--selected) }
      button:disabled { opacity: .62; cursor: wait }
      nav button { border: 0; border-radius: 0; background: transparent; color: var(--muted);
        padding: 6px 4px }
      nav button[aria-pressed="true"] { color: var(--accent) }
      .nav-indicator { position: absolute; inset: auto auto 0 0; width: 25%; height: 3px; pointer-events: none;
        background: var(--accent); transform: translateX(calc(var(--view-index, 0) * 100%)) }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
      nav button:focus-visible { outline-offset: -4px }
      .content { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain;
        scrollbar-color: var(--field) transparent }
      section { display: grid; gap: 18px; align-content: start; padding: 24px; min-height: 340px }
      .heading { display: grid; gap: 4px }
      h3 { font-size: 25px; font-weight: 720; letter-spacing: -.03em; line-height: 1.2 }
      h4 { font-size: 15px }
      .hint, small { font-size: 13px; color: var(--muted); overflow-wrap: anywhere }
      .status-panel {
        background: radial-gradient(ellipse at 100% 0%, #293d61, transparent 76%), var(--summary);
        color: var(--summary-ink); border-radius: 12px; padding: 20px;
        display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(140px, 1fr);
        align-items: center; gap: 24px;
      }
      .result { display: grid; justify-items: start; gap: 5px; min-width: 0 }
      .result button { margin-top: 10px }
      .sync-route {
        display: grid; gap: 10px; padding: 16px; border-radius: 9px;
        background: #9eb5e912; border: 1px solid #acc1f54d;
      }
      .route-labels { display: flex; justify-content: space-between; gap: 8px;
        font-size: 12px; font-weight: 650; color: var(--summary-muted) }
      .route-line { position: relative; height: 4px; margin: 6px; background: #91ace564; border-radius: 4px }
      .route-line::before, .route-line::after {
        content: ""; position: absolute; top: 50%; border-radius: 50%;
        width: 10px; height: 10px; background: #b2c5ed; transform: translate(-50%, -50%);
      }
      .route-line::before { left: 0 }
      .route-line::after { left: 100% }
      .sync-route[data-state="ok"] .route-line::after { background: #a5e0c6 }
      .sync-route[data-state="error"] .route-line::after { background: #ffc0b4 }
      .route-pulse { position: absolute; inset: 0; opacity: 0; pointer-events: none }
      .route-pulse::before { content: ""; position: absolute; left: 0; top: 50%;
        width: 8px; height: 8px; border-radius: 50%; transform: translate(-50%, -50%); background: #fff }
      .status-panel h4 { font-size: clamp(20px, 4vw, 27px); line-height: 1.25; margin-bottom: 6px }
      .status-panel p, .status-panel time { font-size: 13px; color: var(--summary-muted); overflow-wrap: anywhere }
      .status-panel time { display: block; margin-top: 8px }
      .status-panel button { background: var(--summary-ink); color: var(--summary);
        border-color: transparent; white-space: nowrap }
      .status-panel button:hover:enabled { background: var(--summary-muted) }
      .status-panel button:focus-visible { outline-color: var(--summary-ink) }
      .details { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); border-block: 1px solid var(--line) }
      .details div { padding: 12px 0; min-width: 0 }
      .details div + div { border-inline-start: 1px solid var(--line); padding-inline-start: 16px }
      .details dt { font-size: 13px; color: var(--muted) }
      .details dd { overflow-wrap: anywhere; font-weight: 650 }
      .actions, .key-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px }
      .fields { display: grid; gap: 12px }
      label { display: grid; gap: 5px; min-width: 0; font-weight: 600 }
      input, select { width: 100%; font-weight: 400; caret-color: var(--accent) }
      input::placeholder { color: var(--muted); opacity: 1 }
      input[aria-invalid="true"] { border-color: var(--error) }
      .automatic { display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 12px; border-radius: 8px; background: var(--recess) }
      .automatic small { display: block; font-weight: 400 }
      #automatic { width: 20px; height: 20px; min-height: 20px; margin: 0; flex: none;
        accent-color: var(--accent); cursor: pointer }
      .rule-editor { display: flex; gap: 8px; align-items: end; flex-wrap: wrap }
      .rule-editor label { flex: 1 1 185px }
      .rule-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px }
      .rule-toolbar select { width: auto }
      .rules { list-style: none; padding: 0; margin: 0 }
      .rules li { display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 9px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere }
      .rule-state { flex: none; font-size: 13px; color: var(--good) }
      .rule-state[data-enabled="false"] { color: var(--warning) }
      .primary { background: var(--accent); border-color: transparent; color: var(--on-accent) }
      .primary:hover:enabled { background: var(--accent); filter: contrast(1.2) }
      footer { border-top: 1px solid var(--line); background: var(--recess); min-height: 48px }
      footer:has(#sync[hidden]):has(#status:is(:empty, [data-summary])) { display: none }
      #status { color: var(--muted); min-width: 0; overflow-wrap: anywhere }
      #status[data-kind="error"], .field-error { color: var(--error) }
      #status[data-kind="success"] { color: var(--good) }
      #sync { flex: none }
      @media (prefers-reduced-motion: no-preference) {
        dialog[open] { animation: open-panel .18s cubic-bezier(.2,.8,.2,1) }
        button { transition: background-color .14s }
        .nav-indicator { transition: transform .22s cubic-bezier(.2,.8,.2,1) }
        .sync-route[data-pending] .route-pulse { animation: route-pulse .72s ease-out both }
        @keyframes route-pulse {
          0% { transform: translateX(0); opacity: 0 }
          15%, 75% { opacity: 1 }
          100% { transform: translateX(100%); opacity: 0 }
        }
        @keyframes open-panel { from { opacity: .5; transform: translateY(5px) } }
      }
      @media (prefers-color-scheme: dark) {
        dialog { --surface: #171e2d; --recess: #131a27; --ink: #f0f4ff; --muted: #b1bdd6;
          --line: #414e64; --field: #8190a9; --accent: #a8c2ff; --on-accent: #192845;
          --selected: #263958; --good: #a2d4b5; --warning: #efc88f; --error: #ffb9b0;
          --summary: #233450; --summary-ink: #f7f9ff; --summary-muted: #cedaf4; color-scheme: dark }
      }
      @media (max-width: 510px) {
        dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px) }
        .sync-route { padding: 12px }
        nav button { font-size: 13px }
        .top, footer { padding: 10px 12px }
        section { padding: 16px 12px; gap: 14px; min-height: 0 }
        .status-panel { padding: 15px; gap: 16px; grid-template-columns: minmax(0, 1fr) }
        .status-panel button { justify-self: start }
        .rule-editor label { flex-basis: 100% }
      }
      @media (forced-colors: active) {
        dialog { border: 1px solid CanvasText }
        .nav-indicator { background: Highlight }
      }
    `);
    root.adoptedStyleSheets = [stylesheet];
    // Build the dialog without HTML parsing so strict Trusted Types pages can open it.
    const get = id => root.getElementById(id);
    const element = (tag, attributes = {}, ...children) => {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      node.append(...children);
      return node;
    };
    const button = (id, text) => element('button', { id, type: 'button' }, text);
    const label = (text, field) => element('label', {}, text, field);
    const input = (id, options = {}) => element('input', { id, ...options });
    const select = (id, options) => element('select', { id }, ...options.map(
      ([value, text]) => element('option', { value }, text),
    ));
    const hint = (id, text) => element('p', { id, class: 'hint' }, text);
    const heading = (id, title, description) => element('div', { class: 'heading' },
      element('h3', { id: id + '-title', tabindex: '-1' }, title), element('p', { class: 'hint' }, description),
    );
    const section = (id, ...children) => element('section', { id, 'aria-labelledby': id + '-title', hidden: '' }, ...children);
    const navigation = element('nav', { 'aria-label': '配置栏目' });
    const detail = (id, title) => element('div', {}, element('dt', {}, title), element('dd', { id }));
    const overviewAction = button('overview-action', '立即同步');
    const route = element('div', { class: 'sync-route', 'aria-hidden': 'true' },
      element('div', { class: 'route-labels' }, element('span', {}, '本机'), element('span', {}, 'WebDAV')),
      element('div', { class: 'route-line' }, element('span', { class: 'route-pulse' })),
    );
    const content = element('div', { class: 'content' },
      section('overview', heading('overview', '同步概览', '网站名单与扩展偏好'),
        element('div', { class: 'status-panel' },
          element('div', { class: 'result' },
            element('h4', { id: 'sync-state', 'aria-live': 'polite' }),
            element('p', { id: 'sync-message' }),
            element('time', { id: 'last-sync', hidden: '' }),
            overviewAction,
          ),
          route,
        ),
        element('dl', { class: 'details' }, detail('saved-host', 'WebDAV 服务器'), detail('auto-state', '自动同步')),
        element('div', { class: 'actions' }, button('edit-connection', '管理连接')),
      ),
      section('webdav', heading('webdav', 'WebDAV 连接', '两台设备填写同一个目录，即可共用网站名单和偏好。'),
        element('div', { class: 'fields' },
          label('WebDAV 目录网址', input('url', { type: 'url', placeholder: 'https://dav.example.com/同步目录/',
            autocomplete: 'off', 'aria-describedby': 'url-error' })),
          element('p', { id: 'url-error', class: 'hint field-error', hidden: '' }),
          label('用户名', input('username', { autocomplete: 'off', 'aria-describedby': 'username-error' })),
          element('p', { id: 'username-error', class: 'hint field-error', hidden: '' }),
        ),
        element('div', { class: 'key-row' },
          button('password', '输入或更换应用密码'), hint('password-status', '通过浏览器对话框输入应用密码'),
        ),
        element('label', { class: 'automatic' },
          element('span', {}, '打开网页时自动同步', element('small', {}, '每 30 分钟最多尝试一次')),
          input('automatic', { type: 'checkbox' }),
        ),
        element('div', { class: 'actions' }, button('connect', '保存连接')),
      ),
      section('sites', heading('sites', '网站名单', '按域名添加允许或暂停规则。'),
        element('div', { class: 'rule-editor' },
          label('添加或更新域名', input('domain', { placeholder: 'nodeseek.com' })),
          button('allow', '允许'), button('pause', '暂停'),
        ),
        element('div', { class: 'rule-toolbar' },
          label('搜索现有规则', input('rule-search', { type: 'search', placeholder: '输入域名片段' })),
          label('筛选状态', select('rule-filter', [['all', '全部'], ['allow', '允许'], ['pause', '暂停']])),
        ),
        element('p', { id: 'rule-count', class: 'hint', role: 'status' }),
        element('ul', { id: 'rules', class: 'rules', 'aria-label': '网站名单规则' }),
      ),
      section('preferences', heading('preferences', '扩展偏好', '与使用同一 WebDAV 配置文件的 Chrome 扩展共享。'),
        label('主题', select('theme', [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']])),
        label('Chrome 右键菜单', select('contextMenu', [['false', '关闭'], ['true', '开启']])),
        label('Chrome 同步间隔（分钟）', input('syncIntervalMinutes', { type: 'number', min: '1', max: '60', step: '1' })),
        element('div', { class: 'actions' }, button('save', '保存偏好')),
      ),
    );
    const syncButton = button('sync', '立即同步');
    syncButton.className = 'primary';
    const dialog = element('dialog', { 'aria-labelledby': 'title', lang: 'zh-CN' },
      element('header', { class: 'top' },
        element('div', {}, element('h2', { id: 'title' }, 'CookieSync'), element('p', { class: 'hint' }, '配置同步')),
        button('close', '关闭'),
      ),
      navigation,
      content,
      element('footer', {},
        element('p', { id: 'status', class: 'hint', role: 'status', 'aria-live': 'polite' }),
        syncButton,
      ),
    );
    const views = [['overview', '概览'], ['webdav', 'WebDAV'], ['sites', '网站名单'], ['preferences', '扩展偏好']];
    let current;
    let view = 'webdav';
    let rules = [];
    function showView(activeId) {
      view = activeId;
      navigation.style.setProperty('--view-index', String(views.findIndex(([id]) => id === activeId)));
      for (const [id] of views) {
        get(id).hidden = id !== activeId;
        get(id + '-nav').setAttribute('aria-pressed', String(id === activeId));
      }
      syncButton.hidden = !current || view === 'overview';
      updateFeedbackVisibility();
      content.scrollTop = 0;
    }
    for (const [id, title] of views) {
      const control = button(id + '-nav', title);
      control.setAttribute('aria-controls', id);
      control.onclick = event => { if (event.isTrusted) showView(id); };
      navigation.append(control);
    }
    navigation.append(element('span', { class: 'nav-indicator', 'aria-hidden': 'true' }));
    root.append(dialog);
    showView('webdav');
    get('automatic').checked = true;
    panel = { dialog, host };
    let pendingPassword;
    let displayed = { ...defaults };
    let busy = false;
    function updateFeedbackVisibility() {
      const feedback = get('status');
      feedback.toggleAttribute('data-summary', view === 'overview' && feedback.textContent === get('sync-message').textContent);
    }
    function run(action, showProgress = true) {
      return async event => {
        if (busy || (event && !event.isTrusted)) return;
        busy = true;
        root.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
          get('status').dataset.kind = 'progress';
          get('status').textContent = showProgress ? '处理中…' : '';
          updateFeedbackVisibility();
          get('status').textContent = (await withLock(action)) || '';
          get('status').dataset.kind = 'success';
        } catch (error) {
          get('status').dataset.kind = 'error';
          get('status').textContent = error.message || '操作失败';
        } finally {
          updateFeedbackVisibility();
          busy = false;
          root.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
      };
    }
    function renderRules() {
      const query = get('rule-search').value.trim().toLowerCase();
      const filter = get('rule-filter').value;
      const shown = rules.filter(([domain, rule]) =>
        domain.includes(query) && (filter === 'all' || rule.enabled === (filter === 'allow')),
      );
      get('rule-count').textContent = !rules.length ? '还没有规则，可添加一个域名。'
        : !shown.length ? '没有匹配的规则。' : '显示 ' + shown.length + ' / ' + rules.length + ' 条规则';
      get('rules').replaceChildren(...shown.map(([domain, rule]) => element('li', {},
        element('span', {}, domain), element('span', { class: 'rule-state', 'data-enabled': String(rule.enabled) },
          rule.enabled ? '允许' : '暂停'),
      )));
    }
    get('rule-search').oninput = renderRules;
    get('rule-filter').onchange = renderRules;
    get('edit-connection').onclick = event => {
      if (!event.isTrusted) return;
      showView('webdav');
      get('url').focus();
    };

    async function render({ refreshPreferences = true } = {}) {
      const local = current ? await readConfig(current) : empty();
      rules = Object.entries(local.rules);
      renderRules();
      if (refreshPreferences) {
        for (const key of Object.keys(defaults)) {
          displayed[key] = local.preferences[key]?.value ?? defaults[key];
          get(key).value = String(displayed[key]);
        }
      }
      const status = current && await GM.getValue(statusKey(current), null);
      route.dataset.state = status?.ok === true ? 'ok' : status?.ok === false ? 'error' : 'idle';
      const lastSync = get('last-sync');
      lastSync.hidden = !status;
      if (status) {
        const time = new Date(status.at);
        lastSync.dateTime = time.toISOString();
        lastSync.textContent = time.toLocaleString('zh-CN');
      }
      get('sync-state').textContent = !current ? '还未连接 WebDAV'
        : !status ? '等待首次同步'
        : status.ok === false ? '上次同步失败' : status.ok === true ? '同步完成' : '最近同步结果';
      get('sync-message').textContent = status?.message || (current
        ? '立即同步，检查云端配置并合并本机改动。' : '添加 WebDAV 连接后即可开始同步。');
      get('saved-host').textContent = current ? new URL(destination(current)).host : '未配置';
      get('auto-state').textContent = !current ? '等待连接' : current.automatic === false ? '已关闭' : '已开启';
      overviewAction.textContent = current ? '立即同步' : '配置 WebDAV';
      get('edit-connection').hidden = !current;
      syncButton.hidden = !current || view === 'overview';
    }
    function active() {
      if (!current) throw new Error('请先保存 WebDAV 连接');
      return current;
    }
    async function changeRule(enabled) {
      const connection = active();
      const domain = normalizeDomain(get('domain').value);
      const effective = await readConfig(connection);
      const updated = revision(enabled, effective.rules[domain], 'enabled');
      merge(effective, { ...empty(), rules: { [domain]: updated } });
      await GM.setValue(editKey(connection, 'rules', domain), updated);
      get('domain').value = '';
      await render({ refreshPreferences: false });
      return '名单已保存到本机';
    }
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      host.remove();
      if (panel?.dialog === dialog) panel = undefined;
    });
    get('close').onclick = event => { if (event.isTrusted) dialog.close(); };
    function askPassword() {
      // Third-party documents can observe keyboard events from a shadow tree.
      return window.prompt('CookieSync · 输入 WebDAV 应用密码（浏览器对话框会显示输入内容）');
    }
    get('password').onclick = event => {
      if (!event.isTrusted) return;
      const value = askPassword();
      if (value) {
        pendingPassword = value;
        get('password-status').textContent = '已输入应用密码，点击「保存连接」提交';
      }
    };
    function clearFieldError(id) {
      get(id).removeAttribute('aria-invalid');
      get(id + '-error').hidden = true;
    }
    function fieldError(id, message) {
      get(id).setAttribute('aria-invalid', 'true');
      get(id + '-error').hidden = false;
      get(id + '-error').textContent = message;
      get(id).focus();
      throw new Error(message);
    }
    for (const id of ['url', 'username']) get(id).oninput = () => clearFieldError(id);
    get('connect').className = 'primary';
    get('connect').onclick = run(async () => {
      const url = get('url').value.trim();
      const username = get('username').value.trim();
      clearFieldError('url');
      clearFieldError('username');
      try {
        webdavDirectory(url);
      } catch {
        fieldError('url', '请输入有效的 HTTPS 目录网址，账号和密码请单独填写。');
      }
      if (!username || username.includes(':')) fieldError('username', '请输入用户名，用户名不能含冒号。');
      const sameConnection = current?.url === url && current.username === username;
      const password = pendingPassword || (sameConnection ? current.password : askPassword());
      if (password === null) return '已取消保存连接';
      const next = { url, username, password, automatic: get('automatic').checked };
      destination(next);
      await GM.setValue(connectionKey, next);
      pendingPassword = undefined;
      get('password-status').textContent = '应用密码已保存在油猴本机存储';
      current = next;
      await render();
      showView('overview');
      get('overview-title').focus();
      return '连接已保存';
    });
    get('allow').onclick = run(() => changeRule(true));
    get('pause').onclick = run(() => changeRule(false));
    async function savePreferences() {
      const connection = active();
      const changes = {};
      const values = { theme: get('theme').value, contextMenu: get('contextMenu').value === 'true',
        syncIntervalMinutes: get('syncIntervalMinutes').valueAsNumber };
      const effective = await readConfig(connection);
      for (const [name, value] of Object.entries(values)) {
        if (!validPreference(name, value)) throw new Error('同步间隔须为 1 到 60 的整数');
        if (value !== displayed[name])
          changes[editKey(connection, 'preferences', name)] = revision(value, effective.preferences[name], 'value');
      }
      if (Object.keys(changes).length) await GM.setValues(changes);
    }
    get('save').onclick = run(async () => {
      await savePreferences();
      await render();
      return '普通设置已保存到本机';
    });
    const synchronize = run(async () => {
      await savePreferences();
      try {
        const connection = active();
        await GM.setValue(scheduleKey(connection), { at: Date.now() });
        route.setAttribute('data-pending', '');
        get('sync-state').textContent = '正在同步';
        overviewAction.textContent = '同步中…';
        syncButton.textContent = '同步中…';
        return await reportSync(connection);
      } finally {
        route.removeAttribute('data-pending');
        syncButton.textContent = '立即同步';
        await render();
      }
    }, false);
    syncButton.onclick = synchronize;
    overviewAction.onclick = event => {
      if (!event.isTrusted) return;
      if (current) return synchronize(event);
      showView('webdav');
      get('url').focus();
    };
    document.body.append(host);
    dialog.showModal();
    await run(async () => {
      current = await GM.getValue(connectionKey, null);
      if (current) {
        get('url').value = current.url;
        get('username').value = current.username;
        get('automatic').checked = current.automatic !== false;
        get('password-status').textContent = '已有应用密码，可按需更换';
      }
      await render();
      showView(current ? 'overview' : 'webdav');
    })();
  }

  function start() {
    if (GM_info.isIncognito) return;
    GM.registerMenuCommand('CookieSync · 配置同步', openPanel);
    GM.registerMenuCommand('CookieSync · 查看同步状态', async () => {
      const connection = await GM.getValue(connectionKey, null);
      alert(connection ? statusText(await GM.getValue(statusKey(connection), null)) : '请先保存 WebDAV 连接');
    });
    const trigger = () => {
      if (!document.hidden) void maybeSync().catch(() => {});
    };
    document.addEventListener('visibilitychange', trigger);
    trigger();
  }

  start();
})();
