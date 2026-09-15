/* ===========================================================
   Звонки: WebRTC поверх сигналинга из общего WebSocket.
   Аудио и видео 1:1, рингтон синтезируется Web Audio — без файлов.
   =========================================================== */

const el = (id) => document.getElementById(id);

export class CallManager {
  constructor({ send, iceServers, onState }) {
    this.send = send;
    this.iceServers = iceServers;
    this.onState = onState || (() => {});

    this.pc = null;
    this.localStream = null;
    this.call = null;           // { id, chatId, video, peer, role }
    this.pendingIce = [];
    this.timer = null;
    this.startedAt = 0;
    this.muted = false;
    this.camOff = false;

    this.overlay = el('call-overlay');
    this.remoteVideo = el('call-remote-video');
    this.localVideo = el('call-local-video');
  }

  get active() { return !!this.call; }

  /* ------------------------- исходящий ------------------------- */
  start(chat, video) {
    if (this.call) return;
    this.call = { id: null, chatId: chat.id, video, peer: chat.peer, role: 'caller', state: 'calling' };
    this.render('Вызов…');
    this.ring('outgoing');
    this.send({ t: 'call:start', chatId: chat.id, video });
  }

  /* ------------------------- входящий ------------------------- */
  incoming({ callId, chatId, video, from }) {
    if (this.call) { this.send({ t: 'call:decline', callId }); return; }
    this.call = { id: callId, chatId, video, peer: from, role: 'callee', state: 'ringing' };
    this.render(video ? 'Входящий видеозвонок' : 'Входящий звонок');
    this.ring('incoming');
    if (navigator.vibrate) navigator.vibrate([400, 250, 400, 250, 400]);
  }

  accept() {
    if (!this.call || this.call.state !== 'ringing') return;
    this.stopRing();
    this.call.state = 'connecting';
    this.render('Соединение…');
    this.send({ t: 'call:accept', callId: this.call.id });
  }

  decline() {
    if (!this.call) return;
    this.send({ t: 'call:decline', callId: this.call.id });
    this.teardown();
  }

  hangup() {
    if (!this.call) return;
    if (this.call.id) this.send({ t: 'call:end', callId: this.call.id });
    this.teardown();
  }

  /* ------------------ события от сервера ------------------ */
  async handle(msg) {
    switch (msg.t) {
      case 'call:outgoing':
        if (!this.call) return;
        this.call.id = msg.callId;
        this.call.peer = this.call.peer || msg.peers?.[0];
        this.render('Вызов…');
        break;

      case 'call:incoming':
        this.incoming(msg);
        break;

      case 'call:accepted': {
        if (!this.call || this.call.id !== msg.callId) return;
        this.stopRing();
        this.call.peer = msg.by || this.call.peer;
        this.call.state = 'connecting';
        this.render('Соединение…');
        await this.connect(msg.initiator);
        break;
      }

      case 'call:signal':
        await this.onSignal(msg.signal);
        break;

      case 'call:taken':
        if (this.call && this.call.id === msg.callId) this.teardown();
        break;

      case 'call:busy':
        this.teardown();
        this.onState({ type: 'error', text: msg.reason });
        break;

      case 'call:ended': {
        if (!this.call || this.call.id !== msg.callId) return;
        const label = { declined: 'Звонок отклонён', missed: 'Нет ответа' }[msg.status] || 'Звонок завершён';
        this.onState({ type: 'ended', text: label });
        this.teardown();
        break;
      }
    }
  }

