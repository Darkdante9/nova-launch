/**
 * Load test: Token full-text search under high-concurrency read pressure.
 *
 * Target: 50 concurrent users, 60-second sustained load.
 * SLOs:   p95 response time < 500 ms, error rate < 0.1%.
 *
 * Query terms are randomised from a 200-term dictionary to avoid cache hits
 * masking real index performance.
 *
 * Run: k6 run load-tests/scenarios/token-search-load.js
 *
 * Closes #1301
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { config } from '../config/test-config.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const searchErrorRate = new Rate('token_search_errors');
const searchDuration = new Trend('token_search_duration_ms', true);
const totalRequests = new Counter('token_search_total_requests');

// ---------------------------------------------------------------------------
// Test options
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
    },
  },
  thresholds: {
    // Core SLOs from issue #1301
    token_search_duration_ms: ['p(95)<500'],
    token_search_errors: ['rate<0.001'],
    // Stdlib fallback
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

// ---------------------------------------------------------------------------
// 200-term dictionary of realistic token name/symbol search terms
// ---------------------------------------------------------------------------
const SEARCH_TERMS = [
  // Stellar ecosystem tokens
  'XLM', 'USDC', 'yXLM', 'AQUA', 'SHX', 'LOBSTR', 'WHL', 'MOBI',
  'RMT', 'ETH', 'BTC', 'LINK', 'MATIC', 'SOL', 'AVAX', 'DOT',
  'ADA', 'ALGO', 'XRP', 'BNB', 'DOGE', 'SHIB', 'UNI', 'AAVE',
  'COMP', 'CRV', 'MKR', 'SNX', 'SUSHI', 'YFI', 'BAL', 'REN',
  // Token name fragments
  'stellar', 'nova', 'launch', 'token', 'coin', 'crypto', 'defi',
  'swap', 'pool', 'yield', 'stake', 'farm', 'bridge', 'wrap',
  'liquid', 'governance', 'vote', 'dao', 'protocol', 'network',
  // Partial symbol matches (tests prefix search efficiency)
  'US', 'US D', 'Ste', 'Nov', 'Lau', 'Tok', 'Co', 'De',
  'Sw', 'Po', 'Yi', 'St', 'Fa', 'Br', 'Wr', 'Li',
  // Edge cases: mixed case, numbers
  'Token1', 'Coin2', 'Swap3', 'Pool4', 'Yield5', 'Stake6', 'Farm7',
  'uSDC', 'xLM', 'bTC', 'eTH', 'sOL', 'aVAX', 'dOT', 'aDA',
  // Short queries (high cardinality)
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
  'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't',
  // Multi-word / descriptive names
  'stellar lumens', 'usd coin', 'wrapped bitcoin', 'ether token',
  'nova launch', 'governance token', 'liquidity pool', 'yield farm',
  'staking reward', 'bridge asset', 'wrapped eth', 'liquid stake',
  // Project-specific tokens (seeded in staging DB)
  'NOVA', 'NVL', 'NLCH', 'NVLT', 'NLT', 'NVLX', 'NVLA', 'NLX',
  'NLA', 'NLB', 'NLC', 'NLD', 'NLE', 'NLF', 'NLG', 'NLH',
  // Longer descriptive queries
  'decentralised finance', 'automated market maker', 'constant product',
  'flash loan', 'arbitrage bot', 'price oracle', 'collateral ratio',
  'liquidation penalty', 'interest rate model', 'total value locked',
  // Numbers and alphanumerics
  '2023', '2024', '2025', 'v1', 'v2', 'v3', 'beta', 'alpha',
  'test', 'demo', 'dev', 'prod', 'main', 'core', 'base', 'root',
  // More realistic token symbols
  'WBTC', 'WETH', 'WBNB', 'WSOL', 'WAVAX', 'WDOT', 'WADA', 'WALGO',
  'stUSD', 'stXLM', 'stETH', 'stBTC', 'stSOL', 'stAVAX', 'stDOT',
  'lUSD', 'lXLM', 'lETH', 'lBTC', 'lSOL', 'lAVAX', 'lDOT', 'lADA',
  // Fiat-pegged stablecoins
  'USDT', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'LUSD', 'FRAX', 'MIM',
  'DAI', 'SUSD', 'CUSD', 'HUSD', 'EURS', 'EURT', 'EURC', 'AGEUR',
  // Additional symbols to reach 200
  'FTT', 'RAY', 'SRM', 'MAPS', 'OXY', 'MEDIA', 'LIKE', 'COPE',
  'STEP', 'NINJA', 'SLIM', 'SAMO', 'ATLAS', 'POLIS', 'GRAPE', 'TULIP',
  'PORT', 'MNGO', 'FIDA', 'KIN', 'CRP', 'LIQ', 'SUNNY', 'SBR',
  'CASH', 'LARIX', 'PAI', 'ORCA', 'MERC', 'SNY', 'SLND', 'SOL',
];

// ---------------------------------------------------------------------------
// VU entrypoint
// ---------------------------------------------------------------------------
export default function () {
  const baseUrl = config.baseUrl;

  // Pick a random term; different VUs diverge naturally across iterations
  const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];

  const url = `${baseUrl}/api/tokens/search?q=${encodeURIComponent(term)}&limit=20`;

  const start = Date.now();
  const res = http.get(url, {
    headers: { Accept: 'application/json' },
    tags: { endpoint: 'token-search' },
  });
  const elapsed = Date.now() - start;

  searchDuration.add(elapsed);
  totalRequests.add(1);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response is JSON': (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
    'p95 < 500 ms': () => elapsed < 500,
  });

  searchErrorRate.add(!ok);

  // Short think time between requests (realistic user pacing)
  sleep(Math.random() * 0.5 + 0.1);
}

// ---------------------------------------------------------------------------
// Summary artifact for CI reporting
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const p95 = data.metrics.token_search_duration_ms?.values?.['p(95)'] ?? null;
  const errRate = data.metrics.token_search_errors?.values?.rate ?? null;
  const total = data.metrics.token_search_total_requests?.values?.count ?? null;

  const summary = {
    scenario: 'token-search-load',
    timestamp: new Date().toISOString(),
    vus: 50,
    duration: '60s',
    totalRequests: total,
    p95ResponseTimeMs: p95 !== null ? Math.round(p95) : null,
    errorRate: errRate !== null ? parseFloat((errRate * 100).toFixed(4)) : null,
    sloP95Passed: p95 !== null ? p95 < 500 : null,
    sloErrorRatePassed: errRate !== null ? errRate < 0.001 : null,
  };

  return {
    'load-tests/results/token-search-load-summary.json': JSON.stringify(
      summary,
      null,
      2
    ),
    stdout: JSON.stringify(summary, null, 2),
  };
}
