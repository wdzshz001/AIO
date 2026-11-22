import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';
import { buildAll, ROOT } from './build.mjs';

await buildAll({ watch: true });

const env = { ...process.env, AGG_DEV: '1' };
// DSH 自身跑在 Electron 里，会带这个变量；不清掉 electron 会退化成纯 Node
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  cwd: path.join(ROOT, 'apps/desktop'),
  // 注意不能继承 stdio，否则 Electron 在本环境下会直接退出
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
});

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
child.on('close', (code) => process.exit(code ?? 0));
