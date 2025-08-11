import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EVENT_MODULO, STATE_FILE, AUDIO_DIR } from './config.js';
import { buildPlaylistIndex } from './tracks.js';

const writeAtomic = (filePath, data) => {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  // fsync to disk, then rename
  const fd = fs.openSync(tmp, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, filePath);
};

export const nowSec = () => Math.floor(Date.now() / 1000);

export const newRoomState = (queue) => ({
  eventCount: 0,
  queue,
  playState: { mode: 'paused', anchorPositionSec: 0, wallTime: Date.now() / 1000 },
  clients: {},
});

export const loadState = async () => {
  let state = {};
  if (fs.existsSync(STATE_FILE)) {
    try {
      const txt = fs.readFileSync(STATE_FILE, 'utf8');
      state = JSON.parse(txt);
    } catch (e) {
      console.error('Fatal: corrupted state:', e);
      process.exit(1);
    }
  }
  // Build fresh playlist
  const playlist = await buildPlaylistIndex(AUDIO_DIR);
  const playlistIds = playlist.map(t => t.trackId);

  // For each room: rotate queue to align with new playlist, reset cached markers, bump eventCount
  for (const [room, rs] of Object.entries(state)) {
    let newQueue;
    if (Array.isArray(rs.queue) && rs.queue.length > 0) {
      const head = rs.queue[0];
      const idx = playlistIds.indexOf(head);
      if (idx >= 0) {
        newQueue = playlistIds.slice(idx).concat(playlistIds.slice(0, idx));
      } else {
        newQueue = playlistIds.slice();
      }
    } else {
      newQueue = playlistIds.slice();
    }
    rs.queue = newQueue;
    for (const c of Object.values(rs.clients || {})) {
      c.cachedHeadTrackId = null;
    }
    rs.eventCount = (rs.eventCount + 1) % EVENT_MODULO;
    if (!rs.playState) rs.playState = { mode: 'paused', anchorPositionSec: 0, wallTime: Date.now() / 1000 };
  }
  return { state, playlist };
};

export const saveState = (state) => {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
};

export const bumpEvent = (roomState) => {
  roomState.eventCount = (roomState.eventCount + 1) % EVENT_MODULO;
};

export const activeClientIds = (roomState) => {
  const t = nowSec();
  return Object.entries(roomState.clients)
    .filter(([id, c]) => c.sse === true && t - (c.lastPingSec || 0) <= 6)
    .map(([id]) => id);
};

export const barrierSatisfied = (roomState) => {
  const head = roomState.queue[0];
  const active = activeClientIds(roomState);
  if (active.length === 0) return true; // nobody to wait for
  for (const id of active) {
    const c = roomState.clients[id];
    if (!c || c.cachedHeadTrackId !== head) return false;
  }
  return true;
};
