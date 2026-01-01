# Nectmania's IRC (Vue + WS + MySQL)

Frosted glass UI built with Vue 3 + Vite and a WebSocket server that persists messages to MySQL.

## Features
- WebSocket chat with channel switching
- Message history loaded from MySQL
- Optional image URL rendering (message is a single image URL)
- Responsive layout

## Requirements
- Node.js 18+ (recommended)
- MySQL 5.7+ / 8.0+

## Setup
```bash
npm install
```

## Database
Create table:
```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  channel VARCHAR(64) NOT NULL,
  ip VARCHAR(64),
  text TEXT NOT NULL,
  ts BIGINT NOT NULL,
  from_name VARCHAR(64),
  resolution VARCHAR(32),
  uuid VARCHAR(64)
);

CREATE INDEX idx_channel_ts ON chat_messages (channel, ts);
```

## Environment
The WS server reads MySQL settings from env vars:
```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=your_user
MYSQL_PASSWORD=your_password
MYSQL_DB=sql_irc
```

## Development
Start the WS server:
```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=your_user \
MYSQL_PASSWORD=your_password MYSQL_DB=sql_irc \
node server/ws-server.mjs
```

Start the Vite dev server:
```bash
npm run dev
```

## Production
Build:
```bash
npm run build
```

Preview locally:
```bash
npm run preview -- --host 0.0.0.0 --port 4173
```

## WebSocket Protocol
Client -> Server:
- `say`: `{ type: "say", channel, text, ts, from, resolution, uuid }`
- `history`: `{ type: "history", channel, limit }`

Server -> Client:
- `msg`: `{ type: "msg", channel, from, text, ts, fromIp }`
- `history`: `{ type: "history", channel, items }`

## Notes
- History queries are ordered by `ts` and limited to 500 max.
- Local assets live in `public/` (e.g. `avatar.jpg`, `bg2.jpg`).
