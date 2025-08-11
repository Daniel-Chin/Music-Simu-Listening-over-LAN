import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import mime from 'mime';

import { PORT, AUDIO_DIR, STATE_FILE, ROOM_CODE_LENGTH, HEARTBEAT_SEC, DEV_MODE, EVENT_MODULO } from './config.js';
import { loadState, saveState, newRoomState, bumpEvent, nowSec, activeClientIds, barrierSatisfied } from './state.js';
import { buildPlaylistIndex, hashId } from './tracks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: '2mb' }));

// in-memory live state (persisted on every accepted event)
let playlist = [];
let rooms = {};  // map room_code -> room state
const sseStreams = new Map(); // room_code => Map(clientId => res)

const boot = async () => {
  const loaded = await loadState();
  rooms = loaded.state || {};
  playlist = loaded.playlist || [];
  if (Object.keys(rooms).length === 0) {
    const room = randomRoomCode();
    rooms[room] = newRoomState(playlist.map(t => t.trackId));
    saveState(rooms);
  }
  printLandingURL();
};

// Helpers
const randomRoomCode = () => nanoid(ROOM_CODE_LENGTH).toLowerCase().replace(/[^a-z0-9]/g,'');

const advanceTime = (st) => {
  if (st.playState.mode !== 'playing')
    return;
  const oldTime = st.playState.anchorPositionSec;
  const elapsed = Date.now() / 1000 - (st.playState.wallTime || 0);
  st.playState.anchorPositionSec = Math.max(0, oldTime + elapsed);
  st.playState.wallTime = Date.now() / 1000;
  return;
};

const getRoom = (room_code) => {
  const rs = rooms[room_code];
  if (!rs) throw Object.assign(new Error('room not found'), { status: 404 });
  return rs;
};

const pushSSE = (room_code, evt) => {
  const streams = sseStreams.get(room_code);
  if (!streams) return;
  console.log(`Pushing SSE with eventCount ${evt.eventCount}`);
  for (const [cid, res] of streams.entries()) {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (e) {
      // ignore broken pipe
    }
  }
};

const fullSnapshot = (room_code) => {
  const rs = getRoom(room_code);
  return {
    room: room_code,
    eventCount: rs.eventCount,
    queue: rs.queue,
    playState: rs.playState,
    clients: rs.clients,
    index: playlist,
  };
};

const acceptEvent = (room_code, mutate) => {
  const rs = getRoom(room_code);
  advanceTime(rs);
  mutate(rs);
  bumpEvent(rs);
  saveState(rooms);
  pushSSE(room_code, { event: 'state', payload: fullSnapshot(room_code), eventCount: rs.eventCount });
};

const requireMatchHeader = (req, rs) => {
  const h = req.get('If-Match-Event');
  const n = h ? parseInt(h, 10) : NaN;
  if (Number.isNaN(n) || n !== rs.eventCount) {
    return false;
  }
  return true;
};

// UI pages
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/landing.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// Discovery & Pairing
app.get('/qr', async (req, res) => {
  const room_code = (req.query.room_code || '').toString();
  if (!rooms[room_code]) return res.status(404).send('room not found');
  const url = `${guessBaseURL(req)}/?room=${encodeURIComponent(room_code)}`;
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(url, { errorCorrectionLevel: 'M' }));
});

app.post('/pair', (req, res) => {
  const { room_code, clientName } = req.body || {};
  if (!rooms[room_code]) return res.status(404).json({ error: 'room not found' });
  if (!clientName || String(clientName).length > 40) return res.status(400).json({ error: 'invalid name' });
  const clientId = nanoid(10);
  const rs = rooms[room_code];
  rs.clients[clientId] = {
    name: clientName,
    lastPingSec: nowSec(),
    sse: false,
    cachedHeadTrackId: null,
  };
  saveState(rooms);
  res.json({ clientId, eventCount: rs.eventCount, snapshot: fullSnapshot(room_code) });
});

// Index & Metadata
app.get('/index', (req, res) => {
  res.json(playlist);
});

app.get('/cover/:trackId', async (req, res) => {
  const { trackId } = req.params;
  const item = playlist.find(t => t.trackId === trackId);
  if (!item) return res.status(404).send('not found');
  // Use music-metadata to extract picture if any
  try {
    const file = path.join(AUDIO_DIR, item.fileName);
    const mmAny = await import('music-metadata');
    let meta = {};
    try {
      const buf = fs.readFileSync(file);
      meta = await mmAny.parseBuffer(buf, { mimeType: mime.getType(file) || undefined }, { duration: false });
    } catch {}
    const pic = meta.common && Array.isArray(meta.common.picture) ? meta.common.picture[0] : null;
    if (pic) {
      res.setHeader('Content-Type', pic.format || 'image/jpeg');
      return res.end(Buffer.from(pic.data));
    }
  } catch {}
  res.status(404).send('no cover');
});

// Files
app.get('/file/:trackId', (req, res) => {
  const { trackId } = req.params;
  const item = playlist.find(t => t.trackId === trackId);
  if (!item) return res.status(404).send('not found');
  const fpath = path.join(AUDIO_DIR, item.fileName);
  const type = item.mime || mime.getType(fpath) || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  const stream = fs.createReadStream(fpath);
  stream.pipe(res);
});

// State & SSE
app.get('/snapshot', (req, res) => {
  const room = (req.query.room || '').toString();
  if (!rooms[room]) return res.status(404).send('room not found');
  res.json(fullSnapshot(room));
});

