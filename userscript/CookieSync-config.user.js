// ==UserScript==
// @name         CookieSync 配置同步
// @namespace    https://github.com/Xioaruan912/CookieSync
// @version      1.3.2
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

  function destination(connection) {
    let url;
    try { url = new URL(connection.url.trim()); } catch { throw new Error('请输入有效的 WebDAV 目录网址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('请填写最终 HTTPS 目录网址，账号和密码分别填写');
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
      await GM.setValue(statusKey(connection), { at: Date.now(), message: error.message });
      throw error;
    }
    await GM.setValue(statusKey(connection), { at: Date.now(), message });
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
        --surface: #fdf9f3; --canvas: #f2ebe1; --ink: #30231e; --muted: #68564e;
        --edge: #dfd2c5; --brand: #923e32; --selected: #f2ded4; --on-brand: #fff;
        --positive: #276146; --caution: #79501f; --danger: #a12f26;
        box-sizing: border-box; width: min(820px, calc(100vw - 32px)); max-width: none;
        max-height: min(92dvh, 760px); padding: 0; overflow: hidden;
        background: var(--surface); color: var(--ink); border: 1px solid var(--edge);
        border-radius: 20px; box-shadow: 0 28px 96px #39211845;
        font: 14px/1.55 "Inter", "Segoe UI", "Microsoft YaHei UI", sans-serif;
        color-scheme: light;
      }
      dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto }
      dialog::backdrop { background: #231913a6 }
      *, *::before, *::after { box-sizing: border-box }
      h2, h3, p { margin: 0 }
      .top {
        background: radial-gradient(ellipse at 95% 0%, #694239 0%, transparent 65%), #392822;
        color: #fff6ee; padding: 24px 28px; display: flex; justify-content: space-between;
        align-items: start; gap: 14px;
      }
      .top h2 { font-size: clamp(23px, 4vw, 32px); line-height: 1.15; font-weight: 680; letter-spacing: -.025em }
      .top p { color: #efcfc1; margin-top: 6px; font-size: 12px }
      .workspace { display: grid; grid-template-columns: 166px minmax(0, 1fr); min-height: 0 }
      nav { display: flex; flex-direction: column; align-items: stretch; gap: 6px;
        padding: 22px 12px; background: var(--canvas); border-inline-end: 1px solid var(--edge) }
      nav button { text-align: left; min-width: 0; border-color: transparent; background: transparent; color: var(--muted) }
      nav button[aria-pressed="true"] { color: var(--brand); background: var(--selected); font-weight: 700 }
      .content { min-width: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable }
      section { display: grid; align-content: start; gap: 16px; min-height: 365px; padding: 24px 28px }
      [hidden] { display: none !important }
      .heading { display: grid; gap: 3px; border-bottom: 1px solid var(--edge); padding-bottom: 13px }
      h3 { font-size: 21px; font-weight: 680; letter-spacing: -.02em }
      .hint, small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere }
      .fields { display: grid; gap: 14px }
      label { display: grid; gap: 5px; min-width: 0; font-weight: 550 }
      input, select, button {
        min-width: 0; border: 1px solid var(--edge); border-radius: 9px; min-height: 40px;
        padding: 7px 12px; font: inherit; color: inherit; background: var(--surface);
      }
      input, select { width: 100%; font-weight: 400 }
      input::placeholder { color: var(--muted); opacity: .85 }
      button { cursor: pointer; white-space: normal; font-weight: 600 }
      button:hover:enabled { background: var(--selected) }
      button:disabled { cursor: wait; opacity: .62 }
      .primary { background: var(--brand); color: var(--on-brand); border-color: transparent }
      .primary:hover:enabled { filter: brightness(1.12); background: var(--brand) }
      #close { background: #ffffff0d; color: #fff6ee; border-color: #eacebe59; min-height: 34px; padding: 4px 11px }
      #close:hover:enabled { background: #ffffff21 }
      .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px }
      .key-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px }
      .automatic { display: flex; justify-content: space-between; align-items: center; gap: 16px;
        background: var(--canvas); padding: 10px 12px; border-radius: 9px }
      .automatic small { display: block; font-weight: 400 }
      #automatic { appearance: none; flex: 0 0 38px; width: 38px; min-height: 22px; height: 22px;
        border-radius: 20px; border-color: transparent; background: #7d6a60; cursor: pointer;
        padding: 0; margin: 0; position: relative }
      #automatic::before { content: ""; position: absolute; top: 2px; left: 2px;
        width: 16px; height: 16px; border-radius: 50%; background: #fff }
      #automatic:checked { background: var(--brand) }
      #automatic:checked::before { transform: translateX(16px) }
      .rules { list-style: none; padding: 0; margin: 0; max-height: 218px; overflow: auto }
      .rules li { display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 8px 0; border-bottom: 1px solid var(--edge); overflow-wrap: anywhere }
      .rule-state { flex: none; font-size: 12px; color: var(--positive) }
      .rule-state[data-enabled="false"] { color: var(--caution) }
      footer { border-top: 1px solid var(--edge); background: var(--surface);
        display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 28px }
      .feedback { min-width: 0; display: grid; gap: 1px; overflow-wrap: anywhere }
      #connection { font-weight: 650; font-size: 13px }
      #connection[data-connected="true"] { color: var(--positive) }
      #status[data-kind="error"] { color: var(--danger) }
      #status:empty { display: none }
      #sync { flex: none }
      :focus-visible { outline: 2px solid var(--brand); outline-offset: 3px }
      #close:focus-visible { outline-color: #ffe6d8 }
      @media (prefers-reduced-motion: no-preference) {
        dialog[open] { animation: appear .22s ease-out }
        dialog::backdrop { animation: shade .18s ease-out }
        section:not([hidden]) { animation: appear .18s ease-out }
        button, #automatic, #automatic::before { transition: background-color .16s, transform .16s }
        button:enabled:active { transform: translateY(1px) }
        @keyframes appear { from { opacity: .5; transform: translateY(5px) } }
        @keyframes shade { from { opacity: 0 } }
      }
      @media (prefers-color-scheme: dark) {
        dialog { --surface: #281e1b; --canvas: #211916; --ink: #faf0e8; --muted: #c8b3a8;
          --edge: #584139; --brand: #eba998; --selected: #49312a; --on-brand: #2e1d17;
          --positive: #b6e4c8; --caution: #edc48a; --danger: #ffb5aa; color-scheme: dark }
        #automatic:checked::before { background: #392822 }
      }
      @media (max-width: 610px) {
        dialog { width: calc(100vw - 20px); max-height: 94dvh; border-radius: 14px }
        .top { padding: 16px }
        .workspace { grid-template-columns: minmax(0,1fr); grid-template-rows: auto minmax(0,1fr) }
        nav { flex-direction: row; padding: 6px 9px; border-inline-end: 0; border-bottom: 1px solid var(--edge) }
        nav button { flex: 1; text-align: center; padding-inline: 3px }
        section { min-height: 0; padding: 16px }
        footer { padding: 9px 12px; align-items: center }
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
      element('h3', { id: id + '-title' }, title), element('p', { class: 'hint' }, description),
    );
    const section = (id, ...children) => element('section', { id, 'aria-labelledby': id + '-title', hidden: '' }, ...children);
    const navigation = element('nav', { 'aria-label': '配置栏目' });
    const content = element('div', { class: 'content' },
      section('webdav', heading('webdav', 'WebDAV 连接', '两台设备填写同一个目录，即可共用网站名单和偏好。'),
        element('div', { class: 'fields' },
          label('WebDAV 目录网址', input('url', { type: 'url', placeholder: 'https://dav.example.com/同步目录/',
            autocomplete: 'off' })),
          label('用户名', input('username', { autocomplete: 'off' })),
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
        label('域名', input('domain', { placeholder: 'nodeseek.com' })),
        element('div', { class: 'actions' }, button('allow', '允许'), button('pause', '暂停')),
        hint('rule-count', '暂无自定义规则'),
        element('ul', { id: 'rules', class: 'rules', 'aria-label': '网站名单规则' }),
      ),
      section('preferences', heading('preferences', '普通设置', '这些偏好也会同步到使用同一配置文件的 Chrome 扩展。'),
        label('主题', select('theme', [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']])),
        label('Chrome 右键菜单', select('contextMenu', [['false', '关闭'], ['true', '开启']])),
        label('Chrome 同步间隔（分钟）', input('syncIntervalMinutes', { type: 'number', min: '1', max: '60', step: '1' })),
        element('div', { class: 'actions' }, button('save', '保存普通设置')),
      ),
    );
    const syncButton = button('sync', '合并并同步');
    syncButton.className = 'primary';
    const dialog = element('dialog', { 'aria-labelledby': 'title', lang: 'zh-CN' },
      element('header', { class: 'top' },
        element('div', {}, element('h2', { id: 'title' }, 'CookieSync'), element('p', {}, '配置同步')),
        button('close', '关闭'),
      ),
      element('div', { class: 'workspace' }, navigation, content),
      element('footer', {},
        element('div', { class: 'feedback' },
          element('p', { id: 'connection' }), hint('last-sync', '尚未同步'),
          element('p', { id: 'status', class: 'hint', role: 'status', 'aria-live': 'polite' }),
        ),
        syncButton,
      ),
    );
    const views = [['webdav', 'WebDAV 连接'], ['sites', '网站名单'], ['preferences', '普通设置']];
    function showView(activeId) {
      for (const [id] of views) {
        get(id).hidden = id !== activeId;
        get(id + '-nav').setAttribute('aria-pressed', String(id === activeId));
      }
      content.scrollTop = 0;
    }
    for (const [id, title] of views) {
      const control = button(id + '-nav', title);
      control.setAttribute('aria-controls', id);
      control.onclick = event => { if (event.isTrusted) showView(id); };
      navigation.append(control);
    }
    root.append(dialog);
    showView('webdav');
    get('automatic').checked = true;
    panel = { dialog, host };
    let current;
    let pendingPassword;
    let displayed = { ...defaults };
    let busy = false;
    function run(action) {
      return async event => {
        if (busy || (event && !event.isTrusted)) return;
        busy = true;
        root.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
          get('status').dataset.kind = 'progress';
          get('status').textContent = '处理中…';
          get('status').textContent = (await withLock(action)) || '';
          get('status').dataset.kind = 'success';
        } catch (error) {
          get('status').dataset.kind = 'error';
          get('status').textContent = error.message || '操作失败';
        } finally {
          busy = false;
          root.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
      };
    }
    async function render({ refreshPreferences = true } = {}) {
      const local = current ? await readConfig(current) : empty();
      const rules = Object.entries(local.rules);
      get('rule-count').textContent = rules.length ? rules.length + ' 条规则' : '暂无自定义规则';
      get('rules').replaceChildren(...rules.map(([domain, rule]) => element('li', {},
        element('span', {}, domain), element('span', { class: 'rule-state', 'data-enabled': String(rule.enabled) },
          rule.enabled ? '允许' : '暂停'),
      )));
      if (refreshPreferences) {
        for (const key of Object.keys(defaults)) {
          displayed[key] = local.preferences[key]?.value ?? defaults[key];
          get(key).value = String(displayed[key]);
        }
      }
      get('last-sync').textContent = statusText(current && await GM.getValue(statusKey(current), null));
      get('connection').dataset.connected = String(Boolean(current));
      get('connection').textContent = current ? '已保存 WebDAV 连接' : '请先保存连接';
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
    get('connect').onclick = run(async () => {
      const url = get('url').value.trim();
      const username = get('username').value.trim();
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
    get('sync').onclick = run(async () => {
      await savePreferences();
      try {
        const connection = active();
        await GM.setValue(scheduleKey(connection), { at: Date.now() });
        return await reportSync(connection);
      } finally {
        await render();
      }
    });
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
