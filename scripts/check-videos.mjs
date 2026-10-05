// Checks every exercise / workout video link with YouTube's oEmbed API.
// oEmbed only answers for videos that exist, are public (or unlisted) and
// allow embedding, so a 200 here means the link will play in the app.
//
//   node scripts/check-videos.mjs     (needs internet access to youtube.com)

import { VIDEOS, WORKOUT_VIDEOS, youtubeId } from '../public/js/program.js';

const links = new Map(); // url -> labels
for (const [exercise, list] of Object.entries(VIDEOS)) for (const [title, url] of list) links.set(url, [...(links.get(url) || []), `${exercise}: ${title}`]);
for (const [title, url] of WORKOUT_VIDEOS) links.set(url, [...(links.get(url) || []), `workout: ${title}`]);

let failed = 0;
for (const [url, labels] of links) {
  const id = youtubeId(url);
  let status;
  let info = '';
  if (!id) {
    status = 'BAD URL';
  } else {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
      status = res.status === 200 ? 'OK' : `HTTP ${res.status}`;
      if (res.ok) {
        const j = await res.json();
        info = `"${j.title}" by ${j.author_name}`;
      }
    } catch (err) {
      status = `ERROR ${err.message}`;
    }
  }
  if (status !== 'OK') failed++;
  console.log(`${status.padEnd(8)} ${url}  [${labels.join('; ')}]  ${info}`);
}
console.log(`\n${links.size - failed}/${links.size} video links OK`);
process.exit(failed ? 1 : 0);
