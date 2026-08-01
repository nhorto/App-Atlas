/**
 * Writes THIRD-PARTY-NOTICES.md.
 *
 * Every URL below is licence metadata being copied into a file. Nothing here is
 * fetched, and naming crates.io as a service this app depends on would be exactly the
 * false positive #25 removed. The fix for #89 has to stay silent about all of it.
 */
import { writeFileSync } from 'node:fs';

const REGISTRIES = {
  rust: 'https://crates.io/crates/',
  python: 'https://pypi.org/project/',
  node: 'https://www.npmjs.com/package/',
};

const LICENCES = ['https://opensource.org/licenses/MIT', 'https://apache.org/licenses/LICENSE-2.0'];

export function render(packages) {
  const lines = packages.map((pkg) => `- [${pkg.name}](${REGISTRIES[pkg.ecosystem]}${pkg.name})`);
  writeFileSync('THIRD-PARTY-NOTICES.md', [...lines, ...LICENCES].join('\n'));
}
