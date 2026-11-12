# -*- coding: utf-8 -*-
"""CDP helper: run JS on an Edge tab. Usage: python cdp.py <jsfile_or_expr> [urlpat]"""
import asyncio, json, sys, urllib.request
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

async def main():
    expr = sys.argv[1]
    urlpat = sys.argv[2] if len(sys.argv) > 2 else 'yuketang'
    if expr.endswith('.js'):
        expr = open(expr, encoding='utf-8').read()
    tabs = json.loads(urllib.request.urlopen('http://localhost:9222/json/list', timeout=5).read())
    tab = next((t for t in tabs if t.get('type') == 'page' and urlpat in t.get('url', '')), None)
    if not tab:
        print('NO_TAB', [t.get('url') for t in tabs]); return
    async with __import__('websockets').connect(tab['webSocketDebuggerUrl'], max_size=20*1024*1024) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {
            'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get('id') == 1:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    print('JS_ERROR', json.dumps(r['exceptionDetails'], ensure_ascii=False)[:2000])
                else:
                    v = r.get('result', {}).get('value')
                    print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
                return

asyncio.run(main())
