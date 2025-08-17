// SPA client: tabs, SSE, caching, queue, controls
const LRU_SIZE = 3;

const qs = new URLSearchParams(location.search);
const room = qs.get('room') || localStorage.getItem('room') || '';
const clientName = localStorage.getItem('clientName') || '';
if (!room || !clientName) location.href = '/landing?room=' + encodeURIComponent(room || '');

const serverState = {
  roomState: null,
  snapshot: null,
  index: [],
};
const localState = {
  cacheRegistry: {},     // from trackId to blobURL
  recentLRU: [],         // last n played
};

let playbackOverseerID = null;

const els = {
  roomLabel: document.getElementById('room-label'),
  cover: document.getElementById('cover'),
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  audio: document.getElementById('audio'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  prevBtn: document.getElementById('prevBtn'),
  seek: document.getElementById('seek'),
  statusLine: document.getElementById('statusLine'),
  queueList: document.getElementById('queue-list'),
  bubble: document.getElementById('bubble'),
  currentInfo: document.getElementById('current-info'),
  shareUrl: document.getElementById('share-url'),
  qrImg: document.getElementById('qr-img'),
  roomCode: document.getElementById('room-code'),
  membersList: document.getElementById('members-list'),
  changeNameBtn: document.getElementById('changeNameBtn'),
};

els.roomLabel.textContent = room;
els.shareUrl.href = location.origin + '/?room=' + room;
els.shareUrl.textContent = els.shareUrl.href;
els.qrImg.src = '/qr?room_code=' + encodeURIComponent(room);
els.roomCode.textContent = 'Code: ' + room;

els.changeNameBtn.addEventListener('click', () => {
  // go to /landing with the same params
  window.location.href = `${window.location.origin}/landing?room=${room}`;
});

// Tabs
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// UI helpers
const showBubble = (msg) => {
  els.bubble.textContent = msg;
  els.bubble.classList.remove('hidden');
  setTimeout(() => els.bubble.classList.add('hidden'), 2500);
};
const findIndexItem = (trackId) => serverState.index.find(x => x.trackId === trackId) || null;

const playbackOverseer = () => {
  clearTimeout(playbackOverseerID);
  const playState = serverState?.roomState?.playState;
  if (! playState) return;
  switch (playState.mode) {
    case 'onBarrier':
      els.audio.pause().catch(()=>{});
      break;
    case 'paused':
      els.audio.pause();
      els.audio.currentTime = playState.songTimeAtPause;
      break;
    case 'playing':
      const target = serverWallTime() - playState.wallTimeAtSongStart;
      const delta = target - els.audio.currentTime;
      if (Math.abs(delta) > 0.5) {
        els.audio.currentTime = target;
        break;
      }
      if (Math.abs(delta) <= 0.010) break;
      const ADJUST = 0.1;
      if (delta > 0) {
        els.audio.playbackRate = 1 + ADJUST;
      } else {
        els.audio.playbackRate = 1 - ADJUST;
      }
      playbackOverseerID = setTimeout(
        playbackOverseer, Math.abs(delta) * 0.5 / ADJUST, 
      );
      break;
    default:
      console.error('Unknown playState mode:', playState.mode);
  }
};

// Networking primitives
const api = async (path, extraBody={}, requireEventHeader=false) => {
  const headers = { 'Content-Type': 'application/json' };
  if (requireEventHeader) headers['If-Match-Event'] = String(serverState.roomState.eventCount);
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify({
    room,
    clientName,
    ...extraBody,
  }) });
  if (r.status === 409) {
    const snapshot = await r.json();
    applySnapshot(snapshot);
    showBubble('Out-of-sync; refreshed.');
    return null;
  }
  if (r.status === 404) {
    alert(`Yo, 404. ${await r.text()}`);
    return null;
  }
  return await r.json();
};

const applySnapshot = (snap) => {
  if (!snap) return;
  const head_change = (
    ! serverState.roomState
  ) || (
    snap.roomState.queue[0] != serverState.roomState.queue[0]
  );
  serverState.snapshot = snap;
  serverState.roomState = snap.roomState;
  serverState.index = snap.index.slice();
  if (head_change) {
    reportCachedHead();
  }
  render();
  maybePrefetchHeadAndNext();
  playbackOverseer();
};

const connectSSE = () => {
  const url = new URL('/events', location.origin);
  url.searchParams.set('room', room);
  url.searchParams.set('clientName', clientName);
  const es = new EventSource(url.toString());
  es.onmessage = (e) => {
    try {
      const snapshot = JSON.parse(e.data);
      if (snapshot) {
        console.log(`SSE event [${snapshot.roomState.eventCount}]`);
        applySnapshot(snapshot);
      }
    } catch {}
  };
  es.onerror = () => {
    // Auto reconnect by EventSource; nothing else
  };
};

// Ping heartbeat
setInterval(() => {
  api('/ping').catch(()=>{});
}, 3000);

