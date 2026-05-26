#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const ENV_PATH = path.join(ROOT, '.env');
const PUB_PATH = path.join(ROOT, 'web/server/data/portal.pub');
const CLIENTS_PATH = path.join(ROOT, 'web/server/data/clients.json');

// ── Exported helpers ────────────────────────────────────────────────

export function base64url(buf) {
  const b64 = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseDuration(str) {
  const m = str.match(/^(\d+)(d|h)$/);
  if (!m) throw new Error(`Invalid duration: "${str}" (use e.g. 365d or 24h)`);
  const n = parseInt(m[1], 10);
  return m[2] === 'd' ? n * 86400 : n * 3600;
}

export function loadPrivateKey() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}. Run --init first.`);
  }
  const env = fs.readFileSync(ENV_PATH, 'utf8');
  const match = env.match(/^PORTAL_SIGNING_KEY=(.+)$/m);
  if (!match) {
    throw new Error('PORTAL_SIGNING_KEY not found in .env. Run --init first.');
  }
  const der = Buffer.from(match[1], 'base64');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function signJwt(payload, privateKey) {
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];
  const data = Buffer.from(segments.join('.'));
  const sig = crypto.sign(null, data, privateKey);
  segments.push(base64url(sig));
  return segments.join('.');
}

export function generateKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

// ── Internal helpers ────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function readClients() {
  if (!fs.existsSync(CLIENTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8'));
}

function writeClients(arr) {
  fs.mkdirSync(path.dirname(CLIENTS_PATH), { recursive: true });
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(arr, null, 2) + '\n');
}

function formatDate(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

// ── CLI modes ───────────────────────────────────────────────────────

function doInit() {
  const { publicKey, privateKey } = generateKeypair();

  // Write public key PEM
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.mkdirSync(path.dirname(PUB_PATH), { recursive: true });
  fs.writeFileSync(PUB_PATH, pubPem);

  // Encode private key as base64 DER
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const privB64 = Buffer.from(privDer).toString('base64');

  // Write/replace in .env
  const line = `PORTAL_SIGNING_KEY=${privB64}`;
  if (fs.existsSync(ENV_PATH)) {
    let env = fs.readFileSync(ENV_PATH, 'utf8');
    if (/^PORTAL_SIGNING_KEY=.+$/m.test(env)) {
      env = env.replace(/^PORTAL_SIGNING_KEY=.+$/m, line);
    } else {
      env = env.trimEnd() + '\n' + line + '\n';
    }
    fs.writeFileSync(ENV_PATH, env);
  } else {
    fs.writeFileSync(ENV_PATH, line + '\n');
  }

  console.log(`Public key  → ${path.relative(ROOT, PUB_PATH)}`);
  console.log(`Private key → .env  PORTAL_SIGNING_KEY`);
}

function doClient(name, platforms, expireStr) {
  const privateKey = loadPrivateKey();
  const sub = slugify(name);
  const jti = crypto.randomUUID().slice(0, 8);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + parseDuration(expireStr);

  const platformList = platforms.split(',').map(p => p.trim());

  const payload = { sub, name, platforms: platformList, iat, exp, jti };
  const token = signJwt(payload, privateKey);

  // Update clients.json
  const clients = readClients();
  clients.push({
    jti,
    sub,
    name,
    platforms: platformList,
    issuedAt: formatDate(iat),
    expiresAt: formatDate(exp),
    token,
  });
  writeClients(clients);

  const url = `https://v3.shoulde.rs/download?key=${token}`;
  console.log(`jti         ${jti}`);
  console.log(`sub         ${sub}`);
  console.log(`platforms   ${platformList.join(', ')}`);
  console.log(`expires     ${formatDate(exp)}`);
  console.log(`\n${url}`);
}

function doAdmin(expireStr) {
  const privateKey = loadPrivateKey();
  const jti = crypto.randomUUID().slice(0, 8);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + parseDuration(expireStr);

  const payload = { sub: 'admin', role: 'admin', iat, exp, jti };
  const token = signJwt(payload, privateKey);

  console.log(token);
}

function printUsage() {
  console.log(`Usage:
  node scripts/issue-token.mjs --init
      Generate Ed25519 keypair, write public key and store private key in .env

  node scripts/issue-token.mjs "Client Name" [--platforms=macos-arm,windows] [--expires=365d]
      Issue a client download token (saved to clients.json)

  node scripts/issue-token.mjs --admin [--expires=7d]
      Issue an admin token (printed to stdout)`);
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Parse flags
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  if (flags.init) {
    doInit();
  } else if (flags.admin) {
    doAdmin(flags.expires || '7d');
  } else if (positional.length > 0) {
    const name = positional[0];
    const platforms = flags.platforms || 'macos-arm,windows';
    const expires = flags.expires || '365d';
    doClient(name, platforms, expires);
  } else {
    printUsage();
    process.exit(1);
  }
}

// Run CLI only when executed directly
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
  main();
}
