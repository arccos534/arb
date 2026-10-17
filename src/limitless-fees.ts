import { profiler } from './profiling.js';
import { Decimal } from 'decimal.js';

// Published representative points, not an exchange-provided exact formula.
// Source: https://docs.limitless.exchange/user-guide/fees (2026-10-17).
const buy = [['0.01','0.03'],['0.50','0.03'],['0.55','0.0252'],['0.60','0.0213'],['0.65','0.018'],['0.70','0.0151'],['0.75','0.0126'],['0.80','0.0105'],['0.85','0.0085'],['0.90','0.0068'],['0.95','0.0053'],['0.99','0.0042'],['0.999','0.004']];
const sell = [['0.01','0.0045'],['0.05','0.006'],['0.10','0.0078'],['0.20','0.0111'],['0.30','0.0132'],['0.40','0.0144'],['0.50','0.015'],['0.60','0.0144'],['0.70','0.0132'],['0.80','0.0111'],['0.90','0.0078'],['0.95','0.006'],['0.99','0.0045'],['0.999','0.0042']];

// Decimal instances are immutable; parse the static fee table once.
const pointsBuy = buy.map(row => row.map(x => new Decimal(x)));
const pointsSell = sell.map(row => row.map(x => new Decimal(x)));

export function limitlessFeeRate(side: 'buy' | 'sell', value: Decimal.Value): Decimal {
  const profileStart = profiler.start();
  try {
  const price = new Decimal(value), points = side === 'buy' ? pointsBuy : pointsSell;
  if (!price.isFinite() || price.lte(0) || price.gte(1)) throw new Error('invalid-limitless-price');
  if (price.lte(points[0]![0]!)) return new Decimal(points[0]![1]!);
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]!, [previousX, previousY] = points[i - 1]!;
    if (price.lte(x!)) return new Decimal(previousY!).plus(price.minus(previousX!).div(new Decimal(x!).minus(previousX!)).mul(new Decimal(y!).minus(previousY!)));
  }
  return new Decimal(points.at(-1)![1]!);
  } finally { profiler.end('fees', profileStart); }
}

export const limitlessFeeAssumption = 'Limitless fees estimated per price level by linear interpolation of published representative points; no account cap applied; exact execution rate and rounding unavailable in public data';
