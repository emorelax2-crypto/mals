/**
 * Mals Chat — встраиваемый виджет.
 * Подключение одной строкой:  <script src="https://ваш-домен/widget.js" async></script>
 *
 * Стили держим в изолированном CSS с префиксом .mals-, чтобы не конфликтовать
 * с вёрсткой сайта, на который виджет ставят.
 */
(function () {
  'use strict';
  if (window.__malsChatLoaded) return;
  window.__malsChatLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var ORIGIN = script ? new URL(script.src).origin : window.location.origin;
  var WS_URL = ORIGIN.replace(/^http/, 'ws') + '/ws/widget';
  var STORAGE_KEY = 'mals_visitor_id';

  var visitorId = localStorage.getItem(STORAGE_KEY);
  if (!visitorId) {
    visitorId =
      'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(STORAGE_KEY, visitorId); } catch (e) {}
  }

  var cfg = null;
  var socket = null;
  var reconnectDelay = 1000;
  var isOpen = false;
  var rendered = new Set();

  /* ---------- шрифт с Google Fonts ---------- */
  var font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap';
  document.head.appendChild(font);

  /* ---------- разметка ---------- */
  var root = document.createElement('div');
  root.className = 'mals-root';
  root.innerHTML = [
    '<button class="mals-launcher" aria-label="Открыть чат">',
      '<svg class="mals-ico-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      '<svg class="mals-ico-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    '</button>',
    '<div class="mals-panel" role="dialog" aria-label="Чат с ассистентом">',
      '<header class="mals-head">',
        '<div class="mals-ava"></div>',
        '<div class="mals-head-txt">',
          '<div class="mals-name"></div>',
          '<div class="mals-role"><span class="mals-dot"></span><span class="mals-role-txt"></span></div>',
        '</div>',
        '<button class="mals-min" aria-label="Свернуть">',
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
        '</button>',
      '</header>',
      '<div class="mals-badge"><span class="mals-badge-txt"></span></div>',
      '<div class="mals-log" aria-live="polite"></div>',
      '<form class="mals-form">',
        '<textarea class="mals-input" rows="1" placeholder="Напишите сообщение…" maxlength="4000"></textarea>',
        '<button type="submit" class="mals-send" aria-label="Отправить">',
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
        '</button>',
      '</form>',
    '</div>',
  ].join('');

  var style = document.createElement('style');
  style.textContent = CSS();
  document.head.appendChild(style);
  document.body.appendChild(root);

  var $ = function (sel) { return root.querySelector(sel); };
  var launcher = $('.mals-launcher');
  var panel = $('.mals-panel');
  var log = $('.mals-log');
  var form = $('.mals-form');
  var input = $('.mals-input');

  launcher.addEventListener('click', toggle);
  $('.mals-min').addEventListener('click', toggle);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    send();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  /* ---------- загрузка настроек ---------- */
  fetch(ORIGIN + '/api/widget-config')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      cfg = data;
      applyConfig();
      connect();
    })
    .catch(function () {
      cfg = { botName: 'Ассистент', title: 'Чат', color: '#6d5efc', position: 'right', disclosure: 'Отвечает ИИ-ассистент' };
      applyConfig();
      connect();
    });

  function applyConfig() {
    root.style.setProperty('--mals-color', cfg.color || '#6d5efc');
    root.classList.toggle('mals-left', cfg.position === 'left');
    $('.mals-name').textContent = cfg.botName || 'Ассистент';
    $('.mals-role-txt').textContent = cfg.botRole || 'ИИ-ассистент';
    $('.mals-badge-txt').textContent = cfg.disclosure || 'Отвечает ИИ-ассистент';

    var ava = $('.mals-ava');
    if (cfg.avatarUrl) {
      ava.style.backgroundImage = 'url(' + cfg.avatarUrl + ')';
    } else {
      ava.textContent = (cfg.botName || 'A').trim().charAt(0).toUpperCase();
    }
  }

  /* ---------- соединение ---------- */
  function connect() {
    try {
      socket = new WebSocket(WS_URL + '?visitor=' + encodeURIComponent(visitorId));
    } catch (e) {
      return setTimeout(connect, 3000);
    }

    socket.addEventListener('open', function () { reconnectDelay = 1000; });

    socket.addEventListener('message', function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }

      if (data.type === 'ready') {
        log.innerHTML = '';
        rendered = new Set();
        (data.conversation.messages || []).forEach(draw);
        if (!(data.conversation.messages || []).length && cfg && cfg.greeting) {
          draw({ id: 'greeting', role: 'assistant', content: cfg.greeting, attachments: [] });
        }
        scrollDown();
      } else if (data.type === 'message') {
        draw(data.message);
        scrollDown();
        if (!isOpen && data.message.role !== 'user') bump();
      } else if (data.type === 'typing') {
        typing(data.value);
      } else if (data.type === 'error') {
        systemLine(data.error);
      }
    });

    socket.addEventListener('close', function () {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    });
  }

  function send() {
    var text = input.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'message', text: text }));
    input.value = '';
    input.style.height = 'auto';
  }

  /* ---------- отрисовка ---------- */
  function draw(message) {
    if (!message || rendered.has(message.id)) return;
    rendered.add(message.id);

    var mine = message.role === 'user';
    var row = document.createElement('div');
    row.className = 'mals-row ' + (mine ? 'mals-mine' : 'mals-theirs');

    var bubble = document.createElement('div');
    bubble.className = 'mals-bubble';
    bubble.textContent = message.content;
    row.appendChild(bubble);

    if (message.role === 'operator') {
      var tag = document.createElement('div');
      tag.className = 'mals-tag';
      tag.textContent = (message.author || 'Менеджер') + ' · живой человек';
      row.appendChild(tag);
    }

    (message.attachments || []).forEach(function (att) {
      row.appendChild(att.type === 'image' ? imageBlock(att) : cardBlock(att));
    });

    log.appendChild(row);
  }

  function imageBlock(att) {
    var a = document.createElement('a');
    a.className = 'mals-img';
    a.href = att.url;
    a.target = '_blank';
    a.rel = 'noopener';
    var img = document.createElement('img');
    img.src = att.url;
    img.alt = att.title || 'Фото';
    img.loading = 'lazy';
    a.appendChild(img);
    return a;
  }

  function cardBlock(att) {
    var card = document.createElement('div');
    card.className = 'mals-card';

    if (att.name) {
      var name = document.createElement('div');
      name.className = 'mals-card-name';
      name.textContent = att.name;
      card.appendChild(name);
    }
    if (att.price) {
      var price = document.createElement('div');
      price.className = 'mals-card-price';
      price.textContent = att.price;
      card.appendChild(price);
    }
    if (att.description) {
      var desc = document.createElement('div');
      desc.className = 'mals-card-desc';
      desc.textContent = att.description;
      card.appendChild(desc);
    }
    if (att.url) {
      var link = document.createElement('a');
      link.className = 'mals-card-btn';
      link.href = att.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = att.buttonText || 'Открыть';
      card.appendChild(link);
    }
    return card;
  }

  function typing(on) {
    var existing = log.querySelector('.mals-typing');
    if (on && !existing) {
      var row = document.createElement('div');
      row.className = 'mals-row mals-theirs mals-typing';
      row.innerHTML = '<div class="mals-bubble mals-dots"><span></span><span></span><span></span></div>';
      log.appendChild(row);
      scrollDown();
    } else if (!on && existing) {
      existing.remove();
    }
  }

  function systemLine(text) {
    var row = document.createElement('div');
    row.className = 'mals-sys';
    row.textContent = text;
    log.appendChild(row);
    scrollDown();
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function toggle() {
    isOpen = !isOpen;
    root.classList.toggle('mals-open', isOpen);
    launcher.classList.remove('mals-bump');
    if (isOpen) {
      scrollDown();
      setTimeout(function () { input.focus(); }, 150);
    }
  }

  function bump() {
    launcher.classList.add('mals-bump');
  }

  /* ---------- стили ---------- */
  function CSS() {
    return [
      '.mals-root{--mals-color:#6d5efc;position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.45}',
      '.mals-root.mals-left{right:auto;left:20px}',
      '.mals-root *{box-sizing:border-box}',
      '.mals-launcher{width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:var(--mals-color);color:#fff;box-shadow:0 10px 30px rgba(20,16,60,.28);display:flex;align-items:center;justify-content:center;transition:transform .18s ease;position:absolute;right:0;bottom:0}',
      '.mals-root.mals-left .mals-launcher{right:auto;left:0}',
      '.mals-launcher:hover{transform:scale(1.06)}',
      '.mals-launcher svg{width:26px;height:26px}',
      '.mals-ico-close{display:none}',
      '.mals-open .mals-ico-close{display:block}',
      '.mals-open .mals-ico-chat{display:none}',
      '@keyframes mals-bump{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}',
      '.mals-launcher.mals-bump{animation:mals-bump .6s ease 3}',
      '.mals-panel{position:absolute;right:0;bottom:74px;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:20px;box-shadow:0 24px 60px rgba(20,16,60,.24);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(14px) scale(.97);pointer-events:none;transition:opacity .2s ease,transform .2s ease}',
      '.mals-root.mals-left .mals-panel{right:auto;left:0}',
      '.mals-open .mals-panel{opacity:1;transform:none;pointer-events:auto}',
      '.mals-head{display:flex;align-items:center;gap:12px;padding:16px;background:var(--mals-color);color:#fff}',
      '.mals-ava{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}',
      '.mals-head-txt{flex:1;min-width:0}',
      '.mals-name{font-weight:700;font-size:15px}',
      '.mals-role{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.85}',
      '.mals-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;flex:none}',
      '.mals-min{background:transparent;border:0;color:#fff;cursor:pointer;opacity:.8;padding:4px}',
      '.mals-min svg{width:20px;height:20px}',
      '.mals-badge{padding:8px 16px;background:#f5f4ff;color:#6b6890;font-size:11.5px;letter-spacing:.01em;display:flex;align-items:center;gap:6px;border-bottom:1px solid #eeecfb}',
      '.mals-badge:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--mals-color);flex:none}',
      '.mals-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#fbfbfe}',
      '.mals-row{display:flex;flex-direction:column;gap:6px;max-width:86%}',
      '.mals-theirs{align-self:flex-start;align-items:flex-start}',
      '.mals-mine{align-self:flex-end;align-items:flex-end}',
      '.mals-bubble{padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-break:break-word;background:#fff;color:#1b1a2e;border:1px solid #eceafb}',
      '.mals-mine .mals-bubble{background:var(--mals-color);color:#fff;border-color:transparent}',
      '.mals-tag{font-size:11px;color:#8b88a8}',
      '.mals-img{display:block;border-radius:14px;overflow:hidden;border:1px solid #eceafb;max-width:240px}',
      '.mals-img img{display:block;width:100%;height:auto}',
      '.mals-card{border:1px solid #eceafb;border-radius:14px;padding:12px;background:#fff;max-width:260px}',
      '.mals-card-name{font-weight:700;color:#1b1a2e;margin-bottom:2px}',
      '.mals-card-price{color:var(--mals-color);font-weight:700;margin-bottom:6px}',
      '.mals-card-desc{font-size:13px;color:#6b6890;margin-bottom:10px}',
      '.mals-card-btn{display:inline-block;padding:8px 14px;border-radius:10px;background:var(--mals-color);color:#fff;text-decoration:none;font-size:13px;font-weight:600}',
      '.mals-sys{align-self:center;font-size:12px;color:#8b88a8;text-align:center;padding:4px 10px}',
      '.mals-dots{display:flex;gap:4px;align-items:center;padding:14px}',
      '.mals-dots span{width:6px;height:6px;border-radius:50%;background:#b9b6d4;animation:mals-blink 1.2s infinite}',
      '.mals-dots span:nth-child(2){animation-delay:.2s}',
      '.mals-dots span:nth-child(3){animation-delay:.4s}',
      '@keyframes mals-blink{0%,60%,100%{opacity:.3}30%{opacity:1}}',
      '.mals-form{display:flex;gap:8px;padding:12px;border-top:1px solid #eeecfb;background:#fff;align-items:flex-end}',
      '.mals-input{flex:1;border:1px solid #e6e4f5;border-radius:12px;padding:10px 12px;font:inherit;resize:none;outline:none;max-height:120px;color:#1b1a2e;background:#fbfbfe}',
      '.mals-input:focus{border-color:var(--mals-color)}',
      '.mals-send{width:42px;height:42px;flex:none;border:0;border-radius:12px;background:var(--mals-color);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}',
      '.mals-send svg{width:19px;height:19px}',
      '@media(max-width:480px){.mals-panel{width:calc(100vw - 24px);height:calc(100vh - 110px)}}',
    ].join('');
  }
})();
