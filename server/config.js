// Server configuration constants.
// Adjust as needed or override via environment variables.

import path    from 'node:path';

export const PORT       = parseInt(process.env.PORT || '3000', 10);
export const AUDIO_DIR  = process.env.AUDIO_DIR || '/home/dan/Music/youtube_playlists/music'; // ABSOLUTE path
export const STATE_FILE = process.env.STATE_FILE || new URL('./state.json', import.meta.url).pathname;
export const ROOM_CODE_LENGTH = 6; // six characters
export const HEARTBEAT_SEC    = 6; // inactive threshold (seconds)
export const PING_PERIOD_SEC  = 3; // clients ping about every ~3s
export const EVENT_MODULO     = 16384; // 2^14
export const DEV_MODE         = process.env.NODE_ENV === 'development';
export const CACHE_DIR  = path.resolve('./transcode-cache'); // cached .opus goes here
