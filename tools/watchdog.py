# -*- coding: utf-8 -*-
"""Re-inject yuketang-helper into course pages after each full reload.
Leaves in ai-workspace/lms-graph reload the page, wiping any manually injected
script. This loop acts like Tampermonkey: detect a matching tab without the panel
iframe, re-inject, and let pendingAutoStart resume the runner."""
import asyncio, io, json, os, sys, time, urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
INJECT = io.open(os.path.join(HERE, 'inject.js'), encoding='utf-8').read()
LOGPATH = os.path.join(HERE, 'watchdog.log')
# cover every course page + the course list (multi-tab brushing)
PATTERNS = ('yuketang.cn/ai-workspace/lms-graph/', 'yuketang.cn/pro/lms/', 'yuketang.cn/pro/courselist')
IDLE_EXIT_SEC = 30 * 60  # exit if no matching tab for 30min (course finished)

CHECK_JS = "({ifr:!!document.querySelector('#ykt-hud-frame'),loaded:!!window.__yktCore,rs:document.readyState,u:location.href.slice(-60)})"
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


async def ev(ws_url, expr):
    async with __import__('websockets').connect(ws_url, max_size=30 * 1024 * 1024) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {
            'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get('id') == 1:
                r = m.get('result', {})
                if 'exceptionDetails' in r:
                    return {'__err': str(r['exceptionDetails'])[:300]}
                return r.get('result', {}).get('value')


async def main():
    seen = {}
    idle_since = time.time()
    log('watchdog start, patterns=%s' % (PATTERNS,))
    while True:
        try:
            tabs = json.loads(urllib.request.urlopen('http://localhost:9222/json/list', timeout=5).read())
        except Exception as e:
            log('list fail %s' % e)
            await asyncio.sleep(5)
            continue
        matched = [t for t in tabs if t.get('type') == 'page' and any(p in t.get('url', '') for p in PATTERNS)]
        if not matched:
            if time.time() - idle_since > IDLE_EXIT_SEC:
                log('no matching tab for 30min, exit')
                return
            await asyncio.sleep(4)
            continue
        idle_since = time.time()
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
            if st.get('ifr'):
                # runner alive; log leaf changes only
                if seen.get(key) != 'alive':
                    lg = await ev(wsu, LOG_JS)
                    tail = (lg or {}).get('log', '') if isinstance(lg, dict) else str(lg)
                    log('alive %s | %s' % (url[-55:], str(tail).replace('\n', ' / ')[-160:]))
                    seen[key] = 'alive'
                continue
            if st.get('loaded'):
                # script running but panel iframe was destroyed by SPA re-render: leave it
                if seen.get(key) != 'headless':
                    lg = await ev(wsu, LOG_JS)
                    tail = (lg or {}).get('log', '') if isinstance(lg, dict) else str(lg)
                    log('headless %s | %s' % (url[-55:], str(tail).replace('\n', ' / ')[-160:]))
                    seen[key] = 'headless'
                continue
            if st.get('rs') == 'loading':
                continue
            # page loaded, no script: inject
            log('inject -> %s' % url[-60:])
            try:
                r = await ev(wsu, INJECT)
            except Exception as e:
                log('inject fail %s' % e)
                continue
            await asyncio.sleep(4)
            # pendingAutoStart should auto-start; if not, click the button
            try:
                lg = await ev(wsu, LOG_JS)
                tail = (lg or {}).get('log', '') if isinstance(lg, dict) else ''
                if not any(k in tail for k in ('启动中', '正在匹配', '开始播放', '运行异常')):
                    c = await ev(wsu, CLICK_JS)
                    log('fallback click: %s' % c)
                    await asyncio.sleep(2)
                    lg = await ev(wsu, LOG_JS)
                    tail = (lg or {}).get('log', '') if isinstance(lg, dict) else ''
                log('post-inject log: %s' % str(tail).replace('\n', ' / ')[-200:])
            except Exception as e:
                log('post check fail %s' % e)
            seen[key] = 'injected'
        await asyncio.sleep(4)


asyncio.run(main())
