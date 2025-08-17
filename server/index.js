import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import mime from 'mime';

import { PORT, AUDIO_DIR, ROOM_CODE_LENGTH, HEARTBEAT_SEC, DEV_MODE } from './config.js';
import { loadState, saveState, newRoomState, bumpEvent, nowSec, barrierSatisfied } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: '2mb' }));

// in-memory live state (persisted on every accepted event)
let playlist = [];
let rooms = {};  // map room_code -> room state
const sseStreams = new Map(); // room_code => Map(clientName => res)

// arm lead for synchronized starts
const ARM_LEAD_SEC = 1.2;

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

const handleJoin = (req, res, next) => {
  const {clientName, room} = req.body;
  const rs = rooms[room];
  if (clientName && rs) {
    if (clientName in rs.clients) {
      rs.clients[clientName].lastPingSec = nowSec();
    } else {
      rs.clients[clientName] = {
        lastPingSec: nowSec(), 
        cachedHeadTrackId: null, 
      }
      console.log(`Hello, ${clientName}`);
    }
  }
  next();
};

app.use(handleJoin);

const getRoomState = (room_code, res) => {
  if (!rooms[room_code]) {
    res.status(404).send('room not found').end();
    return null;
  } else {
    return rooms[room_code];
  }
};

const fullSnapshot = (rs) => {
  return {
    roomState: rs,
    index: playlist,
    serverNowSec: Date.now() / 1000,
  };
};

const pushSSE = (room_code, rs) => {
  const streams = sseStreams.get(room_code);
  if (!streams) return;
  const snapshot = fullSnapshot(rs);
  console.log(`Pushing SSE with eventCount ${snapshot.roomState.eventCount}`);
  for (const [cid, res] of streams.entries()) {
    try {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch (e) {
      // ignore broken pipe
    }
  }
};

const afterEvent = (room_code, rs) => {
  bumpEvent(rs);
  saveState(rooms);
  pushSSE(room_code, rs);
};

const checkEventCount = (req, res, rs) => {
  const h = req.get('If-Match-Event');
  const n = h ? parseInt(h, 10) : NaN;
  if (Number.isNaN(n) || n !== rs.eventCount) {
    res.status(409).json(fullSnapshot(rs));
    console.log(`eventCount is ${rs.eventCount} but client thinks ${n}`);
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
  const url = `${guessBaseURL(req)}/?room=${encodeURIComponent(room_code)}`;
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(url, { errorCorrectionLevel: 'M' }));
});

// Index & Metadata
app.get('/index', (req, res) => {
  res.json(playlist);
});

app.get('/cover/:trackId', async (req, res) => {
  const { trackId } = req.params;
  const item = playlist.find(t => t.trackId === trackId);
  if (!item) return res.status(404).send('track not found');
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
  if (!item) return res.status(404).send('track not found');
  const fpath = path.join(AUDIO_DIR, item.fileName);
  const type = item.mime || mime.getType(fpath) || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  const stream = fs.createReadStream(fpath);
  stream.pipe(res);
});

app.post('/snapshot', (req, res) => {
  const room = req.body.room;
  const rs = getRoomState(room, res);
  if (rs === null) return;
  res.json(fullSnapshot(rs));
});

