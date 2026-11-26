// ==UserScript==
// @name         CookieSync 配置同步
// @namespace    https://github.com/Xioaruan912/CookieSync
// @version      2.2.1
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
  const leaseFileName = 'CookieSync-lease-v1.json';
  const scriptDownloadUrl = 'https://raw.githubusercontent.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config.user.js';
  const connectionKey = 'webdav-connection';
  const deviceKey = 'cookiesync-device-identity';
  const intervalMs = 30 * 60 * 1000;
  const presetSites = [
    ['115.com', '115网盘'],
    ['github.com', 'GitHub'],
    ['bilibili.com', '哔哩哔哩'],
    ['zhihu.com', '知乎'],
    ['douyin.com', '抖音'],
    ['xiaohongshu.com', '小红书'],
    ['weibo.com', '微博'],
    ['v2ex.com', 'V2EX'],
    ['nodeseek.com', 'NodeSeek'],
    ['linux.do', 'LINUX DO'],
    ['baidu.com', '百度'],
    ['taobao.com', '淘宝'],
    ['jd.com', '京东'],
    ['amap.com', '高德地图'],
    ['chatgpt.com', 'ChatGPT'],
    ['claude.ai', 'Claude'],
    ['x.com', 'X'],
    ['youtube.com', 'YouTube'],
  ];
  const defaults = { theme: 'light', contextMenu: false, syncIntervalMinutes: 2 };
  const empty = () => ({ version: 1, rules: {}, preferences: {} });
  const object = value => value && typeof value === 'object' && !Array.isArray(value);

  // Cross-manager compatibility (iOS Stay / Safari Userscripts / Violentmonkey / Tampermonkey).
  const gmGetValue = (key, fallback) => GM.getValue(key, fallback);
  const gmSetValue = (key, value) => GM.setValue(key, value);
  const gmListValues = async () => (typeof GM.listValues === 'function' ? await GM.listValues() : []);
  const gmGetValues = async keys => {
    if (typeof GM.getValues === 'function') return GM.getValues(keys);
    const out = {};
    await Promise.all(
      keys.map(async key => {
        const value = await gmGetValue(key, undefined);
        if (value !== undefined) out[key] = value;
      }),
    );
    return out;
  };
  const gmSetValues = async entries => {
    if (typeof GM.setValues === 'function') return GM.setValues(entries);
    await Promise.all(Object.entries(entries).map(([key, value]) => gmSetValue(key, value)));
  };
  const gmRequest = (options, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let handle;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        try {
          handle?.abort?.();
        } catch {
          /* ignore */
        }
        finish(reject, new Error('timeout'));
      }, timeoutMs);
      try {
        handle = GM.xmlHttpRequest({
          ...options,
          onload: res => finish(resolve, res),
          onerror: () => finish(reject, new Error('network')),
          ontimeout: () => finish(reject, new Error('timeout')),
          onabort: () => finish(reject, new Error('abort')),
        });
        if (handle && typeof handle.then === 'function') {
          handle.then(
            res => finish(resolve, res),
            err => finish(reject, err),
          );
        }
      } catch (error) {
        finish(reject, error);
      }
    });

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

  function destination(connection, targetFile = fileName) {
    const url = webdavDirectory(connection.url);
    if (!connection.username.trim() || connection.username.includes(':') || !connection.password)
      throw new Error('请填写 WebDAV 用户名和应用密码，用户名不能含冒号');
    url.pathname = url.pathname.replace(/\/?$/, '/') + targetFile;
    return url.href;
  }

  async function request(connection, method, headers = {}, data, targetFile = fileName) {
    const url = destination(connection, targetFile);
    const bytes = new TextEncoder().encode(connection.username.trim() + ':' + connection.password);
    const authorization = 'Basic ' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    let response;
    try {
      response = await gmRequest(
        {
          method,
          url,
          data,
          anonymous: true,
          redirect: 'error',
          nocache: true,
          headers: { Authorization: authorization, ...headers },
        },
        20000,
      );
    } catch {
      throw new Error('WebDAV 请求失败，请检查域名授权、网络及最终目录地址');
    }
    if (response.finalUrl && response.finalUrl !== url) throw new Error('WebDAV 地址发生重定向，请填写最终地址');
    return response;
  }

  const dataKey = connection => 'config:' + JSON.stringify([destination(connection), connection.username.trim()]);
  let localLock = Promise.resolve();
  const withLock = action => {
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request('cookiesync-userscript-config', action);
    }
    const next = localLock.then(action, action);
    localLock = next.catch(() => {});
    return next;
  };
  const cacheKey = connection => dataKey(connection) + ':remote-cache';
  const scheduleKey = connection => dataKey(connection) + ':schedule';
  const statusKey = connection => dataKey(connection) + ':status';

  const editPrefix = connection => dataKey(connection) + ':edit:';
  const editKey = (connection, group, name) => editPrefix(connection) + group + ':' + name;

  async function readConfig(connection) {
    const prefix = editPrefix(connection);
    const keys = (await gmListValues()).filter(key => key.startsWith(prefix));
    const stored = await gmGetValues([dataKey(connection), cacheKey(connection), ...keys]);
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

  function detectDeviceProfile() {
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const os = /iPhone/i.test(ua)
      ? 'iPhone'
      : /iPad/i.test(ua)
        ? 'iPad'
        : /Android/i.test(ua)
          ? 'Android'
          : /Mac/i.test(ua)
            ? 'macOS'
            : /Win/i.test(ua)
              ? 'Windows'
              : '设备';
    const browser = /Edg/i.test(ua)
      ? 'Edge'
      : /Firefox|FxiOS/i.test(ua)
        ? 'Firefox'
        : /CriOS|Chrome/i.test(ua)
          ? 'Chrome'
          : /Safari/i.test(ua)
            ? 'Safari'
            : '浏览器';
    return {
      slot: isMobile ? 'mobile' : 'desktop',
      defaultName: `${os} ${browser}`,
      uaFamily: `${os.toLowerCase()}-${browser.toLowerCase()}`,
    };
  }

  async function ensureDeviceIdentity() {
    const saved = await GM.getValue(deviceKey, null);
    const profile = detectDeviceProfile();
    if (saved && typeof saved.deviceId === 'string' && saved.deviceId.trim()) {
      return {
        deviceId: saved.deviceId,
        deviceName: saved.deviceName || profile.defaultName,
        slot: profile.slot,
        uaFamily: profile.uaFamily,
      };
    }
    const created = {
      deviceId: `${profile.slot}-${crypto.randomUUID().slice(0, 8)}`,
      deviceName: profile.defaultName,
    };
    await GM.setValue(deviceKey, created);
    return { ...created, slot: profile.slot, uaFamily: profile.uaFamily };
  }

  async function publishSlotLease(connection) {
    try {
      const id = await ensureDeviceIdentity();
      for (let attempt = 0; attempt < 2; attempt++) {
        const read = await request(connection, 'GET', {}, undefined, leaseFileName);
        if (![200, 404].includes(read.status)) return;
        let existing = null;
        if (read.status === 200 && read.responseText) {
          try {
            existing = JSON.parse(read.responseText);
          } catch {
            existing = null;
          }
        }
        const now = Date.now();
        const prevDesktop = existing?.slots?.desktop || (existing?.activeDeviceId ? {
          deviceId: existing.activeDeviceId,
          deviceName: existing.activeDeviceName || existing.activeDeviceId.slice(0, 8),
          userAgentFamily: existing.userAgentFamily || '',
          leaseAt: Number(existing.leaseAt) || 0,
          epoch: Number(existing.epoch) || 0,
          dataRevision: existing.dataRevision || '',
          lastDataWriteAt: Number(existing.lastDataWriteAt) || 0,
        } : undefined);
        const prevMobile = existing?.slots?.mobile;
        const prevSelf = id.slot === 'mobile' ? prevMobile : prevDesktop;
        const nextSlot = {
          deviceId: id.deviceId,
          deviceName: id.deviceName,
          userAgentFamily: id.uaFamily,
          leaseAt: now,
          epoch: (Number(prevSelf?.epoch) || 0) + 1,
          dataRevision: crypto.randomUUID(),
          lastDataWriteAt: now,
        };
        const desktop = id.slot === 'desktop' ? nextSlot : prevDesktop;
        const mobile = id.slot === 'mobile' ? nextSlot : prevMobile;
        const primary = desktop || nextSlot;
        const merged = {
          version: 1,
          activeDeviceId: primary.deviceId,
          activeDeviceName: primary.deviceName,
          userAgentFamily: primary.userAgentFamily,
          leaseAt: primary.leaseAt,
          epoch: primary.epoch,
          dataRevision: primary.dataRevision,
          lastDataWriteAt: primary.lastDataWriteAt,
          slots: {
            ...(desktop ? { desktop } : {}),
            ...(mobile ? { mobile } : {}),
          },
        };
        const etag = read.responseHeaders?.match(/^etag:[ \t]*([^\r\n]+)/im)?.[1].trim();
        const condition = read.status === 404 ? { 'If-None-Match': '*' } : etag ? { 'If-Match': etag } : {};
        const write = await request(
          connection,
          'PUT',
          { 'Content-Type': 'application/json; charset=utf-8', ...condition },
          JSON.stringify(merged),
          leaseFileName,
        );
        if (write.status >= 200 && write.status < 300) return;
        if (write.status !== 412) return;
      }
    } catch {
      /* Lease update is auxiliary; never fail config sync. */
    }
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
    await publishSlotLease(connection);
    return message;
  }

  function currentPageDomain() {
    if (typeof location === 'undefined' || !location.hostname) return '';
    try {
      return normalizeDomain(location.hostname);
    } catch {
      return '';
    }
  }

  function isNewerVersion(remoteVersion, localVersion) {
    const parse = v => String(v || '').split('.').map(n => Number(n) || 0);
    const a = parse(remoteVersion);
    const b = parse(localVersion);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const left = a[i] || 0;
      const right = b[i] || 0;
      if (left !== right) return left > right;
    }
    return false;
  }

  async function checkScriptUpdate() {
    const localVersion = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '2.2.1';
    try {
      const response = await gmRequest(
        {
          method: 'GET',
          url: scriptDownloadUrl,
          anonymous: true,
          nocache: true,
        },
        15000,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error('检查更新失败（HTTP ' + response.status + '）');
      }
      const match = /@version\s+(\d+(?:\.\d+){1,3})/.exec(response.responseText || '');
      if (!match) throw new Error('无法解析远程版本号');
      const remoteVersion = match[1];
      return {
        localVersion,
        remoteVersion,
        hasUpdate: isNewerVersion(remoteVersion, localVersion),
        downloadUrl: scriptDownloadUrl,
      };
    } catch (error) {
      throw new Error(error instanceof Error && error.message !== 'timeout' ? error.message : '无法连接 GitHub 检查更新');
    }
  }

  async function quickAddCurrentSite() {
    const domain = currentPageDomain();
    if (!domain) throw new Error('当前页面不是普通网站域名');
    const connection = await GM.getValue(connectionKey, null);
    if (!connection) throw new Error('请先打开「配置同步」保存 WebDAV 连接');
    const effective = await readConfig(connection);
    const updated = revision(true, effective.rules[domain], 'enabled');
    merge(effective, { ...empty(), rules: { [domain]: updated } });
    await GM.setValue(editKey(connection, 'rules', domain), updated);
    return domain;
  }

  function isExtensionActive() {
    return typeof document !== 'undefined' && Boolean(document.documentElement?.hasAttribute?.('data-cookiesync-ext'));
  }

  // GM storage is shared across sites, while Web Locks are scoped to an origin.
  // The shared claim coalesces restored tabs; conditional PUT handles any overlap.
  async function maybeSync() {
    if (isExtensionActive()) return;
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
        --surface: #ffffff; --recess: #ffffff; --ink: #000000; --muted: #666666;
        --faint: #999999; --line: #e4e4e4; --line-strong: #111111;
        --accent: #6f8dff; --accent-hover: #5b7bff; --on-accent: #ffffff;
        --good: #16a34a; --warning: #d97706; --error: #dc2626;
        width: min(820px, calc(100vw - 40px)); max-width: none;
        max-height: min(680px, calc(100dvh - 40px)); padding: 0; overflow: hidden;
        border: 1px solid var(--line); border-radius: 20px; background: var(--surface); color: var(--ink);
        box-shadow: 0 28px 72px -24px rgba(0, 0, 0, 0.22); color-scheme: light;
        font: 14px/1.55 "Noto Sans SC", "PingFang SC", "Helvetica Neue", "Inter", -apple-system, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      dialog[open] { display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto }
      dialog::backdrop { background: rgba(0, 0, 0, 0.34); backdrop-filter: blur(4px) }
      *, *::before, *::after { box-sizing: border-box }
      [hidden] { display: none !important }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;
        clip-path: inset(50%); white-space: nowrap }
      h2, h3, h4, p, dl, dd { margin: 0 }
      button, input, select { font: inherit; color: inherit }
      .sheet-handle { display: none }
      .top, footer {
        display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 26px;
      }
      .top { border-bottom: 1px solid var(--line) }
      .wordmark { display: flex; align-items: center; gap: 10px }
      .brand-mark { width: 28px; height: 28px; flex: none; display: block }
      .top h2 { font-size: 16px; font-weight: 500; letter-spacing: -.02em; line-height: 1.1 }
      .top-sub { font-size: 11px; color: var(--faint); margin-left: 6px; font-weight: 400 }
      .yield-banner {
        padding: 10px 26px; border-bottom: 1px solid var(--line);
        font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 8px;
      }
      .yield-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--good); flex: none }
      nav {
        display: flex; align-items: center; gap: 6px; padding: 12px 26px;
        border-bottom: 1px solid var(--line); background: var(--surface);
      }
      button, input, select { min-height: 40px; min-width: 0 }
      button {
        padding: 8px 18px; border: 1px solid var(--line); border-radius: 999px;
        background: transparent; color: var(--ink); font-size: 13px; font-weight: 400;
        cursor: pointer; transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
      }
      button:hover:enabled:not([aria-disabled="true"]) { border-color: var(--line-strong) }
      button:disabled, button[aria-disabled="true"] { opacity: .48; cursor: wait }
      #close { border-color: var(--line); color: var(--muted); padding: 6px 14px; min-height: 34px; font-size: 12.5px }
      nav button {
        border: 1px solid transparent; border-radius: 999px; background: transparent;
        color: var(--muted); padding: 6px 14px; min-height: 34px; font-size: 13px;
      }
      nav button:hover:enabled { border-color: transparent; color: var(--ink) }
      nav button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); font-weight: 500 }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
      .content { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain }
      section { display: grid; gap: 18px; align-content: start; padding: 26px; min-height: 320px }
      .heading { display: grid; gap: 5px; padding-bottom: 14px; border-bottom: 1px solid var(--line) }
      h3 { font-size: 24px; font-weight: 400; letter-spacing: -.03em; line-height: 1.15 }
      h4 { font-size: 15px; font-weight: 400 }
      .hint, small { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere }
      #overview { padding: 0; gap: 0 }
      .status-panel {
        padding: 36px 26px 30px; min-height: 248px;
        display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr);
        align-items: center; gap: 32px;
      }
      .result { display: grid; justify-items: start; gap: 12px; min-width: 0 }
      .result h4 {
        font-size: clamp(28px, 3.6vw, 40px); font-weight: 400; letter-spacing: -.035em;
        line-height: 1.08; text-wrap: balance;
      }
      .result p { color: var(--muted); font-size: 13.5px; max-width: 38ch; overflow-wrap: anywhere; line-height: 1.6 }
      #overview-action { margin-top: 4px; padding: 9px 22px; min-width: 118px }
      .sync-route {
        --signal: var(--accent);
        display: flex; flex-direction: column; gap: 14px; padding: 22px 20px;
        border-left: 1px solid var(--line); min-width: 0; color: var(--muted);
      }
      .sync-route[data-state="ok"] { --signal: var(--good) }
      .sync-route[data-state="error"] { --signal: var(--error) }
      .sync-route[data-pending] { --signal: var(--accent) }
      .route-kicker { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint) }
      .route-track { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12.5px; color: var(--ink) }
      .route-dots { flex: 1; display: flex; align-items: center; justify-content: space-evenly }
      .route-dot { width: 5px; height: 5px; border-radius: 999px; background: var(--signal); opacity: .45 }
      .route-sub { font-size: 12px; color: var(--faint) }
      .overview-meta {
        display: grid; align-items: center; grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px; padding: 14px 26px; border-top: 1px solid var(--line);
      }
      .details { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, .8fr) minmax(0, 1.2fr) }
      .details div { padding: 4px 0; min-width: 0 }
      .details div + div { border-inline-start: 1px solid var(--line); padding-inline: 14px 4px }
      .details dt { font-size: 11.5px; color: var(--faint) }
      .details dd { overflow-wrap: anywhere; font-size: 13.5px; font-weight: 500; margin-top: 2px }
      #last-sync { font-variant-numeric: tabular-nums }
      .actions, .key-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px }
      .fields { display: grid; gap: 16px }
      label { display: grid; gap: 6px; min-width: 0; font-size: 12.5px; color: var(--muted) }
      input, select {
        width: 100%; border: 0; border-bottom: 1px solid var(--line); border-radius: 0;
        background: transparent; padding: 8px 0; font-size: 14px; color: var(--ink);
        caret-color: var(--accent); outline: none; transition: border-color 150ms ease;
      }
      input:focus, select:focus { border-bottom-color: var(--line-strong) }
      input::placeholder { color: var(--faint); opacity: 1 }
      input[aria-invalid="true"] { border-bottom-color: var(--error) }
      .automatic {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 14px 0; border-block: 1px solid var(--line); color: var(--ink); font-size: 13.5px;
      }
      .automatic small { display: block; font-size: 12px; color: var(--faint); margin-top: 2px }
      #automatic { width: 18px; height: 18px; min-height: 18px; margin: 0; flex: none;
        accent-color: var(--accent); cursor: pointer }
      .rule-editor { display: flex; gap: 10px; align-items: end; flex-wrap: wrap }
      .rule-editor label { flex: 1 1 200px }
      .current-site-bar {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 12px 0; border-bottom: 1px solid var(--line);
      }
      .current-site-meta { min-width: 0; display: grid; gap: 2px }
      .current-site-host { font-size: 14px; font-weight: 500; color: var(--ink); overflow-wrap: anywhere }
      .preset-block { display: grid; gap: 10px; padding-bottom: 14px; border-bottom: 1px solid var(--line) }
      .preset-title { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint) }
      .preset-grid { display: flex; flex-wrap: wrap; gap: 7px }
      .preset-chip {
        display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; min-height: 32px;
        border: 1px solid var(--line); border-radius: 999px; background: transparent;
        font-size: 12px; color: var(--muted); cursor: pointer;
      }
      .preset-chip[data-enabled="true"] {
        border-color: var(--accent); color: var(--ink); font-weight: 500;
      }
      .preset-dot { width: 5px; height: 5px; border-radius: 999px; background: var(--faint) }
      .preset-chip[data-enabled="true"] .preset-dot { background: var(--good) }
      .overview-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
      .rule-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 110px; align-items: end; gap: 12px }
      .rules { list-style: none; padding: 0; margin: 0 }
      .rules li {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; font-size: 13.5px;
      }
      .rule-state { flex: none; font-size: 12px; color: var(--good) }
      .rule-state[data-enabled="false"] { color: var(--warning) }
      .primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 500 }
      .primary:hover:enabled { background: var(--accent-hover); border-color: transparent }
      footer { border-top: 1px solid var(--line); background: var(--surface); min-height: 52px }
      footer:has(#sync[hidden]):has(#status:is(:empty, [data-summary])) { display: none }
      #status { color: var(--muted); min-width: 0; overflow-wrap: anywhere; font-size: 12.5px }
      #status[data-kind="error"], .field-error { color: var(--error) }
      #status[data-kind="success"] { color: var(--good) }
      #sync { flex: none }
      @media (prefers-reduced-motion: no-preference) {
        dialog[open] { animation: open-panel .22s cubic-bezier(.2,.8,.2,1) }
        .sync-route[data-state="ok"] .route-dot,
        .sync-route[data-pending] .route-dot { animation: dot-wave 2s ease-in-out infinite }
        .sync-route[data-pending] .route-dot { animation-duration: .75s }
        .route-dot:nth-child(2) { animation-delay: .15s }
        .route-dot:nth-child(3) { animation-delay: .3s }
        .route-dot:nth-child(4) { animation-delay: .45s }
        .route-dot:nth-child(5) { animation-delay: .6s }
        .route-dot:nth-child(6) { animation-delay: .75s }
        @keyframes dot-wave {
          0%, 100% { opacity: .28; transform: scale(.85) }
          50% { opacity: 1; transform: scale(1.25) }
        }
        @keyframes open-panel { from { opacity: 0; transform: translateY(10px) } }
      }
      @media (prefers-color-scheme: dark) {
        dialog {
          --surface: #000000; --recess: #000000; --ink: #ffffff; --muted: #9a9a9a;
          --faint: #666666; --line: #242424; --line-strong: #ffffff;
          --accent: #7a96ff; --accent-hover: #8ea7ff; --on-accent: #ffffff;
          --good: #30d158; --warning: #ff9f0a; --error: #ff453a;
          box-shadow: 0 28px 80px -20px rgba(0, 0, 0, 0.85); color-scheme: dark;
        }
        select option { background: #111114; color: #ffffff }
      }
      @media (max-width: 600px) {
        dialog {
          margin: auto 0 0 0; width: 100vw; max-height: 88dvh;
          border-radius: 22px 22px 0 0; border-bottom: 0; border-inline: 0;
          padding-bottom: env(safe-area-inset-bottom);
        }
        .sheet-handle {
          display: block; width: 38px; height: 4px; border-radius: 999px;
          background: var(--line); margin: 10px auto 0;
        }
        .top { padding: 10px 18px 12px }
        nav { padding: 10px 18px; overflow-x: auto }
        nav button { flex: 1; padding: 7px 10px; font-size: 12.5px; white-space: nowrap }
        .yield-banner { padding: 10px 18px }
        section { padding: 18px; gap: 16px; min-height: 0 }
        .status-panel { min-height: 0; padding: 22px 18px 18px; gap: 20px; grid-template-columns: minmax(0, 1fr) }
        .sync-route { border-left: 0; border-top: 1px solid var(--line); padding: 16px 0 0 }
        .overview-meta { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 12px 18px 16px }
        .details div + div { padding-inline-start: 10px }
        .rule-editor label { flex-basis: 100% }
        footer { padding: 12px 18px }
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
    const detail = (id, title, ...children) =>
      element('div', {}, element('dt', {}, title), element('dd', { id }, ...children));
    const overviewAction = button('overview-action', '立即同步');
    overviewAction.className = 'primary';
    const lastSync = element('time', { id: 'last-sync', hidden: '' });
    const noSyncTime = element('span', { id: 'no-sync-time' }, '尚无记录');
    const svgEl = (tag, attrs = {}, ...children) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      node.append(...children);
      return node;
    };
    const brandLogo = svgEl('svg', { viewBox: '0 0 512 512', class: 'brand-mark', 'aria-hidden': 'true' },
      svgEl('rect', { x: 16, y: 16, width: 480, height: 480, rx: 116, fill: '#0E0E12' }),
      svgEl('path', { d: 'M 334 156 A 126 126 0 1 0 198 368', stroke: '#FFFFFF', 'stroke-width': 46, 'stroke-linecap': 'round', fill: 'none' }),
      svgEl('path', { d: 'M 178 356 A 126 126 0 0 0 378 242', stroke: '#6F8DFF', 'stroke-width': 46, 'stroke-linecap': 'round', fill: 'none' }),
      svgEl('circle', { cx: 256, cy: 256, r: 16, fill: '#FFFFFF' }),
      svgEl('circle', { cx: 364, cy: 186, r: 15, fill: '#6F8DFF' }),
    );
    const route = element('div', { class: 'sync-route', 'aria-hidden': 'true' },
      element('span', { class: 'route-kicker' }, 'SYNC PIPELINE'),
      element('div', { class: 'route-track' },
        element('span', {}, '本机'),
        element('div', { class: 'route-dots' },
          element('span', { class: 'route-dot' }),
          element('span', { class: 'route-dot' }),
          element('span', { class: 'route-dot' }),
          element('span', { class: 'route-dot' }),
          element('span', { class: 'route-dot' }),
          element('span', { class: 'route-dot' }),
        ),
        element('span', {}, 'WebDAV'),
      ),
      element('span', { class: 'route-sub' }, '与 Chrome 扩展共用同一份私人云端配置'),
    );
    const content = element('div', { class: 'content' },
      section('overview',
        element('h3', { id: 'overview-title', class: 'sr-only', tabindex: '-1' }, '同步概览'),
        element('div', { class: 'status-panel' },
          element('div', { class: 'result' },
            element('h4', { id: 'sync-state', 'aria-live': 'polite' }),
            element('p', { id: 'sync-message' }),
            overviewAction,
          ),
          route,
        ),
        element('div', { class: 'overview-meta' },
          element('dl', { class: 'details' },
            detail('saved-host', 'WebDAV 服务器'), detail('auto-state', '自动同步'),
            detail('last-result', '上次同步', lastSync, noSyncTime),
          ),
          element('div', { class: 'overview-actions' },
            button('check-update', '检查更新'),
            button('edit-connection', '管理连接'),
          ),
        ),
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
      section('sites', heading('sites', '网站名单', '一键加入当前网站、从预设名单快速勾选，或手动添加域名。'),
        element('div', { id: 'current-site-bar', class: 'current-site-bar', ...(currentPageDomain() ? {} : { hidden: '' }) },
          element('div', { class: 'current-site-meta' },
            element('span', { class: 'hint' }, '当前打开的网站'),
            element('span', { id: 'current-site-host', class: 'current-site-host' }, currentPageDomain()),
          ),
          button('add-current-site', '一键加入'),
        ),
        element('div', { class: 'preset-block' },
          element('span', { class: 'preset-title' }, '高频预设名单（点击快速切换）'),
          element('div', { id: 'preset-grid', class: 'preset-grid', 'aria-label': '预设网站名单' }),
        ),
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
    const extYieldBanner = element('div', { class: 'yield-banner', ...(isExtensionActive() ? {} : { hidden: '' }) },
      element('span', { class: 'yield-dot', 'aria-hidden': 'true' }),
      element('span', {}, '已检测到 CookieSync Chrome 扩展正在运行，油猴版自动同步已静默让位，避免重复同步。'),
    );
    const dialog = element('dialog', { 'aria-labelledby': 'title', lang: 'zh-CN' },
      element('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
      element('header', { class: 'top' },
        element('div', { class: 'wordmark' },
          brandLogo,
          element('h2', { id: 'title' }, 'CookieSync', element('span', { class: 'top-sub' }, '油猴版')),
        ),
        button('close', '关闭'),
      ),
      extYieldBanner,
      navigation,
      content,
      element('footer', {},
        element('p', { id: 'status', class: 'hint', role: 'status', 'aria-live': 'polite' }),
        syncButton,
      ),
    );
    const views = [['overview', '概览'], ['webdav', '连接'], ['sites', '名单'], ['preferences', '偏好']];
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
        const trigger = event?.currentTarget;
        const buttons = root.querySelectorAll('button');
        for (const button of buttons) {
          if (button === trigger) button.setAttribute('aria-disabled', 'true');
          else button.disabled = true;
        }
        try {
          get('status').dataset.kind = 'progress';
          get('status').textContent = showProgress ? '处理中…' : '';
          updateFeedbackVisibility();
          get('status').textContent = (await withLock(() => action(event))) || '';
          get('status').dataset.kind = 'success';
        } catch (error) {
          get('status').dataset.kind = 'error';
          get('status').textContent = error.message || '操作失败';
        } finally {
          updateFeedbackVisibility();
          busy = false;
          trigger?.removeAttribute('aria-disabled');
          for (const button of buttons) button.disabled = false;
        }
      };
    }
    function renderRules() {
      const ruleMap = new Map(rules);
      const curHost = currentPageDomain();
      if (curHost) {
        const curRule = ruleMap.get(curHost);
        const addBtn = get('add-current-site');
        addBtn.className = curRule?.enabled ? '' : 'primary';
        addBtn.textContent = curRule?.enabled ? '已在名单' : '一键加入';
      }
      const presetGrid = get('preset-grid');
      presetGrid.replaceChildren(...presetSites.map(([host, name]) => {
        const enabled = ruleMap.get(host)?.enabled === true;
        const chip = element('button', {
          type: 'button',
          class: 'preset-chip',
          'data-enabled': String(enabled),
          'aria-pressed': String(enabled),
        }, element('span', { class: 'preset-dot', 'aria-hidden': 'true' }), name);
        chip.onclick = run(() => changeRuleForDomain(host, !enabled));
        return chip;
      }));

      const query = get('rule-search').value.trim().toLowerCase();
      const filter = get('rule-filter').value;
      const shown = rules.filter(([domain, rule]) =>
        domain.includes(query) && (filter === 'all' || rule.enabled === (filter === 'allow')),
      );
      get('rule-count').textContent = !rules.length ? '还没有规则，可点击上方预设或添加一个域名。'
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
      lastSync.hidden = !status;
      noSyncTime.hidden = Boolean(status);
      if (status) {
        const time = new Date(status.at);
        lastSync.dateTime = time.toISOString();
        lastSync.textContent = time.toLocaleString('zh-CN', {
          year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
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
    async function changeRuleForDomain(rawDomain, enabled) {
      const connection = active();
      const domain = normalizeDomain(rawDomain);
      const effective = await readConfig(connection);
      const updated = revision(enabled, effective.rules[domain], 'enabled');
      merge(effective, { ...empty(), rules: { [domain]: updated } });
      await GM.setValue(editKey(connection, 'rules', domain), updated);
      await render({ refreshPreferences: false });
      return enabled ? `已将 ${domain} 加入名单` : `已暂停 ${domain}`;
    }
    async function changeRule(enabled) {
      const msg = await changeRuleForDomain(get('domain').value, enabled);
      get('domain').value = '';
      return msg;
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
    get('add-current-site').onclick = run(async () => {
      const host = currentPageDomain();
      if (!host) throw new Error('当前页面不支持加入名单');
      return changeRuleForDomain(host, true);
    });
    get('check-update').onclick = run(async () => {
      const info = await checkScriptUpdate();
      if (info.hasUpdate) {
        if (window.confirm(`发现 CookieSync 油猴版新版本 v${info.remoteVersion}（当前 v${info.localVersion}），是否立即打开安装更新？`)) {
          window.open(info.downloadUrl, '_blank', 'noopener');
        }
        return `发现新版本 v${info.remoteVersion}`;
      }
      return `已是最新版 v${info.localVersion}`;
    });
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
      if (Object.keys(changes).length) await gmSetValues(changes);
    }
    get('save').onclick = run(async () => {
      await savePreferences();
      await render();
      return '普通设置已保存到本机';
    });
    const synchronize = run(async event => {
      await savePreferences();
      try {
        const connection = active();
        await GM.setValue(scheduleKey(connection), { at: Date.now() });
        route.dataset.pending = event?.detail ? 'pointer' : 'keyboard';
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
    const extRunning = isExtensionActive();
    GM.registerMenuCommand(extRunning ? 'CookieSync · 配置同步（已让位给扩展）' : 'CookieSync · 配置同步', openPanel);
    const pageHost = currentPageDomain();
    if (pageHost && !extRunning) {
      GM.registerMenuCommand(`CookieSync · 一键加入 ${pageHost}`, async () => {
        try {
          const added = await quickAddCurrentSite();
          alert(`已将 ${added} 加入 CookieSync 同步名单`);
        } catch (error) {
          alert(error instanceof Error ? error.message : '加入失败');
        }
      });
    }
    GM.registerMenuCommand('CookieSync · 检查脚本更新', async () => {
      try {
        const info = await checkScriptUpdate();
        if (info.hasUpdate) {
          if (confirm(`发现新版本 v${info.remoteVersion}（当前 v${info.localVersion}），是否打开安装页面？`)) {
            window.open(info.downloadUrl, '_blank', 'noopener');
          }
        } else {
          alert(`CookieSync 油猴版已是最新（v${info.localVersion}）`);
        }
      } catch (error) {
        alert(error instanceof Error ? error.message : '检查更新失败');
      }
    });
    GM.registerMenuCommand('CookieSync · 查看同步状态', async () => {
      if (isExtensionActive()) {
        alert('已检测到 CookieSync Chrome 扩展正在运行，油猴版已自动静默让位。');
        return;
      }
      const connection = await GM.getValue(connectionKey, null);
      alert(connection ? statusText(await GM.getValue(statusKey(connection), null)) : '请先保存 WebDAV 连接');
    });
    if (extRunning) return;
    const trigger = () => {
      if (!document.hidden && !isExtensionActive()) void maybeSync().catch(() => {});
    };
    document.addEventListener('visibilitychange', trigger);
    trigger();
  }

  start();
})();
