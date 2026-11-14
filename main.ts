// Token Radar entry (Node 22, standard library only).
//
// What it does, in order: read the sealed snapshot, score every pre-token
// protocol with the radar-2 model in lib/model.ts, refuse to continue when the
// board would fail the gate, write board.json and the dashboard's data.js,
// copy dashboard/ and screenshots/ into the output, and finish by writing
// dossier.json with the vendored make.fun library — the same bytes the scorer
// rebuilds, so the dossier always matches what is handed in.
//
// The dashboard is a static page with no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read the
// data.js this program writes from the very board rows the gate checks, so
// the page a reader sees and the board that is scored can never drift apart.
//
// Run outside the grader's container with MAKEFUN_OUTPUT_DIR standing in
// for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps, from the kit's gate: the text cap shapes the dossier's
 *  bytes, the other caps only refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name value` or `--name=value` in the arguments, else `fallback`. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}` && i + 1 < argv.length) return argv[i + 1]!;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  const hint = 'pass --input <snapshot.json|directory> or mount the sealed /input';
  process.stderr.write(`token radar: no snapshot at ${inputFile}: ${hint}\n`);
  process.exit(2);
}
const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dot-names, and report
 *  the names copied. Subdirectories are not part of the dashboard or the
 *  screenshots, so only files are taken. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isFile()) continue;
    copyFileSync(join(from, entry.name), join(to, entry.name));
    copied.push(entry.name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  const noun = shots.length === 1 ? 'image' : 'images';
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} ${noun}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
const badShot = shots.find((name) => !IMAGE_NAME.test(name));
if (badShot !== undefined) {
  process.stderr.write(`token radar: screenshots/${badShot}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
  process.exit(1);
}

// The dossier is written last: the scorer rebuilds it from this /output and
// compares the bytes, so nothing may change after this line.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const summary =
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ` +
  `${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
  `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} ` +
  `(${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`;
process.stdout.write(summary);
