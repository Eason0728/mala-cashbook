# -*- coding: utf-8 -*-
"""把整頁截圖裁成聚焦片段，轉成 base64 供圖解網頁內嵌。"""
from PIL import Image
import base64, io, json, os

SRC = os.path.expanduser('~/mala-cashbook/e2e/guide')

# (輸出名, 來源檔, 上, 下)  —— 原圖 780x1688
CROPS = [
    ('login',    's1-login.png',        140,  1180),
    ('tabs',     's2-entry-empty.png',  140,   560),
    ('name',     's3-entry-filled.png', 790,  1270),
    ('amount',   's3-entry-filled.png',1270,  1688),
    ('done',     's4-submitted.png',    440,   900),
    ('list',     's5-list.png',         430,  1250),
    ('open',     's6-list-open.png',    430,  1150),
    ('export',   's7-export.png',       300,  1100),
]

out = {}
for name, src, top, bottom in CROPS:
    im = Image.open(os.path.join(SRC, src)).convert('RGB')
    im = im.crop((0, top, im.width, bottom))
    im.thumbnail((640, 2000), Image.LANCZOS)     # 網頁上不需要 2x
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=82, optimize=True)
    out[name] = base64.b64encode(buf.getvalue()).decode()
    print('%-8s %s  %d×%d  %d KB' % (name, src, im.width, im.height, len(out[name]) // 1024))

json.dump(out, open('/tmp/guide_imgs.json', 'w'))
print('總計 %d KB' % (sum(len(v) for v in out.values()) // 1024))
