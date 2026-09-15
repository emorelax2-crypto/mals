/* Админка Mals Chat. Alpine.js подключён с CDN, разметка — в index.html. */

const api = {
  async call(method, url, body, isForm) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      if (isForm) options.body = body;
      else {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
    }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    return data;
  },
  get: (url) => api.call('GET', url),
  post: (url, body) => api.call('POST', url, body),
  put: (url, body) => api.call('PUT', url, body),
  del: (url) => api.call('DELETE', url),
  upload: (url, formData) => api.call('POST', url, formData, true),
};

const EMPTY_TRIGGER = () => ({
  id: null,
  title: '',
  keywords: '',
  match_type: 'any',
  note: '',
  media_id: null,
  card: { name: '', price: '', description: '', url: '', buttonText: 'Открыть' },
  enabled: true,
  priority: 0,
});

document.addEventListener('alpine:init', () => {
  Alpine.data('panel', () => ({
    /* --- состояние --- */
    booted: false,
    authed: false,
    password: '',
    loginError: '',
    tab: 'inbox',
    toast: null,

    settings: {},
    groundRules: '',
    model: '',
    publicUrl: '',
    savingSettings: false,

    conversations: [],
    search: '',
    current: null,
    messages: [],
    operatorText: '',
    typingIn: {},

    triggers: [],
    editing: null,

    media: [],
    uploading: false,

    keys: [],
    newKeyName: '',

    stats: { today: {}, conversations: 0, activeToday: 0, messages: 0, unread: 0, takeovers: 0 },
    queue: { inFlight: 0, pending: 0, limit: 0 },
    online: 0,

    sandbox: { text: '', reply: '', matched: [], attachments: [], busy: false, error: '' },

    socket: null,

    /* --- запуск --- */
    async init() {
      const me = await api.get('/admin/api/me').catch(() => ({ authed: false }));
      this.authed = me.authed;
      this.booted = true;
      if (this.authed) await this.afterLogin();
      this.$watch('tab', (tab) => this.onTab(tab));
    },

    async login() {
      this.loginError = '';
      try {
        await api.post('/admin/api/login', { password: this.password });
        this.password = '';
        this.authed = true;
        await this.afterLogin();
      } catch (error) {
        this.loginError = error.message;
      }
    },

    async logout() {
      await api.post('/admin/api/logout');
      this.authed = false;
      if (this.socket) this.socket.close();
    },

    async afterLogin() {
      await Promise.all([this.loadSettings(), this.loadConversations(), this.loadStats()]);
      this.connect();
      setInterval(() => this.authed && this.loadStats(), 15000);
      this.icons();
    },

    onTab(tab) {
      if (tab === 'triggers') this.loadTriggers(), this.loadMedia();
      if (tab === 'media') this.loadMedia();
      if (tab === 'connect') this.loadKeys();
      if (tab === 'inbox') this.loadConversations();
      this.icons();
    },

    icons() {
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    notify(text, kind = 'ok') {
      this.toast = { text, kind };
      setTimeout(() => (this.toast = null), 3000);
    },

    /* --- живые события --- */
    connect() {
      const url = location.origin.replace(/^http/, 'ws') + '/ws/admin';
      this.socket = new WebSocket(url);

      this.socket.addEventListener('message', (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        if (data.type === 'message') {
          if (this.current && data.conversationId === this.current.id) {
            if (!this.messages.some((m) => m.id === data.message.id)) this.messages.push(data.message);
            this.scrollLog();
          }
          this.loadConversations({ silent: true });
        } else if (data.type === 'typing') {
          this.typingIn = { ...this.typingIn, [data.conversationId]: data.value };
        } else if (data.type === 'queue') {
          this.queue = { inFlight: data.inFlight, pending: data.pending, limit: data.limit };
        } else if (data.type === 'reply_failed') {
          this.notify('Ответ не сгенерирован: ' + data.error, 'err');
        }
      });

      this.socket.addEventListener('close', () => {
        if (this.authed) setTimeout(() => this.connect(), 3000);
      });
    },

    /* --- настройки --- */
    async loadSettings() {
      const data = await api.get('/admin/api/settings');
      this.settings = data.settings;
      this.groundRules = data.groundRules;
      this.model = data.model;
      this.publicUrl = data.publicUrl;
    },

    async saveSettings() {
      this.savingSettings = true;
      try {
        const data = await api.put('/admin/api/settings', this.settings);
        this.settings = data.settings;
        this.notify('Настройки сохранены');
      } catch (error) {
        this.notify(error.message, 'err');
      } finally {
        this.savingSettings = false;
      }
    },

    /* --- диалоги --- */
    async loadConversations({ silent = false } = {}) {
      try {
        const data = await api.get('/admin/api/conversations?search=' + encodeURIComponent(this.search));
        this.conversations = data.conversations;
        this.icons();
      } catch (error) {
        if (!silent) this.notify(error.message, 'err');
      }
    },

    async openConversation(id) {
      const data = await api.get('/admin/api/conversations/' + id);
      this.current = data.conversation;
      this.messages = data.messages;
      this.scrollLog();
      this.loadConversations({ silent: true });
      this.icons();
    },

    async sendOperator() {
      const text = this.operatorText.trim();
      if (!text || !this.current) return;
      this.operatorText = '';
      try {
        await api.post(`/admin/api/conversations/${this.current.id}/reply`, { text });
      } catch (error) {
        this.notify(error.message, 'err');
      }
    },

    async toggleTakeover() {
      if (!this.current) return;
      const value = !this.current.takeover;
      await api.post(`/admin/api/conversations/${this.current.id}/takeover`, { value });
      this.current = { ...this.current, takeover: value ? 1 : 0 };
      this.notify(value ? 'Диалог переведён на вас — ИИ молчит' : 'ИИ снова отвечает в этом диалоге');
      this.loadConversations({ silent: true });
    },

    scrollLog() {
      this.$nextTick(() => {
        const box = this.$refs.log;
        if (box) box.scrollTop = box.scrollHeight;
      });
    },

    /* --- ключевые слова --- */
    async loadTriggers() {
      this.triggers = (await api.get('/admin/api/triggers')).triggers;
      this.icons();
    },

    newTrigger() {
      this.editing = EMPTY_TRIGGER();
    },

    editTrigger(trigger) {
      this.editing = JSON.parse(JSON.stringify({ ...trigger, card: trigger.card || {} }));
      this.editing.card = { name: '', price: '', description: '', url: '', buttonText: 'Открыть', ...this.editing.card };
    },

    async saveTrigger() {
      try {
        await api.post('/admin/api/triggers', this.editing);
        this.editing = null;
        await this.loadTriggers();
        this.notify('Правило сохранено');
      } catch (error) {
        this.notify(error.message, 'err');
      }
    },

    async removeTrigger(id) {
      if (!confirm('Удалить правило?')) return;
      await api.del('/admin/api/triggers/' + id);
      await this.loadTriggers();
    },

    /* --- медиа --- */
    async loadMedia() {
      this.media = (await api.get('/admin/api/media')).media;
      this.icons();
    },

    async uploadFiles(event) {
      const files = [...event.target.files];
      if (!files.length) return;
      this.uploading = true;
      try {
        for (const file of files) {
          const form = new FormData();
          form.append('file', file);
          form.append('title', file.name);
          await api.upload('/admin/api/media', form);
        }
        await this.loadMedia();
        this.notify('Загружено: ' + files.length);
      } catch (error) {
        this.notify(error.message, 'err');
      } finally {
        this.uploading = false;
        event.target.value = '';
      }
    },

    async removeMedia(id) {
      if (!confirm('Удалить фото? Правила, где оно стоит, останутся без картинки.')) return;
      await api.del('/admin/api/media/' + id);
      await this.loadMedia();
    },

    mediaById(id) {
      return this.media.find((m) => m.id === id);
    },

    /* --- ключи --- */
    async loadKeys() {
      this.keys = (await api.get('/admin/api/keys')).keys;
      this.icons();
    },

    async createKey() {
      await api.post('/admin/api/keys', { name: this.newKeyName || 'Приложение' });
      this.newKeyName = '';
      await this.loadKeys();
      this.notify('Ключ создан');
    },

    async removeKey(id) {
      if (!confirm('Отозвать ключ? Приложение перестанет отвечать.')) return;
      await api.del('/admin/api/keys/' + id);
      await this.loadKeys();
    },

    copy(text) {
      navigator.clipboard.writeText(text).then(() => this.notify('Скопировано'));
    },

    /* --- статистика --- */
    async loadStats() {
      try {
        const data = await api.get('/admin/api/stats');
        this.stats = data.stats;
        this.queue = data.queue;
        this.online = data.online;
      } catch { /* сеть моргнула — переживём до следующего тика */ }
    },

    /* --- песочница --- */
    async runSandbox() {
      const text = this.sandbox.text.trim();
      if (!text) return;
      this.sandbox.busy = true;
      this.sandbox.error = '';
      this.sandbox.reply = '';
      try {
        const data = await api.post('/admin/api/preview', { text });
        this.sandbox.reply = data.reply;
        this.sandbox.matched = data.matchedTriggers;
        this.sandbox.attachments = data.attachments;
      } catch (error) {
        this.sandbox.error = error.message;
      } finally {
        this.sandbox.busy = false;
        this.icons();
      }
    },

    /* --- вспомогательное --- */
    get snippet() {
      return `<script src="${this.publicUrl}/widget.js" async><\/script>`;
    },

    curlExample(key) {
      return [
        `curl -X POST ${this.publicUrl}/api/v1/chat \\`,
        `  -H "X-API-Key: ${key || 'ВАШ_КЛЮЧ'}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '{"channel":"telegram","contact_id":"user-42","contact_name":"Иван","text":"Сколько стоит доставка?"}'`,
      ].join('\n');
    },

    time(ts) {
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    },

    when(ts) {
      const date = new Date(ts);
      const today = new Date().toDateString() === date.toDateString();
      return today
        ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    },

    roleLabel(role) {
      return { user: 'Клиент', assistant: this.settings.bot_name || 'ИИ', operator: 'Менеджер' }[role] || role;
    },

    trim(text, n = 60) {
      if (!text) return '';
      return text.length > n ? text.slice(0, n) + '…' : text;
    },
  }));
});
