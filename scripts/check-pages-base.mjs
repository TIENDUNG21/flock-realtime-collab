// Verifies a static build works under a sub-path (GitHub Pages serves /<repo>/):
// every local asset referenced from the HTML must be relative or start with the base,
// and must exist in the build output. Usage: node scripts/check-pages-base.mjs <dist> <base>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dist, base] = process.argv.slice(2);
if (!dist || !base || !base.startsWith('/') || !base.endsWith('/')) {
  console.error('usage: check-pages-base.mjs <dist-dir> </base/>');
  process.exit(2);
}

const problems = [];
const pages = readdirSync(dist).filter((f) => f.endsWith('.html'));
if (pages.length === 0) problems.push(`no HTML files in ${dist}`);

for (const page of pages) {
  const html = readFileSync(join(dist, page), 'utf8');
  for (const [, attr, url] of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|#|data:)/.test(url)) continue;
    let local;
    if (url.startsWith(base)) local = url.slice(base.length);
    else if (url.startsWith('/')) {
      problems.push(`${page}: ${attr}="${url}" is absolute but outside ${base}`);
      continue;
    } else local = url.replace(/^\.\//, '');
    const file = local.split(/[?#]/)[0];
    if (file && !existsSync(join(dist, file)))
      problems.push(`${page}: ${attr}="${url}" does not exist in the build`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.info(`ok: ${pages.length} pages reference only assets under ${base} or relative paths`);
