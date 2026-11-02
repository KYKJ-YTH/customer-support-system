// Launcher shim — resolves Chinese paths at runtime, called from ASCII path
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url));
const server = join(root, 'workbench', 'server.mjs');

// node is in G:\各种环境\ — reconstruct from codepoints to avoid encoding issues
const nodeDir = 'G:\\' + '\u5404\u79CD\u73AF\u5883';
const nodeExe = nodeDir + '\\node.exe';

console.log('Starting intake server:', nodeExe, server);
const child = spawn(nodeExe, [server], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env },
});
child.on('error', e => { console.error('Failed to start:', e.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 0));