// Initial snapshot
api('/snapshot')
  .then(applySnapshot)
  .then(connectSSE);

// Controls
els.playPauseBtn.addEventListener('click', async () => {
  const pos = els.audio.currentTime || 0;
  if (serverState.roomState.playState.mode === 'playing') {
    els.audio.pause();
    await api('/pause', {}, true);
  } else {
    // don't play, wait for server
    await api('/play', {}, true);
  }
});
els.nextBtn.addEventListener('click', async () => {
  await api('/next', {}, true);
});
els.prevBtn.addEventListener('click', async () => {
  await api('/prev', {}, true);
});
els.seek.addEventListener('input', (e) => {
  const dur = Math.max(1, els.audio.duration || 1);
  const newPos = dur * (Number(e.target.value) / 100);
  els.audio.currentTime = newPos;
  els.audio.pause();
});
els.seek.addEventListener('change', async () => {
  const pos = els.audio.currentTime || 0;
  await api('/seek', { positionSec: pos }, true);
});

// Rendering
const render = () => {
  const headId = serverState.roomState.queue[0];
  const item = findIndexItem(headId);
  if (item) {
    els.title.textContent = item.title || item.fileName;
    els.artist.textContent = item.artist || 'Unknown';
    const coverUrl = '/cover/' + headId;
    els.cover.src = coverUrl;

    // Inject cover art into currentInfo
    let embedded = els.currentInfo.querySelector('.embedded-cover');
    if (!embedded) {
      embedded = document.createElement('img');
      embedded.className = 'embedded-cover';
      embedded.style.maxWidth = '100%';
      embedded.style.display = 'block';
      embedded.style.marginBottom = '0.5rem';
      els.currentInfo.prepend(embedded);
    }
    if (embedded.src !== location.origin + coverUrl) embedded.src = coverUrl;
  }
  renderQueue();
  renderStatus();
  renderMembers();
};

const renderMembers = () => {
  if (!els.membersList) return;
  els.membersList.innerHTML = '';
  const clients = Object.entries(serverState.roomState.clients || {});
  const nowSec = Date.now() / 1000;
  const head = serverState.roomState.queue[0];
  clients
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .forEach(([clientName, c]) => {
      const li = document.createElement('li');
      const online = (nowSec - (c.lastPingSec || 0)) <= 6;
      const ready = online && c.cachedHeadTrackId === head;
      const parts = [];
      parts.push(clientName);
      parts.push(online ? '🟢' : '⚪');
      if (ready) parts.push('[ready]');
      if (serverState.roomState.playState.mode === 'onBarrier' && online && !ready) parts.push('[downloading]');
      li.textContent = parts.join(' ');
      els.membersList.appendChild(li);
    });
};

const renderQueue = () => {
  els.queueList.innerHTML = '';
  serverState.roomState.queue.forEach((trackId, i) => {
    const it = findIndexItem(trackId);
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.textContent = `${i===0?'▶ ':'  '}${(it?.title)||'Unknown'} · ${(it?.artist)||''} · ${(it?.duration||0).toFixed(0)}s`;
    li.appendChild(left);
    const btn = document.createElement('button');
    btn.textContent = 'Play next';
    btn.disabled = i === 0;
    btn.addEventListener('click', async () => {
      await api('/nudge', { trackId }, true);
    });
    li.appendChild(btn);
    els.queueList.appendChild(li);
  });
};

