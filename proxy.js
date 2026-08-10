/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  🔥 HordProxy Render v3.0 — Production-Grade Proxy        ║
 * ║  Connection pooling • DNS cache • Circuit breaker          ║
 * ║  Concurrency limit • Body size limit • Keep-alive          ║
 * ║  Zero dependencies • 100% Node.js built-ins                ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

"use strict";

const http = require("http");
const https = require("https");
const dns = require("dns");
const { URL } = require("url");
const { pipeline } = require("stream");
const { promisify } = require("util");

const pipelineAsync = promisify(pipeline);

// ═══════════════════════════════════════════
// Config (tune these)
// ═══════════════════════════════════════════

const CFG = {
  port: parseInt(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",

  // Timeouts (ms)
  connectTimeout: 8_000,
  readTimeout: 28_000,
  idleTimeout: 60_000,

  // Retry
  maxRetries: 2,
  retryDelayBase: 400,
  retryDelayMax: 2_000,

  // Rate limiting
  ratePerMin: 90,
  rateWindowMs: 60_000,
  rateGcThreshold: 600,

  // Concurrency
  maxConcurrentRequests: 80,
  maxBodySize: 50 * 1024 * 1024,   // 50MB request body limit
  maxResponseSize: 200 * 1024 * 1024, // 200MB response limit (0 = unlimited)

  // Connection pooling (keep-alive agents)
  maxSocketsPerHost: 20,
  keepAliveTimeout: 30_000,

  // DNS cache
  dnsCacheSize: 500,
  dnsCacheTtlMs: 300_000,  // 5 min

  // Circuit breaker
  circuitFailThreshold: 5,
  circuitResetMs: 30_000,  // 30s cooldown after failures

  // Auth
  allowedKeys: [
    // "your-secret-key-here",
  ],
};

// ═══════════════════════════════════════════
// DNS Cache
// ═══════════════════════════════════════════

class DnsCache {
  constructor(maxSize = 500, ttlMs = 300_000) {
    this._map = new Map();
    this._max = maxSize;
    this._ttl = ttlMs;
  }

  get(hostname) {
    const entry = this._map.get(hostname);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this._map.delete(hostname);
      return null;
    }
    // Round-robin among resolved IPs
    if (entry.ips.length > 1) {
      entry.roundRobin = ((entry.roundRobin || 0) + 1) % entry.ips.length;
      return entry.ips[entry.roundRobin];
    }
    return entry.ips[0];
  }

  set(hostname, ips) {
    if (!ips || ips.length === 0) return;
    if (this._map.size >= this._max) {
      // Evict oldest
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(hostname, {
      ips,
      expires: Date.now() + this._ttl,
      roundRobin: 0,
    });
  }

  get size() { return this._map.size; }
}

// ═══════════════════════════════════════════
// Circuit Breaker
// ═══════════════════════════════════════════

class CircuitBreaker {
  constructor(failThreshold = 5, resetMs = 30_000) {
    this._threshold = failThreshold;
    this._resetMs = resetMs;
    this._hosts = new Map(); // hostname → {fails, openUntil}
  }

  isOpen(hostname) {
    const entry = this._hosts.get(hostname);
    if (!entry) return false;
    if (Date.now() > entry.openUntil) {
      this._hosts.delete(hostname);
      return false;
    }
    return true;
  }

  recordSuccess(hostname) {
    this._hosts.delete(hostname);
  }

  recordFailure(hostname) {
    let entry = this._hosts.get(hostname);
    if (!entry) {
      entry = { fails: 0, openUntil: 0 };
      this._hosts.set(hostname, entry);
    }
    entry.fails++;
    if (entry.fails >= this._threshold) {
      entry.openUntil = Date.now() + this._resetMs;
    }
  }
}

// ═══════════════════════════════════════════
// Connection Agents (keep-alive pooling)
// ═══════════════════════════════════════════

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: CFG.keepAliveTimeout,
  maxSockets: CFG.maxSocketsPerHost,
  maxFreeSockets: Math.floor(CFG.maxSocketsPerHost / 2),
  timeout: CFG.idleTimeout,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: CFG.keepAliveTimeout,
  maxSockets: CFG.maxSocketsPerHost,
  maxFreeSockets: Math.floor(CFG.maxSocketsPerHost / 2),
  timeout: CFG.idleTimeout,
});

// ═══════════════════════════════════════════
// Rate limiter
// ═══════════════════════════════════════════

const rateMap = new Map();

function rateLimit(ip) {
  if (rateMap.size > CFG.rateGcThreshold) {
    const cutoff = Date.now() - CFG.rateWindowMs * 3;
    for (const [k, v] of rateMap) {
      if (v.reset < cutoff) rateMap.delete(k);
    }
  }
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    rateMap.set(ip, { count: 1, reset: now + CFG.rateWindowMs });
    return true;
  }
  if (entry.count >= CFG.ratePerMin) return false;
  entry.count++;
  return true;
}

