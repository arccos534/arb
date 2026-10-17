import 'dotenv/config';
import { z } from 'zod';

const positive = z.coerce.number().positive();
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const schema = z.object({
  APP_MODE: z.literal('research').default('research'),
  DATA_DIR: z.string().min(1).default('./data'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  DATABASE_URL: z.string().default(''),
  STORAGE_POSTGRES: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  HORIZON_HOURS: z.coerce.number().min(0).default(0),
  MIN_HOURS_TO_END: z.coerce.number().min(0).default(0),
  DISCOVERY_INTERVAL_SECONDS: positive.min(30).default(300),
  REST_REFRESH_SECONDS: positive.min(5).default(30),
  MAX_PAGES: z.coerce.number().int().min(0).default(0),
  MAX_WATCH_PAIRS: z.coerce.number().int().min(0).default(0),
  REQUEST_TIMEOUT_MS: positive.int().default(10000),
  MAX_BOOK_AGE_MS: positive.int().default(2000),
  MAX_BOOK_SKEW_MS: positive.int().default(750),
  TARGET_NET_SHARES: decimal.default('10').refine(v => Number(v) > 0),
  MAX_POSITION_COST_USD: decimal.default('10').refine(v => Number(v) > 0),
  MIN_NET_ROI: decimal.default('0.03'),
  REBALANCE_COST_PER_PAIR_USD: decimal.default('0.10'),
  EXECUTION_BUFFER_USD: decimal.default('0.05'),
  MAX_JOURNAL_MB: positive.int().default(128),
  MAX_TOTAL_JOURNAL_MB: positive.int().default(1024),
  SNAPSHOT_INTERVAL_SECONDS: positive.min(5).default(30),
  USE_WEBSOCKETS: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
}).refine(v => v.HORIZON_HOURS === 0 || v.MIN_HOURS_TO_END < v.HORIZON_HOURS, 'Invalid horizon');

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
