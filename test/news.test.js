// Run: npm test   (stubs global fetch and Date.now; no network)
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/news.js');
const { decode, safeLink, reset } = handler._test;

const T0 = Date.parse('2026-11-07T20:00:00Z'); // 21:00 Oslo
let now = T0;
Date.now = () => now;

const rss = (items) =>
  `<?xml version="1.0"?><rss><channel><title>x</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>` +
      (i.guid ? `<guid>${i.guid}</guid>` : '') +
      `<pubDate>${new Date(i.date ?? T0).toUTCString()}</pubDate></item>`)
    .join('')}</channel></rss>`;

const NRK_OK = [
  { title: 'NRK en', link: 'https://www.nrk.no/a-1.1', guid: '1.1', date: T0 - 60e3 },
  { title: 'NRK to', link: 'https://www.nrk.no/b-1.2', guid: '1.2', date: T0 - 120e3 },
];
const VG_OK = [
  { title: 'VG en', link: 'https://www.vg.no/i/A/en', guid: 'https://www.vg.no/i/A', date: T0 - 30e3 },
  { title: 'VG to', link: 'https://www.vg.no/i/B/to', guid: 'https://www.vg.no/i/B', date: T0 - 90e3 },
];

let feeds, calls;
function setFeeds(nrk, vg) { feeds = { NRK: nrk, VG: vg }; }
globalThis.fetch = async (url) => {
  const src = url.includes('nrk.no') ? 'NRK' : 'VG';
  calls[src]++;
  const f = feeds[src];
  if (f === 'fail') return { ok: false, status: 503, text: async () => '' };
  if (f === 'neterr') throw new TypeError('fetch failed');
  return { ok: true, status: 200, text: async () => rss(f) };
};

function call() {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { resolve({ status: this.statusCode, cc: this.headers['cache-control'], body: JSON.parse(body) }); },
    };
    handler({ url: '/api/news' }, res);
  });
}
const titles = (r) => r.body.items.map((i) => i.title);

test.beforeEach(() => {
  reset();
  now = T0;
  calls = { NRK: 0, VG: 0 };
  setFeeds(NRK_OK, VG_OK);
});

test('1. normal NRK + VG success', async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(titles(r), ['VG en', 'NRK en', 'VG to', 'NRK to']); // newest first
  assert.deepEqual(r.body.errors, []);
  assert.equal(r.body.count, 4);
  assert.ok(r.body.updated);
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ['link', 'published', 'source', 'title']); // compat, no guid leak
  assert.equal(r.body.sources.NRK.ok, true);
  assert.equal(r.body.sources.VG.ok, true);
  assert.equal(r.cc, 'public, max-age=0, s-maxage=60');
});

test('2. NRK failure with cached NRK data → stale NRK + warning', async () => {
  await call();
  now += 61e3;
  setFeeds('fail', VG_OK);
  const r = await call();
  assert.equal(r.status, 200);
  assert.ok(titles(r).includes('NRK en'));
  assert.deepEqual(r.body.sources.NRK, { ok: false, stale: true, fetchedAt: new Date(T0).toISOString(), error: 'HTTP 503' });
  assert.equal(r.body.sources.VG.ok, true);
  assert.match(r.body.errors[0], /^NRK: oppdatering feilet \(HTTP 503\), viser lagrede saker fra kl\. 21:00$/);
  assert.equal(r.cc, 'public, max-age=0, s-maxage=20');
});

test('3. VG failure with cached VG data → stale VG + warning', async () => {
  await call();
  now += 61e3;
  setFeeds(NRK_OK, 'neterr');
  const r = await call();
  assert.equal(r.status, 200);
  assert.ok(titles(r).includes('VG en'));
  assert.equal(r.body.sources.VG.stale, true);
  assert.equal(r.body.sources.VG.error, 'fetch failed');
  assert.match(r.body.errors[0], /^VG: oppdatering feilet/);
});

test('4. one source failing without cached data → other source only', async () => {
  setFeeds('fail', VG_OK);
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(titles(r), ['VG en', 'VG to']);
  assert.deepEqual(r.body.sources.NRK, { ok: false, stale: false, fetchedAt: null, error: 'HTTP 503' });
  assert.deepEqual(r.body.errors, ['NRK: HTTP 503']);
  assert.equal(r.cc, 'public, max-age=0, s-maxage=20');
});

test('5. both failing with usable stale data → 200 with both stale', async () => {
  await call();
  now += 2 * 3600e3;
  setFeeds('fail', 'fail');
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 4);
  assert.equal(r.body.sources.NRK.stale, true);
  assert.equal(r.body.sources.VG.stale, true);
  assert.equal(r.body.errors.length, 2);
});

test('6. both failing with no usable data → 502 no-store, retried only after 20 s', async () => {
  setFeeds('fail', 'neterr');
  const r = await call();
  assert.equal(r.status, 502);
  assert.equal(r.cc, 'no-store');
  assert.match(r.body.error, /Ingen feeds svarte: NRK: HTTP 503; VG: fetch failed/);
  now += 19e3;
  await call();
  assert.deepEqual(calls, { NRK: 1, VG: 1 }, 'no upstream hammering inside the 20 s window');
  now += 1e3;
  setFeeds(NRK_OK, VG_OK);
  const ok = await call();
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, { NRK: 2, VG: 2 });
});

test('7. stale data older than 6 h is not used', async () => {
  await call();
  now = T0 + 6 * 3600e3; // exactly 6 h: still allowed
  setFeeds('fail', VG_OK);
  assert.equal((await call()).body.sources.NRK.stale, true);
  now = T0 + 6 * 3600e3 + 21e3; // past 6 h (and past the 20 s retry window of the previous call)
  calls = { NRK: 0, VG: 0 };
  const r = await call();
  assert.equal(r.body.sources.NRK.stale, false);
  assert.ok(!titles(r).some((t) => t.startsWith('NRK')));
  // VG was refreshed successfully at 6 h, so it's fine; now both fail past 6 h of the NRK data
  now += 21e3;
  setFeeds('fail', 'fail');
  const both = await call();
  assert.equal(both.status, 200, 'VG last-good (refreshed at 6 h) is still young');
  assert.equal(both.body.sources.VG.stale, true);
  assert.equal(both.body.sources.NRK.stale, false);
  now = T0 + 13 * 3600e3;
  assert.equal((await call()).status, 502, 'everything older than 6 h → 502');
});

test('8. duplicate removal by guid and canonical link', async () => {
  setFeeds(
    [
      { title: 'NRK ny', link: 'https://www.nrk.no/sak-1.9', guid: '1.9', date: T0 - 10e3 },
      { title: 'NRK samme guid', link: 'https://www.nrk.no/sak-endret-1.9', guid: '1.9', date: T0 - 20e3 },
      { title: 'NRK annen', link: 'https://www.nrk.no/annen-1.8', guid: '1.8', date: T0 - 30e3 },
    ],
    [
      { title: 'VG original', link: 'https://www.vg.no/i/X/sak', date: T0 - 5e3 },
      { title: 'VG utm', link: 'https://www.vg.no/i/X/sak?utm_source=rss&amp;utm_medium=feed', date: T0 - 6e3 },
      { title: 'VG fragment+slash', link: 'http://WWW.VG.NO/i/X/sak/#top', date: T0 - 7e3 },
      { title: 'VG annen query', link: 'https://www.vg.no/i/X/sak?side=2', date: T0 - 8e3 },
    ],
  );
  const r = await call();
  assert.deepEqual(titles(r), ['VG original', 'VG annen query', 'NRK ny', 'NRK annen']);
});

test('9. VG live-score titles filtered, normal sports stories kept', async () => {
  setFeeds(
    [{ title: '1-0: NRK beholdes (filter gjelder bare VG)', link: 'https://www.nrk.no/s-1.5', date: T0 }],
    [
      '1-0: Hermoso, Roma', '3-0: Mora, Roma', '2–1: Haaland, City', ' 10-2: Rekord', '1 - 1: Utlikning',
      'Hermoso med scoring for Roma', 'RBK herjet mot Start – toppscoreren fortsatte målshowet',
      'Vant 3-0 over Start', 'VM 2026: Norge klare', 'Ruud: – 6-4 var nok',
    ].map((title, i) => ({ title, link: `https://www.vg.no/i/${i}`, date: T0 - i * 1000 })),
  );
  const r = await call();
  assert.deepEqual(titles(r).sort(), [
    '1-0: NRK beholdes (filter gjelder bare VG)', 'Hermoso med scoring for Roma',
    'RBK herjet mot Start – toppscoreren fortsatte målshowet', 'Ruud: – 6-4 var nok',
    'VM 2026: Norge klare', 'Vant 3-0 over Start',
  ].sort());
});

