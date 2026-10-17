export type Venue = 'polymarket' | 'limitless';
export type Outcome = 'yes' | 'no';
export type FeeModel =
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'polymarket'; rate: string }
  | { kind: 'limitless-curve'; model: 'published-table-linear-v1' }
  | { kind: 'contracts-bound'; rate: string };

export interface Market {
  venue: Venue;
  id: string;
  slug: string;
  title: string;
  description: string;
  resolutionSource: string;
  endsAt: string;
  yesToken: string;
  noToken: string;
  positiveLabel: string;
  negativeLabel: string;
  rulesHash: string;
  externalSlug: string | null;
  fee: FeeModel;
  raw: Record<string, unknown>;
}

export interface Level { price: string; shares: string }
export interface Book {
  venue: Venue;
  slug: string;
  outcome: Outcome;
  assetId: string;
  asks: Level[];
  bids: Level[];
  receivedAt: number;
  sourceTimestamp: number | null;
  transport: 'rest' | 'websocket';
  tickSize: string | null;
  minOrderShares: string | null;
}

export interface Pair {
  id: string;
  polymarket: Market;
  limitless: Market;
  score: number;
  reasons: string[];
  review: { approved: boolean; reasons: string[]; validUntil?: string };
}

export interface Evaluation {
  pairId: string;
  direction: 'poly-yes-limitless-no' | 'poly-no-limitless-yes';
  observedAt: string;
  status: 'rejected' | 'research-positive' | 'research-negative';
  reasons: string[];
  targetNetShares: string;
  payout: string | null;
  cost: string | null;
  profit: string | null;
  roi: string | null;
  legs: unknown[];
  assumptions: string[];
}
