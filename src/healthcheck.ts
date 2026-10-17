import { readFile } from 'node:fs/promises';
import path from 'node:path';

try {
  const health = JSON.parse(await readFile(path.join(process.env.DATA_DIR ?? './data', 'health-latest.json'), 'utf8')) as { at: string; ready: boolean };
  const age = Date.now() - Date.parse(health.at);
  if (!health.ready || !Number.isFinite(age) || age < -1000 || age > 180000) process.exitCode = 1;
} catch { process.exitCode = 1; }
