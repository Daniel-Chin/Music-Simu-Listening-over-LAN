import fs      from 'node:fs/promises';
import fssync  from 'node:fs';
import path    from 'node:path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

import express from 'express';
import mime from 'mime';
import { nanoid } from 'nanoid';
import ffm     from 'fluent-ffmpeg';
import QRCode from 'qrcode';

import {
  PORT, AUDIO_DIR, ROOM_CODE_LENGTH, HEARTBEAT_SEC, DEV_MODE, 
  CACHE_DIR,
} from './config.js';
import {
  loadState, saveState, newRoomState, bumpEvent, nowSec, 
  barrierSatisfied, setQueueToPlaylistKeepingHead,
} from './state.js';

const LEAD_AGAINST_LATENCY = 0.5;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: '2mb' }));

// in-memory live state (persisted on every accepted event)
let playlist = [];
let rooms = {};  // map room_code -> room state
const sseStreams = new Map(); // room_code => Map(clientName => res)

try {
  const { default: ffmpegPath } = await import('ffmpeg-static');
  if (ffmpegPath) ffm.setFfmpegPath(ffmpegPath);
} catch { /* optional */ }

await fs.mkdir(CACHE_DIR, { recursive: true });
const cachePathFor = (id) => path.join(CACHE_DIR, `${id}.opus`);
const inflight = new Map(); // id -> Promise<string outPath>

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

const wallTime = () => (Date.now() / 1000);

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

const fullSnapshot = (rs) => {
  return {
    roomState: rs,
    index: playlist,
  };
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
      const buf = fssync.readFileSync(file);
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
app.use('/cache', express.static(CACHE_DIR, {
  immutable: true,
  maxAge: '30d',
  setHeaders: (res) => {
    // Weak ETag is already added by express.static; adding Cache-Control here.
    res.setHeader('Accept-Ranges', 'bytes');
  },
}));

app.get('/file/:trackId', async (req, res, next) => {
  const { trackId } = req.params;
  const item = playlist.find(t => t.trackId === trackId);
  if (!item) return res.status(404).send('track not found');
  const src_path = path.join(AUDIO_DIR, item.fileName);
  const cache_path = cachePathFor(trackId);
  let promise = inflight.get(trackId);
  if ((!promise) && fssync.existsSync(cache_path)) {
    console.log(`cache hits: ${trackId}`);
  } else {
    if (!promise) {
      console.log(`transcoding ${trackId}...`);
      promise = transcodeOpus(src_path, cache_path);
      inflight.set(trackId, promise);
      promise.finally(() => {
        inflight.delete(trackId);
        console.log(`transcoded ${trackId}.`);
      });
    }
    await promise;
  }
  req.url = `/cache/${path.basename(cache_path)}`;
  return app._router.handle(req, res, next);
});

const transcodeOpus = async (src_path, cache_path) => {
  // ffmpeg -i in.wav -c:a libopus -b:a 128k out.opus
  return await new Promise((resolve, reject) => {
    ffm(src_path)
      .noVideo()
      .audioCodec('libopus')
      .audioBitrate('128k')
      .format('opus')
      .outputOptions([
        '-sn', '-dn',               // drop subs/data: -sn -dn
        '-map', '0:a:0',            // pick first audio: -map 0:a:0
        // '-map_chapters', '-1',      // drop chapters
        '-map_metadata', '0',       // keep global metadata
        '-vbr', 'on',               // libopus VBR
        '-compression_level', '10', // libopus quality
      ])
      // .on('start', cmd => console.log('ffmpeg:', cmd))
      .on('error', reject)
      .on('end', resolve)
      .save(cache_path);
  });
};

app.post('/snapshot', (req, res) => {
  const room = req.body.room;
  const rs = getRoomState(room, res);
  if (rs === null) return;
  res.json(fullSnapshot(rs));
});

const updateBarrier = (rs) => {
  if (rs.playState.mode === 'onBarrier' && barrierSatisfied(rs)) {
    playSong(rs);
  }
};

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

  req.on('close', () => {
    // SSE closed
    sseStreams.get(room)?.delete(clientName);
    // Re-evaluate barrier (primary signal is SSE close)
    updateBarrier(rs);
    afterEvent(room, rs);
  });
});

