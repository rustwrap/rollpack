"use strict";
/*
 * rollpack dev server — a webpack-dev-server-shaped dev server over the rollpack Compiler.
 *
 * It serves the compiled assets (+ static dirs) over HTTP, watches sources and rebuilds via the
 * Compiler, and pushes updates to the browser over Server-Sent Events. The injected client either
 * triggers a fast full reload (live-reload) or, when `hot` is enabled, runs registered
 * `module.hot` dispose handlers first. Granular state-preserving HMR is not possible on a
 * whole-bundle engine, so hot updates fall back to a reload (documented).
 *
 * Constructor is compatible with `new WebpackDevServer(options, compiler)` (and the legacy
 * `(compiler, options)` order).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain",
};
function mime(file) { return MIME[path.extname(file).toLowerCase()] || "application/octet-stream"; }

// Browser client: connects SSE, applies hot dispose handlers, then reloads on each successful build.
const CLIENT = `(function(){
  if (typeof window === "undefined" || !window.EventSource) return;
  var hot = window.__rollpack_hot__ || (window.__rollpack_hot__ = (function(){
    var accepts = [], disposes = [], statusHandlers = [], status = "idle", data = {};
    function setStatus(s){ status = s; statusHandlers.forEach(function(h){ try { h(s); } catch(e){} }); }
    return {
      _accepts: accepts, _disposes: disposes,
      accept: function(dep, cb){ if (typeof dep === "function" || dep == null) { accepts.push(dep || function(){}); } else { accepts.push(cb || function(){}); } },
      decline: function(){}, dispose: function(cb){ disposes.push(cb); }, addDisposeHandler: function(cb){ disposes.push(cb); },
      removeDisposeHandler: function(){}, invalidate: function(){ location.reload(); },
      data: data, status: function(){ return status; }, addStatusHandler: function(cb){ statusHandlers.push(cb); }, removeStatusHandler: function(){},
      apply: function(){ return Promise.resolve([]); }, check: function(){ return Promise.resolve(null); }, _setStatus: setStatus,
    };
  })());
  var first = true;
  var es = new EventSource("/__rollpack_sse");
  es.addEventListener("message", function(ev){
    var msg; try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if (msg.type === "connected") { first = false; return; }
    if (msg.type === "errors") { console.error("%c[rollpack] build failed", "color:red", "\\n" + (msg.errors||[]).join("\\n")); return; }
    if (msg.type === "ok") {
      hot._setStatus("check");
      try { hot._disposes.forEach(function(cb){ try { cb(hot.data); } catch(e){} }); } catch(e){}
      console.log("[rollpack] update — reloading");
      hot._setStatus("apply");
      location.reload();
    }
  });
  es.addEventListener("error", function(){ /* EventSource auto-retries */ });
})();`;

function normalizeStatic(stat, context) {
  if (stat === false) return [];
  if (stat == null) return [path.join(context, "public"), context];
  const arr = Array.isArray(stat) ? stat : [stat];
  return arr.map((s) => {
    if (typeof s === "string") return path.isAbsolute(s) ? s : path.resolve(context, s);
    if (s && s.directory) return path.isAbsolute(s.directory) ? s.directory : path.resolve(context, s.directory);
    return context;
  });
}

function injectClient(html) {
  const tag = `<script src="/__rollpack_hmr_client.js"></script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + "</body>");
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + "</head>");
  return html + "\n" + tag;
}

class DevServer {
  constructor(options, compiler) {
    // Support both `new DevServer(options, compiler)` and legacy `(compiler, options)`.
    if (options && (typeof options.run === "function" || options.hooks)) { const t = options; options = compiler; compiler = t; }
    this.options = options || {};
    this.compiler = compiler;
    this.sseClients = new Set();
    this.server = null;
    this.watching = null;
    this.lastHash = "";
  }

  start(cb) {
    const o = this.options;
    const compiler = this.compiler;
    const port = o.port != null ? o.port : 8080;
    const host = o.host || "localhost";
    const context = compiler.context;
    const ctx = {
      outDir: compiler.outputPath,
      staticDirs: normalizeStatic(o.static, context),
      historyApiFallback: o.historyApiFallback,
    };
    // Enable hot defines for the build.
    if (o.hot !== false) { compiler.$rollpack = compiler.$rollpack || {}; compiler.$rollpack.hot = true; }

    this.server = http.createServer((req, res) => this.handle(req, res, ctx));
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const actualPort = (this.server.address() && this.server.address().port) || port;
        const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/`;
        console.log(`\x1b[36m\x1b[1mrollpack\x1b[0m dev server running at \x1b[33m${url}\x1b[0m`);
        // Build + watch, push updates to clients.
        this.watching = compiler.watch(compiler.options.watchOptions || {}, (err, stats) => {
          if (err) { console.error(err); return; }
          this.lastHash = (stats && stats.toJson && stats.toJson().hash) || String(Date.now());
          this.broadcast(stats);
        });
        if (cb) cb(null, this);
        resolve(this);
      });
    });
  }

  broadcast(stats) {
    const hasErrors = stats && stats.hasErrors && stats.hasErrors();
    const payload = JSON.stringify(hasErrors
      ? { type: "errors", hash: this.lastHash, errors: (stats.toJson().errors || []).map((e) => e.message) }
      : { type: "ok", hash: this.lastHash });
    for (const res of this.sseClients) { try { res.write(`data: ${payload}\n\n`); } catch (_) {} }
  }

  handle(req, res, ctx) {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/__rollpack_sse") return this.sse(res);
    if (url === "/__rollpack_hmr_client.js") { res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" }); return res.end(CLIENT); }
    const rel = url.replace(/^\/+/, "") || "index.html";
    const bases = [ctx.outDir, ...ctx.staticDirs];
    for (const b of bases) if (this.serveFile(path.join(b, rel), res)) return;
    // SPA history fallback to index.html for extension-less routes.
    if (ctx.historyApiFallback !== false && !path.extname(rel)) {
      for (const b of bases) if (this.serveFile(path.join(b, "index.html"), res)) return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("rollpack dev server: not found — " + url);
  }

  serveFile(file, res) {
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
      const type = mime(file);
      let body = fs.readFileSync(file);
      if (type === "text/html") body = Buffer.from(injectClient(body.toString("utf8")));
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      res.end(body);
      return true;
    } catch (_) { return false; }
  }

  sse(res) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write("retry: 1000\n\n");
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }

  // webpack-dev-server v4 API
  startCallback(cb) { this.start().then(() => cb && cb(), cb); }
  stopCallback(cb) { this.stop().then(() => cb && cb(), cb); }
  async stop() {
    if (this.watching) await new Promise((r) => this.watching.close(r));
    for (const r of this.sseClients) { try { r.end(); } catch (_) {} }
    this.sseClients.clear();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
  close(cb) { this.stop().then(() => cb && cb(), cb); }
}

module.exports = DevServer;
