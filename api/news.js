const FEEDS = [
  { source: 'NRK', url: 'https://www.nrk.no/toppsaker.rss' },
  { source: 'VG', url: 'https://www.vg.no/rss/feed/', filterScores: true },
];

const FRESH_TTL_MS = 60 * 1000; // all feeds OK: reuse result for 60 s
const RETRY_TTL_MS = 20 * 1000; // any feed failed: retry after 20 s
const MAX_STALE_MS = 6 * 60 * 60 * 1000; // last-good feed data usable for 6 h
const FETCH_TIMEOUT_MS = 8000;
const MAX_ITEMS = 20;

// Combined response, shared by all requests to this function instance.
// The CDN's s-maxage is derived from `expires`, so the two layers never stack.
let cache = { data: null, error: null, expires: 0 };
let inflight = null;
// Last successful parse per source: { items, fetchedAt (ms) }
const lastGood = {};

// VG live-score updates such as "1-0: Hermoso, Roma" or "2–1: ..."
const SCORE_TITLE = /^\s*\d{1,2}\s*[-–]\s*\d{1,2}\s*:/;

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function codePointToString(n) {
  const valid = Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
  return valid ? String.fromCodePoint(n) : null;
}

// Single pass, so "&amp;lt;" correctly becomes "&lt;". Invalid numeric
// entities are left as-is instead of throwing.
function decode(str) {
  return str
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|(lt|gt|quot|apos|amp));/g, (match, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name];
      return codePointToString(dec ? parseInt(dec, 10) : parseInt(hex, 16)) ?? match;
    })
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? decode(m[1].trim()) : '';
}

function safeLink(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Same article regardless of scheme, host case, #fragment, utm_* params or trailing slash.
function canonicalLink(href) {
  const url = new URL(href);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url.host + url.pathname.replace(/\/+$/, '') + url.search;
}

function parseItem(xml, feed) {
  try {
    const title = tag(xml, 'title');
    const link = safeLink(tag(xml, 'link'));
    const date = new Date(tag(xml, 'pubDate'));
    if (!title || !link || isNaN(date)) return null;
    if (feed.filterScores && SCORE_TITLE.test(title)) return null;
    return {
      title,
      link,
      source: feed.source,
      published: date.toISOString(),
      guid: tag(xml, 'guid') || null, // used for de-duplication, removed from the response
    };
  } catch {
    return null; // one malformed item must not break the whole feed
  }
}

async function fetchFeed(feed) {
  let res;
  try {
    res = await fetch(feed.url, {
      headers: { 'User-Agent': 'norsk-nyheter/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'tidsavbrudd' : err.message);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = (xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [])
    .map((item) => parseItem(item, feed))
    .filter(Boolean);
  if (items.length === 0) throw new Error('ingen saker i feeden');
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const keys = ['link:' + canonicalLink(item.link)];
    if (item.guid) keys.push(`guid:${item.source}:${item.guid}`);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

const osloTime = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit' });

async function refresh() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const now = Date.now();
  const errors = [];
  const sources = {};
  const pool = [];

  results.forEach((result, i) => {
    const { source } = FEEDS[i];
    if (result.status === 'fulfilled') {
      lastGood[source] = { items: result.value, fetchedAt: now };
      pool.push(...result.value);
      sources[source] = { ok: true, stale: false, fetchedAt: new Date(now).toISOString() };
      return;
    }
    const error = result.reason?.message || String(result.reason);
    const good = lastGood[source];
    if (good && now - good.fetchedAt <= MAX_STALE_MS) {
      pool.push(...good.items);
      errors.push(`${source}: oppdatering feilet (${error}), viser lagrede saker fra kl. ${osloTime.format(good.fetchedAt)}`);
      sources[source] = { ok: false, stale: true, fetchedAt: new Date(good.fetchedAt).toISOString(), error };
    } else {
      errors.push(`${source}: ${error}`);
      sources[source] = { ok: false, stale: false, fetchedAt: null, error };
    }
  });

  const items = dedupe(pool.sort((a, b) => new Date(b.published) - new Date(a.published)))
    .slice(0, MAX_ITEMS)
    .map(({ guid, ...item }) => item);

  if (items.length === 0) {
    return { data: null, error: `Ingen feeds svarte: ${errors.join('; ')}`, expires: now + RETRY_TTL_MS };
  }
  return {
    data: { updated: new Date(now).toISOString(), count: items.length, errors, sources, items },
    error: null,
    expires: now + (errors.length ? RETRY_TTL_MS : FRESH_TTL_MS),
  };
}

async function getCached() {
  if (Date.now() < cache.expires) return cache;
  // Concurrent requests share a single upstream refresh.
  if (!inflight) {
    inflight = refresh()
      .then((next) => { cache = next; })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return cache;
}

async function handler(req, res) {
  let current;
  try {
    current = await getCached();
  } catch (err) {
    current = { data: null, error: err.message };
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!current.data) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: current.error }));
  }
  // CDN may keep the response only as long as the in-memory copy is still valid.
  const ttl = Math.max(1, Math.ceil((current.expires - Date.now()) / 1000));
  res.statusCode = 200;
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${ttl}`);
  res.end(JSON.stringify(current.data));
}

module.exports = handler;
// Internals exposed for tests only.
module.exports._test = {
  decode,
  safeLink,
  canonicalLink,
  reset() {
    cache = { data: null, error: null, expires: 0 };
    inflight = null;
    for (const k of Object.keys(lastGood)) delete lastGood[k];
  },
};
