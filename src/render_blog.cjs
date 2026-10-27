// Reuse the site's trusted Markdown renderer at build time, with no browser or network.
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const source = fs.readFileSync(__dirname + '/index.src.html', 'utf8');
const start = source.indexOf('  const T =', source.indexOf('/* ---------- Blog'));
const end = source.indexOf('  const slug =', start);
if (start < 0 || end < 0) throw new Error('Blog renderer boundary missing');
const context = vm.createContext({
  document: { getElementById: () => ({ textContent: JSON.stringify(input.images) }) },
  ico: name => `<svg class="ico" aria-hidden="true"><use href="#i-${String(name).replace(/[^a-z-]/g, '')}"/></svg>`,
});
vm.runInContext(source.slice(start, end) + '\nglobalThis.render = md;', context);
process.stdout.write(JSON.stringify(input.bodies.map(body => context.render(body))));
