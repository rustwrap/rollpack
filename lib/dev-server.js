"use strict";
/*
 * webpack-dev-server-shaped HTTP server. Single-entry browser builds use Rolldown's native
 * DevEngine for incremental rebuilds, per-client patches and optional dynamic-import lazy
 * compilation. Unsupported shapes retain the complete-rebuild live-reload fallback.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createNativeDevBuild } = require("./build");
const { NATIVE_RUNTIME, FALLBACK_CLIENT } = require("./hmr-runtime");

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain",
};

function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function normalizeStatic(stat, context) {
  if (stat === false) return [];
  if (stat == null) return [path.join(context, "public"), context];
  const list = Array.isArray(stat) ? stat : [stat];
  return list.map((item) => {
    if (typeof item === "string") return path.isAbsolute(item) ? item : path.resolve(context, item);
    if (item && item.directory) return path.isAbsolute(item.directory)
      ? item.directory
      : path.resolve(context, item.directory);
    return context;
  });
}

function injectClient(html) {
  const tag = `<script src="/__rustwrap_hmr_client.js"></script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + "</body>");
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + "</head>");
  return html + "\n" + tag;
}

function lazyImportsEnabled(config) {
  const value = config && config.experiments && config.experiments.lazyCompilation;
  if (value === true) return true;
  return !!(value && typeof value === "object" && value.imports !== false);
}

function messagesFromStats(stats) {
  if (!stats || typeof stats.toJson !== "function") return [];
  return (stats.toJson().errors || []).map((error) => error.message || String(error));
}

class DevServer {
  constructor(options, compiler) {
    // Support both `new DevServer(options, compiler)` and the legacy `(compiler, options)` order.
    if (options && (typeof options.run === "function" || options.hooks)) {
      const current = options;
      options = compiler;
      compiler = current;
    }
    this.options = options || {};
    this.compiler = compiler;
    this.sseClients = new Map();
    this.clientRegistrations = new Map();
    this.patchFiles = new Map();
    this.memoryAssets = new Map();
    this.server = null;
    this.watching = null;
    this.devEngine = null;
    this.nativeBuild = null;
    this.nativeHmr = false;
    this.lastHash = "";
    this.lastStats = null;
    this.lastBuildErrored = false;
    this.fallbackClientSeed = 0;
  }

  async start(cb) {
    const options = this.options;
    const compiler = this.compiler;
    const port = options.port != null ? options.port : 8080;
    const host = options.host || "localhost";
    const context = compiler.context;
    const serverContext = {
      outDir: compiler.outputPath,
      staticDirs: normalizeStatic(options.static, context),
      historyApiFallback: options.historyApiFallback,
    };
    const hot = options.hot !== false;
    if (hot) {
      compiler.$rustwrap = compiler.$rustwrap || {};
      compiler.$rustwrap.hot = true;
    }

    this.server = http.createServer((req, res) => {
      Promise.resolve(this.handle(req, res, serverContext)).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
        if (!res.writableEnded) res.end(error && error.stack ? error.stack : String(error));
      });
    });

    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(port, host, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      const actualPort = (this.server.address() && this.server.address().port) || port;
      const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/`;
      console.log(`\x1b[36m\x1b[1m@rustwrap/webpack\x1b[0m dev server running at \x1b[33m${url}\x1b[0m`);

      if (hot) {
        const devMode = {
          implement: NATIVE_RUNTIME,
          lazy: lazyImportsEnabled(compiler.options),
        };
        this.nativeBuild = createNativeDevBuild(compiler, compiler.options, context, devMode);
      }
      if (this.nativeBuild) await this.startNativeWatcher();
      else this.startFallbackWatcher();
    } catch (error) {
      if (this.server && this.server.listening) await new Promise((resolve) => this.server.close(resolve));
      if (cb) cb(error);
      throw error;
    }

    if (cb) cb(null, this);
    return this;
  }

  async startNativeWatcher() {
    const { dev } = await import("rolldown/experimental");
    const watchOptions = this.compiler.options.watchOptions || {};
    const watch = {
      skipWrite: true,
      usePolling: !!watchOptions.poll,
      pollInterval: typeof watchOptions.poll === "number" ? watchOptions.poll : undefined,
      debounceDuration: watchOptions.aggregateTimeout == null ? 10 : watchOptions.aggregateTimeout,
    };
    if (watchOptions.ignored) watch.exclude = watchOptions.ignored;

    this.compiler.watchMode = true;
    this.nativeHmr = true;
    this.devEngine = await dev(this.nativeBuild.inputOptions, this.nativeBuild.outputOptions, {
      rebuildStrategy: "always",
      watch,
      onOutput: (result) => this.consumeNativeOutput(result),
      onHmrUpdates: (result) => this.consumeNativeUpdates(result),
      onAdditionalAssets: (output) => this.captureAdditionalAssets(output),
    });
    await this.devEngine.run();
  }

  startFallbackWatcher() {
    this.watching = this.compiler.watch(this.compiler.options.watchOptions || {}, (error, stats) => {
      if (error) {
        console.error(error);
        this.broadcastPayload({ type: "errors", errors: [error.message || String(error)] });
        return;
      }
      this.lastStats = stats;
      this.lastHash = (stats && stats.toJson && stats.toJson().hash) || String(Date.now());
      const hasErrors = stats && stats.hasErrors && stats.hasErrors();
      this.broadcastPayload(hasErrors
        ? { type: "errors", hash: this.lastHash, errors: messagesFromStats(stats) }
        : { type: "ok", hash: this.lastHash });
    });
  }

  async consumeNativeOutput(result) {
    const isError = result instanceof Error;
    const snapshot = this.nativeBuild.sink.drain();
    await this.compiler.hooks.watchRun.promise(this.compiler);
    const stats = await this.compiler.compile({
      nativeHmr: true,
      output: isError ? null : result,
      error: isError ? result : null,
      sink: snapshot,
    });
    await this.compiler.hooks.done.promise(stats);
    this.compiler.hooks.afterDone.call(stats);
    this.lastStats = stats;
    this.lastHash = (stats.toJson().hash) || String(Date.now());
    const hasErrors = stats.hasErrors();
    const recovered = this.lastBuildErrored && !hasErrors;
    this.lastBuildErrored = hasErrors;
    if (hasErrors) {
      this.broadcastPayload({ type: "errors", hash: this.lastHash, errors: messagesFromStats(stats) });
    } else if (recovered) {
      this.broadcastPayload({ type: "reload", reason: "build recovered" });
    }
  }

  consumeNativeUpdates(result) {
    if (result instanceof Error) {
      this.lastBuildErrored = true;
      this.broadcastPayload({ type: "errors", errors: [result.message || String(result)] });
      return;
    }
    this.lastBuildErrored = false;
    for (const clientUpdate of result.updates || []) {
      const clientId = clientUpdate.clientId;
      const update = clientUpdate.update;
      if (!update || update.type === "Noop") continue;
      if (update.type === "FullReload") {
        this.sendToClient(clientId, { type: "reload", reason: update.reason });
        continue;
      }
      if (update.type !== "Patch") {
        throw new Error(`Unknown Rolldown HMR update: ${JSON.stringify(update)}`);
      }
      this.storePatchFiles(clientId, update);
      this.sendToClient(clientId, {
        type: "patch",
        url: this.patchUrl(clientId, update.filename),
        changedIds: update.changedIds,
        seq: update.seq,
      });
    }
  }

  storePatchFiles(clientId, update) {
    const key = this.patchKey(clientId, update.filename);
    this.patchFiles.set(key, {
      body: update.code,
      contentType: "application/javascript",
      notifyFilename: update.filename,
    });
    if (update.sourcemap && update.sourcemapFilename) {
      this.patchFiles.set(this.patchKey(clientId, update.sourcemapFilename), {
        body: update.sourcemap,
        contentType: "application/json",
      });
    }
    // Bound long-running dev sessions without deleting a just-announced patch.
    while (this.patchFiles.size > 200) this.patchFiles.delete(this.patchFiles.keys().next().value);
  }

  patchKey(clientId, filename) {
    return `${clientId}\0${filename}`;
  }

  patchUrl(clientId, filename) {
    return `/__rustwrap_hmr/${encodeURIComponent(clientId)}/${encodeURIComponent(filename)}`;
  }

  captureAdditionalAssets(output) {
    for (const item of (output && output.output) || []) {
      const body = item.type === "chunk" ? item.code : item.source;
      this.memoryAssets.set("/" + item.fileName.replace(/\\/g, "/").replace(/^\/+/, ""), body);
    }
  }

  broadcastPayload(message) {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    for (const response of this.sseClients.values()) {
      try { response.write(payload); } catch (_) {}
    }
  }

  sendToClient(clientId, message) {
    const response = this.sseClients.get(clientId);
    if (!response) return;
    try { response.write(`data: ${JSON.stringify(message)}\n\n`); } catch (_) {}
  }

  async handle(req, res, context) {
    const parsed = new URL(req.url || "/", "http://rustwrap.local");
    const url = decodeURIComponent(parsed.pathname);
    if (url === "/__rustwrap_sse") return this.sse(req, res, parsed);
    if (url === "/__rustwrap_hmr_client.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
      res.end(FALLBACK_CLIENT);
      return;
    }
    if (url.startsWith("/__rustwrap_hmr/")) return this.servePatch(url, res);
    if (url === "/@vite/lazy") return this.serveLazyEntry(parsed, res);
    if (this.devEngine) await this.devEngine.ensureLatestBuildOutput();
    if (this.memoryAssets.has(url)) {
      res.writeHead(200, { "Content-Type": mime(url), "Cache-Control": "no-cache" });
      res.end(this.memoryAssets.get(url));
      return;
    }

    const rel = url.replace(/^\/+/, "") || "index.html";
    const bases = [context.outDir, ...context.staticDirs];
    for (const base of bases) if (this.serveFile(path.join(base, rel), res)) return;
    if (context.historyApiFallback !== false && !path.extname(rel)) {
      for (const base of bases) if (this.serveFile(path.join(base, "index.html"), res)) return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("@rustwrap/webpack dev server: not found - " + url);
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
    } catch (_) {
      return false;
    }
  }

  async servePatch(url, res) {
    const parts = url.slice("/__rustwrap_hmr/".length).split("/");
    if (parts.length !== 2) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("HMR patch not found");
      return;
    }
    const clientId = decodeURIComponent(parts[0]);
    const filename = decodeURIComponent(parts[1]);
    const patch = this.patchFiles.get(this.patchKey(clientId, filename));
    if (!patch) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("HMR patch not found");
      return;
    }
    res.writeHead(200, { "Content-Type": patch.contentType, "Cache-Control": "no-cache" });
    if (patch.notifyFilename && this.devEngine) {
      res.once("finish", () => {
        this.devEngine.notifyPayloadDelivered(patch.notifyFilename).catch((error) => console.error(error));
      });
    }
    res.end(patch.body);
  }

  async serveLazyEntry(parsed, res) {
    if (!this.devEngine || !this.nativeHmr) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Lazy compilation is not enabled");
      return;
    }
    const moduleId = parsed.searchParams.get("id");
    const clientId = parsed.searchParams.get("clientId");
    if (!moduleId || !clientId) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing lazy compilation id or clientId");
      return;
    }
    const pendingRegistration = this.clientRegistrations.get(clientId);
    if (pendingRegistration) await pendingRegistration;
    else if (!this.sseClients.has(clientId)) await this.devEngine.registerClient(clientId);
    const output = await this.devEngine.compileEntry(moduleId, clientId);
    res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
    res.once("finish", () => {
      this.devEngine.notifyPayloadDelivered(output.filename).catch((error) => console.error(error));
    });
    res.end(output.code);
  }

  async sse(_req, res, parsed) {
    const clientId = parsed.searchParams.get("clientId") || `fallback-${++this.fallbackClientSeed}`;
    const previous = this.sseClients.get(clientId);
    if (previous && previous !== res) {
      try { previous.end(); } catch (_) {}
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 1000\n\n");
    this.sseClients.set(clientId, res);
    res.on("close", () => {
      if (this.sseClients.get(clientId) !== res) return;
      this.sseClients.delete(clientId);
      this.clientRegistrations.delete(clientId);
      if (this.devEngine) {
        this.devEngine.removeClient(clientId).catch((error) => console.error(error));
      }
    });

    if (this.devEngine) {
      const registration = this.devEngine.registerClient(clientId);
      this.clientRegistrations.set(clientId, registration);
      await registration;
    }
    res.write(`data: ${JSON.stringify({ type: "connected", clientId })}\n\n`);
    if (this.lastStats && this.lastStats.hasErrors && this.lastStats.hasErrors()) {
      res.write(`data: ${JSON.stringify({ type: "errors", errors: messagesFromStats(this.lastStats) })}\n\n`);
    }
  }

  startCallback(cb) {
    this.start().then(() => cb && cb(), cb);
  }

  stopCallback(cb) {
    this.stop().then(() => cb && cb(), cb);
  }

  async stop() {
    if (this.watching) await new Promise((resolve) => this.watching.close(resolve));
    if (this.devEngine) {
      await this.devEngine.close();
      this.devEngine = null;
    }
    for (const response of this.sseClients.values()) {
      try { response.end(); } catch (_) {}
    }
    this.sseClients.clear();
    this.clientRegistrations.clear();
    this.patchFiles.clear();
    this.memoryAssets.clear();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  close(cb) {
    this.stop().then(() => cb && cb(), cb);
  }
}

module.exports = DevServer;
