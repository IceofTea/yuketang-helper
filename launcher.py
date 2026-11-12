# -*- coding: utf-8 -*-
"""yuketang-helper all-in-one launcher.

Double-click (or run the packaged exe):
  1. ensures a browser is up with --remote-debugging-port=9222
  2. opens the course-list page in it
  3. waits for a yuketang page to appear (user logs in)
  4. runs the watchdog loop: re-injects the HUD into every course tab

Works standalone (no install needed when frozen with PyInstaller).
"""
import asyncio, io, json, os, subprocess, sys, time, urllib.request

import websockets  # noqa: F401  (kept top-level so PyInstaller bundles it)

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

CDP = 'http://localhost:9222'
COURSELIST = 'https://yjsy-fjnu.yuketang.cn/pro/courselist'
PATTERNS = ('yuketang.cn/ai-workspace/lms-graph/', 'yuketang.cn/pro/lms/', 'yuketang.cn/pro/courselist')
LOGPATH = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'ykt-launcher.log')

CHECK_JS = "({ifr:!!document.querySelector('#ykt-hud-frame'),loaded:!!window.__yktCore,rs:document.readyState,u:location.href.slice(-60),login:(/passport|login|signin/i.test(location.hostname+location.pathname)||/登录|登陆/.test(document.title||'')||(!document.querySelector('.lesson-cardS, .leaf-detail, video, audio, .catalog-box')&&!!document.querySelector('img[src*=qr], [class*=qrcode], [class*=login-box], [class*=login-dialog], [class*=login-wrap], .xt-login')))})"
LOG_JS = """(function(){
if(window.__yktLog&&window.__yktLog.length)return{log:window.__yktLog.slice(-8).join(' | ')};
var f=document.querySelector('#ykt-hud-frame');
if(!f||!f.contentDocument)return{log:'NOIFRAME'};
var d=f.contentDocument;var info=d.querySelector('#hud-feed');
return{log:info?info.innerText.slice(-300):'no-log'}})()"""
CLICK_JS = """(function(){
if(sessionStorage.getItem('ykt_paused'))return 'paused-skip';
var f=document.querySelector('#ykt-hud-frame');
if(!f||!f.contentDocument)return 'NOIFRAME';
var b=f.contentDocument.querySelector('#btn-run');
if(b){b.click();return 'clicked'}return 'nobtn'})()"""


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with io.open(LOGPATH, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def load_inject():
    """Prefer a tools/inject.js next to the exe/script so users can swap in newer
    builds; fall back to the copy bundled inside the exe."""
    here = os.path.dirname(os.path.abspath(sys.argv[0]))
    for p in (os.path.join(here, 'tools', 'inject.js'),
              os.path.join(getattr(sys, '_MEIPASS', here), 'tools', 'inject.js'),
              os.path.join(here, 'inject.js')):
        if os.path.exists(p):
            src = io.open(p, encoding='utf-8').read()
            log('inject.js loaded from %s' % p)
            return src
    return None


def port_up():
    try:
        urllib.request.urlopen(CDP + '/json/version', timeout=3).read()
        return True
    except Exception:
        return False


def find_browser():
    cands = [
        os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe'),
        os.path.expandvars(r'%ProgramFiles%\Microsoft\Edge\Application\msedge.exe'),
        os.path.expandvars(r'%ProgramFiles%\Google\Chrome\Application\chrome.exe'),
        os.path.expandvars(r'%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe'),
        os.path.expandvars(r'%LocalAppData%\Google\Chrome\Application\chrome.exe'),
    ]
    return next((c for c in cands if os.path.exists(c)), None)


async def ev(ws_url, expr):
    async with websockets.connect(ws_url, max_size=30 * 1024 * 1024) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {
            'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get('id') == 1:
                r = m.get('result', {})
                if 'exceptionDetails' in r:
                    return {'__err': str(r['exceptionDetails'])[:300]}
                return r.get('result', {}).get('value')


def tabs():
    try:
        return json.loads(urllib.request.urlopen(CDP + '/json/list', timeout=5).read())
    except Exception:
        return []


def ensure_browser():
    if port_up():
        log('debug port 9222 already up')
        return True
    exe = find_browser()
    if not exe:
        log('ERROR: Edge/Chrome not found - start your browser with --remote-debugging-port=9222')
        return False
    # Dedicated profile dir is REQUIRED:
    #  - Chrome/Edge >=136 ignore --remote-debugging-port on the default profile
    #  - a running instance swallows the flag (new process just hands off the URL)
    # It also keeps the yuketang login session persistent across restarts.
    profile = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'tools', 'browser_profile')
    os.makedirs(profile, exist_ok=True)
    log('starting browser with remote debugging (profile: %s) ...' % profile)
    subprocess.Popen([exe, '--remote-debugging-port=9222',
                      '--user-data-dir=%s' % profile,
                      '--no-first-run', '--no-default-browser-check',
                      COURSELIST])
    for _ in range(25):
        time.sleep(1)
        if port_up():
            log('debug port up')
            return True
    log('ERROR: debug port did not come up - check firewall/antivirus blocking localhost:9222')
    return False


def ensure_courselist_open():
    """If no courselist tab exists, open one via CDP."""
    if any('pro/courselist' in t.get('url', '') for t in tabs() if t.get('type') == 'page'):
        return
    pages = [t for t in tabs() if t.get('type') == 'page']
    if pages:
        try:
            req = urllib.request.Request(CDP + '/json/new?' + urllib.parse.quote(COURSELIST, safe=''), method='PUT')
            urllib.request.urlopen(req, timeout=5)
            log('opened course-list tab')
        except Exception as e:
            log('could not open tab automatically (%s) - please open %s' % (e, COURSELIST))


async def watchdog_loop(inject):
    seen = {}
    log('watchdog running - HUD will auto-inject into yuketang pages')
    log('==> log in to yuketang in the browser, then the picker panel appears')
    while True:
        matched = [t for t in tabs() if t.get('type') == 'page' and any(p in t.get('url', '') for p in PATTERNS)]
        if not matched:
            await asyncio.sleep(4)
            continue
        for t in matched:
            url = t.get('url', '')
            wsu = t.get('webSocketDebuggerUrl')
            if not wsu:
                continue
            try:
                st = await ev(wsu, CHECK_JS)
            except Exception as e:
                log('eval fail %s %s' % (url[-40:], e))
                continue
            if not isinstance(st, dict):
                continue
            key = url
            if st.get('login'):
                # 登录墙：跳过注入，等用户登录后页面出现课程元素再继续
                if seen.get(key) != 'waiting-login':
                    log('waiting for login - %s' % url[-55:])
                    seen[key] = 'waiting-login'
                continue
            if st.get('ifr'):
                if seen.get(key) != 'alive':
                    lg = await ev(wsu, LOG_JS)
                    tail = (lg or {}).get('log', '') if isinstance(lg, dict) else str(lg)
                    log('alive %s | %s' % (url[-55:], str(tail).replace('\n', ' / ')[-160:]))
                    seen[key] = 'alive'
                continue
            if st.get('loaded'):
                if seen.get(key) != 'headless':
                    seen[key] = 'headless'
                continue
            if st.get('rs') == 'loading':
                continue
            log('inject -> %s' % url[-60:])
            try:
                await ev(wsu, inject)
            except Exception as e:
                log('inject fail %s' % e)
                continue
            await asyncio.sleep(4)
            try:
                lg = await ev(wsu, LOG_JS)
                tail = (lg or {}).get('log', '') if isinstance(lg, dict) else ''
                if not any(k in tail for k in ('启动中', '正在匹配', '开始播放', '运行异常')):
                    c = await ev(wsu, CLICK_JS)
                    log('fallback click: %s' % c)
                    await asyncio.sleep(2)
                log('post-inject log: %s' % str(tail).replace('\n', ' / ')[-200:])
            except Exception as e:
                log('post check fail %s' % e)
            seen[key] = 'injected'
        await asyncio.sleep(4)


def main():
    print('=' * 56)
    print('  Yuketang Helper - one-click launcher')
    print('=' * 56)
    inject = load_inject()
    if not inject:
        log('ERROR: inject.js not found (expected tools/inject.js next to this file)')
        input('press Enter to exit')
        return
    if not ensure_browser():
        input('press Enter to exit')
        return
    ensure_courselist_open()
    try:
        asyncio.run(watchdog_loop(inject))
    except KeyboardInterrupt:
        log('stopped by user')


if __name__ == '__main__':
    main()