// SSE
app.get('/events', (req, res) => {
  const room = (req.query.room || '').toString();
  const clientName = (req.query.clientName || '').toString();
  const rs = getRoomState(room, res);
  if (rs === null) {
    console.log('Terminating event stream because room is not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  if (!sseStreams.has(room)) sseStreams.set(room, new Map());
  sseStreams.get(room).set(clientName, res);

  // mark client's SSE present
  rs.clients[clientName] = rs.clients[clientName] || { lastPingSec: nowSec(), cachedHeadTrackId: null };
  rs.clients[clientName].sse = true;

  req.on('close', () => {
    // SSE closed
    sseStreams.get(room)?.delete(clientName);
    if (rs.clients[clientName]) rs.clients[clientName].sse = false;
    // Re-evaluate barrier (primary signal is SSE close)
    if (rs.playState?.mode === 'onBarrier' && barrierSatisfied(rs)) {
      // arm a future start
      rs.playState = { mode: 'armed', wallTimeAtSongStart: Date.now() / 1000 + ARM_LEAD_SEC, pausedPositionSec: 0 };
      afterEvent(room, rs);
    } else {
      saveState(rooms);
    }
  });
});

// Time sync for session clock
app.post('/time', (req, res) => {
  res.json({ nowSec: Date.now() / 1000 });
});

app.post('/ping', (req, res) => {
  const { clientName, room } = req.body || {};
  const rs = getRoomState(room, res);
  const c = rs.clients[clientName];
  if (c) c.lastPingSec = nowSec();

  // Evict stale clients (no heartbeat in > 2 * HEARTBEAT_SEC)
  const now = nowSec();
  for (const [cid, client] of Object.entries(rs.clients)) {
    if (now - client.lastPingSec > HEARTBEAT_SEC * 2) {
      console.log(`Evicting stale client ${cid} from room ${room}`);
      delete rs.clients[cid];
      sseStreams.get(room)?.delete(cid);
    }
  }
  
  afterEvent(room, rs);
  res.json({ ok: true });
});

// Control (requires If-Match-Event)
app.post('/play', (req, res) => {
  const { room, positionSec } = req.body || {};
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;
  const pos = Math.max(0, Number(positionSec) || 0);
  const startAt = Date.now() / 1000 + ARM_LEAD_SEC;
  rs.playState = {
    mode: 'onBarrier',
    wallTimeAtSongStart: startAt - pos,
    pausedPositionSec: 0
  };
  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/pause', (req, res) => {
  const { room } = req.body || {};
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;
  // compute current position from WTASS if available; otherwise keep previous pausedPositionSec
  let curPos = rs.playState?.pausedPositionSec || 0;
  if (rs.playState?.wallTimeAtSongStart && (rs.playState.mode === 'playing' || rs.playState.mode === 'armed')) {
    curPos = Math.max(0, (Date.now() / 1000) - rs.playState.wallTimeAtSongStart);
  }
  rs.playState = { mode: 'paused', wallTimeAtSongStart: null, pausedPositionSec: curPos };
  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/seek', (req, res) => {
  const { room, positionSec } = req.body || {};
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;
  const pos = Math.max(0, Number(positionSec) || 0);
  const startAt = Date.now() / 1000 + ARM_LEAD_SEC;
  rs.playState = {
    mode: 'armed',
    wallTimeAtSongStart: startAt - pos,
    pausedPositionSec: 0
  };
  afterEvent(room, rs);
  res.json({ ok: true });
});

const rotateQueue = (rs, is_next_not_prev) => {
  if (is_next_not_prev) {
    const head = rs.queue.shift();
    rs.queue.push(head);
  } else {
    const tail = rs.queue.pop();
    rs.queue.unshift(tail);
  }
  // new head: wait for barrier first
  rs.playState = { mode: 'onBarrier', wallTimeAtSongStart: null, pausedPositionSec: 0 };
  // null all cached markers (clients must re-assert for new head)
  for (const c of Object.values(rs.clients)) c.cachedHeadTrackId = null;
};

app.post('/next', (req, res) => {
  const { room } = req.body || {};
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  rotateQueue(rs, true);

  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/prev', (req, res) => {
  const { room } = req.body || {};
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  rotateQueue(rs, false);

  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/nudge', (req, res) => {
  const { room, trackId } = req.body || {};
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  const idx = rs.queue.indexOf(trackId);
  if (idx > 0) {
    rs.queue.splice(idx, 1);
    rs.queue.splice(1, 0, trackId); // next-up
  }

  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/cache-head', (req, res) => {
  const { room, clientName, trackId } = req.body || {};
  const rs = getRoomState(room, res);

  const c = rs.clients[clientName];
  if (!c) return res.status(404).json({ error: `client ${clientName} not found` });
  // only accept mark for current head
  if (rs.queue[0] !== trackId) {
    return res.status(400).json({ error: 'trackId is not current head' });
  }
  c.cachedHeadTrackId = trackId;
  
  // Evaluate barrier; if satisfied and currently onBarrier, arm a future start
  if (rs.playState?.mode === 'onBarrier' && barrierSatisfied(rs)) {
    rs.playState = { mode: 'armed', wallTimeAtSongStart: Date.now() / 1000 + ARM_LEAD_SEC, pausedPositionSec: 0 };
  }
  afterEvent(room, rs);
  res.json({ ok: true });
});

// Debug (dev-only)
app.get('/debug/state', (req, res) => {
  if (!DEV_MODE) return res.status(403).end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(rooms, null, 2));
});

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
  console.log("Potential URLs:");
  for (const ip of ips) {
    console.log(`http://${ip}:${PORT}/?room=${room}`);
  }
};

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  boot().catch(err => { console.error(err); process.exit(1); });
});
