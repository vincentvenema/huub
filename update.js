// update.js
// Polls funkentechno's Bluesky feed for posts with Bandcamp links,
// enriches with Bandcamp metadata, regenerates index.html.
//
// Usage: node update.js
// Requires: Node 18+

import { readFile, writeFile } from 'fs/promises';

const HANDLE = 'funkentechno.bsky.social';
const BSKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const PAGE_LIMIT = 100;          // posts per API page (max 100)
const MAX_PAGES = 25;            // safety cap on how far we page back
const SINCE = new Date('2026-01-01T00:00:00Z');  // only collect posts from this date on
const HTML_FILE = 'index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAuthorFeedPage(cursor) {
  let url = `${BSKY_API}?actor=${HANDLE}&limit=${PAGE_LIMIT}&filter=posts_no_replies`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bluesky API ${res.status}`);
  return res.json();
}

// Page back through the feed (newest first) until we pass the cutoff date.
async function fetchPostsSince(cutoff) {
  const posts = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchAuthorFeedPage(cursor);
    const batch = (data.feed || []).map((item) => item.post);
    posts.push(...batch);
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
    const oldest = batch[batch.length - 1];
    if (oldest?.record?.createdAt && new Date(oldest.record.createdAt) < cutoff) break;
  }
  return posts;
}

function extractBandcampUrl(post) {
  // Prefer structured facets (rich text links) over regex
  const facets = post.record.facets || [];
  for (const facet of facets) {
    for (const feature of (facet.features || [])) {
      if (feature.$type === 'app.bsky.richtext.facet#link' &&
          feature.uri && feature.uri.includes('bandcamp.com/album/')) {
        return feature.uri;
      }
    }
  }
  // Embedded external links
  const embed = post.record.embed;
  if (embed && embed.external && embed.external.uri && embed.external.uri.includes('bandcamp.com/album/')) {
    return embed.external.uri;
  }
  // Last resort, regex
  const text = post.record.text || '';
  const match = text.match(/https:\/\/[^\s]+\.bandcamp\.com\/album\/[^\s)]+/);
  return match ? match[0] : null;
}

function extractNote(text, artist, album, maxLen = 220) {
  let clean = (text || '').replace(/https?:\/\/\S+/g, '').trim();

  // If the post starts with "Artist - Album" or similar, strip that off
  if (artist && album) {
    const re = new RegExp(`^\\s*${artist.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[\\-–—:]\\s*${album.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[\\.\\n]?`, 'i');
    clean = clean.replace(re, '').trim();
  }

  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();

  if (clean.length > maxLen) {
    clean = clean.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }
  return clean;
}

async function fetchBandcampMeta(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FunkentechnoFeed/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const meta = (prop) => {
    const re = new RegExp(`<meta property="og:${prop}" content="([^"]+)"`, 'i');
    return (html.match(re) || [])[1] || '';
  };

  const title = meta('title');
  const match = title.match(/^(.+),\s*by\s+(.+)$/i);
  const album = match ? match[1].trim() : title;
  const artist = match ? match[2].trim() : '';

  return {
    artist,
    album,
    bandcamp: meta('url') || url,
    cover: meta('image')
  };
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function normalizeUrl(u) {
  return u.split('?')[0].replace(/\/$/, '');
}

async function main() {
  console.log(`Fetching @${HANDLE} posts back to ${SINCE.toISOString().slice(0, 10)}...`);
  const posts = await fetchPostsSince(SINCE);
  console.log(`  ${posts.length} posts retrieved`);

  const template = await readFile(HTML_FILE, 'utf-8');

  const ALBUMS_RE = /const albums = (\[[\s\S]*?\n\]);/;
  const found = template.match(ALBUMS_RE);
  if (!found) {
    console.error('\nError: could not find const albums array in index.html');
    process.exit(1);
  }

  let existing = [];
  try {
    existing = JSON.parse(found[1]);
  } catch (e) {
    console.error('\nError: existing albums array is not valid JSON, aborting to avoid losing the archive:', e.message);
    process.exit(1);
  }

  // Reuse metadata we already have so we don't refetch Bandcamp for known albums.
  const byUrl = new Map(existing.map((a) => [normalizeUrl(a.bandcamp), a]));

  const seen = new Set();
  const albums = [];   // full 2026 list, newest first, rebuilt from the feed each run
  let added = 0;

  for (const post of posts) {
    const created = post?.record?.createdAt ? new Date(post.record.createdAt) : null;
    if (!created || created < SINCE) continue;       // 2026 onward only

    const bcUrl = extractBandcampUrl(post);
    if (!bcUrl) continue;

    const normUrl = normalizeUrl(bcUrl);
    if (seen.has(normUrl)) continue;
    seen.add(normUrl);

    if (byUrl.has(normUrl)) {
      albums.push(byUrl.get(normUrl));               // already known, keep as is
      continue;
    }

    process.stdout.write(`  ${normUrl} ... `);
    try {
      await sleep(300);                               // be gentle with Bandcamp
      const meta = await fetchBandcampMeta(normUrl);
      const note = extractNote(post.record.text, meta.artist, meta.album);
      const date = formatDate(post.record.createdAt);
      albums.push({ ...meta, note, date });
      added++;
      console.log('ok');
    } catch (e) {
      console.log(`failed (${e.message})`);
    }
  }

  if (albums.length === 0) {
    console.log('\nNo 2026 albums found. Leaving index.html unchanged.');
    return;
  }

  const json = JSON.stringify(albums, null, 2);
  const updated = template.replace(ALBUMS_RE, () => `const albums = ${json};`);

  if (updated === template) {
    console.log('\nNo changes. Archive already up to date.');
    return;
  }

  await writeFile(HTML_FILE, updated);
  console.log(`\n${albums.length} albums in 2026 (${added} newly fetched). Wrote ${HTML_FILE}`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
