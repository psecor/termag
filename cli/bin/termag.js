#!/usr/bin/env node
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major < 20) {
  process.stderr.write(`termag: needs Node.js 20 or newer; ${process.execPath} is ${process.version}\n`);
  process.exit(1);
}

let main;
try {
  ({ main } = await import('../dist/main.js'));
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes('dist')) throw err;
  process.stderr.write('termag: the CLI is not built; run `make install-cli` (or `cli/install.sh`) in the termag checkout\n');
  process.exit(1);
}
process.exitCode = await main(process.argv.slice(2));
