// Minimal local proxy for SC Player+. No dependencies (Node built-ins only).
// SoundCloud's api-v2 only sends CORS headers for origin https://soundcloud.com,
// so the browser page can't call it directly. This server calls SoundCloud
// server-to-server (no CORS involved) and hands the result to the page, which
// now talks to its own origin (http://localhost:8787) instead.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 8787;
const HTML_FILE = path.join(__dirname, "soundcloud-player.html");

function proxyJson(targetUrl, res) {
  https.get(targetUrl, (upstream) => {
    var chunks = [];
    upstream.on("data", function (c) { chunks.push(c); });
    upstream.on("end", function () {
      res.writeHead(upstream.statusCode || 200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(Buffer.concat(chunks));
    });
  }).on("error", function (err) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(err) }));
  });
}

const server = http.createServer((req, res) => {
  var u = new URL(req.url, "http://localhost:" + PORT);

  if (u.pathname === "/" || u.pathname === "/soundcloud-player.html") {
    fs.readFile(HTML_FILE, function (err, data) {
      if (err) { res.writeHead(500); res.end("Cannot read soundcloud-player.html"); return; }
      // no-store: this file gets edited constantly during development, and
      // browsers will otherwise happily serve a stale cached copy on reload.
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

  if (u.pathname === "/api/resolve") {
    var trackUrl = u.searchParams.get("url");
    var clientId = u.searchParams.get("client_id");
    if (!trackUrl || !clientId) { res.writeHead(400); res.end("Missing url or client_id"); return; }
    proxyJson("https://api-v2.soundcloud.com/resolve?url=" + encodeURIComponent(trackUrl) + "&client_id=" + encodeURIComponent(clientId), res);
    return;
  }

  if (u.pathname === "/api/media") {
    var mediaUrl = u.searchParams.get("url");
    var clientId2 = u.searchParams.get("client_id");
    if (!mediaUrl || !clientId2) { res.writeHead(400); res.end("Missing url or client_id"); return; }
    var sep = mediaUrl.indexOf("?") === -1 ? "?" : "&";
    proxyJson(mediaUrl + sep + "client_id=" + encodeURIComponent(clientId2), res);
    return;
  }

  // Batch-fetches full track objects by id — large playlists come back from
  // /api/resolve with only the first few tracks fully populated, the rest
  // truncated to just an id; this fills those in.
  if (u.pathname === "/api/tracks") {
    var ids = u.searchParams.get("ids");
    var clientId3 = u.searchParams.get("client_id");
    if (!ids || !clientId3) { res.writeHead(400); res.end("Missing ids or client_id"); return; }
    proxyJson("https://api-v2.soundcloud.com/tracks?ids=" + encodeURIComponent(ids) + "&client_id=" + encodeURIComponent(clientId3), res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, function () {
  console.log("SC Player+ running at http://localhost:" + PORT);
});
