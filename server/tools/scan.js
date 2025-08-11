import { buildPlaylistIndex } from '../tracks.js'; 
import { AUDIO_DIR } from '../config.js'; 
const list = await buildPlaylistIndex(AUDIO_DIR); 
console.log(JSON.stringify(list, null, 2)); 
