import { WebSocketServer } from 'ws';

/**
 * Хаб живых соединений.
 *  - widget-сокеты подписаны на один диалог;
 *  - admin-сокеты получают всё (новые сообщения, статусы, счётчики).
 */
export class Hub {
  constructor() {
    this.widgets = new Map(); // conversationId -> Set<ws>
    this.admins = new Set();
  }

  addWidget(conversationId, ws) {
    if (!this.widgets.has(conversationId)) this.widgets.set(conversationId, new Set());
    this.widgets.get(conversationId).add(ws);
    ws.on('close', () => {
      const set = this.widgets.get(conversationId);
      if (!set) return;
      set.delete(ws);
      if (!set.size) this.widgets.delete(conversationId);
    });
  }

  addAdmin(ws) {
    this.admins.add(ws);
    ws.on('close', () => this.admins.delete(ws));
  }

  toConversation(conversationId, payload) {
    send(this.widgets.get(conversationId), payload);
  }

  toAdmins(payload) {
    send(this.admins, payload);
  }

  /** Событие, которое видят и клиент, и операторы. */
  broadcastMessage(conversationId, message) {
    this.toConversation(conversationId, { type: 'message', message });
    this.toAdmins({ type: 'message', conversationId, message });
  }

  get onlineWidgets() {
    return [...this.widgets.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function send(targets, payload) {
  if (!targets) return;
  const data = JSON.stringify(payload);
  for (const ws of targets) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch {
        /* соединение отвалилось — переживём */
      }
    }
  }
}

export function attachWebsocket(server, { hub, onWidgetOpen, onWidgetMessage, isAdmin }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }

    if (url.pathname === '/ws/widget' || url.pathname === '/ws/admin') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws, req, url) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    if (url.pathname === '/ws/admin') {
      if (!isAdmin(req)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      hub.addAdmin(ws);
      ws.send(JSON.stringify({ type: 'hello', role: 'admin' }));
      return;
    }

    // widget
    try {
      const conversation = await onWidgetOpen(url);
      hub.addWidget(conversation.id, ws);
      ws.conversationId = conversation.id;
      ws.send(JSON.stringify({ type: 'ready', conversation }));
    } catch (error) {
      ws.close(4400, error.message?.slice(0, 100) || 'bad request');
      return;
    }

    ws.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (payload.type !== 'message' || !payload.text) return;
      try {
        await onWidgetMessage(ws.conversationId, String(payload.text).slice(0, 4000), payload.contactName);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
      }
    });
  });

  // Пинг раз в 30 секунд — иначе прокси молча рвут «тихие» соединения.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}
