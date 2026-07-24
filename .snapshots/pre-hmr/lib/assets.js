"use strict";
/*
 * Asset modules (webpack 5): type "asset/resource" (emit a file, import resolves to its URL),
 * "asset/inline" (data URI), "asset/source" (raw string), and "asset" (auto: inline under the
 * dataUrlCondition.maxSize threshold, else resource).
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function hash(content, len) {
  const algo = crypto.getHashes().includes("md4") ? "md4" : "sha256";
  return crypto.createHash(algo).update(content).digest("hex").slice(0, len || 20);
}

function interpolate(template, resource, content, publicPath) {
  const ext = path.extname(resource);
  const name = path.basename(resource, ext);
  const h = hash(content, 20);
  if (typeof template === "function") template = template({ filename: resource });
  return (template || "[hash][ext]")
    .replace(/\[ext\]/gi, ext)
    .replace(/\[name\]/gi, name)
    .replace(/\[base\]/gi, name + ext)
    .replace(/\[(?:content|full)?hash(?::(\d+))?\]/gi, (_m, n) => h.slice(0, n ? parseInt(n, 10) : 20));
}

// Returns a Rolldown load() result: an ESM module exporting the asset's URL / data-uri / source.
function handleAsset(resource, meta, cfg, compilation, _prod) {
  const out = cfg.output || {};
  const content = fs.readFileSync(resource);
  const type = meta.type;
  const mimeFor = (p) => { try { return require("mime-types").lookup(p) || "application/octet-stream"; } catch (_) { return "application/octet-stream"; } };

  let resolvedType = type;
  if (type === "asset") {
    const maxSize = (meta.parser && meta.parser.dataUrlCondition && meta.parser.dataUrlCondition.maxSize) || 8192;
    resolvedType = content.length <= maxSize ? "asset/inline" : "asset/resource";
  }

  if (resolvedType === "asset/source") {
    return { code: `export default ${JSON.stringify(content.toString("utf8"))};`, moduleType: "js" };
  }
  if (resolvedType === "asset/inline") {
    const mime = mimeFor(resource);
    const dataUri = `data:${mime};base64,${content.toString("base64")}`;
    return { code: `export default ${JSON.stringify(dataUri)};`, moduleType: "js" };
  }
  // asset/resource: emit the file and resolve to its public URL.
  const tmpl = (meta.generator && meta.generator.filename) || out.assetModuleFilename || "[hash][ext]";
  const filename = interpolate(tmpl, resource, content, out.publicPath).replace(/^\.?[\\/]/, "");
  if (compilation) compilation.emitAsset(filename, content, { sourceFilename: resource });
  const publicPath = (meta.generator && meta.generator.publicPath) || out.publicPath || "";
  const url = (typeof publicPath === "string" ? publicPath : "") + filename;
  return { code: `export default ${JSON.stringify(url)};`, moduleType: "js" };
}

module.exports = { handleAsset, hash, interpolate };
