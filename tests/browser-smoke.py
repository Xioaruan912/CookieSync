"""Optional browser smoke test. Uses synthetic accounts, local WebDAV and isolated Chrome profiles.
Install tests/requirements-browser.txt, run playwright install chromium, build dist/, then run this file.
Test screenshots and profiles are written to an OS temporary directory, never the repository.
"""
import os, json, threading, base64, time, tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

ROOT = Path(tempfile.mkdtemp(prefix='cookiesync-smoke-'))
EXT = Path(__file__).resolve().parents[1] / 'dist'
files = {}
version = 0
requests = []
reject_conditions = False
reject_reads = False

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
    options = context.new_page(); options.on('pageerror', lambda error: errors.append(str(error)))
    options.goto(f'chrome-extension://{extension_id}/options/index.html')
    options.get_by_role('button', name='WebDAV', exact=True).click()
    options.locator('#webdav-url').fill(base + '/dav/')
    options.locator('#webdav-username').fill('local-test')
    options.locator('#webdav-password').fill('dummy-app-password')
    options.locator('#webdav-path').fill('cookies.txt')
    options.get_by_role('button', name='测试连接', exact=True).click()
    options.get_by_text('连接测试成功：已验证临时文件的创建、覆盖、读取和删除', exact=True).wait_for()
    assert not files, 'probe must be removed'
    options.get_by_role('button', name='保存并使用 WebDAV', exact=True).click()
    options.get_by_text('当前后端：WebDAV', exact=True).wait_for()
    assert options.evaluate('async () => (await chrome.storage.local.get("webdav-local-settings"))["webdav-local-settings"].password') == 'dummy-app-password'
    assert not options.evaluate('async () => (await chrome.storage.sync.get("webdav-local-settings"))["webdav-local-settings"] || null')
    options.evaluate('''async () => { const key='settings-storage-key'; const saved=(await chrome.storage.sync.get(key))[key]; await chrome.storage.sync.set({[key]:{...saved, backgroundSync:false, startupPull:false}}); }''')
    options.screenshot(path=str(ROOT / 'settings.png'), full_page=True)
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
    before_repeat = version
    repeated = options.evaluate('(message) => chrome.runtime.sendMessage(message)', payload)
    assert repeated['isOk'] and version == before_repeat, 'unchanged push must skip remote PUT'
    print('semantic_digest_skips_unchanged_push_passed')
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
    options.get_by_text('WebDAV 配置已保存，已切换同步后端', exact=True).wait_for()
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
    popup.goto(f'chrome-extension://{extension_id}/popup/index.html')
    popup.get_by_role('button', name='打开同步管理', exact=True).wait_for()
    popup.screenshot(path=str(ROOT / 'popup.png'))
    panel = context.new_page(); panel.on('pageerror', lambda error: errors.append(str(error)))
    panel.goto(f'chrome-extension://{extension_id}/sidepanel/index.html')
    panel.get_by_role('heading', name='同步管理', exact=True).wait_for()
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
    ro = receiver.new_page(); ro.goto(f'chrome-extension://{rid}/options/index.html')
    ro.get_by_role('button',name='WebDAV',exact=True).click()
    ro.locator('#webdav-url').fill(base+'/dav/'); ro.locator('#webdav-username').fill('local-test')
    ro.locator('#webdav-password').fill('dummy-app-password'); ro.locator('#webdav-path').fill('cookies.txt')
    ro.get_by_role('button',name='保存并使用 WebDAV',exact=True).click()
    ro.get_by_text('当前后端：WebDAV',exact=True).wait_for()
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
server.shutdown()
