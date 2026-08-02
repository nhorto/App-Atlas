import fs from 'node:fs';
import { Parser, Language, Query } from 'web-tree-sitter';
await Parser.init();
const lang = await Language.load('/home/user/App-Atlas/vendor/grammars/tree-sitter-csharp.wasm');
const parser = new Parser();
parser.setLanguage(lang);
const src = fs.readFileSync(process.argv[2] ?? '/tmp/claude-0/-home-user-App-Atlas/80251b23-3df6-5f26-9418-6ce5c1328d80/scratchpad/cs/sample.cs', 'utf8');
const tree = parser.parse(src);
if (process.argv[3] === '--tree') {
  const walk = (n, d = 0) => {
    if (d > 6) return;
    console.log('  '.repeat(d) + n.type + (n.childCount === 0 ? ` "${n.text.slice(0,40)}"` : ''));
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i), d + 1);
  };
  walk(tree.rootNode);
} else {
  const q = new Query(lang, fs.readFileSync(process.argv[3], 'utf8'));
  for (const m of q.matches(tree.rootNode)) {
    console.log(m.captures.map(c => `${c.name}=${JSON.stringify(c.node.text.slice(0,50))}`).join('  '));
  }
}