// ═══════════════════════════════════════════
// Concurrency limiter
// ═══════════════════════════════════════════

let activeRequests = 0;
function concurrencyGuard() {
  if (activeRequests >= CFG.maxConcurrentRequests) return false;
  activeRequests++;
  return true;
}
function releaseConcurrency() { if (activeRequests > 0) activeRequests--; }

// ═══════════════════════════════════════════
// Global state
// ═══════════════════════════════════════════

const dnsCache = new DnsCache(CFG.dnsCacheSize, CFG.dnsCacheTtlMs);
const circuitBreaker = new CircuitBreaker(CFG.circuitFailThreshold, CFG.circuitResetMs);

let stats = {
  totalRequests: 0,
  activeRequests: 0,
  failedRequests: 0,
  rateLimited: 0,
  bytesSent: 0,
  circuitTrips: 0,
  startTime: Date.now(),
};

// ═══════════════════════════════════════════
// User-Agent rotation
// ═══════════════════════════════════════════

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0",
];

function randomUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

// ═══════════════════════════════════════════
// Headers
// ═══════════════════════════════════════════

const SKIP_REQ = new Set([
  "host", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
  "x-forwarded-port", "x-real-ip", "true-client-ip",
  "x-proxy-target", "x-proxy-key", "x-proxy-mode", "x-proxy-retry",
  "x-render-origin", "x-render-proxy", "cf-connecting-ip", "cf-ipcountry",
  "cf-ray", "cf-visitor", "cf-worker",
  "connection", "proxy-connection", "proxy-authorization",
  "proxy-authenticate", "forwarded", "via", "x-request-id",
  "cdn-loop", "x-arr-log-id", "content-length", "transfer-encoding",
]);

const SKIP_RES = new Set([
  "set-cookie", "server", "report-to", "nel",
  "cf-ray", "cf-cache-status", "x-render-origin",
  "transfer-encoding",
]);

const NULL_BODY = new Set([204, 205, 304]);

// ═══════════════════════════════════════════
// URL extraction
// ═══════════════════════════════════════════

function extractTarget(req) {
  let t = req.headers["x-proxy-target"];
  if (t) {
    if (t.startsWith("http://") || t.startsWith("https://")) return t;
    return decodeBase64Url(t);
  }
  const url = new URL(req.url, `http://${req.headers.host || "x"}`);
  t = url.searchParams.get("b");
  if (t) return decodeBase64Url(t);
  t = url.searchParams.get("url");
  if (t) return decodeBase64Url(t);
  return null;
}

function decodeBase64Url(s) {
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  try {
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const dec = Buffer.from(b, "base64").toString("utf-8");
    if (dec.startsWith("http://") || dec.startsWith("https://")) return dec;
    return s;
  } catch { return s; }
}

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": body.length,
  });
  res.end(body);
}

function retryDelay(attempt) {
  return Math.min(CFG.retryDelayBase * Math.pow(2, attempt), CFG.retryDelayMax);
}

// ═══════════════════════════════════════════
// Core — proxy one request
// ═══════════════════════════════════════════

function proxyRequest(targetUrl, method, reqHeaders, bodyBuffer, attempt, callback) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname;
  const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
  const isHttps = parsed.protocol === "https:";
  const reqPath = parsed.pathname + parsed.search;

  // Circuit breaker
  if (circuitBreaker.isOpen(hostname)) {
    return callback(new Error(`Circuit open for ${hostname}`), null);
  }

  // Resolve DNS (cached)
  const cachedIP = dnsCache.get(hostname);
  if (cachedIP) {
    return doConnect(cachedIP, port, isHttps, hostname, reqPath, method, reqHeaders, bodyBuffer, attempt, callback);
  }

  dns.lookup(hostname, { family: 4, timeout: 4000 }, (err, address) => {
    if (err) {
      circuitBreaker.recordFailure(hostname);
      return retryOrFail(err, targetUrl, method, reqHeaders, bodyBuffer, attempt, callback);
    }
    dnsCache.set(hostname, [address]);
    doConnect(address, port, isHttps, hostname, reqPath, method, reqHeaders, bodyBuffer, attempt, callback);
  });
}

