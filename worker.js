// Cloudflare Worker version of the SC Player+ proxy (see server.js for the local
// Node equivalent). Deploy this on Cloudflare Workers so the static page — hosted
// on GitHub Pages / a custom domain, a different origin — can call it with CORS
// allowed. api-v2.soundcloud.com itself only allows CORS for https://soundcloud.com,
// so this worker fetches it server-to-server (no CORS involved there) and re-serves
// the result with permissive CORS headers of its own.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS),
  });
}

async function proxyJson(targetUrl) {
  const upstream = await fetch(targetUrl);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS),
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

    if (url.pathname === "/api/resolve") {
      let trackUrl = url.searchParams.get("url");
      const clientId = url.searchParams.get("client_id");
      if (!trackUrl || !clientId) return jsonResponse({ error: "Missing url or client_id" }, 400);
      trackUrl = await expandShortLink(trackUrl);
      const target = "https://api-v2.soundcloud.com/resolve?url=" + encodeURIComponent(trackUrl) + "&client_id=" + encodeURIComponent(clientId);
      return proxyJson(target);
    }

    if (url.pathname === "/api/media") {
      const mediaUrl = url.searchParams.get("url");
      const clientId = url.searchParams.get("client_id");
      if (!mediaUrl || !clientId) return jsonResponse({ error: "Missing url or client_id" }, 400);
      const sep = mediaUrl.indexOf("?") === -1 ? "?" : "&";
      return proxyJson(mediaUrl + sep + "client_id=" + encodeURIComponent(clientId));
    }

    // Batch-fetches full track objects by id — large playlists come back
    // from /api/resolve with only the first few tracks fully populated, the
    // rest truncated to just an id; this fills those in.
    if (url.pathname === "/api/tracks") {
      const ids = url.searchParams.get("ids");
      const clientId = url.searchParams.get("client_id");
      if (!ids || !clientId) return jsonResponse({ error: "Missing ids or client_id" }, 400);
      const target = "https://api-v2.soundcloud.com/tracks?ids=" + encodeURIComponent(ids) + "&client_id=" + encodeURIComponent(clientId);
      return proxyJson(target);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