app.post('/ping', (req, res) => {
  const { clientName, room } = req.body;
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

app.post('/time', (req, res) => {
  res.json(wallTime());
});

const playSong = (rs) => {
  rs.playState = {
    mode: 'playing',
    wallTimeAtSongStart: wallTime() - rs.playState.songTimeAtPause + LEAD_AGAINST_LATENCY,
    songTimeAtPause: null,
  };
};

// Control (requires If-Match-Event)
app.post('/play', (req, res) => {
  const { room } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;
  switch (rs.playState.mode) {
    case 'playing':
      res.end('Already playing');
      return;
    case 'onBarrier':
      res.end('Not so fast');
      return;
    case 'paused':
      playSong(rs);
      afterEvent(room, rs);
      res.json({ ok: true });
      return;
    default:
      console.error(`Unknown play state: ${rs.playState.mode}`);
      return;
  }
});

app.post('/pause', (req, res) => {
  const { room } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;
  switch (rs.playState.mode) {
    case 'playing':
      rs.playState = {
        mode: 'paused',
        wallTimeAtSongStart: null,
        songTimeAtPause: wallTime() - rs.playState.wallTimeAtSongStart,
      };
      afterEvent(room, rs);
      res.json({ ok: true });
      return;
    case 'onBarrier':
      res.end('Not so fast');
      return;
    case 'paused':
      res.end('already paused');
      return;
    default:
      console.error(`Unknown play state: ${rs.playState.mode}`);
  }
});

app.post('/seek', (req, res) => {
  const { room, positionSec } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;
  switch (rs.playState.mode) {
    case 'onBarrier':
      res.end('Not so fast');
      return;
    case 'playing':
      rs.playState = {
        mode: 'playing',
        wallTimeAtSongStart: wallTime() - positionSec + LEAD_AGAINST_LATENCY,
        songTimeAtPause: null,
      };
      afterEvent(room, rs);
      res.json({ ok: true });
      return;
    case 'paused':
      rs.playState = {
        mode: 'paused',
        wallTimeAtSongStart: null,
        songTimeAtPause: positionSec,
      }
      afterEvent(room, rs);
      res.json({ ok: true });
      return;
    default:
      console.error(`Unknown play state: ${rs.playState.mode}`);
  }
});

const rotateQueue = (rs, is_next_not_prev) => {
  if (is_next_not_prev) {
    const head = rs.queue.shift();
    rs.queue.push(head);
  } else {
    const tail = rs.queue.pop();
    rs.queue.unshift(tail);
  }
  rs.playState = {
    mode: 'onBarrier', 
    wallTimeAtSongStart: null,
    songTimeAtPause: 0,
  };
  // null all cached markers (clients must re-assert for new head)
  for (const c of Object.values(rs.clients)) c.cachedHeadTrackId = null;
};

app.post('/next', (req, res) => {
  const { room } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  rotateQueue(rs, true);

  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/prev', (req, res) => {
  const { room } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  rotateQueue(rs, false);

  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/nudge', (req, res) => {
  const { room, trackId } = req.body;
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

const swap = (arr, i, j) => {
  [arr[i], arr[j]] = [arr[j], arr[i]];
};

const shuffleArrayInPlace = (arr) => {
  // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    swap(arr, i, j);
  }
};

app.post('/shuffle-queue', (req, res) => {
  const { room } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  const head = rs.queue[0];
  shuffleArrayInPlace(rs.queue);
  const idx = rs.queue.indexOf(head);
  swap(rs.queue, 0, idx); // put head back to the front
  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/reset-queue', (req, res) => {
  const { room } = req.body;
  const rs = getRoomState(room, res);
  if (!checkEventCount(req, res, rs)) return;

  setQueueToPlaylistKeepingHead(rs, playlist);
  afterEvent(room, rs);
  res.json({ ok: true });
});

app.post('/cache-head', (req, res) => {
  const { room, clientName, trackId } = req.body;
  const rs = getRoomState(room, res);

  const c = rs.clients[clientName];
  if (!c) return res.status(404).json({ error: `client ${clientName} not found` });
  c.cachedHeadTrackId = trackId;
  
  // Evaluate barrier, and if satisfied and currently onBarrier, release
  updateBarrier(rs);
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