function doConnect(ip, port, isHttps, hostname, path, method, reqHeaders, bodyBuffer, attempt, callback) {
  const transport = isHttps ? https : http;

  const fwdHdrs = {
    "User-Agent": randomUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Host": hostname,
  };

  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    if (SKIP_REQ.has(lk) || lk === "user-agent" || lk === "host" || lk === "accept-encoding") continue;
    fwdHdrs[k] = v;
  }

  const reqOpts = {
    hostname: ip,
    port,
    path: path,
    method,
    headers: fwdHdrs,
    agent: isHttps ? httpsAgent : httpAgent,
    timeout: CFG.readTimeout,
    servername: hostname, // SNI for TLS
    rejectUnauthorized: true,
  };

  const proxyReq = transport.request(reqOpts, (proxyRes) => {
    circuitBreaker.recordSuccess(hostname);
    callback(null, proxyRes);
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    circuitBreaker.recordFailure(hostname);
    retryOrFail(new Error("timeout"), null, null, null, null, attempt, callback);
  });

  proxyReq.on("error", (err) => {
    proxyReq.destroy();
    circuitBreaker.recordFailure(hostname);
    retryOrFail(err, null, null, null, null, attempt, callback);
  });

  if (bodyBuffer && method !== "GET" && method !== "HEAD") {
    proxyReq.write(bodyBuffer);
  }
  proxyReq.end();
}

function retryOrFail(err, targetUrl, method, reqHeaders, bodyBuffer, attempt, callback) {
  if (attempt < CFG.maxRetries && targetUrl) {
    const delay = retryDelay(attempt);
    setTimeout(() => proxyRequest(targetUrl, method, reqHeaders, bodyBuffer, attempt + 1, callback), delay);
  } else {
    callback(err, null);
  }
}

// ═══════════════════════════════════════════
// HTTP CONNECT tunnel handler
// ═══════════════════════════════════════════

function handleConnect(req, res, host, port) {
  const transport = port === 443 ? https : http;

  // DNS lookup
  dns.lookup(host, { family: 4, timeout: 4000 }, (err, address) => {
    if (err) {
      res.writeHead(502);
      return res.end();
    }
    dnsCache.set(host, [address]);

    // Connect to target
    const upstream = transport.request({
      hostname: address,
      port,
      method: "CONNECT",
      path: req.url || `${host}:${port}`,
      servername: host,
      timeout: CFG.connectTimeout,
      agent: false,
    });

    upstream.on("connect", (upstreamRes, upstreamSocket) => {
      // Tell client we're connected
      res.writeHead(200, "Connection Established");
      res.write("");

      // Bidirectional pipe
      const clientSocket = req.socket;
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);

      upstreamSocket.on("error", () => {
        clientSocket.destroy();
      });
      clientSocket.on("error", () => {
        upstreamSocket.destroy();
      });
      clientSocket.on("close", () => {
        upstreamSocket.destroy();
        releaseConcurrency();
      });
    });

    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
      releaseConcurrency();
    });

    upstream.end();
  });
}

// ═══════════════════════════════════════════
// Request handler
// ═══════════════════════════════════════════

function handleRequest(req, res) {
  const clientIP =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress || "?";

  // ── HTTP CONNECT tunneling (for HTTPS proxying — yt-dlp, browsers) ──
  if (req.method === "CONNECT") {
    const [targetHost, targetPort] = (req.url || "").split(":");
    const port = parseInt(targetPort) || 443;
    if (!targetHost) {
      res.writeHead(400);
      return res.end();
    }
    handleConnect(req, res, targetHost, port);
    return;
  }

  // ── CORS ──
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, HEAD, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  // ── Auth ──
  if (CFG.allowedKeys.length > 0) {
    const key = req.headers["x-proxy-key"] || "";
    if (!CFG.allowedKeys.includes(key)) {
      return json(res, 401, { error: "unauthorized" });
    }
  }

  // ── Rate limit ──
  if (!rateLimit(clientIP)) {
    stats.rateLimited++;
    return json(res, 429, { error: "rate_limited", retryAfter: 60 });
  }

  // ── Concurrency ──
  if (!concurrencyGuard()) {
    return json(res, 503, { error: "overloaded", retryAfter: 2 });
  }

  stats.totalRequests++;
  stats.activeRequests = activeRequests;

  // ── Target URL ──
  const targetUrl = extractTarget(req);
  if (!targetUrl) {
    releaseConcurrency();
    return json(res, 200, {
      status: "healthy",
      version: "3.0.0-render",
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      metrics: {
        totalRequests: stats.totalRequests,
        activeRequests: stats.activeRequests,
        failedRequests: stats.failedRequests,
        rateLimited: stats.rateLimited,
        circuitTrips: stats.circuitTrips,
        dnsCacheSize: dnsCache.size,
        connectionPool: {
          http: { used: Object.keys(httpAgent.sockets).length, free: Object.keys(httpAgent.freeSockets).length },
          https: { used: Object.keys(httpsAgent.sockets).length, free: Object.keys(httpsAgent.freeSockets).length },
        },
      },
      features: {
        connectionPooling: true,
        dnsCache: `${CFG.dnsCacheSize} entries`,
        circuitBreaker: `${CFG.circuitFailThreshold} fails / ${CFG.circuitResetMs}ms`,
        concurrencyLimit: CFG.maxConcurrentRequests,
        maxBodySize: `${CFG.maxBodySize / 1024 / 1024}MB`,
        uaRotation: `${UA_LIST.length} browsers`,
        retries: CFG.maxRetries,
        protocols: ["HTTP/1.1", "HTTPS/1.1"],
      },
    });
  }

  // ── Validate ──
  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    releaseConcurrency();
    return json(res, 400, { error: "invalid_url" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    releaseConcurrency();
    return json(res, 400, { error: "bad_protocol" });
  }

  // ── Body ──
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > CFG.maxBodySize) {
        req.destroy();
        releaseConcurrency();
        if (!res.headersSent) json(res, 413, { error: "body_too_large" });
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (total <= CFG.maxBodySize) {
        doProxy(targetUrl, req.method, req.headers, Buffer.concat(chunks), res);
      }
    });
    req.on("error", () => {
      releaseConcurrency();
      if (!res.headersSent) json(res, 400, { error: "request_error" });
    });
  } else {
    doProxy(targetUrl, req.method, req.headers, null, res);
  }
}

