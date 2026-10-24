import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { APP_ROOT } from '../src/config.mjs';
import { writeText } from '../src/utils.mjs';
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const workflow = await readFile(path.join(APP_ROOT, 'config/workflow.md'), 'utf8');
const rule = workflow.match(/^7\.[\s\S]*?(?=^8\.)/m)[0];
for (const project of await readdir(path.join(APP_ROOT, 'projects'), { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const dir = path.join(APP_ROOT, 'projects', project.name);
  for (const name of ['workflow.md', 'style-guide.md']) {
    const file = path.join(dir, '00_shared', name);
    let before;
    try { before = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const after = name === 'workflow.md' ? before.replace(/^7\.[\s\S]*?(?=^8\.)/m, rule)
      : before.replace('语境不同可采用不同译法，不机械统一', '全书采用固定译法；仅在原文确有特殊用意时逐处说明例外，尽可能少用');
    if (after === before) continue;
    await writeText(path.join(dir, '09_history', `${stamp}-before-fixed-terms`, '00_shared', name), before);
    await writeText(file, after);
    console.log(`${project.name}: ${name}`);
  }
}
