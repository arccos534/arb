import { pathToFileURL } from 'node:url';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { ResearchRunner } from './research.js';
import { benchmark } from './benchmark.js';
import { ResearchStorage } from './storage.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'scan';
  if (command === 'help' || command === '--help') {
    console.log('Commands: scan | observe [--duration SECONDS] | benchmark [--samples N] | report');
    console.log('Public data research only. No credentials, orders, or withdrawals.');
    return;
  }
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, redact: ['DATABASE_URL', 'password', 'secret', 'privateKey'] });
  const integerOption = (name: string, fallback: number): number => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(args[index + 1]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  if (command === 'benchmark') {
    const samples = integerOption('--samples', 20);
    if (samples > 200) throw new Error('At most 200 samples');
    console.log(JSON.stringify(await benchmark(config, samples), null, 2));
    return;
  }
  if (command === 'report') {
    const store = new ResearchStorage(config);
    console.log(JSON.stringify(await store.readLatest('health'), null, 2));
    return;
  }
  if (command !== 'scan' && command !== 'observe') throw new Error(`Unknown command: ${command}`);
  const runner = new ResearchRunner(config, logger);
  const stop = () => runner.stop();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const duration = integerOption('--duration', 0);
    await runner.run(duration ? { once: command === 'scan', durationSeconds: duration } : { once: command === 'scan' });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
