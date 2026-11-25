#!/usr/bin/env node
/**
 * Publish this version to the update channel: one signed record beside every installer of it in the deliveries
 * folder, the folder registered in the channel Space, the deliveries check passed (~/Anjou/_deliveries/AGENTS.md).
 *
 *   npm run release                          every installer of package.json's version in
 *                                            ~/Anjou/_deliveries/rkeychat-desktop/ (mac zip + dmg, linux AppImage + deb)
 *   npm run release -- --notes "what changed"
 *   npm run release -- --folder ~/Anjou/_deliveries/rkeychat-mobile --app rkeychat-mobile   (the phone's folder)
 *   npm run release -- --dry                  show what would be written, write nothing
 *   npm run release -- --version 0.3.3 --build 2026-11-25.3 --commit 9eb8e0b   an earlier version's late artifacts
 *
 * The running rKeyChat daemon on this Mac does the signing (its device key is the channel's publisher):
 * POST /api/updates/record signs each record, POST /api/updates/publish makes the Space once, remembers the folder
 * and registers its files. Run it after the Mac build (`npm run ship`) and again after the Linux artifacts were
 * downloaded from the tag run: a record already there for the same bytes is kept, a file already in the Space is
 * left. The old CURRENT.json (check-updates.mjs on the agent boxes) is still written until those boxes read records.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

const { loadConfig } = await import(path.join(ROOT, 'src', 'config.js'));
const { parseInstallerName, recordProblem } = await import('pearkit/updates');
const check = path.join(os.homedir(), 'Anjou', '_deliveries', 'check.mjs');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP = opt('app') || 'rkeychat-desktop';
const CHANNEL = 'release';
const version = opt('version') || (APP === 'rkeychat-desktop' ? pkg.version : null);
if (!version) { console.error('--version is needed with --app'); process.exit(2); }
const folder = path.resolve(opt('folder') || path.join(os.homedir(), 'Anjou', '_deliveries', APP));
let buildInfo = {};
try { buildInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'build.json'), 'utf8')); } catch { /* a source tree: the record's build is made below */ }
// --build and --commit: a release of a version other than the tree's (its Linux artifacts arriving after the next bump)
const commit = opt('commit') || (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { return ''; } })();
const notes = opt('notes') || '';

const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => !n.endsWith('.release.json') && parseInstallerName(n)?.app === APP && parseInstallerName(n).version === version) : [];
if (!names.length) { console.error(`no installers of ${APP} ${version} in ${folder} (named <app>-<version>-<os>-<arch>.<ext>)`); process.exit(2); }
console.log(`${APP} ${version}${buildInfo.build ? ` (build ${buildInfo.build})` : ''}${commit ? ` @ ${commit}` : ''} → ${folder}`);
for (const n of names) console.log(`  ${n}  ${(fs.statSync(path.join(folder, n)).size / 1048576).toFixed(1)} MB`);

// the build counter: the ship's, else the next for today among the records already in the folder
const today = new Date().toISOString().slice(0, 10);
const build = opt('build') || buildInfo.build || (() => {
  const seqs = fs.readdirSync(folder).filter((n) => n.endsWith('.release.json')).map((n) => { try { return JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8')).build; } catch { return ''; } }).filter((b) => String(b).startsWith(today)).map((b) => Number(String(b).split('.').pop()) || 0);
  return `${today}.${Math.max(0, ...seqs) + 1}`;
})();

const port = loadConfig()?.port ?? 4455;
const base = `http://127.0.0.1:${port}`;
async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10 * 60_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
try { await fetch(base + '/api/rooms', { signal: AbortSignal.timeout(1500) }); } catch { console.error(`rKeyChat is not running on ${base}: open the app (or rkeychat start --background); it holds the key that signs the records`); process.exit(3); }

// 1. one signed record beside every installer of this version
let written = 0;
for (const n of names) {
  const abs = path.join(folder, n), recFile = `${abs}.release.json`;
  const p = parseInstallerName(n);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  try { if (JSON.parse(fs.readFileSync(recFile, 'utf8')).sha256 === sha256) { console.log(`record  ${n}  (already there)`); continue; } } catch { /* none yet */ }
  const record = { app: APP, channel: CHANNEL, version, build, commit, os: p.os, arch: p.arch, ext: p.ext, file: n, size: fs.statSync(abs).size, sha256, notes, publishedAt: new Date().toISOString() };
  if (flag('dry')) { console.log(`would write ${path.basename(recFile)}:`, JSON.stringify(record)); continue; }
  const { sig, publisher } = await api('POST', '/api/updates/record', { record });
  const signed = { ...record, publisher, sig };
  const problem = recordProblem(signed);
  if (problem) { console.error(`REFUSED: ${n}: ${problem}`); process.exit(4); }
  fs.writeFileSync(recFile, JSON.stringify(signed, null, 2) + '\n');
  written++;
  console.log(`record  ${n}  signed by ${publisher.slice(0, 20)}…`);
}
if (flag('dry')) process.exit(0);

// 2. the folder in the channel Space (made on the first run), its link and publisher for the Updates block
if (APP === 'rkeychat-desktop') {
  const r = await api('POST', '/api/updates/publish', { folder });
  console.log(`channel Space ${String(r.topic || '').slice(0, 12)}… · ${r.registered.length} file(s) registered · ${r.peers} peer(s) connected`);
  console.log(`  link       ${r.link}`);
  console.log(`  publisher  ${r.publisher}`);
}

// 3. the deliveries check: a failure stops the release
const chk = spawnSync(process.execPath, [check], { encoding: 'utf8' });
process.stdout.write(chk.stdout || ''); process.stderr.write(chk.stderr || '');
if (chk.status !== 0) { console.error('the deliveries check failed (above): fix it before telling anyone about this release'); process.exit(7); }

// 4. the older "which version is current" manifest the agent boxes still read (CURRENT.json; goes when they read records)
const legacy = path.join(os.homedir(), 'Anjou', '_deliveries', 'publish.mjs');
if (APP === 'rkeychat-desktop' && fs.existsSync(legacy)) {
  for (const n of names.filter((x) => /\.(zip|AppImage)$/.test(x))) spawnSync(process.execPath, [legacy, 'rkeychat', version, `${path.basename(folder)}/${n}`], { stdio: 'inherit' });
}
console.log(`${written} record(s) written; every device on the channel sees ${version} as it syncs`);
