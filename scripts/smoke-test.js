const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'src/cli/index.js');

const result = spawnSync(process.execPath, [entry, '--demo', '--no-color'], {
  cwd: projectRoot,
  encoding: 'utf8',
  timeout: 5000,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status || 1);
}

if (!result.stdout.includes('Signal Rush CLI demo smoke test complete.')) {
  console.error('Smoke test did not reach expected completion marker.');
  console.error(result.stdout);
  process.exit(1);
}

console.log('Smoke test passed.');
