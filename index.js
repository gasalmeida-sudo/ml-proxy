const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const PROXY_SECRET = process.env.PROXY_SECRET || "";

const ALLOWED_HOSTS = ["api.mercadolibre.com", "api.mercadolivre.com.br"];

function proxyRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, Host: url.hostname },
    };
    delete options.headers["host"];
    delete options.headers["x-proxy-secret"];
    delete options.headers["x-target-url"];
    delete options.headers["connection"];
    delete options.headers["transfer-encoding"];

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
    return res.end(JSON.stringify({ status: "ok", version: "2.0" }));
  }

  // Auth check
  if (PROXY_SECRET && req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // Get target URL from: header, /proxy/{url} path, or ?url= query param
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

    const fwdHeaders = { ...req.headers };
    delete fwdHeaders["x-proxy-secret"];
    delete fwdHeaders["x-target-url"];
    delete fwdHeaders["host"];
    delete fwdHeaders["connection"];

    const result = await proxyRequest(targetUrl, req.method, fwdHeaders, body);

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

server.listen(PORT, () => console.log(`ML Proxy v2 running on port ${PORT}`));
