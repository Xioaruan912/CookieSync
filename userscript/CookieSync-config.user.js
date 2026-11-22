// ==UserScript==
// @name         CookieSync 配置同步
// @namespace    https://github.com/Xioaruan912/CookieSync
// @version      1.2.0
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
        :host{all:initial}
        dialog{width:min(520px,calc(100vw - 32px));max-height:85vh;box-sizing:border-box;
          padding:24px;border:1px solid #366556;border-radius:14px;background:#f5faf7;color:#173a2e;
          font:14px/1.5 system-ui,sans-serif;color-scheme:light}
        dialog::backdrop{background:#0b241d99} header, .actions{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
        h2,h3,p{margin:0} section{display:grid;gap:8px;margin-block:14px;padding-top:12px;border-top:1px solid #c4d9cf}
        label{display:grid;gap:3px} label:has(input[type=checkbox]){display:flex;align-items:center;gap:8px}
        input,select,button{font:inherit;padding:6px 8px;border:1px solid #8da99c;border-radius:6px}
        input,select{min-width:0;background:white} button{background:#e1f1e8;color:#173a2e;cursor:pointer}
        button:disabled{cursor:wait;opacity:.6} #sync{background:#16563e;color:white}
        #rules{max-height:140px;overflow:auto;padding-left:24px;overflow-wrap:anywhere;margin:0}
        :focus-visible{outline:2px solid #176852;outline-offset:2px}
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
    const section = (...children) => element('section', {}, ...children);
    const dialog = element('dialog', { 'aria-labelledby': 'title' },
      element('header', {}, element('h2', { id: 'title' }, 'CookieSync 配置同步'), button('close', '关闭')),
      section(
        element('h3', {}, 'WebDAV 设置'),
        label('WebDAV 目录网址', input('url', { type: 'url', placeholder: 'https://dav.example.com/同步目录/',
          autocomplete: 'off' })),
        label('用户名', input('username', { autocomplete: 'off' })),
        button('password', '输入或更换应用密码'),
        element('p', { id: 'password-status' }, '通过浏览器对话框输入应用密码'),
        element('label', {}, input('automatic', { type: 'checkbox', checked: '' }), '打开网页时自动同步（每 30 分钟最多一次）'),
        button('connect', '保存连接'),
        element('p', { id: 'connection' }),
        element('p', { id: 'last-sync' }),
      ),
      section(
        element('h3', {}, '网站名单'),
        label('域名', input('domain', { placeholder: 'nodeseek.com' })),
        element('div', { class: 'actions' }, button('allow', '允许'), button('pause', '暂停')),
        element('ul', { id: 'rules', 'aria-label': '网站名单规则' }),
      ),
      section(
        element('h3', {}, '普通设置'),
        label('主题', select('theme', [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']])),
        label('Chrome 右键菜单', select('contextMenu', [['false', '关闭'], ['true', '开启']])),
        label('Chrome 同步间隔（分钟）', input('syncIntervalMinutes', { type: 'number', min: '1', max: '60', step: '1' })),
        button('save', '保存普通设置'),
      ),
      button('sync', '合并并同步'),
      element('p', { id: 'status', role: 'status', 'aria-live': 'polite' }),
    );
    root.append(dialog);
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
          get('status').textContent = '处理中…';
          get('status').textContent = (await withLock(action)) || '';
        } catch (error) {
          get('status').textContent = error.message || '操作失败';
        } finally {
          busy = false;
          root.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
      };
    }
    async function render({ refreshPreferences = true } = {}) {
      const local = current ? await readConfig(current) : empty();
      get('rules').replaceChildren(...Object.entries(local.rules).map(([domain, rule]) => {
        const row = document.createElement('li');
        row.textContent = domain + (rule.enabled ? ' · 允许' : ' · 暂停');
        return row;
      }));
      if (refreshPreferences) {
        for (const key of Object.keys(defaults)) {
          displayed[key] = local.preferences[key]?.value ?? defaults[key];
          get(key).value = String(displayed[key]);
        }
      }
      get('last-sync').textContent = statusText(current && await GM.getValue(statusKey(current), null));
      get('connection').textContent = current ? '已保存连接，配置文件为 ' + fileName : '请先保存连接';
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
