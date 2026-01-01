<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, computed, watch } from "vue";

type Role = "user" | "assistant";
type Msg = { id: number; role: Role; text: string; ts: number; identity?: string; ip?: string };

// channels list
const channels = ref(["#general", "#help", "#dev"]);
const activeChannel = ref<string>(channels.value[0] ?? "#general");

const now = Date.now();
const CLIENT_UUID_KEY = 'irc_client_uuid';

function getClientUuid() {
  const existing = localStorage.getItem(CLIENT_UUID_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID();
  localStorage.setItem(CLIENT_UUID_KEY, next);
  return next;
}

// messages stored per-channel
const messagesByChannel = ref<Record<string, Msg[]>>({
  "#general": [
    { id: now - 60000, role: "assistant", text: "Welcome to #general", ts: now - 60000 },
    { id: now - 50000, role: "assistant", text: "Discuss Everything.", ts: now - 50000 },
  ],
  "#help": [
    { id: now - 45000, role: "assistant", text: "Welcome to #help", ts: now - 45000 },
    { id: now - 40000, role: "assistant", text: "Any issue for Airport.", ts: now - 40000 },
  ],
  "#dev": [
    { id: now - 35000, role: "assistant", text: "Welcome to #dev", ts: now - 35000 },
    { id: now - 30000, role: "assistant", text: "Discuss development.", ts: now - 30000 },
  ],
});

// fast lookup per channel to avoid O(n) scans
const messageIndexByChannel = new Map<string, Map<number, Msg>>();

// computed view of current channel's messages
const currentMessages = computed(() => messagesByChannel.value[activeChannel.value] ?? []);

const input = ref("");
const speaker = ref<string>('');
const latency = ref<number | null>(null);
const localIp = ref<string | null>(null);
let pingTimer: number | null = null;
const listRef = ref<HTMLElement | null>(null);

// WebSocket
const wsRef = ref<WebSocket | null>(null);
const wsStatus = ref<'disconnected' | 'connecting' | 'connected'>('disconnected');

function getChannelStore(channel: string) {
  let arr = messagesByChannel.value[channel];
  if (!arr) {
    arr = [];
    messagesByChannel.value[channel] = arr;
  }
  let map = messageIndexByChannel.get(channel);
  if (!map) {
    map = new Map<number, Msg>();
    for (const m of arr) map.set(m.id, m);
    messageIndexByChannel.set(channel, map);
  }
  return { arr, map };
}

async function scrollIfActive(channel: string) {
  if (channel !== activeChannel.value) return;
  await nextTick();
  scrollToBottom();
}

function connectWs() {
  if (wsRef.value) return;
  wsStatus.value = 'connecting';
  try {
    const host = location.hostname || 'localhost';
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ws/';
    const ws = new WebSocket(url);
    wsRef.value = ws;

    ws.addEventListener('open', () => {
      wsStatus.value = 'connected';
      console.log('ws connected');
      try { ws.send(JSON.stringify({ type: 'sys', text: 'client ready', ts: Date.now() })); } catch (e) {}
      // start periodic ping for latency (1s)
      if (pingTimer == null) {
        pingTimer = window.setInterval(() => {
          try {
            const t = Date.now();
            ws.send(JSON.stringify({ type: 'ping', ts: t }));
          } catch (e) { /* ignore send errors */ }
        }, 1000);
      }
      // request history for the current channel once connected
      try { requestHistory(activeChannel.value, 200); } catch (e) { /* ignore */ }
    });

    ws.addEventListener('message', async (ev) => {
      let payload: any;
      try { payload = JSON.parse(ev.data.toString()); } catch (err) { console.warn('invalid json', ev.data); return; }

      if (!payload || !payload.type) return;

      if (payload.type === 'pong') {
        // compute latency from echoed ts
        const sent = payload.ts ?? Date.now();
        latency.value = Date.now() - sent;
        return;
      }

      // if server sent our IP in a sys welcome, capture it and don't render as a chat message
      if (payload.type === 'sys' && payload.ip) {
        localIp.value = payload.ip;
        return;
      }

      // handle history payload from server
      if (payload.type === 'history' && payload.channel && Array.isArray(payload.items)) {
        const ch = payload.channel;
        const { arr, map } = getChannelStore(ch);
        // merge items, dedupe by id
        for (const it of payload.items) {
          const incomingId = it.id ?? it.ts ?? Date.now();
          if (map.has(incomingId)) continue;
          const mapped: Msg = { id: incomingId, role: (it.role as Role) ?? (it.from === speaker.value ? 'user' : 'assistant'), text: it.text ?? '', ts: it.ts ?? (it.ts === 0 ? 0 : incomingId), identity: it.from ?? it.identity ?? undefined, ip: it.fromIp ?? it.ip ?? undefined };
          arr.push(mapped);
          map.set(incomingId, mapped);
        }
        // sort ascending by ts
        arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        // do not auto-scroll when loading history to allow user to view older messages at top
        return;
      }

      if (payload.type === 'msg') {
        const ch = payload.channel ?? activeChannel.value;
        const { arr, map } = getChannelStore(ch);
        const incomingId = payload.id ?? payload.ts ?? Date.now();
        const existing = map.get(incomingId);
        const from = payload.from ?? 'unknown';
        const role: Role = (from === speaker.value) ? 'user' : 'assistant';
        if (existing) {
          // Update existing local message with ip/from if server provided them
          existing.ip = payload.fromIp ?? existing.ip;
          existing.identity = payload.from ?? existing.identity;
          existing.role = role;
        } else {
          const incoming: Msg = { id: incomingId, role, text: payload.text ?? '', ts: payload.ts ?? incomingId, identity: payload.from ?? undefined, ip: payload.fromIp ?? undefined };
          arr.push(incoming);
          map.set(incomingId, incoming);
        }
        await scrollIfActive(ch);
        return;
      }

      if (payload.type === 'sys') {
        // write a system note into current channel for stability
        const ch = activeChannel.value;
        const { arr, map } = getChannelStore(ch);
        const sysMsg: Msg = { id: Date.now(), role: 'assistant', text: payload.text ?? '[sys]', ts: Date.now() };
        arr.push(sysMsg);
        map.set(sysMsg.id, sysMsg);
        await scrollIfActive(ch);
        return;
      }

      // default: push a sys echo
      const ch = activeChannel.value;
      const { arr, map } = getChannelStore(ch);
      const info: Msg = { id: Date.now(), role: 'assistant', text: `received: ${JSON.stringify(payload)}`, ts: Date.now() };
      arr.push(info);
      map.set(info.id, info);
      await scrollIfActive(ch);
    });

    ws.addEventListener('close', (ev) => {
      console.log('ws closed', ev.code, ev.reason);
      wsRef.value = null;
      wsStatus.value = 'disconnected';
      if (pingTimer != null) { clearInterval(pingTimer); pingTimer = null; latency.value = null; }
    });

    ws.addEventListener('error', (err) => {
      console.error('ws error', err);
      wsStatus.value = 'disconnected';
      if (pingTimer != null) { clearInterval(pingTimer); pingTimer = null; latency.value = null; }
    });
  } catch (err) {
    console.error('connect error', err);
    wsStatus.value = 'disconnected';
    wsRef.value = null;
  }
}

function closeWs() {
  const ws = wsRef.value;
  if (!ws) return;
  try { ws.close(); } catch (e) { /* ignore */ }
  wsRef.value = null;
  wsStatus.value = 'disconnected';
}

function requestHistory(channel: string, limit = 200) {
  if (!channel) return;
  const ws = wsRef.value;
  if (wsStatus.value === 'connected' && ws) {
    try {
      ws.send(JSON.stringify({ type: 'history', channel, limit }));
    } catch (e) {
      console.warn('history request failed', e);
    }
  } else {
    console.warn('cannot request history, ws not connected');
  }
}

function scrollToBottom() {
  const el = listRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

async function send() {
  const text = input.value.trim();
  if (!text) return;

  const ts = Date.now();
  // require speaker to be set
  if (!speaker.value || speaker.value.trim().length === 0) {
    const note: Msg = { id: Date.now() + 2, role: 'assistant', text: '请先填写发言者。', ts: Date.now() };
    const { arr, map } = getChannelStore(activeChannel.value);
    arr.push(note);
    map.set(note.id, note);
    await scrollIfActive(activeChannel.value);
    return;
  }

  const msg: Msg = { id: ts, role: "user", text, ts, identity: speaker.value };

  // ensure channel array exists (use local ref to satisfy TypeScript)
  {
    const { arr, map } = getChannelStore(activeChannel.value);
    arr.push(msg);
    map.set(msg.id, msg);
  }

  // attempt to send via websocket
  const payload = {
    type: 'say',
    channel: activeChannel.value,
    text,
    ts,
    from: speaker.value,
    resolution: `${window.screen.width}x${window.screen.height}`,
    uuid: getClientUuid(),
  };
  if (wsStatus.value === 'connected' && wsRef.value) {
    try {
      wsRef.value.send(JSON.stringify(payload));
    } catch (e) {
      console.warn('ws send failed', e);
    }
  } else {
    // push a local assistant/system notice about disconnected state
    const note: Msg = { id: Date.now() + 1, role: 'assistant', text: '未连接：消息已本地保存。', ts: Date.now() };
    const { arr, map } = getChannelStore(activeChannel.value);
    arr.push(note);
    map.set(note.id, note);
  }

  input.value = "";
  await scrollIfActive(activeChannel.value);
}

const formatTime = (ts?: number) => {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString();
};

const imageUrlRegex = /^(https?:\/\/[^\s]+?\.(?:jpg|jpeg|png|gif|webp|bmp|svg))(?:\?.*)?$/i;

function getImageUrl(text: string): string | undefined {
  const raw = text.trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return undefined;
  return imageUrlRegex.test(raw) ? raw : undefined;
}

function onKeydown(e: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function onSpeakerInput() {
  // allow only A-Z a-z 0-9 characters
  speaker.value = speaker.value.replace(/[^A-Za-z0-9]/g, '');
}

// scroll to bottom when switching channels
watch(activeChannel, async () => {
  // request history for the newly active channel to ensure we have recent messages
  try { requestHistory(activeChannel.value, 200); } catch (e) { /* ignore */ }
  await nextTick();
  scrollToBottom();
});

onMounted(() => {
  scrollToBottom();
  connectWs();
});

onBeforeUnmount(() => {
  closeWs();
});
</script>

<template>
  <div class="page">
    <div class="stage">
      <div class="shell">
      <!-- Sidebar -->
      <aside class="sidebar glass">
        <div class="brand">
          <div class="dot" :class="wsStatus === 'connected' ? 'ok' : 'warn'"></div>
          <div class="title">
            <div class="name">Nectmania IRC</div>
            <div class="sub">PC Demo UI</div>
          </div>
        </div>

        <div class="section">
          <div class="sectionTitle">Channels</div>
          <div class="chanList">
            <button
              v-for="c in channels"
              :key="c"
              class="chan"
              :class="{ active: c === activeChannel }"
              @click="activeChannel = c"
            >
              {{ c }}
            </button>
          </div>
        </div>

        <div class="section foot">
          <div class="mini">
            <div class="avatar">
              <img class="avatarImg" src="/avatar.jpg" alt="" />
            </div>
            <div class="meta">
              <div class="who">{{ localIp ?? 'Guest' }}</div>
              <div class="status" v-if="wsStatus !== 'connected'">{{ wsStatus }}</div>
              <div class="status" v-else>connected<span v-if="latency !== null"> ({{ latency }} ms)</span></div>
            </div>
          </div>
        </div>
      </aside>

      <!-- Main -->
      <main class="main glass">
        <header class="topbar">
          <div class="left">
            <div class="pill">{{ activeChannel }}</div>
            <div class="hint">Frosted Glass Theme By kyroslee</div>
          </div>
          <div class="right"></div>
        </header>

        <section class="messages" ref="listRef">
          <div class="msgWrap">
            <div
              v-for="m in currentMessages"
              :key="m.id"
              class="msg"
              :class="m.role"
            >
              <div class="line">
                <span class="role">[{{ m.identity ?? (m.role === 'user' ? 'You' : 'System') }}]</span>
                <span class="text" v-if="!getImageUrl(m.text)">{{ m.text }}</span>
                <span class="text" v-else>
                  <img class="msgImage" :src="getImageUrl(m.text)" alt="" loading="lazy" />
                </span>
              </div>
              <div class="metaRow">
                <div class="ts">{{ formatTime(m.ts) }}</div>
                <div class="ip" v-if="m.ip">{{ m.ip }}</div>
              </div>
            </div>
          </div>
        </section>

        <footer class="composerWrap">
          <form class="composer glass2" @submit.prevent="send">
              <input v-model="speaker" @input="onSpeakerInput" class="speaker" placeholder="Username" />
            <textarea
              v-model="input"
              class="input"
              placeholder="Message… (Enter 发送 / Shift+Enter 换行)"
              rows="1"
              @keydown="onKeydown"
            ></textarea>
            <button class="send" type="submit" :disabled="!speaker">Send</button>
          </form>
          <div class="tips">Nectmania 2020-2026 ,CylorineNET & Lazuritium Before. Since 2020. </div>
        </footer>
      </main>
      </div>
    </div>
  </div>
</template>

<style>
:root{
  /* Dark theme base */
  --bg-start: #05060a;
  --bg-end: #0e1420;

  --glass-bg: rgba(255,255,255,.04);
  --glass-bd: rgba(255,255,255,.06);
  --glass-blur: 14px;
  --glass-shadow: 0 18px 60px rgba(0,0,0,.6);

  /* Fluid UI variables */
  --sidebar-w: clamp(240px, 18vw, 320px);
  --gap: clamp(10px, 1.6vw, 20px);
  --page-padding: clamp(4px, 0.8vw, 16px);
  --shell-padding: clamp(8px, 1.2vw, 20px);
  --radius: clamp(8px, 1vw, 20px);
  --font-base: clamp(13px, 1vw, 16px);
  --msg-font: clamp(14px, 0.9vw, 16px);

  --text: rgba(255,255,255,.94);
  --muted: rgba(255,255,255,.6);
}

*{ box-sizing: border-box; }
body{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }

.page{
  height: 100vh;
  width: 100%;
  padding: 0; /* move outer padding to .stage to ensure equal margins */
  overflow: hidden; /* only inner areas scroll */
  /* dark gradient overlay + background image */
  background-image: linear-gradient(180deg, rgba(5,6,10,0.65), rgba(14,20,32,0.65)), url('/bg2.jpg');
  background-size: cover, cover;
  background-position: center center, center center;
  background-repeat: no-repeat, no-repeat;
  color: var(--text);
  box-sizing: border-box;
}

.glass{
  background: var(--glass-bg);
  border: 1px solid var(--glass-bd);
  border-radius: var(--radius);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.glass2{
  background: rgba(255,255,255,.08);
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 16px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))){
  .glass, .glass2{ background: rgba(20,20,20,.55); }
}

.shell{
  height: 100%;
  width: 100%;
  margin: 0;
  display: flex;
  gap: var(--gap);
  padding: var(--shell-padding);
  box-sizing: border-box;
}

/* Responsive adjustments */
@media (max-width: 1100px) {
  .shell{
    gap: clamp(10px, 2vw, 18px);
    padding: clamp(10px, 2vw, 20px);
  }
  .chan{ padding: clamp(8px, 1.5vw, 10px); }
}

@media (max-width: 900px) {
  :root{
    --sidebar-w: 0px;
    --gap: clamp(8px, 3vw, 16px);
    --shell-padding: clamp(8px, 3vw, 16px);
    --page-padding: clamp(6px, 2vw, 12px);
    --radius: clamp(6px, 1vw, 12px);
  }

  .shell{
    flex-direction: column; /* single column */
    gap: var(--gap);
    padding: var(--shell-padding);
  }

  .sidebar{
    display: block;
    padding: 10px;
  }

  .messages{
    padding: 0 6px;
  }

  .section{
    margin-top: 8px;
    padding: 8px;
  }

  .chanList{
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chan{
    width: auto;
  }
}

/* Sidebar */
.sidebar{
  flex: 0 0 var(--sidebar-w);
  width: var(--sidebar-w);
  padding: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.brand{
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
}

.brand { justify-content: flex-start; }
.title { text-align: center; flex: 1; }

.dot{
  position: absolute;
  left: 25px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px; height: 12px;
  border-radius: 999px;
  background: rgba(255,255,255,.75);
  box-shadow: 0 0 0 6px rgba(255,255,255,.10);
}
.dot.ok{ background: #36d66a; }
.dot.warn{ background: #f4c542; }

.title .name{ font-weight: 650; letter-spacing: .2px; }
.title .sub{ font-size: 12px; color: var(--muted); margin-top: 2px; }

.section{
  margin-top: 10px;
  padding: 10px;
  border-radius: 14px;
  background: rgba(255,255,255,.05);
  border: 1px solid rgba(255,255,255,.10);
}

.sectionTitle{
  font-size: 15px;
  color: var(--muted);
  margin-bottom: 14px;
}

.chanList{
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chan{
  width: 100%;
  text-align: left;
  padding: 10px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.06);
  color: var(--text);
  cursor: pointer;
}

.chan:hover{
  background: rgba(255,255,255,.10);
}

/* Stage: adds equal outer spacing around the shell */
.stage{
  width: 100%;
  height: 100%;
  padding: var(--page-padding);
  box-sizing: border-box;
}

.chan.active{
  background: rgba(255,255,255,.14);
  border-color: rgba(255,255,255,.22);
}

.foot{
  margin-top: auto;
}

.mini{
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar{
  width: 34px; height: 34px;
  border-radius: 12px;
  background: rgba(255,255,255,.14);
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.18);
}
.avatarImg{
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.meta .who{ font-weight: 600; font-size: 14px; }
.meta .status{ font-size: 12px; color: var(--muted); margin-top: 2px; }

/* Main */
.main{
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar{
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.04);
}

.pill{
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(255,255,255,.08);
  font-weight: 650;
  letter-spacing: .2px;
}

.hint{
  display: inline-block;
  margin-left: 10px;
  font-size: 12px;
  color: var(--muted);
}

.right{ display: flex; gap: 8px; }

.wsStatus{ display:inline-flex; align-items:center; padding:6px 8px; color:var(--muted); font-size:12px; }
.composer .speaker{ width: 120px; min-width: 100px; max-width: 180px; padding:10px; height:44px; box-sizing:border-box; border-radius:8px; border:1px solid rgba(255,255,255,.08); background: rgba(0,0,0,.12); color:var(--text); font-size:15px; }

.messages{
  flex: 1;
  overflow: auto;
  padding: 18px 10px;
}

.msgWrap{
  max-width: 100%;
  margin: 0;
  padding: 0 12px 18px 8px;
}

.msg{
  display: block;
  margin: 6px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

/* Console-style single-line messages (no bubbles) */
.line{
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 6px 8px;
  border-radius: 6px;
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Roboto Mono', 'Courier New', monospace;
  white-space: pre-wrap;
}

.line .role{
  color: var(--muted);
  font-size: 12px;
  min-width: 72px;
}

.line .text{
  color: var(--text);
  flex: 1;
}

.msg.assistant{ text-align: left; }
.msg.user{ text-align: left; }

/* timestamp styling */
.ts{
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
  opacity: 0.55;
}

.ip{
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
  opacity: 0.6;
}

.role{
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}

.text{
  white-space: pre-wrap;
  line-height: 1.55;
  font-size: 15px;
}
.msgImage{
  max-width: min(320px, 100%);
  height: auto;
  border-radius: 10px;
  display: block;
}

/* Composer */
.composerWrap{
  padding: 12px 16px 8px;
  border-top: 1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.03);
}

.composer{
  display: flex;
  gap: 10px;
  padding: 10px;
  align-items: center;
}

.input{
  flex: 1;
  resize: none;
  border: 0;
  outline: none;
  padding: 10px 10px;
  border-radius: 12px;
  background: rgba(0,0,0,.18);
  color: var(--text);
  min-height: 44px;
  line-height: 1.45;
  font-size: 14px;
}

.send{
  height: 44px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,.16);
  background: rgba(255,255,255,.10);
  color: var(--text);
  cursor: pointer;
  font-weight: 650;
}
.send:hover{ background: rgba(255,255,255,.14); }
.send:disabled{ opacity: 0.5; cursor: not-allowed; }

.tips{
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
</style>
