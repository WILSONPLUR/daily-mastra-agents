import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Import the deployed dependencies without starting the server or connecting
// to a database. Bundling and TypeScript do not catch missing runtime exports.
const outputDirectory = new URL('../.mastra/output/', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('package.json', outputDirectory), 'utf8'),
);
const dependencies = Object.keys(manifest.dependencies).filter((name) =>
  name.startsWith('@mastra/'),
);
const result = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    `for (const name of ${JSON.stringify(dependencies)}) {
      await import(name);
      console.log('Runtime import passed:', name);
    }`,
  ],
  { cwd: outputDirectory, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
