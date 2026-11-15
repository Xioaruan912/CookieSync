"""Capture real first-use UI for store review, with an isolated synthetic profile."""
import argparse
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--extension', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
extension = Path(args.extension).resolve()
output = Path(args.output).resolve()
source = Path(__file__).resolve().parents[1]
if output == source or source in output.parents:
    raise ValueError('Write screenshots outside the source repository')
assert (extension / 'manifest.json').is_file()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='cookiesync-store-screenshots-') as profile:
    assert Path(profile).resolve().parent == Path(tempfile.gettempdir()).resolve()
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True,
            viewport={'width':1280,'height':800},
            args=[f'--disable-extensions-except={extension}',f'--load-extension={extension}'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            identity = worker.url.split('/')[2]
            page = context.new_page()
            page.goto(f'chrome-extension://{identity}/options/index.html')
            page.get_by_role('button',name='Google Drive',exact=True).click()
            page.get_by_role('button',name='使用 Google 登录',exact=True).wait_for()
            page.screenshot(path=str(output/'01-google-drive.png'))
            page.get_by_role('button',name='WebDAV',exact=True).click()
            page.locator('#webdav-url').fill('https://dav.example.test/CookieSync/')
            page.locator('#webdav-username').fill('demo-user')
            page.locator('#webdav-path').fill('cookies.txt')
            page.screenshot(path=str(output/'02-webdav.png'))
            print('Captured 2 real 1280x800 first-use screenshots; no real credentials or fabricated sync results')
        finally:
            context.close()
