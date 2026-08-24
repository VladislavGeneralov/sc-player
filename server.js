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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, function () {
  console.log("SC Player+ running at http://localhost:" + PORT);
});
