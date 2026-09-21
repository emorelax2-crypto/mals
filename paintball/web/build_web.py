#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает самодостаточную страницу web/index.html: подставляет в шаблон
сам проект (.sb3) и кадр-заставку в виде base64."""
import base64, io, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")

tpl = io.open(os.path.join(HERE, "page.template.html"), encoding="utf-8").read()
page = (tpl
        .replace("{{SB3_B64}}", b64(os.path.join(ROOT, "paintball.sb3")))
        .replace("{{POSTER_B64}}", b64(os.path.join(ROOT, "screenshots", "gameplay.png"))))
out = os.path.join(HERE, "index.html")
io.open(out, "w", encoding="utf-8").write(page)
print("готово: %s (%d КБ)" % (out, os.path.getsize(out) // 1024))
