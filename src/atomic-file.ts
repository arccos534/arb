import { rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Windows can refuse replacement while another process briefly holds the
// destination open. Keep the old complete file readable throughout retries.
const replacementDelays = [10, 20, 40, 80, 160, 250, 250, 250, 250, 250, 250];
const transientCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function atomicWriteFile(filename: string, contents: string, durable = false): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flush: durable });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); return; }
      catch (error) {
        const wait = replacementDelays[attempt];
        if (wait === undefined || !transientCodes.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(wait);
      }
    }
  } finally {
    // A failed replacement must not leak a complete report on every retry.
    // Never unlink the destination: readers must always see an intact report.
    await unlink(temporary).catch(() => {});
  }
}
