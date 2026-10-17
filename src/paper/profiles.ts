import { paperSettingsSchema, type PaperSettings } from './types.js';

// Initial paper-testing hypotheses, not an optimized or validated trading edge.
export function strategyProfile(bank: 200 | 500): PaperSettings {
  return paperSettingsSchema.parse(bank === 200 ? {} : {
    initialPerVenue: '250', targetNetShares: '25', maxPositionCost: '25',
    maxTotalExposureUsd: '100', cashReserve: '25', lossLimit: '15',
    minProfitUsd: '0.35', maxUnhedgedLossUsd: '1.5',
  });
}
