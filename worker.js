// Cloudflare Worker version of the SC Player+ proxy (see server.js for the local
// Node equivalent). Deploy this on Cloudflare Workers so the static page — hosted
// on GitHub Pages / a custom domain, a different origin — can call it with CORS
// allowed. api-v2.soundcloud.com itself only allows CORS for https://soundcloud.com,
// so this worker fetches it server-to-server (no CORS involved there) and re-serves
// the result with permissive CORS headers of its own.
//
// client_id is optional: without one the worker uses its own, scraped from
// soundcloud.com's JS bundle and cached ~6 h. SoundCloud rotates that key now and
// then (answers 401) — on a 401/403 the worker grabs a fresh one and retries once.
// A client_id sent by the page still wins; if SoundCloud rejects it, the worker
// retries with its own. X-Client-Id-Source: client | auto tells which one worked.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-Client-Id-Source",
};

const KEY_TTL_MS = 6 * 60 * 60 * 1000;       // keep a scraped client_id this long
const REFRESH_GAP_MS = 60 * 1000;            // forced re-scrape (after a 401) at most once a minute
// caches.default needs a URL-shaped key; nothing is ever fetched from it.
// (On a bare *.workers.dev address Cloudflare's cache may be a no-op — then the
// module variables below are the only cache, which still covers a warm isolate.)
const KEY_CACHE_URL = "https://scdj-proxy.internal/client-id";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

let autoKey = null, autoKeyAt = 0, lastRefreshAt = 0, scraping = null;

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS),
  });
}

// soundcloud.com's own web client carries the public client_id in one of its
// a-v2.sndcdn.com/assets/*.js bundles (usually one of the last ones on the page).
async function scrapeClientId() {
  const page = await fetch("https://soundcloud.com/", { headers: { "User-Agent": UA } });
  if (!page.ok) throw new Error("soundcloud.com answered " + page.status);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (let i = scripts.length - 1; i >= 0; i--) {
    const res = await fetch(scripts[i], { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    const js = await res.text();
    // indexOf first: cheaper than running the regex over megabytes of bundle
    for (let at = js.indexOf("client_id"); at !== -1; at = js.indexOf("client_id", at + 9)) {
      const m = /^client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/.exec(js.slice(at, at + 60));
      if (m) return m[1];
    }
  }
  throw new Error("client_id not found in " + scripts.length + " soundcloud.com scripts");
}

async function cachedKey() {
  try {
    if (typeof caches === "undefined") return null;
    const hit = await caches.default.match(KEY_CACHE_URL);
    if (!hit) return null;
    const saved = await hit.json();
    return saved && saved.key && Date.now() - saved.at < KEY_TTL_MS ? saved : null;
  } catch (e) {
    return null;
  }
}

async function storeKey(key, at) {
  try {
    if (typeof caches === "undefined") return;
    await caches.default.put(KEY_CACHE_URL, new Response(JSON.stringify({ key, at }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + KEY_TTL_MS / 1000 },
    }));
  } catch (e) {}
}

// The worker's own client_id. force — the current one was just rejected: scrape a
// new one (unless that already happened under a minute ago — then keep what we have).
async function getAutoKey(force) {
  if (!force) {
    if (autoKey && Date.now() - autoKeyAt < KEY_TTL_MS) return autoKey;
    const saved = await cachedKey();
    if (saved) { autoKey = saved.key; autoKeyAt = saved.at; return autoKey; }
  } else if (autoKey && Date.now() - lastRefreshAt < REFRESH_GAP_MS) {
    return autoKey;
  }
  if (!scraping) {                             // concurrent requests share one scrape
    lastRefreshAt = Date.now();
    scraping = scrapeClientId()
      .then(async (key) => { autoKey = key; autoKeyAt = Date.now(); await storeKey(key, autoKeyAt); return key; })
      .finally(() => { scraping = null; });
  }
  return scraping;
}

const rejected = (res) => res.status === 401 || res.status === 403;

// Calls SoundCloud with build(clientId). Order: the page's own key (if sent), the
// worker's cached key, then a freshly scraped one — moving on only on 401/403.
async function proxyWithClientId(clientId, build) {
  let source = clientId ? "client" : "auto";
  let key = clientId;
  if (!key) {
    try { key = await getAutoKey(false); } catch (e) {
      return jsonResponse({ error: "Missing client_id and auto lookup failed: " + e.message }, 400);
    }
  }
  let upstream = await fetch(build(key));
  for (const force of [false, true]) {
    if (!rejected(upstream)) break;
    let next;
    try { next = await getAutoKey(force); } catch (e) { break; }
    if (next === key) continue;
    key = next; source = "auto";
    upstream = await fetch(build(key));
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "X-Client-Id-Source": source }, CORS_HEADERS),
  });
}

// SoundCloud's mobile-app "share" links are shortened redirectors
// (https://on.soundcloud.com/xxxxx) that 302 to the real permalink —
// api-v2.soundcloud.com/resolve doesn't follow that redirect itself and
// just 404s on the short link. Expand it here first so /resolve always
// gets the canonical soundcloud.com URL.
async function expandShortLink(trackUrl) {
  try {
    const u = new URL(trackUrl);
    if (u.hostname !== "on.soundcloud.com") return trackUrl;
    const res = await fetch(trackUrl, { redirect: "follow" });
    return res.url || trackUrl;
  } catch (e) {
    return trackUrl;
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const clientId = url.searchParams.get("client_id");

    if (url.pathname === "/api/resolve") {
      let trackUrl = url.searchParams.get("url");
      if (!trackUrl) return jsonResponse({ error: "Missing url" }, 400);
      trackUrl = await expandShortLink(trackUrl);
      return proxyWithClientId(clientId, (cid) =>
        "https://api-v2.soundcloud.com/resolve?url=" + encodeURIComponent(trackUrl) + "&client_id=" + encodeURIComponent(cid));
    }

    if (url.pathname === "/api/media") {
      const mediaUrl = url.searchParams.get("url");
      if (!mediaUrl) return jsonResponse({ error: "Missing url" }, 400);
      const sep = mediaUrl.indexOf("?") === -1 ? "?" : "&";
      return proxyWithClientId(clientId, (cid) => mediaUrl + sep + "client_id=" + encodeURIComponent(cid));
    }

    // Batch-fetches full track objects by id — large playlists come back
    // from /api/resolve with only the first few tracks fully populated, the
    // rest truncated to just an id; this fills those in.
    if (url.pathname === "/api/tracks") {
      const ids = url.searchParams.get("ids");
      if (!ids) return jsonResponse({ error: "Missing ids" }, 400);
      return proxyWithClientId(clientId, (cid) =>
        "https://api-v2.soundcloud.com/tracks?ids=" + encodeURIComponent(ids) + "&client_id=" + encodeURIComponent(cid));
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
