import { Decimal } from 'decimal.js';
import type { Level } from './domain.js';

// Only arrays owned by the normalizers are certified. Unknown/mutable callers
// still get a sorted copy, so public quote helpers retain their old contract.
const ascending = new WeakSet<Level[]>(), descending = new WeakSet<Level[]>();
export function certifyLevels(values: Level[], asc: boolean): Level[] {
  (asc ? ascending : descending).add(values); return values;
}
export function orderedLevels(values: Level[], asc: boolean): Level[] {
  if ((asc ? ascending : descending).has(values)) return values;
  return sortLevels(values.slice(), asc);
}
export function sortLevels(values: Level[], asc: boolean): Level[] {
  const compare = (a: Level, b: Level) => new Decimal(a.price).comparedTo(b.price) * (asc ? 1 : -1);
  if (values.some((value, i) => i > 0 && compare(values[i - 1]!, value) > 0)) values.sort(compare);
  return certifyLevels(values, asc);
}
