"""Optional browser smoke test. Uses synthetic accounts, local WebDAV and isolated Chrome profiles.
Install tests/requirements-browser.txt, run playwright install chromium, build dist/, then run this file.
Test screenshots and profiles are written to an OS temporary directory, never the repository.
"""
import os, json, threading, base64, time, tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

ROOT = Path(tempfile.mkdtemp(prefix='cookiesync-smoke-'))
# The repository stays source-only; load the freshly built unpacked release by default.
EXT = Path(os.environ.get('COOKIESYNC_DIST') or Path(__file__).resolve().parents[1] / 'dist')
files = {}
version = 0
requests = []
reject_conditions = False
reject_reads = False

def wait_extension(page, predicate):
    # wait_for_function uses eval, which extension pages correctly block via CSP.
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if page.evaluate(predicate): return
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for extension storage/UI')

def mock_115_health(ctx):
    # The read-only login probe must never leave the test machine: intercept it
    # in every profile from the start, including the background service worker.
    ctx.route('**my.115.com/**', lambda route: route.fulfill(
        status=200, content_type='application/json',
        body=json.dumps({'state': True, 'data': {'user_name': 'fixture-user'}})))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, code, data=b'', etag=None):
        self.send_response(code)
        if etag: self.send_header('ETag', etag)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        requests.append(('GET', self.path))
        if self.path.startswith('/dav/'):
            if reject_reads: self.reply(403); return
            item = files.get(self.path)
            if item: self.reply(200, item[0], item[1])
            else: self.reply(404)
        else:
            self.reply(200, b'<html><title>CookieSync test site</title><script>localStorage.setItem("test_token", "dummy_local_token")</script><body>Local test page</body></html>')
    def do_PUT(self):
        global version
        requests.append(('PUT', self.path))
        existing = files.get(self.path)
        if reject_conditions and (self.headers.get('If-Match') or self.headers.get('If-None-Match')): return self.reply(412)
        if self.headers.get('If-None-Match') == '*' and existing: return self.reply(412)
        if self.headers.get('If-Match') and (not existing or self.headers['If-Match'] != existing[1]): return self.reply(412)
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        version += 1
        files[self.path] = (body, '"%s"' % version)
        self.reply(201)
    def do_DELETE(self):
        requests.append(('DELETE', self.path)); files.pop(self.path, None); self.reply(204)

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
errors = []
with sync_playwright() as p:
    profile_path = tempfile.mkdtemp(prefix='test-profile-', dir=ROOT)
    context = p.chromium.launch_persistent_context(profile_path, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], viewport={'width': 1100, 'height': 1050})
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=20000)
    extension_id = worker.url.split('/')[2]
    print('extension_loaded', bool(extension_id))
    assert extension_id == 'mlgghgdchflafjaegkneinnockfeboei', 'Extension ID must stay identical across computers'
    mock_115_health(context)
    options = context.new_page(); options.on('pageerror', lambda error: errors.append(str(error)))
    options.goto(f'chrome-extension://{extension_id}/options/index.html')
    options.locator('#webdav-url').fill(base + '/dav/')
    options.locator('#webdav-username').fill('local-test')
    options.locator('#webdav-password').fill('dummy-app-password')
    options.locator('#webdav-path').fill('cookies.txt')
    options.get_by_role('button', name='测试连接', exact=True).click()
    options.get_by_text('连接测试成功：已验证临时文件的创建、覆盖、读取和删除', exact=True).wait_for()
    assert not files, 'probe must be removed'
    options.get_by_role('button', name='保存并使用 WebDAV', exact=True).click()
    options.get_by_text('WebDAV 配置已保存', exact=True).wait_for()
    assert options.evaluate('async () => (await chrome.storage.local.get("webdav-local-settings"))["webdav-local-settings"].password') == 'dummy-app-password'
    assert not options.evaluate('async () => (await chrome.storage.sync.get("webdav-local-settings"))["webdav-local-settings"] || null')
    cloud_toggle = options.locator('label').filter(has_text='使用 Chrome / Google 账号同步').get_by_role('checkbox')
    cloud_toggle.check()
    options.get_by_role('button', name='保存并使用 WebDAV', exact=True).click()
    wait_extension(options, 'async () => (await chrome.storage.sync.get("webdav-cloud-settings-v1"))["webdav-cloud-settings-v1"]?.settings?.password === "dummy-app-password"')
    options.evaluate('''async () => { const key='webdav-cloud-settings-v1'; const c=(await chrome.storage.sync.get(key))[key]; await chrome.storage.sync.set({[key]:{...c,settings:{...c.settings,path:'synced-other-device.txt'}}}); }''')
    wait_extension(options, '() => document.querySelector("#webdav-path").value === "synced-other-device.txt"')
    options.locator('#webdav-path').fill('cookies.txt')
    cloud_toggle.uncheck()
    options.get_by_role('button', name='保存并使用 WebDAV', exact=True).click()
    wait_extension(options, 'async () => (await chrome.storage.sync.get("webdav-cloud-settings-v1"))["webdav-cloud-settings-v1"]?.enabled === false')
    assert not options.evaluate('async () => (await chrome.storage.sync.get("webdav-cloud-settings-v1"))["webdav-cloud-settings-v1"].settings || null')
    print('webdav_google_config_opt_in_remote_restore_and_opt_out_passed')
    options.evaluate('''async () => { const key='settings-storage-key'; const saved=(await chrome.storage.sync.get(key))[key]; await chrome.storage.sync.set({[key]:{...saved, backgroundSync:false, startupPull:false}}); }''')
    options.screenshot(path=str(ROOT / 'settings.png'), full_page=True)
    # First-run guide: connection and test are done, the first push is not.
    assert options.locator('.connection-guide').is_visible()
    assert options.locator('.connection-guide li[data-done="true"]').count() == 2
    assert options.locator('.connection-guide li[data-done="false"]').count() == 1
    print('first_run_connection_guide_passed')
    site = context.new_page(); site.goto(base + '/site'); site.bring_to_front()
    context.add_cookies([{'name': 'session_test', 'value': 'dummy_login', 'url': base, 'httpOnly': True, 'sameSite': 'Lax'}])
    payload = {'type': 'PushCookie', 'payload': {'host': f'127.0.0.1:{server.server_port}', 'sourceUrl': base + '/site', 'favIconUrl': ''}}
    pushed = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    print('push_result', json.dumps({k:v for k,v in pushed.items() if k!='result'}, ensure_ascii=False))
    assert pushed['isOk'], pushed
    assert '/dav/cookies.txt' in files
    remote = json.loads(files['/dav/cookies.txt'][0])
    entry = remote['domainCookieMap'][f'127.0.0.1:{server.server_port}']
    assert any(c['name']=='session_test' for c in entry['cookies'])
    assert any(v['key']=='test_token' for v in entry['localStorageItems'])
    assert all(v.get('origin') == base for v in entry['localStorageItems']), 'localStorage must carry its exact origin'
    before_repeat = version
    repeated = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert repeated['isOk'] and version == before_repeat, 'unchanged push must skip remote PUT'
    print('semantic_digest_skips_unchanged_push_passed')
    # Session storage is opt-in per site and restores only after a reload.
    options.evaluate('''async () => {
        const key='settings-storage-key'; const saved=(await chrome.storage.sync.get(key))[key];
        await chrome.storage.sync.set({[key]:{...saved, includeSessionStorage:true}});
    }''')
    site.evaluate("sessionStorage.setItem('session_fixture','s1')")
    site.bring_to_front()
    session_push = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert session_push['isOk'], session_push
    entry = json.loads(files['/dav/cookies.txt'][0])['domainCookieMap'][f'127.0.0.1:{server.server_port}']
    assert any(v['key']=='session_fixture' and v['value']=='s1' and v.get('origin')==base for v in entry['sessionStorageItems']), entry['sessionStorageItems']
    site.evaluate("sessionStorage.setItem('session_fixture','stale')")
    pulled_session = options.evaluate('(message) => chrome.runtime.sendMessage(message)', {
        'type':'PullCookie','payload':{'domain':f'127.0.0.1:{server.server_port}','activeTabUrl':base+'/site','reload':True}})
    assert pulled_session['isOk'], pulled_session
    site.wait_for_load_state('load')
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if site.evaluate("sessionStorage.getItem('session_fixture')") == 's1': break
        except Exception:
            pass
        time.sleep(0.2)
    else:
        raise AssertionError('session storage was not restored after the reload')
    print('origin_tagged_localstorage_and_session_storage_passed')
    # IndexedDB is opt-in and restores whole object stores after a reload.
    options.evaluate('''async () => {
        const key='settings-storage-key'; const saved=(await chrome.storage.sync.get(key))[key];
        await chrome.storage.sync.set({[key]:{...saved, includeIndexedDB:true}});
    }''')
    site.evaluate('''() => new Promise((resolve, reject) => {
        const request = indexedDB.open('cookiesync_fixture', 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('auth')) db.createObjectStore('auth');
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('auth', 'readwrite');
            tx.objectStore('auth').put({ token: 'idb-token', at: 123 }, 'k1');
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => reject(tx.error);
        };
    })''')
    site.bring_to_front()
    idb_push = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert idb_push['isOk'], idb_push
    entry = json.loads(files['/dav/cookies.txt'][0])['domainCookieMap'][f'127.0.0.1:{server.server_port}']
    idb_records = entry.get('indexedDBRecords') or []
    assert any(r['database'] == 'cookiesync_fixture' and r['store'] == 'auth' and r['origin'] == base for r in idb_records), idb_records
    site.evaluate('''() => new Promise((resolve, reject) => {
        const request = indexedDB.open('cookiesync_fixture');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('auth', 'readwrite');
            tx.objectStore('auth').clear();
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => reject(tx.error);
        };
    })''')
    idb_pull = options.evaluate('(message) => chrome.runtime.sendMessage(message)', {
        'type':'PullCookie','payload':{'domain':f'127.0.0.1:{server.server_port}','activeTabUrl':base+'/site','reload':True}})
    assert idb_pull['isOk'], idb_pull
    site.wait_for_load_state('load')
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            value = site.evaluate('''() => new Promise((resolve) => {
                const request = indexedDB.open('cookiesync_fixture');
                request.onerror = () => resolve(null);
                request.onsuccess = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('auth')) { db.close(); resolve(null); return; }
                    const get = db.transaction('auth', 'readonly').objectStore('auth').get('k1');
                    get.onsuccess = () => { db.close(); resolve(get.result); };
                    get.onerror = () => { db.close(); resolve(null); };
                };
            })''')
            if value and value.get('token') == 'idb-token': break
        except Exception:
            pass
        time.sleep(0.3)
    else:
        raise AssertionError('IndexedDB record was not restored after the reload')
    print('indexeddb_opt_in_roundtrip_passed')
    # Conditional-PUT gateways must fail visibly, then work only after explicit opt-in.
    context.add_cookies([{'name':'session_test','value':'changed_login','url':base,'httpOnly':True,'sameSite':'Lax'}])
    reject_conditions = True
    site.bring_to_front()
    failed = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert not failed['isOk'] and '412' in failed['msg'], failed
    manager = context.new_page(); manager.goto(f'chrome-extension://{extension_id}/sidepanel/index.html')
    manager.get_by_role('alert').filter(has_text='最近一次推送未成功').wait_for()
    manager.get_by_role('button', name='刷新远程列表', exact=True).wait_for()
    options.locator('label').filter(has_text='AList / OpenList').get_by_role('checkbox').check()
    options.get_by_role('button', name='保存并使用 WebDAV', exact=True).click()
    options.get_by_text('WebDAV 配置已保存', exact=True).wait_for()
    site.bring_to_front()
    recovered = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert recovered['isOk'], recovered
    manager.get_by_role('button',name='刷新远程列表',exact=True).click()
    manager.get_by_text('最近一次推送未成功',exact=False).wait_for(state='hidden')
    assert manager.locator('tbody tr').count() == 1
    reject_reads = True
    manager.get_by_role('button',name='刷新远程列表',exact=True).click()
    manager.get_by_role('alert').filter(has_text='远程列表未加载').wait_for()
    reject_reads = False
    manager.get_by_role('button',name='刷新远程列表',exact=True).click()
    manager.get_by_role('alert').filter(has_text='远程列表未加载').wait_for(state='hidden')
    manager.close(); reject_conditions = False
    print('conditional_gateway_recovery_and_manager_feedback_passed')
    context.clear_cookies()
    site.evaluate('localStorage.clear()')
    pulled = options.evaluate('(message) => chrome.runtime.sendMessage(message)', {'type': 'PullCookie', 'payload': {'domain': f'127.0.0.1:{server.server_port}', 'activeTabUrl': base + '/site', 'reload': False}})
    print('pull_result', json.dumps({k:v for k,v in pulled.items() if k!='result'}, ensure_ascii=False))
    assert pulled['isOk'], pulled
    assert any(c['name']=='session_test' and c['value']=='changed_login' for c in context.cookies(base))
    assert site.evaluate('localStorage.getItem("test_token")') == 'dummy_local_token'
    print('real_browser_webdav_push_pull_localstorage_passed')
    # Stop and restart worker, then verify the message handler still responds.
    cdp = context.new_cdp_session(site)
    cdp.send('ServiceWorker.enable')
    targets = cdp.send('Target.getTargets')['targetInfos']
    sw = next(t for t in targets if t['type']=='service_worker' and extension_id in t['url'])
    cdp.send('Target.closeTarget', {'targetId':sw['targetId']})
    time.sleep(1)
    site.bring_to_front()
    again = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert again['isOk'], again
    print('worker_restart_message_handler_passed')
    # Fixtures use an isolated profile and intercept the document: no real accounts.
    options.evaluate('''async () => {
      const key = 'settings-storage-key';
      const saved = (await chrome.storage.sync.get(key))[key];
      await chrome.storage.sync.set({ [key]: { ...saved, protobufEncoding: true, encryptionEnabled: true, encryptionPassword: 'dummy-test-passphrase' } });
    }''')
    for domain in ['xiaohongshu.com', 'douyin.com', '115.com']:
        url = f'https://www.{domain}/'
        fixture = context.new_page()
        fixture.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<html><script>localStorage.setItem("fixture", "dummy")</script><body>Isolated fixture</body></html>'))
        fixture.goto(url); fixture.bring_to_front()
        context.add_cookies([
          {'name': 'session_fixture', 'value': 'dummy_session', 'domain': f'www.{domain}', 'path': '/', 'secure': True, 'httpOnly': True, 'sameSite': 'Lax'},
          {'name': 'subdomain_fixture', 'value': 'dummy_subdomain', 'domain': f'passport.{domain}', 'path': '/login', 'secure': True, 'httpOnly': True, 'sameSite': 'Lax'}
        ])
        result = options.evaluate('(message) => chrome.runtime.sendMessage(message)', {'type': 'PushCookie', 'payload': {'host': domain, 'sourceUrl': url}})
        assert result['isOk'], result
        assert b'dummy_session' not in files['/dav/cookies.txt'][0]
        context.clear_cookies()
        result = options.evaluate('(message) => chrome.runtime.sendMessage(message)', {'type': 'PullCookie', 'payload': {'domain': domain, 'activeTabUrl': url, 'reload': False}})
        assert result['isOk'], result
        restored = context.cookies()
        session = next(c for c in restored if c['name']=='session_fixture')
        assert session['expires'] == -1, session
        assert any(c['name']=='subdomain_fixture' for c in restored)
        print('encrypted_family_fixture_passed', domain)
        fixture.close()

    # A queued snapshot survives tab closure and does not upload immediately.
    options.evaluate('''async () => {
      const key='settings-storage-key'; const saved=(await chrome.storage.sync.get(key))[key];
      await chrome.storage.sync.set({[key]:{...saved, backgroundSync:true, startupPull:true, syncIntervalMinutes:2}});
      const cfgKey='domainConfig-storage-key'; const cfg=(await chrome.storage.local.get(cfgKey))[cfgKey];
      cfg.domainMap['115.com']={...cfg.domainMap['115.com'], autoPush:true, autoPull:false};
      await chrome.storage.local.set({[cfgKey]:cfg});
    }''')
    automatic_page = context.new_page()
    automatic_page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<html><body>Automatic sync fixture</body></html>'))
    automatic_page.goto('https://www.115.com/')
    automatic_page.wait_for_timeout(500)
    before_queue_version = version
    context.add_cookies([{'name':'session_fixture','value':'new_automatic_value','domain':'www.115.com','path':'/','secure':True,'httpOnly':True,'sameSite':'Lax'}])
    automatic_page.evaluate('localStorage.setItem("queued_token", "newest_offline_token"); window.dispatchEvent(new Event("pagehide"));')
    def queued():
        return options.evaluate('''async () => {
          const data=await chrome.storage.local.get(null);
          return Object.entries(data).filter(([k,v])=>k.startsWith('cookiesync-pending-') && typeof v==='object').flatMap(([k,v])=>Object.values(v)).find(j=>j.domain==='115.com');
        }''')
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        job=queued()
        if job and any(c.get('value')=='new_automatic_value' for c in job['cookies']) and any(i.get('value')=='newest_offline_token' for i in job['localStorageItems']): break
        time.sleep(.2)
    else: raise AssertionError('latest automatic snapshot not durably queued')
    automatic_page.close()
    time.sleep(1)
    assert version == before_queue_version, 'automatic writes must not be immediate'
    print('durable_queue_and_low_frequency_passed')
    popup = context.new_page(); popup.on('pageerror', lambda error: errors.append(str(error)))
    # An extension page opened in a normal tab would identify itself as the active tab.
    # Supply a synthetic active website for the popup view while keeping real extension storage.
    popup.add_init_script("""if (location.protocol === 'chrome-extension:' && chrome.tabs) {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (filter, callback) => {
        if (!filter.active) return callback ? query(filter, callback) : query(filter);
        const tabs = [{id: 99, windowId: 1, url: 'https://popup-fixture.example/'}];
        if (callback) callback(tabs);
        else return Promise.resolve(tabs);
      };
    }""")
    popup.goto(f'chrome-extension://{extension_id}/popup/index.html')
    popup.get_by_role('button', name='打开同步管理', exact=True).wait_for()
    popup.get_by_role('heading', name='popup-fixture.example', exact=True).wait_for()
    popup.get_by_role('button', name='加入名单', exact=True).click()
    popup.get_by_role('switch', name='自动推送', exact=True).wait_for()
    popup.set_viewport_size({'width':240,'height':640})
    assert popup.evaluate('document.documentElement.scrollWidth <= innerWidth')
    labels=popup.locator('.popup-directions label')
    assert labels.nth(1).bounding_box()['y'] > labels.first.bounding_box()['y']
    popup.set_viewport_size({'width':390,'height':640})
    popup.get_by_text('设置此电脑的同步方向', exact=True).click()
    popup.get_by_role('button', name='仅拉取', exact=True).click()
    wait_extension(popup, """async () => {
      const data = await chrome.storage.local.get('domainConfig-storage-key');
      const item = data['domainConfig-storage-key']?.domainMap?.['popup-fixture.example'];
      return item?.autoPush === false && item?.autoPull === true;
    }""")
    popup.locator('.sync-popup').screenshot(path=str(ROOT / 'popup.png'))
    panel = context.new_page(); panel.on('pageerror', lambda error: errors.append(str(error)))
    panel.goto(f'chrome-extension://{extension_id}/sidepanel/index.html')
    panel.get_by_role('heading', name='同步管理', exact=True).wait_for()
    assert popup.get_by_role('button', name='打开设置', exact=True).is_visible()
    assert popup.locator('.signal-card').is_visible()
    search = panel.get_by_role('textbox', name='搜索网站域名')
    search.fill('no-matching-domain.example')
    panel.get_by_text('没有匹配的网站', exact=True).wait_for()
    panel.get_by_role('button', name='清除搜索', exact=True).click()
    assert search.input_value() == ''
    panel.get_by_role('button', name='115.com', exact=True).click()
    panel.get_by_role('textbox', name='搜索 Cookie', exact=True).wait_for()
    panel.get_by_role('button', name='返回', exact=True).click()
    search.wait_for()
    panel.screenshot(path=str(ROOT / 'manager.png'))
    assert not errors, errors
    print('UI_errors', errors)
    context.close()
    # A real browser restart must replay the persistent pending queue.
    context = p.chromium.launch_persistent_context(profile_path, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
    deadline=time.monotonic()+20
    while time.monotonic()<deadline and version == before_queue_version: time.sleep(.2)
    assert version > before_queue_version, 'startup did not upload persistent pending snapshot'
    print('browser_restart_pending_replay_passed')
    context.close()
    # A separate receiver profile has no source cookies, then restores on actual startup.
    receiver_path = tempfile.mkdtemp(prefix='receiver-profile-', dir=ROOT)
    receiver = p.chromium.launch_persistent_context(receiver_path, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    rw = receiver.service_workers[0] if receiver.service_workers else receiver.wait_for_event('serviceworker')
    rid = rw.url.split('/')[2]
    mock_115_health(receiver)
    ro = receiver.new_page(); ro.goto(f'chrome-extension://{rid}/options/index.html')
    ro.locator('#webdav-url').fill(base+'/dav/'); ro.locator('#webdav-username').fill('local-test')
    ro.locator('#webdav-password').fill('dummy-app-password'); ro.locator('#webdav-path').fill('cookies.txt')
    ro.get_by_role('button',name='保存并使用 WebDAV',exact=True).click()
    ro.get_by_text('WebDAV 配置已保存',exact=True).wait_for()
    ro.evaluate('''async () => { const key='settings-storage-key'; const saved=(await chrome.storage.sync.get(key))[key]; await chrome.storage.sync.set({[key]:{...saved, startupPull:true, backgroundSync:false, protobufEncoding:true, encryptionEnabled:true, encryptionPassword:'dummy-test-passphrase'}}); }''')
    assert not receiver.cookies('https://www.115.com/')
    receiver.close()
    receiver = p.chromium.launch_persistent_context(receiver_path, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        restored=receiver.cookies()
        if any(c['name']=='session_fixture' and c['value']=='new_automatic_value' for c in restored): break
        time.sleep(.2)
    else: raise AssertionError('receiver did not restore cookies at startup')
    for domain in ['xiaohongshu.com','douyin.com','115.com']:
        assert any(c['name']=='session_fixture' and c['domain']==f'www.{domain}' for c in restored), domain
    print('separate_profile_startup_restore_passed')
    receiver.close()
    # First connection with an empty destination must seed without a manual push or second alarm.
    seed_path = tempfile.mkdtemp(prefix='first-seed-profile-', dir=ROOT)
    seed = p.chromium.launch_persistent_context(seed_path, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = seed.service_workers[0] if seed.service_workers else seed.wait_for_event('serviceworker')
    sid = sw.url.split('/')[2]
    mock_115_health(seed)
    seed.add_cookies([{'name':'auto_seed_session','value':'synthetic-seed','domain':'www.115.com','path':'/','secure':True,'httpOnly':True,'sameSite':'Lax'}])
    so = seed.new_page(); so.goto(f'chrome-extension://{sid}/options/index.html')
    so.locator('#webdav-url').fill(base+'/dav/'); so.locator('#webdav-username').fill('local-test')
    so.locator('#webdav-password').fill('dummy-app-password'); so.locator('#webdav-path').fill('automatic-first-seed.txt')
    so.get_by_role('button',name='保存并使用 WebDAV',exact=True).click()
    deadline=time.monotonic()+20
    while time.monotonic()<deadline and '/dav/automatic-first-seed.txt' not in files: time.sleep(.1)
    assert '/dav/automatic-first-seed.txt' in files, 'first connect never uploaded existing site cookie'
    seeded=json.loads(files['/dav/automatic-first-seed.txt'][0])
    assert any(c['value']=='synthetic-seed' for c in seeded['domainCookieMap']['115.com']['cookies'])
    wait_extension(so, 'async () => { const s=(await chrome.storage.local.get("cookiesync-auto-status"))["cookiesync-auto-status"]; return s?.phase === "idle" && s?.lastSuccess && s?.pendingCount === 0; }')
    seed_version=version
    seed_check=so.evaluate('async () => (await chrome.storage.local.get("cookiesync-auto-status"))["cookiesync-auto-status"].lastCheck')
    so.get_by_role('link',name='自动同步',exact=True).click()
    assert not so.locator('#webdav-url').is_visible()
    so.get_by_role('button',name='立即检查并同步',exact=True).click()
    wait_extension(so, f'async () => {{ const s=(await chrome.storage.local.get("cookiesync-auto-status"))["cookiesync-auto-status"]; return s?.lastCheck > {seed_check} && s?.phase === "idle"; }}')
    assert version == seed_version, 'manual check uploaded unchanged content'
    assert so.get_by_text('最近上传成功',exact=True).is_visible()
    print('first_connection_automatic_seed_and_status_hash_skip_passed')
    # Arbitrary visited sites are discovered; no manual PushCookie message is sent.
    so.evaluate('''async () => { const all=await chrome.storage.local.get(null); await chrome.storage.local.set(Object.fromEntries(Object.keys(all).filter(k=>k.endsWith('-last-attempt')).map(k=>[k,0]))); }''')
    seed.add_cookies([
      {'name':'nodeseek_sid','value':'synthetic-nodeseek','domain':'.nodeseek.com','path':'/','secure':True,'httpOnly':True},
      {'name':'not_visited','value':'excluded-fixture','domain':'.unvisited.example','path':'/','secure':True},
    ])
    ns=seed.new_page()
    ns.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<html><script>localStorage.setItem("fixture-token","nodeseek-state")</script><body>NodeSeek fixture</body></html>'))
    ns.goto('https://www.nodeseek.com/')
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        saved=json.loads(files['/dav/automatic-first-seed.txt'][0])['domainCookieMap']
        if 'nodeseek.com' in saved:break
        time.sleep(.1)
    else:raise AssertionError('visiting NodeSeek did not auto-register/upload without a manual push')
    assert any(c['value']=='synthetic-nodeseek' for c in saved['nodeseek.com']['cookies'])
    assert any(i['value']=='nodeseek-state' for i in saved['nodeseek.com']['localStorageItems'])
    assert not so.evaluate('async () => (await chrome.storage.local.get("domainConfig-storage-key"))["domainConfig-storage-key"].domainMap["unvisited.example"] || null')
    empty=seed.new_page()
    empty.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<html>Empty fixture</html>'))
    empty.goto('https://empty.example/')
    time.sleep(.7)
    assert not so.evaluate('async () => (await chrome.storage.local.get("domainConfig-storage-key"))["domainConfig-storage-key"].domainMap["empty.example"] || null')
    print('visited_nodeseek_auto_discovery_and_unvisited_cookie_exclusion_passed')
    # Login data can appear after PageReady; discovery keeps checking unknown pages.
    so.evaluate('''async () => { const all=await chrome.storage.local.get(null); await chrome.storage.local.set(Object.fromEntries(Object.keys(all).filter(k=>k.endsWith('-last-attempt')).map(k=>[k,0]))); }''')
    # Custom allowlist entries are saved through the real options UI before visiting them.
    so.get_by_role('link',name='网站名单',exact=True).click()
    so.get_by_label('自定义自动同步域名',exact=True).fill('late-login.example')
    so.get_by_role('button',name='添加网站',exact=True).click()
    wait_extension(so, 'async () => !!(await chrome.storage.sync.get("cookiesync-site-rule-v1:late-login.example"))["cookiesync-site-rule-v1:late-login.example"]?.enabled')
    so.get_by_label('自定义自动同步域名',exact=True).fill('storage-only.example')
    so.get_by_role('button',name='添加网站',exact=True).click()
    wait_extension(so, 'async () => !!(await chrome.storage.sync.get("cookiesync-site-rule-v1:storage-only.example"))["cookiesync-site-rule-v1:storage-only.example"]?.enabled')
    late=seed.new_page()
    late.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<html>Late login fixture</html>'))
    late.goto('https://late-login.example/')
    only=seed.new_page()
    only.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<html><script>localStorage.setItem("fixture-token","storage-only-login")</script></html>'))
    only.goto('https://storage-only.example/')
    seed.add_cookies([{'name':'late_sid','value':'late-login-fixture','domain':'late-login.example','path':'/','secure':True,'httpOnly':True}])
    deadline=time.monotonic()+50
    while time.monotonic()<deadline:
        saved=json.loads(files['/dav/automatic-first-seed.txt'][0])['domainCookieMap']
        if 'late-login.example' in saved and 'storage-only.example' in saved:break
        # Test scheduler eligibility without waiting a full two-minute upload interval.
        so.evaluate('''async () => { const all=await chrome.storage.local.get(null); await chrome.storage.local.set(Object.fromEntries(Object.keys(all).filter(k=>k.endsWith('-last-attempt')).map(k=>[k,0]))); }''')
        time.sleep(.4)
    else:raise AssertionError('late Cookie or LocalStorage-only login was not auto-discovered')
    assert any(c['value']=='late-login-fixture' for c in saved['late-login.example']['cookies'])
    assert any(i['value']=='storage-only-login' for i in saved['storage-only.example']['localStorageItems'])
    print('late_cookie_and_localstorage_only_auto_discovery_passed')
    # Removing permission stops already registered sites and legacy queued jobs, retaining their data.
    unknown=seed.new_page()
    unknown.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<html><script>localStorage.setItem("token","unlisted")</script></html>'))
    seed.add_cookies([{'name':'legacy_sid','value':'legacy-preserved','domain':'legacy-unlisted.example','path':'/','secure':True}])
    unknown.goto('https://legacy-unlisted.example/')
    time.sleep(1)
    assert not so.evaluate('async () => (await chrome.storage.local.get("domainConfig-storage-key"))["domainConfig-storage-key"].domainMap["legacy-unlisted.example"] || null')
    # Disable NodeSeek through its real built-in list checkbox, then change its local Cookie.
    so.get_by_role('navigation', name='设置导航').get_by_role('link', name='网站名单', exact=True).click()
    assert so.url.endswith('#sites')
    so.get_by_text('查看和编辑内置 300 个网站',exact=True).click()
    so.get_by_label('搜索内置网站',exact=True).fill('nodeseek.com')
    so.get_by_label('内置网站列表',exact=True).get_by_role('checkbox').uncheck()
    wait_extension(so, 'async () => (await chrome.storage.sync.get("cookiesync-site-rule-v1:nodeseek.com"))["cookiesync-site-rule-v1:nodeseek.com"]?.enabled === false')
    seed.add_cookies([{'name':'nodeseek_sid','value':'changed-but-paused','domain':'.nodeseek.com','path':'/','secure':True,'httpOnly':True}])
    last_check=so.evaluate('async () => (await chrome.storage.local.get("cookiesync-auto-status"))["cookiesync-auto-status"].lastCheck')
    so.get_by_role('link',name='自动同步',exact=True).click()
    assert not so.locator('#webdav-url').is_visible()
    so.get_by_role('button',name='立即检查并同步',exact=True).click()
    wait_extension(so, f'async () => {{const s=(await chrome.storage.local.get("cookiesync-auto-status"))["cookiesync-auto-status"];return s?.lastCheck > {last_check} && s?.phase === "idle";}}')
    saved=json.loads(files['/dav/automatic-first-seed.txt'][0])['domainCookieMap']
    assert any(c['value']=='synthetic-nodeseek' for c in saved['nodeseek.com']['cookies'])
    assert any(c['value']=='changed-but-paused' for c in seed.cookies('https://www.nodeseek.com/'))
    assert not 'legacy-unlisted.example' in saved
    print('allowlist_ui_custom_add_pause_and_unlisted_retention_passed')
    # 115 profile: honest login health plus a hidden QR repair entry.
    # Re-registering on the same context wins over the early "ok" handler.
    seed.route('**my.115.com/**', lambda route: route.fulfill(
        status=200, content_type='application/json',
        body=json.dumps({'state': True, 'data': {'user_name': 'fixture-user'}})))
    quintet = [{'name': name, 'value': f'fixture-{name.lower()}', 'domain': '.115.com', 'path': '/',
                'secure': True, 'httpOnly': True, 'sameSite': 'Lax'}
               for name in ('UID', 'CID', 'SEID', 'KID', 'USERSESSIONID')]
    seed.add_cookies(quintet)
    so.get_by_text('115.com 登录状态', exact=False).wait_for()
    so.get_by_role('button', name='立即验证', exact=True).click()
    so.get_by_text('登录有效', exact=False).wait_for()
    so.get_by_text('fixture-user', exact=False).wait_for()
    print('115_health_check_ok_passed')
    seed.route('**my.115.com/**', lambda route: route.fulfill(
        status=200, content_type='application/json',
        body=json.dumps({'state': False, 'error': '登录超时，请重新登录。'})))
    so.get_by_role('button', name='立即验证', exact=True).click()
    so.get_by_text('登录已失效', exact=False).wait_for()
    so.get_by_role('button', name='扫码重新登录', exact=True).wait_for()
    print('115_health_check_invalid_passed')
    # QR repair: mocked token → status(2) → login sets cookies through the
    # body fallback because a fulfilled response carries no Set-Cookie.
    seed.route('**/api/1.0/web/1.0/token', lambda route: route.fulfill(
        status=200, content_type='application/json',
        body=json.dumps({'state': 1, 'data': {'uid': 'tok-fixture', 'time': 1, 'sign': 'sig', 'qrcode': '115.com/scan/dg-fixture'}})))
    seed.route('**/get/status/**', lambda route: route.fulfill(
        status=200, content_type='application/json',
        body=json.dumps({'state': 1, 'data': {'status': 2}})))
    seed.route('**passportapi.115.com/**', lambda route: route.fulfill(
        status=200, content_type='application/json',
        body=json.dumps({'state': 1, 'data': {'cookie': {'cookie': 'UID=99; CID=99; SEID=99; KID=99'}}})))
    so.get_by_role('button', name='扫码重新登录', exact=True).click()
    so.get_by_text('扫码成功，会话已更新并推送', exact=False).wait_for()
    assert any(c['name'] == 'UID' and c['value'] == '99' for c in seed.cookies('https://115.com/'))
    so.get_by_role('button', name='关闭', exact=True).click()
    print('115_qr_repair_fallback_cookies_passed')
    # Overview: rows come from local records only; per-site actions are confirmed by a second click.
    overview = so.evaluate('(message) => chrome.runtime.sendMessage(message)', {'type': 'CookieSyncOverview'})
    assert overview['isOk'], overview
    overview_rows = {row['domain']: row for row in overview['result']['rows']}
    assert '115.com' in overview_rows and overview_rows['115.com']['listed'] is True, overview_rows.keys()
    assert overview_rows['115.com']['health']['state'] == 'invalid'
    assert 'health' in overview_rows['115.com']['attention']
    so.get_by_role('navigation', name='设置导航').get_by_role('link', name='总览', exact=True).click()
    so.locator('.overview-table').wait_for()
    so.get_by_text('已登记站点', exact=True).wait_for()
    so.locator('.overview-domain').filter(has_text='115.com').first.wait_for()
    so.get_by_role('button', name='拉取 115.com', exact=True).click()
    so.get_by_role('button', name='拉取 115.com', exact=True).click()
    so.get_by_text('已从云端应用 115.com', exact=False).wait_for()
    print('overview_panel_rows_and_site_actions_passed')
    pull_all = so.evaluate('(message) => chrome.runtime.sendMessage(message)', {'type': 'CookieSyncPullAll'})
    assert pull_all['isOk'], pull_all
    print('pull_all_message_wired', json.dumps(pull_all.get('result', {}), ensure_ascii=False))
    push_all = so.evaluate('(message) => chrome.runtime.sendMessage(message)', {'type': 'CookieSyncPushAll'})
    assert push_all['isOk'], push_all
    print('push_all_message_wired', json.dumps(push_all.get('result', {}), ensure_ascii=False))
    # Rollback points, redacted diagnostics and remote backups.
    so.get_by_role('link', name='自动同步', exact=True).click()
    so.locator('.safety-card').wait_for()
    assert so.locator('.safety-snapshots li').count() >= 1, 'batch operations must leave a rollback point'
    so.get_by_role('button', name='读取备份信息', exact=True).click()
    so.locator('.safety-slot').first.wait_for()
    assert so.locator('.safety-slot').count() == 3
    with so.expect_download() as download_info:
        so.get_by_role('button', name='导出脱敏诊断', exact=True).click()
    download = download_info.value
    assert download.suggested_filename.endswith('.json')
    diagnostics = json.loads(Path(download.path()).read_text(encoding='utf-8'))
    assert diagnostics['format'] == 'cookiesync-diagnostics-v1'
    diagnostics_text = json.dumps(diagnostics, ensure_ascii=False)
    assert 'dummy_login' not in diagnostics_text, 'cookie values must never be exported'
    assert 'dummy-app-password' not in diagnostics_text, 'WebDAV credentials must never be exported'
    snapshots = so.evaluate('async () => (await chrome.storage.local.get("cookiesync-snapshots-v1"))["cookiesync-snapshots-v1"]')
    rollback = so.evaluate('(message) => chrome.runtime.sendMessage(message)',
                           {'type': 'CookieSyncRollback', 'id': snapshots[0]['id']})
    assert rollback['isOk'], rollback
    print('rollback_diagnostics_and_remote_backup_passed')
    seed.close()
server.shutdown()