test('10a. entity decoding: decimal, hex, named, invalid never throws', () => {
  assert.equal(decode('A &#8211; B &#x2013; C &#X2013; D'), 'A – B – C – D');
  assert.equal(decode('&#39;sitat&apos; &quot;x&quot; &lt;b&gt;'), `'sitat' "x" <b>`);
  assert.equal(decode('&amp;lt; er ikke &lt;'), '&lt; er ikke <'); // no double decoding
  assert.equal(decode('&#99999999; &#1114112; &#xD800; &#0; &#x; &#12345678901; &bogus; &nbsp;'),
    '&#99999999; &#1114112; &#xD800; &#0; &#x; &#12345678901; &bogus; &nbsp;');
  assert.equal(decode('&#x1F4F0; &#128240;'), '📰 📰');
  assert.equal(decode('<![CDATA[Tittel & mer]]>'), 'Tittel & mer');
});

test('10b. malformed entities and invalid links inside a live feed', async () => {
  setFeeds(
    [
      { title: 'Ugyldig &#99999999; og &#xD800; men &#x2013; ok', link: 'https://www.nrk.no/e-1.1', date: T0 - 1e3 },
      { title: 'JS-lenke', link: 'javascript:alert(1)', date: T0 - 2e3 },
      { title: 'Data-lenke', link: 'data:text/html,&lt;script&gt;', date: T0 - 3e3 },
      { title: 'FTP', link: 'ftp://www.nrk.no/x', date: T0 - 4e3 },
      { title: 'Relativ', link: '/nyheter/x', date: T0 - 5e3 },
      { title: 'Tom', link: '', date: T0 - 6e3 },
      { title: 'Store bokstaver', link: 'HTTPS://WWW.NRK.NO/ok-1.7', date: T0 - 7e3 },
    ],
    VG_OK,
  );
  const r = await call();
  const nrk = r.body.items.filter((i) => i.source === 'NRK');
  assert.deepEqual(nrk.map((i) => i.title), ['Ugyldig &#99999999; og &#xD800; men – ok', 'Store bokstaver']);
  assert.equal(nrk[1].link, 'https://www.nrk.no/ok-1.7');
  assert.equal(safeLink('  javascript:alert(1)'), null);
  assert.equal(safeLink('JaVaScRiPt:alert(1)'), null);
});

