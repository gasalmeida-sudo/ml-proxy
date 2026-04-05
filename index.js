const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const PROXY_SECRET = process.env.PROXY_SECRET || "";

const ALLOWED_HOSTS = ["api.mercadolibre.com", "api.mercadolivre.com.br"];

// Browser-like headers to avoid cloud IP detection
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

function proxyRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const finalHeaders = { ...BROWSER_HEADERS, ...headers, Host: url.hostname };
    
    // Remove proxy-specific and problematic headers
    delete finalHeaders["x-proxy-secret"];
    delete finalHeaders["x-target-url"];
    delete finalHeaders["connection"];
    delete finalHeaders["transfer-encoding"];
    
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: finalHeaders,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", version: "3.0" }));
  }

  // Auth check
  if (PROXY_SECRET && req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // Get target URL from: header, ?url= query param, or /proxy/{url} path
  let targetUrl = req.headers["x-target-url"];
  
  if (!targetUrl) {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const urlParam = parsedUrl.searchParams.get("url");
    if (urlParam) {
      targetUrl = urlParam;
    } else if (req.url.startsWith("/proxy/")) {
      targetUrl = decodeURIComponent(req.url.slice(7));
    }
  }

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing url. Use header x-target-url, query ?url=, or path /proxy/{url}" }));
  }

  // Validate target is ML API only
  try {
    const parsed = new URL(targetUrl);
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Only Mercado Livre API domains allowed" }));
    }
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid target URL" }));
  }

  try {
    const bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
    const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : null;

    // Only forward content-type and authorization from original request
    const fwdHeaders = {};
    if (req.headers["content-type"]) fwdHeaders["Content-Type"] = req.headers["content-type"];
    if (req.headers["authorization"]) fwdHeaders["Authorization"] = req.headers["authorization"];

    console.log(`[Proxy] ${req.method} -> ${targetUrl}`);

    const result = await proxyRequest(targetUrl, req.method, fwdHeaders, body);

    console.log(`[Proxy] Response: ${result.status}`);

    const responseHeaders = {
      "Content-Type": result.headers["content-type"] || "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    res.writeHead(result.status, responseHeaders);
    res.end(result.body);
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Proxy request failed", details: err.message }));
  }
});

server.listen(PORT, () => console.log(`ML Proxy v3 running on port ${PORT}`));
