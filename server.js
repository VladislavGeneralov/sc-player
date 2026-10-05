// Minimal local proxy for SC Player+. No dependencies (Node built-ins only).
// SoundCloud's api-v2 only sends CORS headers for origin https://soundcloud.com,
// so the browser page can't call it directly. This server calls SoundCloud
// server-to-server (no CORS involved) and hands the result to the page, which
// now talks to its own origin (http://localhost:8787) instead.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 8787;
const HTML_FILE = path.join(__dirname, "dj-booth.html");
const LEGACY_HTML_FILE = path.join(__dirname, "soundcloud-player.html");

// client_id is optional, same as in worker.js: without one the server uses its
// own, scraped from soundcloud.com's JS bundle and cached ~6 h; on a 401/403 it
// grabs a fresh one (at most once a minute) and retries. A client_id sent by the
// page wins; if SoundCloud rejects it, the server retries with its own.
// X-Client-Id-Source: client | auto tells which one worked.
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
const REFRESH_GAP_MS = 60 * 1000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
var autoKey = null, autoKeyAt = 0, lastRefreshAt = 0, scraping = null;

// soundcloud.com's own web client carries the public client_id in one of its
// a-v2.sndcdn.com/assets/*.js bundles (usually one of the last ones on the page).
async function scrapeClientId() {
  var page = await fetch("https://soundcloud.com/", { headers: { "User-Agent": UA } });
  if (!page.ok) throw new Error("soundcloud.com answered " + page.status);
  var html = await page.text();
  var scripts = Array.from(html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g), function (m) { return m[1]; });
  for (var i = scripts.length - 1; i >= 0; i--) {
    var res = await fetch(scripts[i], { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    var js = await res.text();
    for (var at = js.indexOf("client_id"); at !== -1; at = js.indexOf("client_id", at + 9)) {
      var m = /^client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/.exec(js.slice(at, at + 60));
      if (m) return m[1];
    }
  }
  throw new Error("client_id not found in " + scripts.length + " soundcloud.com scripts");
}

// The server's own client_id. force — the current one was just rejected: scrape a
// new one (unless that already happened under a minute ago — then keep what we have).
function getAutoKey(force) {
  if (!force && autoKey && Date.now() - autoKeyAt < KEY_TTL_MS) return Promise.resolve(autoKey);
  if (force && autoKey && Date.now() - lastRefreshAt < REFRESH_GAP_MS) return Promise.resolve(autoKey);
  if (!scraping) {
    lastRefreshAt = Date.now();
    scraping = scrapeClientId()
      .then(function (key) { autoKey = key; autoKeyAt = Date.now(); console.log("client_id from soundcloud.com: " + key); return key; })
      .finally(function () { scraping = null; });
  }
  return scraping;
}

function rejected(upstream) { return upstream.status === 401 || upstream.status === 403; }

// Calls SoundCloud with build(clientId). Order: the page's own key (if sent), the
// cached own key, then a freshly scraped one — moving on only on 401/403.
async function proxyWithClientId(clientId, build, res) {
  var source = clientId ? "client" : "auto";
  var key = clientId;
  try {
    if (!key) {
      try { key = await getAutoKey(false); } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Missing client_id and auto lookup failed: " + e.message }));
        return;
      }
    }
    var upstream = await fetch(build(key));
    for (var force of [false, true]) {
      if (!rejected(upstream)) break;
      var next;
      try { next = await getAutoKey(force); } catch (e) { break; }
      if (next === key) continue;
      key = next; source = "auto";
      upstream = await fetch(build(key));
    }
    var body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "X-Client-Id-Source": source });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

// SoundCloud's mobile-app "share" links are shortened redirectors
// (https://on.soundcloud.com/xxxxx) that 302 to the real permalink —
// api-v2.soundcloud.com/resolve doesn't follow that redirect itself and
// just 404s on the short link. Expand it here first so /resolve always
// gets the canonical soundcloud.com URL. Uses the global fetch (Node 18+)
// since it follows redirects by default and exposes the final response.url.
async function expandShortLink(trackUrl) {
  try {
    var u = new URL(trackUrl);
    if (u.hostname !== "on.soundcloud.com") return trackUrl;
    var res = await fetch(trackUrl, { redirect: "follow" });
    return res.url || trackUrl;
  } catch (e) {
    return trackUrl;
  }
}

const server = http.createServer(async (req, res) => {
  var u = new URL(req.url, "http://localhost:" + PORT);

  // Root now serves dj-booth.html (the active app) instead of the older
  // single-deck prototype — that one's still reachable at its own path.
  if (u.pathname === "/") {
    fs.readFile(HTML_FILE, function (err, data) {
      if (err) { res.writeHead(500); res.end("Cannot read dj-booth.html"); return; }
      // no-store: this file gets edited constantly during development, and
      // browsers will otherwise happily serve a stale cached copy on reload.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    });
    return;
  }

  if (u.pathname === "/soundcloud-player.html") {
    fs.readFile(LEGACY_HTML_FILE, function (err, data) {
      if (err) { res.writeHead(500); res.end("Cannot read soundcloud-player.html"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    });
    return;
  }

  // Generic static serve for any other .html file living directly in the
  // project folder (e.g. /dj-booth.html) — kept to a simple basename match,
  // no path traversal.
  if (/^\/[A-Za-z0-9_-]+\.html$/.test(u.pathname)) {
    var filePath = path.join(__dirname, path.basename(u.pathname));
    fs.readFile(filePath, function (err, data) {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    });
    return;
  }

  var clientId = u.searchParams.get("client_id");

  if (u.pathname === "/api/resolve") {
    var trackUrl = u.searchParams.get("url");
    if (!trackUrl) { res.writeHead(400); res.end("Missing url"); return; }
    trackUrl = await expandShortLink(trackUrl);
    proxyWithClientId(clientId, function (cid) {
      return "https://api-v2.soundcloud.com/resolve?url=" + encodeURIComponent(trackUrl) + "&client_id=" + encodeURIComponent(cid);
    }, res);
    return;
  }

  if (u.pathname === "/api/media") {
    var mediaUrl = u.searchParams.get("url");
    if (!mediaUrl) { res.writeHead(400); res.end("Missing url"); return; }
    var sep = mediaUrl.indexOf("?") === -1 ? "?" : "&";
    proxyWithClientId(clientId, function (cid) { return mediaUrl + sep + "client_id=" + encodeURIComponent(cid); }, res);
    return;
  }

  // Batch-fetches full track objects by id — large playlists come back from
  // /api/resolve with only the first few tracks fully populated, the rest
  // truncated to just an id; this fills those in.
  if (u.pathname === "/api/tracks") {
    var ids = u.searchParams.get("ids");
    if (!ids) { res.writeHead(400); res.end("Missing ids"); return; }
    proxyWithClientId(clientId, function (cid) {
      return "https://api-v2.soundcloud.com/tracks?ids=" + encodeURIComponent(ids) + "&client_id=" + encodeURIComponent(cid);
    }, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, function () {
  console.log("SC Player+ running at http://localhost:" + PORT);
});
