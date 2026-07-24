'use strict';

const crypto = require('crypto');
const path = require('path');

const DEFAULT_HASH_LENGTH = 20;

function hasValue(value) {
  return value !== undefined && value !== null;
}

function asString(value) {
  return hasValue(value) ? String(value) : '';
}

function normalizeLength(len) {
  if (!hasValue(len)) {
    return DEFAULT_HASH_LENGTH;
  }

  const parsed = Number(len);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_HASH_LENGTH;
}

function getHash(content, len) {
  const length = normalizeLength(len);
  const input = hasValue(content) ? content : '';
  const algorithm = crypto.getHashes().includes('md4') ? 'md4' : 'sha256';

  try {
    return crypto.createHash(algorithm).update(input).digest('hex').slice(0, length);
  } catch (error) {
    // Some OpenSSL builds list md4 but still reject it at runtime.
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
  }
}

function basename(resourcePath) {
  if (!hasValue(resourcePath)) {
    return '';
  }

  return path.win32.basename(path.posix.basename(String(resourcePath)));
}

function derivedExt(vars) {
  if (hasValue(vars.ext)) {
    return String(vars.ext);
  }

  const base = basename(vars.resourcePath);
  return base ? path.extname(base) : '';
}

function derivedName(vars) {
  if (hasValue(vars.name)) {
    return String(vars.name);
  }

  const base = basename(vars.resourcePath);
  const ext = base ? path.extname(base) : '';
  return ext ? base.slice(0, -ext.length) : base;
}

function derivedBase(vars) {
  const base = basename(vars.resourcePath);
  if (base) {
    return base;
  }

  const name = derivedName(vars);
  const ext = derivedExt(vars);
  return name || ext ? name + ext : '';
}

function relativePath(vars) {
  if (!hasValue(vars.resourcePath) || !hasValue(vars.context)) {
    return '';
  }

  const resourcePath = String(vars.resourcePath);
  const context = String(vars.context);
  const directory = path.dirname(resourcePath);

  if (!directory || directory === '.') {
    return '';
  }

  const relative = path.relative(context, directory);
  if (!relative || relative === '.') {
    return '';
  }

  return relative.replace(/\\/g, '/') + '/';
}

function hashValue(providedHash, content, len) {
  const length = normalizeLength(len);
  if (hasValue(providedHash)) {
    return String(providedHash).slice(0, length);
  }

  return getHash(content, length);
}

function interpolateName(template, vars) {
  const values = vars || {};

  if (typeof template === 'function') {
    return asString(template(values));
  }

  return asString(template).replace(/\[([A-Za-z]+)(?::(\d+))?\]/g, (match, token, len) => {
    switch (token.toLowerCase()) {
      case 'name':
        return derivedName(values);
      case 'ext':
        return derivedExt(values);
      case 'base':
        return derivedBase(values);
      case 'path':
        return relativePath(values);
      case 'query':
        return asString(values.query);
      case 'id':
        return asString(hasValue(values.id) ? values.id : (hasValue(values.chunkName) ? values.chunkName : values.name));
      case 'chunkname':
        return asString(values.chunkName || values.name);
      case 'hash':
      case 'fullhash':
        return hashValue(values.fullHash, values.content, len);
      case 'contenthash':
      case 'chunkhash':
        return hashValue(values.contentHash, values.content, len);
      default:
        return match;
    }
  });
}

module.exports = {
  interpolateName,
  getHash,
};
