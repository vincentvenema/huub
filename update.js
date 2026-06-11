// update.js
// Polls funkentechno's Bluesky feed for posts with Bandcamp links,
// enriches with Bandcamp metadata, regenerates index.html.
//
// Usage: node update.js
// Requires: Node 18+

import { readFile, writeFile } from 'fs/promises';

const HANDLE = 'funkentechno.bsky.social';
const BSKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const POSTS_TO_SCAN = 100;
const HTML_FILE = 'index.html';

async function fetchBlueskyPosts() {
  const url = `${BSKY_API}?actor=${HANDLE}&limit=${POSTS_TO_SCAN}&filter=posts_no_replies`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bluesky API ${res.status}`);
  const data = await res.json();
  return data.feed.map(item => item.post);
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
  console.log(`Fetching posts from @${HANDLE}...`);
  const posts = await fetchBlueskyPosts();
  console.log(`  ${posts.length} posts retrieved`);

  const template = await readFile(HTML_FILE, 'utf-8');

  // Find the existing albums array so we accumulate rather than rebuild.
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
  console.log(`  ${existing.length} albums already in the archive`);

  // seen covers both the existing archive and duplicates within this run.
  const seen = new Set(existing.map(a => normalizeUrl(a.bandcamp)));
  const fresh = [];

  for (const post of posts) {
    const bcUrl = extractBandcampUrl(post);
    if (!bcUrl) continue;

    const normUrl = normalizeUrl(bcUrl);
    if (seen.has(normUrl)) continue;
    seen.add(normUrl);

    process.stdout.write(`  ${normUrl} ... `);
    try {
      const meta = await fetchBandcampMeta(normUrl);
      const note = extractNote(post.record.text, meta.artist, meta.album);
      const date = formatDate(post.record.createdAt);
      fresh.push({ ...meta, note, date });
      console.log('ok');
    } catch (e) {
      console.log(`failed (${e.message})`);
    }
  }

  if (fresh.length === 0) {
    console.log('\nNo new albums. Archive already up to date.');
    return;
  }

  // Newest finds on top, the whole existing archive kept beneath. Nothing is dropped.
  const merged = [...fresh, ...existing];
  const json = JSON.stringify(merged, null, 2);
  const updated = template.replace(ALBUMS_RE, () => `const albums = ${json};`);

  await writeFile(HTML_FILE, updated);
  console.log(`\nAdded ${fresh.length} new (${merged.length} total). Wrote ${HTML_FILE}`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