app.get('/events', (req, res) => {
  const room = (req.query.room || '').toString();
  const clientId = (req.query.clientId || '').toString();
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  // mark SSE open
  rs.clients[clientId] && (rs.clients[clientId].sse = true);
  if (!sseStreams.has(room)) sseStreams.set(room, new Map());
  sseStreams.get(room).set(clientId, res);

  req.on('close', () => {
    // SSE closed
    rs.clients[clientId] && (rs.clients[clientId].sse = false);
    sseStreams.get(room)?.delete(clientId);
    // Re-evaluate barrier (primary signal is SSE close)
    if (rs.playState?.mode === 'onBarrier' && barrierSatisfied(rs)) {
      acceptEvent(room, (st) => { st.playState.mode = 'playing'; });
    } else {
      saveState(rooms);
    }
  });
});

app.post('/ping', (req, res) => {
  const { clientId, room } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  const c = rs.clients[clientId];
  if (c) c.lastPingSec = nowSec();
  saveState(rooms);
  res.json({ ok: true });
});

// Control (requires If-Match-Event)
app.post('/play', (req, res) => {
  const { room, positionSec } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  if (!requireMatchHeader(req, rs)) {
    return res.status(409).json({ expectedEventCount: rs.eventCount, snapshot: fullSnapshot(room) });
  }
  acceptEvent(room, (st) => {
    st.playState = {
      mode: 'playing', 
      anchorPositionSec: Math.max(0, Number(positionSec) || 0),
      wallTime: Date.now() / 1000
    };
  });
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

app.post('/pause', (req, res) => {
  const { room } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  if (!requireMatchHeader(req, rs)) {
    return res.status(409).json({ expectedEventCount: rs.eventCount, snapshot: fullSnapshot(room) });
  }
  acceptEvent(room, (st) => {
    st.playState.mode = 'paused';
  });
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

app.post('/seek', (req, res) => {
  const { room, positionSec } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  if (!requireMatchHeader(req, rs)) {
    return res.status(409).json({ expectedEventCount: rs.eventCount, snapshot: fullSnapshot(room) });
  }
  acceptEvent(room, (st) => {
    st.playState.anchorPositionSec = Math.max(0, Number(positionSec) || 0);
  });
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

app.post('/next', (req, res) => {
  const { room } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  if (!requireMatchHeader(req, rs)) {
    return res.status(409).json({ expectedEventCount: rs.eventCount, snapshot: fullSnapshot(room) });
  }
  acceptEvent(room, (st) => {
    // move head to tail (circular queue), reset playState to onBarrier
    const head = st.queue.shift();
    st.queue.push(head);
    st.playState = { mode: 'onBarrier', anchorPositionSec: 0, wallTime: Date.now() / 1000 };
    // null all cached markers (clients must re-assert for new head)
    for (const c of Object.values(st.clients)) c.cachedHeadTrackId = null;
  });
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

app.post('/prev', (req, res) => {
  const { room } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  if (!requireMatchHeader(req, rs)) {
    return res.status(409).json({ expectedEventCount: rs.eventCount, snapshot: fullSnapshot(room) });
  }
  acceptEvent(room, (st) => {
    const tail = st.queue.pop();
    st.queue.unshift(tail);
    st.playState = { mode: 'onBarrier', anchorPositionSec: 0, wallTime: Date.now() / 1000 };
    for (const c of Object.values(st.clients)) c.cachedHeadTrackId = null;
  });
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

app.post('/nudge', (req, res) => {
  const { room, trackId } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  if (!requireMatchHeader(req, rs)) {
    return res.status(409).json({ expectedEventCount: rs.eventCount, snapshot: fullSnapshot(room) });
  }
  acceptEvent(room, (st) => {
    const idx = st.queue.indexOf(trackId);
    if (idx > 0) {
      st.queue.splice(idx, 1);
      st.queue.splice(1, 0, trackId); // next-up
    }
  });
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

app.post('/cache-head', (req, res) => {
  const { room, clientId, trackId } = req.body || {};
  if (!rooms[room]) return res.status(404).end();
  const rs = rooms[room];
  const head = rs.queue[0];
  if (trackId !== head) return res.status(400).json({ error: 'trackId must equal current head' });
  const c = rs.clients[clientId];
  if (!c) return res.status(404).json({ error: 'client not found' });
  c.cachedHeadTrackId = trackId;
  saveState(rooms);
  // Evaluate barrier, and if satisfied and currently onBarrier, release
  if (rs.playState?.mode === 'onBarrier' && barrierSatisfied(rs)) {
    acceptEvent(room, (st) => { st.playState.mode = 'playing'; });
  }
  res.json({ eventCount: rs.eventCount, snapshot: fullSnapshot(room) });
});

// Debug (dev-only)
app.get('/debug/state', (req, res) => {
  if (!DEV_MODE) return res.status(404).end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(rooms, null, 2));
});

// Cover / client static
app.use('/static', express.static(path.join(__dirname, '../client/public')));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/favicon.ico'));
});

// Helper to build a base URL with LAN IP
const guessBaseURL = (req) => {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
};

const getLanIPs = () => {
  const nets = networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
};

const printLandingURL = () => {
  const roomsList = Object.keys(rooms);
  const room = roomsList[0];
  const ips = getLanIPs();
  const base = ips.length ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`;
  console.log(`Landing page: ${base}/landing?room=${room}`);
};

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  boot().catch(err => { console.error(err); process.exit(1); });
});
