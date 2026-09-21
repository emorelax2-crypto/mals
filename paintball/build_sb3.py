#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор проекта Scratch 3 «Пейнтбол» (.sb3).

Файл .sb3 — это zip-архив, внутри которого project.json (сцена, спрайты, блоки)
и файлы костюмов, названные по md5 своего содержимого.
Скрипт собирает всё это с нуля: SVG-костюмы рисуются кодом, блоки строятся
маленьким DSL ниже, на выходе — paintball.sb3, готовый к загрузке на scratch.mit.edu.
"""

import hashlib
import json
import os
import zipfile

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_SB3 = os.path.join(OUT_DIR, "paintball.sb3")

# ---------------------------------------------------------------- костюмы ---

def svg(width, height, body):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        'width="{w}" height="{h}" viewBox="0 0 {w} {h}">{b}</svg>'
    ).format(w=width, h=height, b=body)


def ball_svg(fill, stroke):
    return svg(24, 24,
        '<circle cx="12" cy="12" r="10" fill="{f}" stroke="{s}" stroke-width="2"/>'
        '<ellipse cx="8.5" cy="8.8" rx="3.1" ry="2.2" fill="#ffffff" opacity="0.72"/>'
        .format(f=fill, s=stroke))


def splat_svg(fill, size=64):
    return svg(size, size,
        '<path d="M32 5 c7 0 8 9 15 10 c7 1 12 -2 13 5 c1 7 -8 8 -9 14 c-1 6 6 11 0 16 '
        'c-6 5 -10 -4 -17 -3 c-7 1 -10 9 -16 5 c-6 -4 -1 -11 -6 -15 c-5 -4 -12 -3 -11 -10 '
        'c1 -7 10 -5 13 -11 c3 -6 -1 -11 6 -11 z" fill="{f}"/>'
        '<circle cx="55" cy="13" r="3.4" fill="{f}"/>'
        '<circle cx="9" cy="50" r="2.8" fill="{f}"/>'
        '<circle cx="52" cy="52" r="2.4" fill="{f}"/>'
        '<circle cx="14" cy="9" r="2.2" fill="{f}"/>'.format(f=fill))


def bot_svg(body, glow):
    return svg(70, 76,
        # антенна
        '<rect x="33" y="2" width="4" height="12" fill="#2b3048"/>'
        '<circle cx="35" cy="4" r="4.5" fill="{g}"/>'
        # корпус-шлем
        '<rect x="11" y="13" width="48" height="42" rx="15" fill="{b}" stroke="#2b3048" stroke-width="3"/>'
        # маска-визор
        '<path d="M18 31 q17 -13 34 0 q0 13 -17 15 q-17 -2 -17 -15 z" fill="#1b2340"/>'
        '<ellipse cx="27" cy="32" rx="4.5" ry="3.2" fill="{g}" opacity="0.85"/>'
        '<ellipse cx="43" cy="32" rx="4.5" ry="3.2" fill="{g}" opacity="0.85"/>'
        # "рот" / решётка
        '<rect x="28" y="47" width="14" height="4" rx="2" fill="#2b3048"/>'
        # руки
        '<rect x="2" y="28" width="10" height="17" rx="5" fill="#2b3048"/>'
        '<rect x="58" y="28" width="10" height="17" rx="5" fill="#2b3048"/>'
        # ноги-ранец
        '<rect x="20" y="55" width="11" height="15" rx="5" fill="#2b3048"/>'
        '<rect x="39" y="55" width="11" height="15" rx="5" fill="#2b3048"/>'
        .format(b=body, g=glow))


# Турель нарисована симметрично относительно ствола: при повороте в любую
# сторону она не выглядит перевёрнутой (у «all around» это обычная беда).
MARKER_SVG = svg(104, 66,
    # ствол
    '<rect x="46" y="27" width="52" height="12" rx="6" fill="#3a3f55"/>'
    '<rect x="86" y="22" width="13" height="22" rx="5" fill="#6b7290"/>'
    # симметричные баллоны сверху и снизу
    '<rect x="18" y="5" width="28" height="10" rx="5" fill="#00c2d1" stroke="#2b3048" stroke-width="2"/>'
    '<rect x="18" y="51" width="28" height="10" rx="5" fill="#00c2d1" stroke="#2b3048" stroke-width="2"/>'
    # корпус
    '<circle cx="32" cy="33" r="20" fill="#2b3048" stroke="#6b7290" stroke-width="3"/>'
    '<circle cx="32" cy="33" r="13" fill="#3a3f55"/>'
    # бункер с краской
    '<circle cx="32" cy="33" r="8" fill="#ff5ea8"/>'
    '<circle cx="29" cy="30" r="2.4" fill="#ffe14d"/>')


ARENA_SVG = svg(480, 360,
    '<rect width="480" height="360" fill="#16213f"/>'
    '<rect y="40" width="480" height="60" fill="#1c2a50"/>'
    '<rect y="100" width="480" height="60" fill="#22335f"/>'
    '<rect y="160" width="480" height="70" fill="#283c6e"/>'
    # сетка арены
    '<g stroke="#3d5591" stroke-width="1" opacity="0.5">'
    '<line x1="0" y1="20" x2="480" y2="20"/><line x1="0" y1="60" x2="480" y2="60"/>'
    '<line x1="0" y1="100" x2="480" y2="100"/><line x1="0" y1="140" x2="480" y2="140"/>'
    '<line x1="0" y1="180" x2="480" y2="180"/><line x1="0" y1="220" x2="480" y2="220"/>'
    '<line x1="60" y1="0" x2="60" y2="230"/><line x1="120" y1="0" x2="120" y2="230"/>'
    '<line x1="180" y1="0" x2="180" y2="230"/><line x1="240" y1="0" x2="240" y2="230"/>'
    '<line x1="300" y1="0" x2="300" y2="230"/><line x1="360" y1="0" x2="360" y2="230"/>'
    '<line x1="420" y1="0" x2="420" y2="230"/></g>'
    # пол
    '<rect y="230" width="480" height="130" fill="#2f5b3a"/>'
    '<rect y="230" width="480" height="8" fill="#3d7a4c"/>'
    # надувные укрытия
    '<ellipse cx="70" cy="272" rx="52" ry="34" fill="#e8622d"/>'
    '<ellipse cx="70" cy="266" rx="38" ry="22" fill="#ff8347" opacity="0.8"/>'
    '<ellipse cx="410" cy="272" rx="52" ry="34" fill="#00a5b5"/>'
    '<ellipse cx="410" cy="266" rx="38" ry="22" fill="#25d3e6" opacity="0.8"/>'
    '<rect x="196" y="244" width="88" height="54" rx="22" fill="#e8c62d"/>'
    '<rect x="208" y="252" width="64" height="26" rx="13" fill="#ffe066" opacity="0.8"/>'
    # брызги краски на полу
    '<circle cx="150" cy="330" r="12" fill="#ff5ea8" opacity="0.75"/>'
    '<circle cx="163" cy="338" r="5" fill="#ff5ea8" opacity="0.6"/>'
    '<circle cx="330" cy="318" r="10" fill="#59e3ff" opacity="0.7"/>'
    '<circle cx="318" cy="330" r="4" fill="#59e3ff" opacity="0.6"/>'
    '<circle cx="245" cy="345" r="9" fill="#ffe14d" opacity="0.7"/>'
    '<circle cx="60" cy="340" r="7" fill="#9cff6b" opacity="0.6"/>')


FINISH_SVG = svg(480, 360,
    '<rect width="480" height="360" fill="#101a33"/>'
    '<circle cx="240" cy="180" r="150" fill="#16264a"/>'
    '<circle cx="240" cy="180" r="110" fill="#1d3160"/>'
    '<circle cx="240" cy="180" r="70" fill="#25407b"/>'
    '<circle cx="240" cy="180" r="32" fill="#ff5ea8"/>'
    '<circle cx="95" cy="70" r="26" fill="#ff5ea8" opacity="0.8"/>'
    '<circle cx="118" cy="92" r="10" fill="#ff5ea8" opacity="0.6"/>'
    '<circle cx="392" cy="86" r="22" fill="#59e3ff" opacity="0.8"/>'
    '<circle cx="370" cy="108" r="9" fill="#59e3ff" opacity="0.6"/>'
    '<circle cx="110" cy="300" r="24" fill="#ffe14d" opacity="0.75"/>'
    '<circle cx="380" cy="300" r="20" fill="#9cff6b" opacity="0.75"/>')


# имя костюма -> (svg, центр вращения X, центр вращения Y)
ASSETS = {
    "Арена":    (ARENA_SVG, 240, 180),
    "Финиш":    (FINISH_SVG, 240, 180),
    "Маркер":   (MARKER_SVG, 32, 33),
    "Шарик1":   (ball_svg("#ff5ea8", "#c72f75"), 12, 12),
    "Шарик2":   (ball_svg("#59e3ff", "#1f9fc4"), 12, 12),
    "Шарик3":   (ball_svg("#ffe14d", "#c9a413"), 12, 12),
    "Шарик4":   (ball_svg("#9cff6b", "#4fae2c"), 12, 12),
    "Клякса":   (splat_svg("#ff5ea8"), 32, 32),
    "Мишень1":  (bot_svg("#7a5cff", "#c9ff5e"), 35, 38),
    "Мишень2":  (bot_svg("#ff7a3d", "#ffe14d"), 35, 38),
    "Мишень3":  (bot_svg("#31c4a5", "#9cff6b"), 35, 38),
    "Брызги":   (splat_svg("#c9ff5e"), 32, 32),
}

_asset_files = {}   # md5ext -> bytes


def costume(name):
    data = ASSETS[name][0].encode("utf-8")
    md5 = hashlib.md5(data).hexdigest()
    _asset_files[md5 + ".svg"] = data
    return {
        "assetId": md5,
        "name": name,
        "bitmapResolution": 1,
        "md5ext": md5 + ".svg",
        "dataFormat": "svg",
        "rotationCenterX": ASSETS[name][1],
        "rotationCenterY": ASSETS[name][2],
    }


# ------------------------------------------------------------ конструктор ---

class Var:
    def __init__(self, name, vid, value=0):
        self.name, self.id, self.value = name, vid, value

    def prim(self):
        return [12, self.name, self.id]


class Cast:
    """Ссылка на блок-репортёр или блок-условие."""
    def __init__(self, bid):
        self.bid = bid


SCORE = Var("Очки", "var-ochki")
LIVES = Var("Жизни", "var-zhizni", 5)
TIME = Var("Время", "var-vremya", 60)
VARS = [SCORE, LIVES, TIME]

BC = {"Старт": "bc-start", "Конец": "bc-end"}


class T:
    """Сборщик блоков одной цели (сцены или спрайта)."""

    def __init__(self):
        self.blocks = {}
        self._n = 0

    # --- низкий уровень -----------------------------------------------
    def _new(self, opcode, inputs=None, fields=None, shadow=False, mutation=None):
        self._n += 1
        bid = "b%d" % self._n
        b = {
            "opcode": opcode,
            "next": None,
            "parent": None,
            "inputs": inputs or {},
            "fields": fields or {},
            "shadow": shadow,
            "topLevel": False,
        }
        if mutation:
            b["mutation"] = mutation
        self.blocks[bid] = b
        return bid

    def rep(self, opcode, inputs=None, fields=None):
        return Cast(self._new(opcode, inputs, fields))

    def menu(self, opcode, field, value):
        return self._new(opcode, fields={field: [value, None]}, shadow=True)

    # --- входы --------------------------------------------------------
    @staticmethod
    def _wrap(value, shadow):
        if isinstance(value, Cast):
            return [3, value.bid, shadow]
        if isinstance(value, Var):
            return [3, value.prim(), shadow]
        return [1, [shadow[0], str(value)]]

    def n(self, value):        # число
        return self._wrap(value, [4, ""])

    def s(self, value):        # текст
        return self._wrap(value, [10, ""])

    def pos(self, value):      # положительное целое (счётчик повторов)
        return self._wrap(value, [6, ""])

    def ang(self, value):      # угол
        return self._wrap(value, [8, ""])

    @staticmethod
    def cond(value):
        return [2, value.bid]

    @staticmethod
    def sub(first_block_id):
        return [2, first_block_id]

    # --- сборка скрипта ------------------------------------------------
    def script(self, stack, x=40, y=40):
        stack = [b for b in stack if b]
        for a, b in zip(stack, stack[1:]):
            self.blocks[a]["next"] = b
            self.blocks[b]["parent"] = a
        head = stack[0]
        self.blocks[head]["topLevel"] = True
        self.blocks[head]["x"] = x
        self.blocks[head]["y"] = y
        return head

    def nest(self, stack):
        """Связывает блоки внутри C-блока и возвращает id первого."""
        stack = [b for b in stack if b]
        for a, b in zip(stack, stack[1:]):
            self.blocks[a]["next"] = b
            self.blocks[b]["parent"] = a
        return stack[0]

    def fix_parents(self):
        for bid, b in self.blocks.items():
            for value in b["inputs"].values():
                if not isinstance(value, list) or value[0] not in (1, 2, 3):
                    continue
                for part in value[1:]:
                    if isinstance(part, str) and part in self.blocks:
                        self.blocks[part]["parent"] = bid

    # === события =======================================================
    def when_flag(self):
        return self._new("event_whenflagclicked")

    def when_receive(self, msg):
        return self._new("event_whenbroadcastreceived",
                         fields={"BROADCAST_OPTION": [msg, BC[msg]]})

    def broadcast(self, msg):
        return self._new("event_broadcast",
                         inputs={"BROADCAST_INPUT": [1, [11, msg, BC[msg]]]})

    def broadcast_wait(self, msg):
        return self._new("event_broadcastandwait",
                         inputs={"BROADCAST_INPUT": [1, [11, msg, BC[msg]]]})

    def when_clone(self):
        return self._new("control_start_as_clone")

    # === управление ====================================================
    def wait(self, secs):
        return self._new("control_wait", {"DURATION": self.n(secs)})

    def repeat(self, times, body):
        return self._new("control_repeat",
                         {"TIMES": self.pos(times), "SUBSTACK": self.sub(self.nest(body))})

    def repeat_until(self, condition, body):
        return self._new("control_repeat_until",
                         {"CONDITION": self.cond(condition),
                          "SUBSTACK": self.sub(self.nest(body))})

    def forever(self, body):
        return self._new("control_forever", {"SUBSTACK": self.sub(self.nest(body))})

    def if_then(self, condition, body):
        return self._new("control_if",
                         {"CONDITION": self.cond(condition),
                          "SUBSTACK": self.sub(self.nest(body))})

    def if_else(self, condition, body, body2):
        return self._new("control_if_else",
                         {"CONDITION": self.cond(condition),
                          "SUBSTACK": self.sub(self.nest(body)),
                          "SUBSTACK2": self.sub(self.nest(body2))})

    def stop(self, option="all"):
        has_next = "true" if option == "other scripts in sprite" else "false"
        return self._new("control_stop", fields={"STOP_OPTION": [option, None]},
                         mutation={"tagName": "mutation", "children": [], "hasnext": has_next})

    def clone_myself(self):
        return self.clone_of("_myself_")

    def clone_of(self, sprite):
        menu = self.menu("control_create_clone_of_menu", "CLONE_OPTION", sprite)
        return self._new("control_create_clone_of", {"CLONE_OPTION": [1, menu]})

    def delete_clone(self):
        return self._new("control_delete_this_clone")

    # === движение ======================================================
    def goto_xy(self, x, y):
        return self._new("motion_gotoxy", {"X": self.n(x), "Y": self.n(y)})

    def goto_sprite(self, name):
        menu = self.menu("motion_goto_menu", "TO", name)
        return self._new("motion_goto", {"TO": [1, menu]})

    def point_dir(self, deg):
        return self._new("motion_pointindirection", {"DIRECTION": self.ang(deg)})

    def point_towards(self, target="_mouse_"):
        menu = self.menu("motion_pointtowards_menu", "TOWARDS", target)
        return self._new("motion_pointtowards", {"TOWARDS": [1, menu]})

    def move(self, steps):
        return self._new("motion_movesteps", {"STEPS": self.n(steps)})

    def change_x(self, dx):
        return self._new("motion_changexby", {"DX": self.n(dx)})

    def change_y(self, dy):
        return self._new("motion_changeyby", {"DY": self.n(dy)})

    def set_x(self, x):
        return self._new("motion_setx", {"X": self.n(x)})

    def x_pos(self):
        return self.rep("motion_xposition")

    def y_pos(self):
        return self.rep("motion_yposition")

    def set_rotation(self, style="all around"):
        return self._new("motion_setrotationstyle", fields={"STYLE": [style, None]})

    # === внешний вид ===================================================
    def show(self):
        return self._new("looks_show")

    def hide(self):
        return self._new("looks_hide")

    def switch_costume(self, name):
        menu = self.menu("looks_costume", "COSTUME", name)
        return self._new("looks_switchcostumeto", {"COSTUME": [1, menu]})

    def next_costume(self):
        return self._new("looks_nextcostume")

    def switch_backdrop(self, name):
        menu = self.menu("looks_backdrops", "BACKDROP", name)
        return self._new("looks_switchbackdropto", {"BACKDROP": [1, menu]})

    def set_size(self, size):
        return self._new("looks_setsizeto", {"SIZE": self.n(size)})

    def change_size(self, delta):
        return self._new("looks_changesizeby", {"CHANGE": self.n(delta)})

    def change_effect(self, effect, delta):
        return self._new("looks_changeeffectby",
                         {"CHANGE": self.n(delta)}, {"EFFECT": [effect, None]})

    def clear_effects(self):
        return self._new("looks_cleargraphiceffects")

    def go_front(self):
        return self._new("looks_gotofrontback", fields={"FRONT_BACK": ["front", None]})

    def say(self, message):
        return self._new("looks_say", {"MESSAGE": self.s(message)})

    def say_for(self, message, secs):
        return self._new("looks_sayforsecs",
                         {"MESSAGE": self.s(message), "SECS": self.n(secs)})

    # === сенсоры =======================================================
    def touching(self, name):
        menu = self.menu("sensing_touchingobjectmenu", "TOUCHINGOBJECT", name)
        return self.rep("sensing_touchingobject", {"TOUCHINGOBJECTMENU": [1, menu]})

    def key_pressed(self, key):
        menu = self.menu("sensing_keyoptions", "KEY_OPTION", key)
        return self.rep("sensing_keypressed", {"KEY_OPTION": [1, menu]})

    def mouse_down(self):
        return self.rep("sensing_mousedown")

    # === операторы =====================================================
    def add(self, a, b):
        return self.rep("operator_add", {"NUM1": self.n(a), "NUM2": self.n(b)})

    def sub_op(self, a, b):
        return self.rep("operator_subtract", {"NUM1": self.n(a), "NUM2": self.n(b)})

    def mul(self, a, b):
        return self.rep("operator_multiply", {"NUM1": self.n(a), "NUM2": self.n(b)})

    def div(self, a, b):
        return self.rep("operator_divide", {"NUM1": self.n(a), "NUM2": self.n(b)})

    def random(self, a, b):
        return self.rep("operator_random", {"FROM": self.n(a), "TO": self.n(b)})

    def gt(self, a, b):
        return self.rep("operator_gt", {"OPERAND1": self.s(a), "OPERAND2": self.s(b)})

    def lt(self, a, b):
        return self.rep("operator_lt", {"OPERAND1": self.s(a), "OPERAND2": self.s(b)})

    def or_(self, a, b):
        return self.rep("operator_or", {"OPERAND1": self.cond(a), "OPERAND2": self.cond(b)})

    def and_(self, a, b):
        return self.rep("operator_and", {"OPERAND1": self.cond(a), "OPERAND2": self.cond(b)})

    def join(self, a, b):
        return self.rep("operator_join", {"STRING1": self.s(a), "STRING2": self.s(b)})

    # === переменные ====================================================
    def set_var(self, var, value):
        return self._new("data_setvariableto", {"VALUE": self.s(value)},
                         {"VARIABLE": [var.name, var.id]})

    def change_var(self, var, delta):
        return self._new("data_changevariableby", {"VALUE": self.n(delta)},
                         {"VARIABLE": [var.name, var.id]})


# ------------------------------------------------------------------ сцена ---

def build_stage():
    t = T()

    # Главный цикл игры: счётчик времени и конец партии.
    t.script([
        t.when_flag(),
        t.switch_backdrop("Арена"),
        t.set_var(SCORE, 0),
        t.set_var(LIVES, 5),
        t.set_var(TIME, 60),
        t.broadcast("Старт"),
        t.repeat_until(
            t.or_(t.lt(TIME, 1), t.lt(LIVES, 1)),
            [t.wait(1), t.change_var(TIME, -1)],
        ),
        t.switch_backdrop("Финиш"),
        t.broadcast("Конец"),
    ], 40, 40)

    t.fix_parents()
    return {
        "isStage": True,
        "name": "Stage",
        "variables": {v.id: [v.name, v.value] for v in VARS},
        "lists": {},
        "broadcasts": {bid: name for name, bid in BC.items()},
        "blocks": t.blocks,
        "comments": {},
        "currentCostume": 0,
        "costumes": [costume("Арена"), costume("Финиш")],
        "sounds": [],
        "volume": 100,
        "layerOrder": 0,
        "tempo": 60,
        "videoTransparency": 50,
        "videoState": "off",
        "textToSpeechLanguage": None,
    }


# ----------------------------------------------------------------- маркер ---

def build_marker():
    t = T()

    t.script([
        t.when_flag(),
        t.set_rotation("all around"),
        t.clear_effects(),
        t.set_size(85),
        t.goto_xy(0, -132),
        t.point_dir(90),
        t.show(),
        t.say_for("Целься мышкой, стреляй пробелом или кликом, бегай стрелками!", 3),
    ], 40, 40)

    # Прицеливание и бег вдоль нижней кромки арены.
    t.script([
        t.when_receive("Старт"),
        t.forever([
            t.point_towards("_mouse_"),
            t.if_then(t.or_(t.key_pressed("right arrow"), t.key_pressed("d")),
                      [t.change_x(6)]),
            t.if_then(t.or_(t.key_pressed("left arrow"), t.key_pressed("a")),
                      [t.change_x(-6)]),
            t.if_then(t.gt(t.x_pos(), 215), [t.set_x(215)]),
            t.if_then(t.lt(t.x_pos(), -215), [t.set_x(-215)]),
        ]),
    ], 40, 320)

    # Стрельба с задержкой между выстрелами.
    t.script([
        t.when_receive("Старт"),
        t.forever([
            t.if_then(t.or_(t.key_pressed("space"), t.mouse_down()),
                      [t.clone_of("Шарик"), t.wait(0.2)]),
        ]),
    ], 460, 320)

    t.script([
        t.when_receive("Конец"),
        t.stop("other scripts in sprite"),
        t.point_dir(90),
        t.say(t.join("ИГРА ОКОНЧЕНА! Очки: ", SCORE)),
    ], 460, 40)

    t.fix_parents()
    return {
        "isStage": False,
        "name": "Маркер",
        "variables": {}, "lists": {}, "broadcasts": {},
        "blocks": t.blocks,
        "comments": {},
        "currentCostume": 0,
        "costumes": [costume("Маркер")],
        "sounds": [],
        "volume": 100,
        "layerOrder": 3,
        "visible": True,
        "x": 0, "y": -132, "size": 85, "direction": 90,
        "draggable": False,
        "rotationStyle": "all around",
    }


# ----------------------------------------------------------------- шарик ---

def build_ball():
    t = T()

    t.script([t.when_flag(), t.hide(), t.set_rotation("all around")], 40, 40)

    # Клон рождается у ствола, берёт случайный цвет и летит к прицелу.
    # Клон делает маркер (блок «создать клон Шарик»), поэтому лавины клонов нет:
    # скрипт ниже срабатывает ровно один раз на каждый выстрел.
    t.script([
        t.when_clone(),
        t.goto_sprite("Маркер"),
        t.point_towards("_mouse_"),
        t.move(32),                      # вылет из дула, а не из центра турели
        t.switch_costume("Шарик1"),
        t.repeat(t.random(0, 3), [t.next_costume()]),
        t.go_front(),
        t.clear_effects(),
        t.set_size(65),
        t.show(),
        t.repeat_until(t.or_(t.touching("Мишень"), t.touching("_edge_")),
                       [t.move(17)]),
        t.if_then(t.touching("Мишень"), [
            t.switch_costume("Клякса"),
            t.set_size(45),
            t.repeat(5, [t.change_size(9), t.change_effect("ghost", 19)]),
        ]),
        t.delete_clone(),
    ], 480, 40)

    t.script([t.when_receive("Конец"), t.hide(), t.delete_clone()], 480, 460)

    t.fix_parents()
    return {
        "isStage": False,
        "name": "Шарик",
        "variables": {}, "lists": {}, "broadcasts": {},
        "blocks": t.blocks,
        "comments": {},
        "currentCostume": 0,
        "costumes": [costume("Шарик1"), costume("Шарик2"), costume("Шарик3"),
                     costume("Шарик4"), costume("Клякса")],
        "sounds": [],
        "volume": 100,
        "layerOrder": 2,
        "visible": False,
        "x": 0, "y": -120, "size": 65, "direction": 90,
        "draggable": False,
        "rotationStyle": "all around",
    }


# ---------------------------------------------------------------- мишень ---

def build_bot():
    t = T()

    t.script([t.when_flag(), t.hide(), t.set_rotation("don't rotate")], 40, 40)

    # Фабрика мишеней: пока идёт партия — выпускать новых ботов.
    t.script([
        t.when_receive("Старт"),
        t.wait(1.5),
        t.repeat_until(
            t.or_(t.lt(TIME, 1), t.lt(LIVES, 1)),
            [t.clone_myself(), t.wait(t.random(0.6, 1.5))],
        ),
    ], 40, 220)

    # Жизнь одного бота: спуск, попадание или прорыв.
    t.script([
        t.when_clone(),
        t.switch_costume("Мишень1"),
        t.repeat(t.random(0, 2), [t.next_costume()]),
        t.clear_effects(),
        t.set_size(t.random(65, 105)),
        t.goto_xy(t.random(-205, 205), 175),
        t.show(),
        t.repeat_until(
            t.or_(t.touching("Шарик"), t.lt(t.y_pos(), -122)),
            [
                t.change_y(t.sub_op(0, t.add(2.0, t.div(SCORE, 20)))),
                t.change_x(t.random(-2, 2)),
            ],
        ),
        t.if_else(
            t.touching("Шарик"),
            [
                t.change_var(SCORE, 1),
                t.switch_costume("Брызги"),
                t.repeat(5, [t.change_size(8), t.change_effect("ghost", 19)]),
            ],
            [t.change_var(LIVES, -1)],
        ),
        t.delete_clone(),
    ], 460, 40)

    t.script([t.when_receive("Конец"), t.hide(), t.delete_clone()], 460, 560)

    t.fix_parents()
    return {
        "isStage": False,
        "name": "Мишень",
        "variables": {}, "lists": {}, "broadcasts": {},
        "blocks": t.blocks,
        "comments": {},
        "currentCostume": 0,
        "costumes": [costume("Мишень1"), costume("Мишень2"), costume("Мишень3"),
                     costume("Брызги")],
        "sounds": [],
        "volume": 100,
        "layerOrder": 1,
        "visible": False,
        "x": 0, "y": 175, "size": 90, "direction": 90,
        "draggable": False,
        "rotationStyle": "don't rotate",
    }


# --------------------------------------------------------------- монитор ---

def monitor(var, y):
    return {
        "id": var.id,
        "mode": "default",
        "opcode": "data_variable",
        "params": {"VARIABLE": var.name},
        "spriteName": None,
        "value": var.value,
        "width": 0,
        "height": 0,
        "x": 5,
        "y": y,
        "visible": True,
        "sliderMin": 0,
        "sliderMax": 100,
        "isDiscrete": True,
    }


def build_project():
    return {
        "targets": [build_stage(), build_bot(), build_ball(), build_marker()],
        "monitors": [monitor(SCORE, 5), monitor(LIVES, 32), monitor(TIME, 59)],
        "extensions": [],
        "meta": {"semver": "3.0.0", "vm": "0.2.0", "agent": ""},
    }


def main():
    project = build_project()
    project_json = json.dumps(project, ensure_ascii=False, separators=(",", ":"))

    with zipfile.ZipFile(OUT_SB3, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", project_json)
        for md5ext, data in sorted(_asset_files.items()):
            z.writestr(md5ext, data)

    print("готово: %s (%d байт, %d костюмов)"
          % (OUT_SB3, os.path.getsize(OUT_SB3), len(_asset_files)))


if __name__ == "__main__":
    main()
