const FEEDS = [
  { source: 'NRK', url: 'https://www.nrk.no/toppsaker.rss' },
  { source: 'VG', url: 'https://www.vg.no/rss/feed/' },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { data: null, expires: 0 };

function decode(str) {
  return str
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? decode(m[1].trim()) : '';
}

async function fetchFeed({ source, url }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'norsk-nyheter/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items
    .map((item) => {
      const date = new Date(tag(item, 'pubDate'));
      return {
        title: tag(item, 'title'),
        link: tag(item, 'link'),
        source,
        published: isNaN(date) ? null : date.toISOString(),
      };
    })
    .filter((i) => i.title && i.link && i.published);
}

async function getNews() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  const items = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, 20);
  if (items.length === 0) throw new Error(`Ingen feeds svarte: ${errors.join('; ')}`);
  return { updated: new Date().toISOString(), count: items.length, errors, items };
}

module.exports = async function handler(req, res) {
  try {
    if (!cache.data || Date.now() > cache.expires) {
      cache = { data: await getNews(), expires: Date.now() + CACHE_TTL_MS };
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 5 min cache on Vercel's CDN, plus an in-memory cache inside the function
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
    res.end(JSON.stringify(cache.data));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: err.message }));
  }
};
