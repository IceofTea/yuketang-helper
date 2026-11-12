# -*- coding: utf-8 -*-
"""把 userscript 打包成可通过 CDP 注入的 inject.js（stub 油猴 API + 注入守卫）。"""
import io, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'yuketang-helper.user.js')
OUT = os.path.join(HERE, 'inject.js')

src = io.open(SRC, encoding='utf-8').read()
stub = "var unsafeWindow = window;\nvar GM_xmlhttpRequest = function(){};\nvar GM_info = {script:{version:'test'}};\n"
guard = "if (window.__yktCore) { 'already-injected'; } else { window.__yktCore = true;\n"
io.open(OUT, 'w', encoding='utf-8', newline='\n').write(stub + guard + src + "\n}")
print('OK ->', OUT)
