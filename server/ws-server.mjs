import { WebSocketServer } from 'ws';
import mysql from 'mysql2/promise';

const BASE_PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
let pool;

function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  return pool;
}

async function saveMessage({ channel, from, text, ts, ip, resolution, uuid }) {
  const db = getPool();
  await db.execute(
    'INSERT INTO chat_messages (channel, ip, text, ts, from_name, resolution, uuid) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [channel, ip, text, ts, from ?? null, resolution ?? null, uuid ?? null]
  );
}

async function fetchHistory(channel, limit = 200) {
  const db = getPool();
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 200;
  const [rows] = await db.execute(
    `SELECT channel, ip, text, ts, from_name AS \`from\`, resolution, uuid FROM chat_messages WHERE channel = ? ORDER BY ts DESC LIMIT ${safeLimit}`,
    [channel]
  );
  return rows.slice().reverse();
}

function startServer(port, maxRetries = 5) {
  try {
    const wss = new WebSocketServer({ port });
    console.log(`ws-server starting on port ${port}`);

    wss.on('connection', (ws, req) => {
      const forwarded = req.headers['x-forwarded-for'];
      const realIp = req.headers['x-real-ip'];
      const addr = (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined)
        || (typeof realIp === 'string' ? realIp.trim() : undefined)
        || req.socket.remoteAddress;
      console.log(`client connected: ${addr}`);

      const welcome = { type: 'sys', text: 'ws connected', ts: Date.now(), ip: addr };
      try { ws.send(JSON.stringify(welcome)); } catch (e) { console.error('send error', e); }

      ws.on('message', async (data) => {
        let payload;
        try {
          payload = JSON.parse(data.toString());
        } catch (err) {
          const msg = { type: 'sys', text: 'invalid json', ts: Date.now() };
          ws.send(JSON.stringify(msg));
          console.warn('invalid JSON from', addr, data.toString());
          return;
        }

        if (payload && payload.type === 'say') {
          const channel = payload.channel ?? '#general';
          const text = payload.text ?? '';
          // echo back using the client's ts when available to help client dedupe
          const replyTs = payload.ts ?? Date.now();
          const reply = { type: 'msg', channel, from: payload.from ?? 'echo', text, ts: replyTs, fromIp: addr };
          try {
            await saveMessage({
              channel,
              from: payload.from ?? 'echo',
              text,
              ts: replyTs,
              ip: addr,
              resolution: payload.resolution ?? null,
              uuid: payload.uuid ?? null,
            });
          } catch (err) {
            console.error('mysql save error', err);
          }
          // broadcast to all connected clients so multiple windows stay in sync
          wss.clients.forEach((client) => {
            try {
              if (client.readyState === client.OPEN) client.send(JSON.stringify(reply));
            } catch (e) {
              console.error('broadcast send error', e);
            }
          });
          console.log(`broadcast -> ${addr} [${channel}]: ${text}`);
          return;
        }

        if (payload && payload.type === 'history') {
          const channel = payload.channel ?? '#general';
          const limit = payload.limit ? Number(payload.limit) : 200;
          try {
            const items = await fetchHistory(channel, limit);
            const reply = { type: 'history', channel, items };
            ws.send(JSON.stringify(reply));
          } catch (err) {
            console.error('mysql history error', err);
            const msg = { type: 'sys', text: 'history error', ts: Date.now() };
            ws.send(JSON.stringify(msg));
          }
          return;
        }

        // handle ping for latency measurement
        if (payload && payload.type === 'ping') {
          const pingTs = payload.ts ?? Date.now();
          const pong = { type: 'pong', ts: pingTs };
          try { ws.send(JSON.stringify(pong)); } catch (e) { console.error('pong send error', e); }
          return;
        }

        // otherwise echo back a sys message with original payload
        const info = { type: 'sys', text: `echo: ${JSON.stringify(payload)}`, ts: Date.now() };
        try { ws.send(JSON.stringify(info)); } catch (e) { console.error('send error', e); }
      });

      ws.on('close', (code, reason) => {
        console.log(`client disconnected: ${addr} code=${code} reason=${reason.toString()}`);
      });

      ws.on('error', (err) => {
        console.error('ws error', err);
      });
    });

    wss.on('listening', () => console.log('ws-server listening'));
    wss.on('error', (err) => console.error('wss error', err));

    return wss;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE' && maxRetries > 0) {
      console.warn(`port ${port} in use, trying ${port + 1}...`);
      return startServer(port + 1, maxRetries - 1);
    }
    console.error('failed to start ws-server', err);
    throw err;
  }
}

const wss = startServer(BASE_PORT);
