"use strict";
/*
 * Ambient `const enum` inlining (tsc-parity).
 *
 * tsc/ts-loader inline ambient `const enum` member accesses to literal values at compile time
 * (e.g. `XrmClientApi.Constants.GlobalNotificationLevel.success` -> `1`). Fast TS transformers
 * (oxc/rolldown, esbuild, swc) do NOT inline ambient const enums declared in `.d.ts`, leaving the
 * member access as a runtime reference to a namespace object that doesn't exist at runtime ->
 * "XrmClientApi is not defined".
 *
 * This module parses const enums (with their full namespace path) from the project's `.ts/.tsx`
 * sources and any `.d.ts` they pull in via triple-slash `/// <reference path=.../>`, and returns a
 * map of `Ns.Sub.Enum.Member` -> literal. build.js merges that map into the Define map so the
 * existing (AST-aware) define replacement inlines them exactly like tsc would.
 */
const fs = require("fs");
const path = require("path");

function loadTS(context) {
  try { return require(require.resolve("typescript", { paths: [context, process.cwd()] })); }
  catch { return null; }
}

// Walk a directory for .ts/.tsx sources (skipping node_modules/out/dist/dot-dirs).
function walkSources(dir, out, depth) {
  if (depth > 10) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "out" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSources(full, out, depth + 1);
    else if (/\.(ts|tsx)$/.test(e.name)) out.add(path.normalize(full));
  }
}

// Resolve triple-slash `/// <reference path='...'/>` directives to absolute paths.
function refsIn(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  const re = /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]\s*\/>/g;
  let m;
  while ((m = re.exec(text))) out.push(path.resolve(path.dirname(file), m[1]));
  return out;
}

// Parse one file's const enums into map[fullPath] = literalString.
function collectFile(ts, file, map) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  if (!/const\s+enum/.test(text)) return; // fast skip — most files have none
  let sf;
  try { sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true); } catch { return; }
  const nsStack = [];
  const isConst = (node) => {
    const mods = ts.canHaveModifiers ? ts.getModifiers(node) : node.modifiers;
    return !!(mods && mods.some((m) => m.kind === ts.SyntaxKind.ConstKeyword));
  };
  const visit = (node) => {
    if (ts.isModuleDeclaration(node) && node.name && node.body) {
      nsStack.push(node.name.text);
      ts.forEachChild(node.body, visit);
      nsStack.pop();
      return;
    }
    if (ts.isEnumDeclaration(node) && isConst(node)) {
      const enumName = node.name.text;
      let auto = 0;
      for (const member of node.members) {
        let memberName;
        try { memberName = member.name.getText(sf).replace(/^['"]|['"]$/g, ""); } catch { continue; }
        let value;
        const init = member.initializer;
        if (!init) {
          value = auto; auto += 1;
        } else if (ts.isNumericLiteral(init)) {
          value = Number(init.text); auto = value + 1;
        } else if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand)) {
          value = -Number(init.operand.text); auto = value + 1;
        } else if (ts.isStringLiteral(init)) {
          value = init.text; // string enum member — no auto-increment afterwards
        } else {
          continue; // computed/complex initializer — cannot safely inline
        }
        const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
        map[[...nsStack, enumName, memberName].join(".")] = literal;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// Build the const-enum -> literal map for a build rooted at `context`.
function collectConstEnumDefines(context) {
  const ts = loadTS(context);
  if (!ts) return {}; // typescript not installed -> no-op (degrade to prior behavior)

  const files = new Set();

  // Primary: resolve the tsconfig exactly as tsc would (honoring `extends`, `files`, `include`,
  // `exclude`). This is what pulls in ambient typings declared via `files` in a base tsconfig
  // (e.g. XrmClientApi.d.ts), which triple-slash scanning alone would miss.
  try {
    const configPath = ts.findConfigFile(context, ts.sys.fileExists, "tsconfig.json");
    if (configPath) {
      const host = Object.assign({}, ts.sys, { onUnRecoverableConfigFileDiagnostic() {} });
      const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
      if (parsed && parsed.fileNames) for (const f of parsed.fileNames) files.add(path.normalize(f));
    }
  } catch { /* fall through to source walk */ }

  // Fallback / supplement: walk sources under context when tsconfig resolution yields nothing.
  if (files.size === 0) walkSources(context, files, 0);

  // Always also follow triple-slash `/// <reference path>` directives transitively (covers files
  // referenced directly from source but not listed by the tsconfig).
  const queue = Array.from(files);
  while (queue.length) {
    const f = queue.shift();
    for (const r of refsIn(f)) {
      const n = path.normalize(r);
      if (!files.has(n)) { files.add(n); queue.push(n); }
    }
  }

  const map = {};
  for (const f of files) {
    try { collectFile(ts, f, map); } catch { /* keep going */ }
  }
  return map;
}

module.exports = { collectConstEnumDefines };
