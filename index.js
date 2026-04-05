const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET;
const ALLOWED_HOSTS = ["api.mercadolibre.com", "api.mercadolivre.com.br"];

http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-proxy-secret");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Auth
  if (PROXY_SECRET && req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    res.writeHead(403); return res.end("Forbidden");
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { url, method = "GET", headers = {}, body: reqBody } = JSON.parse(body || "{}");
      if (!url) { res.writeHead(400); return res.end("Missing url"); }

      const parsed = new URL(url);
      if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
        res.writeHead(403); return res.end("Host not allowed");
      }

      const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method, headers };
      const proxy = https.request(opts, (pRes) => {
        let data = "";
        pRes.on("data", (c) => (data += c));
        pRes.on("end", () => {
          res.writeHead(pRes.statusCode, { "Content-Type": pRes.headers["content-type"] || "application/json" });
          res.end(data);
        });
      });
      proxy.on("error", (e) => { res.writeHead(502); res.end(e.message); });
      if (reqBody) proxy.write(typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody));
      proxy.end();
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
}).listen(PORT, () => console.log(`Proxy on :${PORT}`));