test('10c. feed with no usable items counts as failure (falls back to stale)', async () => {
  await call();
  now += 61e3;
  setFeeds([{ title: 'x', link: 'javascript:void(0)' }], VG_OK);
  const r = await call();
  assert.equal(r.body.sources.NRK.stale, true);
  assert.equal(r.body.sources.NRK.error, 'ingen saker i feeden');
});

test('11a. 60 s fresh cache; CDN s-maxage tracks remaining memory TTL', async () => {
  assert.equal((await call()).cc, 'public, max-age=0, s-maxage=60');
  now = T0 + 30e3;
  assert.equal((await call()).cc, 'public, max-age=0, s-maxage=30');
  now = T0 + 59.5e3;
  assert.equal((await call()).cc, 'public, max-age=0, s-maxage=1');
  assert.deepEqual(calls, { NRK: 1, VG: 1 });
  now = T0 + 60e3;
  const r = await call();
  assert.deepEqual(calls, { NRK: 2, VG: 2 }, 'refetched at 60 s');
  assert.equal(r.cc, 'public, max-age=0, s-maxage=60');
  assert.equal(r.body.updated, new Date(T0 + 60e3).toISOString());
});

test('11b. partial failure cached 20 s, then retried', async () => {
  setFeeds(NRK_OK, 'fail');
  await call();
  now = T0 + 19e3;
  assert.equal((await call()).cc, 'public, max-age=0, s-maxage=1');
  assert.deepEqual(calls, { NRK: 1, VG: 1 });
  now = T0 + 20e3;
  setFeeds(NRK_OK, VG_OK);
  const r = await call();
  assert.deepEqual(calls, { NRK: 2, VG: 2 });
  assert.equal(r.body.sources.VG.ok, true);
  assert.equal(r.cc, 'public, max-age=0, s-maxage=60', 'back to 60 s once healthy');
});

test('11c. concurrent requests share one upstream refresh', async () => {
  const rs = await Promise.all([call(), call(), call(), call(), call()]);
  assert.ok(rs.every((r) => r.status === 200));
  assert.deepEqual(calls, { NRK: 1, VG: 1 });
});
