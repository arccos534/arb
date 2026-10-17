import { z } from 'zod';
import type { Book, FeeModel, Outcome, Pair, Venue } from '../domain.js';

const money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).refine(v => Number(v) <= 1000000);
export const paperSettingsSchema = z.object({
  initialPerVenue: money.refine(v => Number(v) >= 10).default('100'),
  targetNetShares: money.refine(v => Number(v) > 0).default('10'),
  maxPositionCost: money.refine(v => Number(v) > 0).default('10'),
  minRoi: z.coerce.number().min(0).max(1).default(0.03),
  maxPositions: z.coerce.number().int().min(1).max(20).default(4),
  latencyMs: z.coerce.number().int().min(100).max(30000).default(400),
  maxSlippage: z.coerce.number().min(0).max(0.1).default(0.005),
  rejectProbability: z.coerce.number().min(0).max(1).default(0.01),
  partialProbability: z.coerce.number().min(0).max(1).default(0.03),
  lossLimit: money.refine(v => Number(v) > 0).default('6'),
  cashReserve: money.default('10'),
  minProfitUsd: money.default('0.15'),
  maxUnhedgedLossUsd: money.refine(v => Number(v) > 0).default('0.75'),
  maxTotalExposureUsd: money.refine(v => Number(v) > 0).default('40'),
  maxQuoteAgeMs: z.coerce.number().int().min(250).max(10000).default(2000),
  maxQuoteSkewMs: z.coerce.number().int().min(50).max(5000).default(750),
  maxExecutionWaitMs: z.coerce.number().int().min(100).max(10000).default(1500),
  minSecondsToEnd: z.coerce.number().int().min(0).max(3600).default(45),
  maxHoldingHours: z.coerce.number().min(0.01).max(8760).default(24),
  retryCooldownMs: z.coerce.number().int().min(1000).max(3600000).default(15000),
  maxAttemptsPerPair: z.coerce.number().int().min(1).max(20).default(3),
  autoRebalance: z.boolean().default(false),
  skipManualReview: z.boolean().default(false),
  rebalanceThreshold: money.default('15'),
  rebalanceFee: money.default('0.25'),
  transferDelayMs: z.coerce.number().int().min(100).max(60000).default(3000),
  seed: z.coerce.number().int().min(1).max(2147483647).default(42317),
}).strict();
export type PaperSettings = z.infer<typeof paperSettingsSchema>;
export type Source = 'live' | 'demo';
export type TradeStatus = 'SCHEDULED' | 'OPEN' | 'UNHEDGED' | 'WAITING_RESOLUTION' | 'SETTLED' | 'CLOSED' | 'FAILED' | 'CANCELLED';
export interface PaperOrder {
  id: string; venue: Venue; outcome: Outcome; slug: string; assetId: string; fee: FeeModel;
  status: 'PENDING' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'CANCELLED';
  targetNetShares: string; grossShares: string; heldShares: string; netShares: string;
  limitPrice: string; reserve: string; cost: string; cashFee: string; contractFee: string;
  costBasis: string; averageFillPrice: string;
  proceeds: string; soldShares: string; resolved: boolean; payoutPerShare: string | null;
  error: string | null;
}
export interface PaperTrade {
  id: string; source: Source; pairId: string; title: string; status: TradeStatus;
  direction: 'poly-yes-limitless-no' | 'poly-no-limitless-yes';
  signalAt: number; executeAfter: number; filledAt: number | null; closedAt: number | null;
  endsAt: number; orders: PaperOrder[]; expectedProfit: string; realizedPnl: string;
  rulesHashes: string[]; notes: string[]; pair: Pair;
  expectedRoi?: string;
  initialCost?: string;
  maxExecutionCost?: string;
  execution?: {
    checkedAt: number; purchaseCost: string | null; executionCost: string | null; reasons: string[];
    actualLatencyMs: number; postArrivalWaitMs: number;
    legs: { venue: Venue; outcome: Outcome; limitPrice: string; proposedLimitPrice: string | null;
      receivedAt: number | null; sourceTimestamp: number | null; receiptAgeMs: number | null; sourceAgeMs: number | null;
      bestAsk: { price: string; shares: string } | null; bestBid: { price: string; shares: string } | null }[];
  };
}
export interface Transfer {
  id: string; from: Venue; to: Venue; amount: string; fee: string;
  status: 'DEPOSIT_PENDING' | 'WITHDRAW_PENDING' | 'COMPLETED'; createdAt: number; nextAt: number; completedAt: number | null;
}
export interface LedgerEntry { id: string; at: number; tradeId: string | null; account: Venue | 'bybit'; amount: string; kind: string }
export interface PaperEvent { id: string; at: number; type: string; tradeId: string | null; message: string; details: unknown }
export interface EquityPoint { at: number; equity: string; cash: string; realized: string; unrealized: string }
export interface PaperState {
  version: 1; sessionId: string; source: Source; createdAt: number; updatedAt: number; sequence: number;
  running: boolean; settings: PaperSettings; rng: number;
  cash: Record<Venue | 'bybit', string>; realizedPnl: string;
  trades: PaperTrade[]; transfers: Transfer[]; ledger: LedgerEntry[]; events: PaperEvent[];
  equity: EquityPoint[]; peakEquity: string; maxDrawdown: string;
  haltReason: string | null;
  entryDiagnostics?: { blockedSignals: number; recent: { pairId: string; direction: PaperTrade['direction']; at: number; reasons: string[] }[] };
}
export interface FeedSnapshot { at: number; pairs: Pair[]; books: Book[]; ready: boolean }
export interface Resolution { venue: Venue; slug: string; yesPayout: string; noPayout: string; evidence: unknown; at: number }
export type DemoScenario = 'normal' | 'partial' | 'rejection' | 'delayed' | 'mismatch';