const formatTime = (t) => {
  const n_secs = Math.round(t);
  const hours = Math.floor(n_secs / 3600);
  const minutes = Math.floor((n_secs % 3600) / 60);
  const seconds = n_secs % 60;
  return `${hours > 0 ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const renderStatus = () => {
  const activeCount = Object.values(serverState.roomState.clients || {}).filter(c => c.sse && (Date.now()/1000 - (c.lastPingSec||0) <= 6)).length;
  const head = serverState.roomState.queue[0];
  const readyCount = Object.values(serverState.roomState.clients || {}).filter(c => c.sse && c.cachedHeadTrackId === head && (Date.now()/1000 - (c.lastPingSec||0) <= 6)).length;
  if (serverState.roomState.playState.mode === 'onBarrier') {
    const haveHead = head && (head in localState.cacheRegistry);
    if (haveHead) {
      els.statusLine.textContent = `waiting for others to download... (${readyCount}/${activeCount} ready)`;
    } else {
      els.statusLine.textContent = 'downloading...';
    }
  } else if (serverState.roomState.playState.mode === 'playing') {
    els.statusLine.textContent = `Playing at ${formatTime(els.audio.currentTime)}`;
  } else {
    els.statusLine.textContent = `Paused at ${formatTime(els.audio.currentTime)}`;
  }
  switch (serverState.roomState.playState.mode) {
    case 'playing':
      playPauseBtn.textContent = '⏸️';
      break;
    case 'paused':
      playPauseBtn.textContent = '▶️';
      break;
    case 'onBarrier':
      playPauseBtn.textContent = '...';
      break;
  }
};

// DB schema: db 'audio', objectStore 'tracks' (key = trackId, value = Blob)

let db = null;

const ensureDB = async () => {
  if (db)
    return;
  const req = indexedDB.open('audio', 1);
  await new Promise((resolve, reject) => {
    req.onupgradeneeded = () => {
      const newDb = req.result;
      newDb.createObjectStore('tracks');
    };
    req.onsuccess = () => {
      db = req.result;
      resolve();
    };
    req.onerror = () => {
      reject(`ensureDB ${req.error}`);
    };
  });
};

const idbGet = async (trackId) => {
  await ensureDB();
  return await new Promise((res, rej) => {
    const tx = db.transaction('tracks', 'readonly');
    const store = tx.objectStore('tracks');
    const rq = store.get(trackId);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(`idb_Get ${rq.error}`);
  });
};

const idbPut = async (trackId, blob) => {
  await ensureDB();
  return await new Promise((res, rej) => {
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    const rq = store.put(blob, trackId);
    rq.onerror = () => rej(`idb_Put ${rq.error}`);
    tx.oncomplete = res;
    tx.onerror = () => rej(`idb_Put ${tx.error}`);
  });
};

const idbDelete = async (trackId) => {
  await ensureDB();
  return await new Promise((res, rej) => {
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    const rq = store.delete(trackId);
    rq.onerror = () => rej(`idb_Delete ${rq.error}`);
    tx.oncomplete = res;
    tx.onerror = () => rej(`idb_Delete ${tx.error}`);
  });
};

const idbListKeys = async () => {
  await ensureDB();
  return await new Promise((res, rej) => {
    const keys = [];
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    const rq = store.openKeyCursor();
    rq.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { keys.push(c.key); c.continue(); } else res(keys);
    };
    rq.onerror = () => rej(`idb_ListKeys ${rq.error}`);
  });
};

const reportCachedHead = async () => {
  const head = serverState.roomState.queue[0];
  if (! head) return;
  if (head in localState.cacheRegistry) {
    await api('/cache-head', { trackId: head });
  }
};

const fetchAndStoreTrack = async (trackId) => {
  const url = `/file/${trackId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('fetch failed');
  const blob = await resp.blob();
  await idbPut(trackId, blob);
  return blob;
};

const getTrackBlobURL = async (trackId, is_head) => {
  let blob = await idbGet(trackId);
  if (!blob) {
    try {
      blob = await fetchAndStoreTrack(trackId);
      if (is_head) {
        await reportCachedHead();
      }
    } catch (e) {
      showBubble('Network error while fetching audio.');
      throw e;
    }
  }
  if (! (trackId in localState.cacheRegistry)) {
    localState.cacheRegistry[trackId] = URL.createObjectURL(blob);
    if (! localState.recentLRU.includes(trackId)) {
      localState.recentLRU.push(trackId);
      while (localState.recentLRU.length > LRU_SIZE) {
        localState.recentLRU.shift();
      }
    }
  }
  return localState.cacheRegistry[trackId];
};

const dropCache = async () => {
  const protect = new Set([
    serverState.roomState.queue[0], 
    serverState.roomState.queue[1], 
    ...localState.recentLRU,
  ].filter(Boolean));
  const keys = await idbListKeys();
  for (const k of keys) {
    if (!protect.has(k)) {
      delete localState.cacheRegistry[k];
      URL.revokeObjectURL(localState.cacheRegistry[k]);
      await idbDelete(k);
    }
  }
};

const maybePrefetchHeadAndNext = async () => {
  const head = serverState.roomState.queue[0];
  const next = serverState.roomState.queue[1];
  if (!head) return;
  await dropCache();
  // Build blob URL for head
  const headURL = await getTrackBlobURL(head, true);
  if (els.audio.src !== headURL) {
    els.audio.src = headURL;
  }

  // Preload metadata if duration missing
  if (!findIndexItem(head)?.duration) {
    const tmp = document.createElement('audio');
    tmp.preload = 'metadata';
    tmp.src = headURL;
    tmp.onloadedmetadata = () => { /* metadata learned implicitly */ };
  }

  // Pre-fetch next
  if (next) {
    await getTrackBlobURL(next, false);
  }
};

els.audio.addEventListener('ended', async () => {
  await api('/next', {}, true);
});

// Keep seek bar in sync
setInterval(() => {
  const dur = els.audio.duration || 0;
  const cur = els.audio.currentTime || 0;
  if (dur > 0) els.seek.value = String(Math.round(cur / dur * 100));
  renderStatus();
}, 500);

// Safe storage estimate helper (handles browsers without navigator.storage)
const safeStorageEstimate = async () => {
  if (navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      return await navigator.storage.estimate();
    } catch {}
  }
  return { usage: 0, quota: 0 };
};
