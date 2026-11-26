// ladder/dashboard/profile.mjs — who the tool is running for, and what their resume says.
//
// The person lives in one file: `profile.local.mjs` next to this one (gitignored, never pushed).
// A fresh clone has no such file and runs on `profile.example.mjs`, a made-up persona with the
// same shape. `LADDER_PROFILE=/path/to/file.mjs` points at any other profile.
//
// This module is the loader plus the matching engine: `termHits` turns a JD into the skills and
// gaps it names. `node profile.mjs --check` greps the resume for skill tokens that no regex in the
// profile covers, so the two cannot drift silently.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.LADDER_PROFILE ? resolve(process.env.LADDER_PROFILE) : join(HERE, 'profile.local.mjs');
export const PROFILE_PATH = existsSync(LOCAL) ? LOCAL : join(HERE, 'profile.example.mjs');
export const PROFILE = (await import(pathToFileURL(PROFILE_PATH).href)).default;

export const SKILLS = PROFILE.skills || [];
export const GAPS = PROFILE.gaps || [];
export const GAP_CAP = PROFILE.gapCap ?? 25;

/**
 * Which skills and gaps a piece of text names. `weight` is the summed skill weight — the raw
 * alignment signal the scorer turns into a 0–100 — and `penalty` is the capped gap cost.
 */
export function termHits(text) {
  const t = String(text || '');
  if (!t.trim()) return { hits: [], weight: 0, gaps: [], penalty: 0 };
  const hits = SKILLS.filter(s => s.re.test(t));
  const gaps = GAPS.filter(g => g.re.test(t));
  return {
    hits: hits.map(s => s.k),
    weight: hits.reduce((a, s) => a + s.w, 0),
    gaps: gaps.map(g => g.k),
    penalty: Math.min(GAP_CAP, gaps.reduce((a, g) => a + g.pen, 0)),
  };
}

// --check: every token on the resume's skill rows must be matched by some SKILLS regex, or this
// file is out of date. Run it after editing the resume.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--check')) {
  if (!PROFILE.resumeTex) { console.log('profile has no resumeTex; nothing to check'); process.exit(0); }
  const tex = readFileSync(resolve(dirname(HERE), PROFILE.resumeTex), 'utf8');
  const rows = [...tex.matchAll(/\\skillrow\{[^}]*\}\{([^}]*)\}/g)].map(m => m[1]);
  const tokens = rows.flatMap(r => r.replace(/\\&/g, '&').split(/,\s*/)).map(t => t.replace(/\([^)]*\)?/g, '').replace(/\)$/, '').trim()).filter(Boolean);
  const missing = tokens.filter(tok => !SKILLS.some(s => s.re.test(tok)));
  console.log(`${tokens.length} resume skill tokens, ${tokens.length - missing.length} covered`);
  if (missing.length) { console.log('not covered by any SKILLS regex:'); for (const m of missing) console.log('  - ' + m); }
  process.exit(missing.length ? 1 : 0);
}
