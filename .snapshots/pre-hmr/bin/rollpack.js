#!/usr/bin/env node
"use strict";
/*
 * rollpack CLI — a minimal `webpack`-compatible command. pcf-scripts uses the programmatic API
 * (require("webpack")(config, cb)), so this CLI only covers basic `webpack [--config f] [--mode m]`
 * invocations for direct use.
 */
const path = require("path");
const fs = require("fs");
const Module = require("module");

// webpack.config.js files often `require()` webpack-ecosystem plugins (TerserPlugin, analyzer,
// eslint-webpack-plugin, ...) that Rolldown doesn't need. Stub any that aren't resolvable so the
// config loads; rollpack reads the relevant intent (mode, externals, Define/Banner) from the object.
const STUB_PKGS = new Set([
  "terser-webpack-plugin", "webpack-bundle-analyzer", "eslint-webpack-plugin",
  "css-minimizer-webpack-plugin", "mini-css-extract-plugin", "fork-ts-checker-webpack-plugin",
  "webpack-cli", "style-loader", "css-loader", "sass-loader", "ts-loader",
]);
function makeStub() {
  class StubPlugin { constructor(o) { this.options = o; } apply() {} }
  return new Proxy(StubPlugin, { get(t, p) { if (p in t) return t[p]; if (typeof p === "string" && /^[A-Z]/.test(p)) return StubPlugin; return undefined; } });
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try { return origLoad.apply(this, arguments); }
  catch (e) { if (STUB_PKGS.has(request)) return makeStub(); throw e; }
};

const webpack = require("../lib/index.js");

function parseArgs(argv) {
  const o = { mode: undefined, config: undefined, watch: false, env: {}, serve: false, port: undefined, host: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "serve" || a === "dev" || a === "server") o.serve = true;
    else if (a === "build") { /* default */ }
    else if (a === "--config" || a === "-c") o.config = argv[++i];
    else if (a === "--mode") o.mode = argv[++i];
    else if (a === "--watch" || a === "-w") o.watch = true;
    else if (a === "--port") o.port = parseInt(argv[++i], 10);
    else if (a === "--host") o.host = argv[++i];
    else if (a.startsWith("--env")) { const kv = (a.includes("=") ? a.slice(6) : argv[++i] || "").split("="); o.env[kv[0]] = kv.length > 1 ? kv[1] : true; }
  }
  return o;
}

function findConfig(explicit) {
  if (explicit) return path.resolve(explicit);
  for (const n of ["webpack.config.js", "webpack.config.cjs"]) {
    const p = path.resolve(process.cwd(), n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const opts = parseArgs(process.argv.slice(2));
const configPath = findConfig(opts.config);
let config = {};
if (configPath) {
  config = require(configPath);
  if (typeof config === "function") config = config(opts.env, { mode: opts.mode }) || {};
}
if (opts.mode) config.mode = opts.mode;
if (opts.watch) config.watch = true;

if (opts.serve) {
  // `rollpack serve` / `webpack serve` — start the dev server.
  if (!config.mode) config.mode = "development";
  const devServerOpts = Object.assign({ hot: true }, config.devServer || {});
  if (opts.port) devServerOpts.port = opts.port;
  if (opts.host) devServerOpts.host = opts.host;
  const compiler = webpack(config);
  const server = new webpack.DevServer(devServerOpts, compiler);
  server.start().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
  process.on("SIGINT", () => server.stop().then(() => process.exit(0)));
} else {
  webpack(config, (err, stats) => {
    if (err) { console.error(String(err && err.stack || err)); process.exit(1); }
    if (stats && stats.hasErrors()) { console.error(stats.toString()); process.exit(2); }
  });
}
