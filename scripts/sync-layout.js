// Shared layout fragments: edits to header/footer belong in /layout, not 13 pages.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const fragments = {
  header: fs.readFileSync(path.join(root, 'layout/header.html'), 'utf8').trim(),
  footer: fs.readFileSync(path.join(root, 'layout/footer.html'), 'utf8').trim()
};
const check = process.argv.includes('--check');
let missing = 0;
for (const name of fs.readdirSync(publicDir).filter(x => x.endsWith('.html'))) {
  const target = path.join(publicDir, name);
  let html = fs.readFileSync(target, 'utf8');
  const original = html;
  html = html.replace(/<header\s+class="site-header">[\s\S]*?<\/header>/, fragments.header);
  html = html.replace(/<footer\s+class="footer">[\s\S]*?<\/footer>/, fragments.footer);
  if (!html.includes('class="site-header"') || !html.includes('class="footer"')) {
    console.error(`Missing shared component: ${name}`); missing += 1; continue;
  }
  if (original !== html) {
    if (check) { console.error(`Out-of-sync layout: ${name}`); missing += 1; }
    else { fs.writeFileSync(target, html, 'utf8'); console.log(`Synced ${name}`); }
  }
}
if (missing) process.exitCode = 1;
else console.log(`Shared layout: ${check ? 'validated' : 'synchronized'}`);
