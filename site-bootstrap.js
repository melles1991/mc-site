'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function readEnv(text) {
  const out = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s=]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
function validSecret(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512
    && !/[\x00-\x20\x7f]/.test(value) && !/^(generated?-by-|generate-with-|change-|replace-|your-)/i.test(value);
}
function publicOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('PUBLIC_SITE_URL must be an HTTP(S) origin without a path, credentials or query.');
  return url.origin;
}
function bootstrap(root = __dirname, env = process.env) {
  const file = env.HOMECRAFT_ENV_FILE ? path.resolve(root, env.HOMECRAFT_ENV_FILE) : path.join(root, '.env');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const values = readEnv(original);
  const activeSecrets = [...new Set([env.SERVER_SECRET, env.HOMECRAFT_SERVER_SECRET].filter(validSecret))];
  const storedSecrets = [...new Set([values.SERVER_SECRET, values.HOMECRAFT_SERVER_SECRET].filter(validSecret))];
  if (activeSecrets.length > 1) throw new Error('SERVER_SECRET and HOMECRAFT_SERVER_SECRET conflict in the environment. Fix them before starting the site.');
  if (storedSecrets.length > 1) throw new Error('SERVER_SECRET and HOMECRAFT_SERVER_SECRET conflict in site.env. Fix them before starting the site.');
  const externalSecret = activeSecrets[0];
  const storedSecret = storedSecrets[0];
  const secret = externalSecret || storedSecret || crypto.randomBytes(32).toString('hex');
  if ((!exists && !externalSecret) || (exists && !storedSecret && !externalSecret)) {
    let text = original.replace(/^\s*(?:HOMECRAFT_SERVER_SECRET|SERVER_SECRET)\s*=.*$/gm, '').trimEnd();
    text += '\nHOMECRAFT_SERVER_SECRET=' + secret + '\n';
    const tmp = file + '.tmp-' + crypto.randomBytes(5).toString('hex');
    try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
  env.SERVER_SECRET = secret; env.HOMECRAFT_SERVER_SECRET = secret;
  const configured = String(env.PUBLIC_SITE_URL || env.HOMECRAFT_PUBLIC_SITE_URL || '').trim();
  const url = configured ? publicOrigin(configured) : `http://localhost:${env.PORT || 3000}`;
  env.PUBLIC_SITE_URL = url; env.HOMECRAFT_PUBLIC_SITE_URL = url;
  env.HOMECRAFT_SITE_PREVIEW = configured ? 'false' : 'true';
  return { publicSiteUrl: url, preview: !configured };
}
module.exports = { bootstrap, readEnv, validSecret, publicOrigin };