  /* ------------------------- WebRTC ------------------------- */
  async connect(isInitiator) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: this.call.video ? { facingMode: 'user', width: { ideal: 1280 } } : false,
      });
    } catch (err) {
      this.onState({ type: 'error', text: 'Нет доступа к микрофону или камере' });
      this.hangup();
      return;
    }

    if (this.call.video) {
      this.localVideo.srcObject = this.localStream;
      this.overlay.classList.add('has-local');
    }

    this.pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4 });
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ t: 'call:signal', callId: this.call.id, signal: { ice: e.candidate } });
    };

    this.pc.ontrack = (e) => {
      const [stream] = e.streams;
      this.remoteVideo.srcObject = stream;
      this.remoteVideo.play?.().catch(() => {});
      if (e.track.kind === 'video') this.overlay.classList.add('has-remote');
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'connected') this.onConnected();
      if (s === 'failed') { this.onState({ type: 'error', text: 'Не удалось установить соединение' }); this.hangup(); }
    };

    if (isInitiator) {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.send({ t: 'call:signal', callId: this.call.id, signal: { sdp: this.pc.localDescription } });
    }
  }

  async onSignal(signal) {
    if (!this.pc || !signal) return;
    try {
      if (signal.sdp) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        for (const ice of this.pendingIce.splice(0)) await this.pc.addIceCandidate(ice).catch(() => {});
        if (signal.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.send({ t: 'call:signal', callId: this.call.id, signal: { sdp: this.pc.localDescription } });
        }
      } else if (signal.ice) {
        const candidate = new RTCIceCandidate(signal.ice);
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => {});
        else this.pendingIce.push(candidate);
      }
    } catch (err) {
      console.warn('[call] signal', err);
    }
  }

  onConnected() {
    if (!this.call || this.call.state === 'active') return;
    this.call.state = 'active';
    this.startedAt = Date.now();
    this.overlay.classList.add('is-active');
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      el('call-state').textContent =
        `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    this.render('00:00');
    if (navigator.vibrate) navigator.vibrate(60);
  }

  /* ------------------------- управление ------------------------- */
  toggleMute() {
    this.muted = !this.muted;
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.render();
  }

  async toggleCamera() {
    if (!this.localStream) return;
    const videoTracks = this.localStream.getVideoTracks();

    if (videoTracks.length === 0) {
      // Дозапрашиваем камеру, если звонок начинался как аудио.
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        const track = cam.getVideoTracks()[0];
        this.localStream.addTrack(track);
        this.pc?.addTrack(track, this.localStream);
        this.localVideo.srcObject = this.localStream;
        this.overlay.classList.add('has-local');
        this.call.video = true;
        this.camOff = false;
        // Пересогласовываем медиа, чтобы собеседник увидел видеодорожку.
        if (this.pc) {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.send({ t: 'call:signal', callId: this.call.id, signal: { sdp: this.pc.localDescription } });
        }
      } catch {
        this.onState({ type: 'error', text: 'Камера недоступна' });
      }
    } else {
      this.camOff = !this.camOff;
      videoTracks.forEach((t) => { t.enabled = !this.camOff; });
      this.overlay.classList.toggle('has-local', !this.camOff);
    }
    this.render();
  }

  async flipCamera() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    const facing = track.getSettings().facingMode === 'user' ? 'environment' : 'user';
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
      const nextTrack = next.getVideoTracks()[0];
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
      await sender?.replaceTrack(nextTrack);
      track.stop();
      this.localStream.removeTrack(track);
      this.localStream.addTrack(nextTrack);
      this.localVideo.srcObject = this.localStream;
    } catch {
      this.onState({ type: 'error', text: 'Вторая камера недоступна' });
    }
  }

  /* ------------------------- интерфейс ------------------------- */
  render(stateText) {
    if (!this.call) return;
    const peer = this.call.peer || {};
    this.overlay.hidden = false;

    const avatar = el('call-avatar');
    avatar.style.setProperty('--hue', peer.avatarHue ?? 220);
    avatar.textContent = peer.avatarEmoji || '👤';
    el('call-name').textContent = peer.displayName || 'Собеседник';
    if (stateText) el('call-state').textContent = stateText;

    const icons = {
      mic: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/></svg>',
      micOff: '<svg viewBox="0 0 24 24"><path d="M1 1l22 22"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1"/><path d="M15 9.3V5a3 3 0 0 0-5.9-.8"/><path d="M19 10v1a7 7 0 0 1-10.8 5.9"/><path d="M5 10v1a7 7 0 0 0 1.2 3.9"/><path d="M12 18v4"/></svg>',
      cam: '<svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7Z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
      flip: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
      hang: '<svg viewBox="0 0 24 24"><path d="M2 9.4a14 14 0 0 1 20 0l-2.2 2.9a3 3 0 0 1-3.6.7l-1.5-.8a1.5 1.5 0 0 1-.8-1.4V9a12 12 0 0 0-3.8 0v1.8c0 .6-.3 1.1-.8 1.4l-1.5.8a3 3 0 0 1-3.6-.7L2 9.4Z"/><path d="M2 20 22 4"/></svg>',
      accept: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>',
    };

    const actions = el('call-actions');
    if (this.call.state === 'ringing') {
      actions.innerHTML = `
        <button class="callbtn callbtn--hang" data-call="decline">${icons.hang}<small>Отклонить</small></button>
        <button class="callbtn callbtn--accept" data-call="accept">${icons.accept}<small>Ответить</small></button>`;
    } else {
      actions.innerHTML = `
        <button class="callbtn ${this.muted ? 'callbtn--off' : ''}" data-call="mute">
          ${this.muted ? icons.micOff : icons.mic}<small>${this.muted ? 'Вкл. звук' : 'Микрофон'}</small></button>
        <button class="callbtn ${this.camOff || !this.call.video ? '' : 'callbtn--off'}" data-call="camera">
          ${icons.cam}<small>Камера</small></button>
        ${this.call.video && !this.camOff
          ? `<button class="callbtn" data-call="flip">${icons.flip}<small>Повернуть</small></button>` : ''}
        <button class="callbtn callbtn--hang" data-call="hangup">${icons.hang}<small>Завершить</small></button>`;
    }
  }

  teardown() {
    this.stopRing();
    clearInterval(this.timer);
    this.timer = null;
    this.pendingIce = [];

    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    try { this.pc?.close(); } catch {}
    this.pc = null;

    this.remoteVideo.srcObject = null;
    this.localVideo.srcObject = null;
    this.overlay.classList.remove('has-remote', 'has-local', 'is-active');
    this.overlay.hidden = true;

    this.muted = false;
    this.camOff = false;
    this.call = null;
    this.onState({ type: 'closed' });
  }

  /* --------------------- рингтон на Web Audio --------------------- */
  ring(kind) {
    this.stopRing();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.audioCtx = ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.connect(ctx.destination);

      const beep = () => {
        if (!this.audioCtx) return;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = kind === 'incoming' ? 660 : 440;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
        osc.connect(g).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.75);
      };
      beep();
      this.ringTimer = setInterval(beep, kind === 'incoming' ? 1600 : 2600);
    } catch { /* автоплей заблокирован — звонок всё равно работает */ }
  }

  stopRing() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
    if (navigator.vibrate) navigator.vibrate(0);
    try { this.audioCtx?.close(); } catch {}
    this.audioCtx = null;
  }
}
