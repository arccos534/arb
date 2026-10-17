import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const directory = path.resolve(options.directory);
await mkdir(directory, { recursive: true });
const deadline = performance.now() + 25 * 3600000;
const stats = { lastSuccessAt: null, lastError: null, failures: 0 };
let stopped = false;
process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
async function save(name, value) {
  const file = path.join(directory, name), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
    for (let i = 0; ; i++) {
      try { await rename(temporary, file); break; }
      catch (e) { if (i >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; await delay(100); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
while (!stopped && performance.now() < deadline) {
  try {
    // The authorized key on the VPS permits only reading the diagnostic report.
    const { stdout } = await execute('ssh.exe', ['-T', '-i', options.identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${options.knownHosts}`, '-o', 'ConnectTimeout=10',
      `${options.user}@${options.host}`], { timeout: 15000, maxBuffer: 2 * 1024 ** 2, windowsHide: true });
    const report = JSON.parse(stdout);
    if (report.schemaVersion !== 1 || !Array.isArray(report.cases) || !Array.isArray(report.table)) throw new Error('Invalid remote diagnostic report');
    stats.lastSuccessAt = new Date().toISOString(); stats.lastError = null;
    await save('execution-latest.json', { ...report, replica: { host: options.host, receivedAt: stats.lastSuccessAt } });
    if (['complete', 'deadline', 'archive-limit', 'case-limit'].includes(report.status)) stopped = true;
  } catch (e) { stats.failures++; stats.lastError = String(e).slice(0, 1000); }
  await save('replication-status.json', stats);
  if (!stopped) await delay(30000);
}
