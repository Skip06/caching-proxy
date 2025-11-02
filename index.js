#!/usr/bin/env node

const http = require("http");
const https = require("https");
const { program } = require("commander");
const fetch = require("node-fetch").default;
const cache = new Map();

// === CLI Setup ===
program
  .option("-p, --port <number>", "Port for proxy server", 3000)
  .option("-o, --origin <url>", "Origin server URL", "https://httpbin.org")
  .option("--clear-cache", "Clear cache and exit");

program.parse();
const opts = program.opts();

// === Clear Cache Mode ===
if (opts.clearCache) {
  const size = cache.size;
  cache.clear();
  console.log(`Cache cleared! ${size} items removed.`);
  process.exit(0);
}

// === Validate Origin URL ===
let originUrl;
try {
  originUrl = new URL(opts.origin);
} catch (err) {
  console.error("Invalid --origin URL.");
  process.exit(1);
}

// === Helper: Send Response (ONLY ONCE!) ===
function sendResponse(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// === Helper: Send Cached Response ===
function sendCachedResponse(res, cached, method, url) {
  const headers = {
    ...cached.headers,
    'x-cache': 'HIT',
    'content-length': String(cached.body.length)
  };
  // Use the original cached status when sending cached responses.
  sendResponse(res, cached.status || 200, headers, cached.body);
  console.log(`HIT ${method} ${url}`);
}

// === Helper: Forward Request ===
async function forwardRequest(req, res, cacheKey, method, url) {
  try {
    const target = originUrl.protocol + '//' + originUrl.host + url;

    const response = await fetch(target, {
      method: req.method,
      headers: {
        ...req.headers,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      redirect: 'follow',
      agent: originUrl.protocol === 'https:'
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers.entries());

    // Remove hop-by-hop
    const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
    hopByHop.forEach(h => delete headers[h]);

    // Determine whether this request was already cached.
    const isHit = cache.has(cacheKey);

    // Build outgoing headers for the client; do not persist the X-Cache header
    // into the cache entry itself.
    const outgoingHeaders = {
      ...headers,
      'x-cache': isHit ? 'HIT' : 'MISS',
      'content-length': String(buffer.length)
    };

    // SEND RESPONSE ONCE
    sendResponse(res, response.status, outgoingHeaders, buffer);

    // Cache only on 200 + GET. Store original headers (without X-Cache) and the
    // response status so we can replay accurately.
    if (response.status === 200 && method === 'GET') {
      // Make a shallow copy to ensure we don't accidentally mutate the
      // headers later.
      const headersToCache = { ...headers };
      delete headersToCache['x-cache'];

      cache.set(cacheKey, {
        body: buffer,
        headers: headersToCache,
        status: response.status,
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error('Fetch failed:', err.message);
    if (!res.headersSent) {
      sendResponse(res, 502, { 'Content-Type': 'text/plain' }, 'Bad Gateway');
    }
  }
}

// === Create Proxy Server ===
const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = req.url;
  // Use the full request URL (including query) as the cache key so identical
  // requests map to the same entry.
  const cacheKey = `${method}:${url}`;

  console.log(`[CACHE] ${method} ${url} → Key: ${cacheKey}, Hit: ${cache.has(cacheKey)}`);

  if (method !== 'GET') {
    return forwardRequest(req, res, cacheKey, method, url);
  }

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    const now = Date.now();
    if (now - cached.timestamp > 5 * 60 * 1000) {
      cache.delete(cacheKey);
    } else {
      sendCachedResponse(res, cached, method, url);
      return;
    }
  }

  await forwardRequest(req, res, cacheKey, method, url);
});

// === Start Server ===
server.listen(opts.port, () => {
  console.log(`Proxy: http://localhost:${opts.port}`);
  console.log(`Origin: ${opts.origin}`);
  console.log(`Clear: caching-proxy --clear-cache`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
});