function doProxy(targetUrl, method, reqHeaders, bodyBuffer, res) {
  proxyRequest(targetUrl, method, reqHeaders, bodyBuffer, 0, (err, proxyRes) => {
    if (err) {
      releaseConcurrency();
      stats.failedRequests++;
      return json(res, 502, { error: "proxy_error", message: err.message });
    }

    // Null body statuses
    if (NULL_BODY.has(proxyRes.statusCode)) {
      releaseConcurrency();
      const hdrs = { "Access-Control-Allow-Origin": "*", "X-Proxied-By": "HordProxy-Render/3.0" };
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!SKIP_RES.has(k.toLowerCase())) hdrs[k] = v;
      }
      res.writeHead(proxyRes.statusCode, hdrs);
      return res.end();
    }

    // Stream response
    const hdrs = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
      "X-Proxied-By": "HordProxy-Render/3.0",
      "Accept-Ranges": "bytes",
    };
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!SKIP_RES.has(k.toLowerCase())) hdrs[k] = v;
    }
    res.writeHead(proxyRes.statusCode, hdrs);

    let bytes = 0;
    proxyRes.on("data", (chunk) => {
      bytes += chunk.length;
      if (CFG.maxResponseSize > 0 && bytes > CFG.maxResponseSize) {
        proxyRes.destroy();
        res.destroy();
        releaseConcurrency();
        return;
      }
    });

    proxyRes.pipe(res);

    res.on("close", () => {
      releaseConcurrency();
      proxyRes.destroy();
      stats.bytesSent += bytes;
    });

    proxyRes.on("error", () => {
      releaseConcurrency();
      if (!res.headersSent) json(res, 502, { error: "upstream_error" });
      res.destroy();
    });
  });
}

// ═══════════════════════════════════════════
// Start
// ═══════════════════════════════════════════

const server = http.createServer(handleRequest);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.maxHeadersCount = 100;
server.requestTimeout = 30_000;

server.listen(CFG.port, CFG.host, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  🔥 HordProxy Render v3.0 — Production  ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Address:    http://${CFG.host}:${CFG.port}`);
  console.log(`║  Health:     http://0.0.0.0:${CFG.port}/`);
  console.log(`║  Pooling:    ${CFG.maxSocketsPerHost}/host (keep-alive)`);
  console.log(`║  DNS cache:  ${CFG.dnsCacheSize} entries, ${CFG.dnsCacheTtlMs / 1000}s TTL`);
  console.log(`║  Circuit:    ${CFG.circuitFailThreshold} fails → ${CFG.circuitResetMs / 1000}s cooldown`);
  console.log(`║  Concurrency: max ${CFG.maxConcurrentRequests} concurrent`);
  console.log(`║  Rate limit: ${CFG.ratePerMin}/min per IP`);
  console.log(`║  Body limit: ${CFG.maxBodySize / 1024 / 1024}MB req / ${CFG.maxResponseSize / 1024 / 1024}MB resp`);
  console.log(`║  UA rotation: ${UA_LIST.length} browsers`);
  console.log(`║  Retries:    ${CFG.maxRetries} (exponential backoff)`);
  console.log(`║  Auth:       ${CFG.allowedKeys.length > 0 ? "enabled" : "open"}`);
  console.log("╚══════════════════════════════════════════╝");
});

process.on("SIGTERM", () => {
  console.log("[HordProxy] Graceful shutdown...");
  server.close(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    console.log("[HordProxy] Done.");
    process.exit(0);
  });
});

process.on("uncaughtException", (err) => {
  console.error("[HordProxy] Uncaught:", err.message);
  // Don't crash — log and continue
});
