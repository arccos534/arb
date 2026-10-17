import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { FeeModel, Market } from './domain.js';
import { array, record } from './http.js';

export function hashRules(fields: unknown): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function binaryOutcomeIndices(labels: string[]): { yes: number; no: number } | null {
  if (labels.length !== 2) return null;
  const clean = labels.map(v => v.toLowerCase().trim());
  const yes = clean.findIndex(v => ['yes', 'up'].includes(v));
  const no = clean.findIndex(v => ['no', 'down'].includes(v));
  if (yes >= 0 && no >= 0) return { yes, no };
  if (yes >= 0 || no >= 0 || clean.some(v => !v) || clean[0] === clean[1]) return null;
  return { yes: 0, no: 1 }; // Named binary outcomes retain native token ordering.
}

export function polyMarket(value: unknown): Market | null {
  const raw = record(value);
  if (raw.active !== true || raw.closed === true || raw.acceptingOrders !== true || raw.enableOrderBook !== true) return null;
  const labels = array(raw.outcomes).map(String);
  const side = binaryOutcomeIndices(labels);
  if (!side) return null;
  const tokens = array(raw.version === 'v2' ? raw.positionIds : raw.clobTokenIds).map(String);
  if (!tokens[side.yes] || !tokens[side.no]) return null;
  let fee: FeeModel = { kind: 'unknown', reason: 'Missing or unsupported Polymarket fee schedule' };
  if (raw.feesEnabled === false) fee = { kind: 'none' };
  else if (raw.feesEnabled === true && raw.feeSchedule) {
    const schedule = record(raw.feeSchedule);
    if (Number(schedule.exponent) === 1 && Number.isFinite(Number(schedule.rate)) && Number(schedule.rate) >= 0 && Number(schedule.rate) < 1) {
      fee = { kind: 'polymarket', rate: String(schedule.rate) };
    }
  }
  const endsAt = String(raw.endDate ?? '');
  const description = String(raw.description ?? '');
  const resolutionSource = String(raw.resolutionSource ?? '');
  return {
    venue: 'polymarket', id: String(raw.id), slug: String(raw.slug), title: String(raw.question),
    endsAt, description, resolutionSource,
    yesToken: tokens[side.yes]!, noToken: tokens[side.no]!,
    positiveLabel: labels[side.yes]!, negativeLabel: labels[side.no]!,
    rulesHash: hashRules([description, resolutionSource, endsAt, labels, tokens, raw.conditionId, raw.version, fee,
      Array.isArray(raw.events) ? raw.events.map(e => { const event = record(e); return [event.description, event.resolutionSource, event.endDate, event.clarifications]; }) : [],
    ]),
    externalSlug: null, fee, raw,
  };
}

export function limitlessMarket(value: unknown, _legacyFeeBound?: string): Market | null {
  const raw = record(value);
  if (raw.tradeType !== 'clob' || raw.expired === true || raw.hidden === true || !['CREATED', 'FUNDED'].includes(String(raw.status))) return null;
  const tokens = record(raw.tokens);
  if (!tokens.yes || !tokens.no) return null;
  const metadata = raw.metadata ? record(raw.metadata) : {};
  const description = String(raw.description ?? '');
  const endsAt = new Date(Number(raw.expirationTimestamp)).toISOString();
  const source = metadata.chainlinkDataStream ?? raw.priceOracleMetadata ?? null;
  const resolutionSource = JSON.stringify(source);
  return {
    venue: 'limitless', id: String(raw.id), slug: String(raw.slug), title: String(raw.title),
    endsAt, description, resolutionSource,
    yesToken: String(tokens.yes), noToken: String(tokens.no),
    positiveLabel: metadata.ufcMoneyline === true && typeof metadata.homeTeam === 'string' ? metadata.homeTeam : 'YES',
    negativeLabel: metadata.ufcMoneyline === true && typeof metadata.awayTeam === 'string' ? metadata.awayTeam : 'NO',
    rulesHash: hashRules([description, endsAt, source, tokens, metadata.openPrice, metadata.externalRulesWatch, raw.conditionId, metadata.homeTeam, metadata.awayTeam, metadata.fee]),
    externalSlug: metadata.externalProvider === 'polymarket' && typeof metadata.externalSlug === 'string' ? metadata.externalSlug : null,
    fee: metadata.fee === false ? { kind: 'none' } : metadata.fee === true
      ? { kind: 'limitless-curve', model: 'published-table-linear-v1' }
      : { kind: 'unknown', reason: 'Missing Limitless fee-enabled flag' }, raw,
  };
}

export function inHorizon(market: Market, config: Config, now = Date.now()): boolean {
  const remaining = Date.parse(market.endsAt) - now;
  return remaining > 0 && remaining >= config.MIN_HOURS_TO_END * 3600000 && (config.HORIZON_HOURS === 0 || remaining <= config.HORIZON_HOURS * 3600000);
}
