// Token Radar model "radar-2": one sealed snapshot in, one ranked board out.
//
// The board ranks every protocol on the snapshot's watchlist — the floor, never a
// ceiling — plus every other rankable pre-token protocol below that floor. A protocol
// counts as pre-token when its record carries no token at all: no market cap, no
// CoinGecko id, no symbol. Protocols whose token already trades are kept apart and
// shown with their market caps; they are never mixed into the ranking.
//
// One function scores every protocol, from the snapshot's own figures only — no
// name is ever special-cased:
//
//   base         = tvl_usd x 0.25
//   growthMult   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//   breadthMult  = 1 + 0.04 x min(max(chains - 1, 0), 5)    (1.00 to 1.20)
//   implied      = max(1, round(base x growthMult x maturityMult x breadthMult))
//
// Each factor earns its place. TVL is the size of the economy a token would price.
// Seven-day growth is momentum. Age with no token is how long the protocol has run
// unpriced, so a launch has more pent-up value to capture. Chain count is
// distribution breadth: a protocol live on several chains reaches more wallets on
// day one. Farm plans come from the same record — category, chains, TVL, age and
// the seven-day trend — never from a hand-written list of names.

/** One protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_chain: 0.04,
  breadth_max_chains: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export interface ImpliedBreakdown {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): ImpliedBreakdown {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_chains);
  const breadthMult = 1 + model.breadth_per_chain * extraChains;
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor, by TVL.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token' as const,
    watchlist: snapshot.watchlist.includes(s.p.slug),
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The trend line: what the protocol's own seven-day TVL change says about sizing the position. */
function trendLine(p: SnapshotProtocol, capital: number): string {
  const g = p.change_7d;
  if (g === null) return `No seven-day change is reported, so start with half the $${capital} position and add the rest after a week of steady TVL.`;
  if (g >= 10) return `TVL rose ${g.toFixed(1)}% in seven days, so the full $${capital} position is justified, but enter it in two halves a week apart.`;
  if (g >= 0) return `TVL rose ${g.toFixed(1)}% in seven days, so a steady $${capital} position fits; add more only after another green week.`;
  if (g >= -10) return `TVL fell ${Math.abs(g).toFixed(1)}% in seven days, so start with half the $${capital} position and scale in only if the slide stops.`;
  return `TVL fell ${Math.abs(g).toFixed(1)}% in seven days, so keep this to a $${Math.max(25, Math.floor(capital / 2))} starter position until the outflow reverses.`;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator')) return `Deposit $${capital} of USDC into a ${name} curator vault on ${chain} and hold the vault shares.`;
  if (c.includes('capital allocator')) return `Allocate $${capital} of USDC to a ${name} vault on ${chain} and keep the allocation live.`;
  if (c.includes('collateral')) return `Deposit $${capital} of collateral into ${name} on ${chain} and keep the position open.`;
  if (c.includes('lend') || c.includes('cdp')) return `Supply $${capital} of USDC to ${name} on ${chain}, borrow a small amount against it, and keep both legs open.`;
  if (c.includes('dex')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the position in range.`;
  if (c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and let it compound.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds in its app the same week.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one market position, then one more the following week.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset through ${name} on ${chain} and hold it for the full term.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('nft')) return `List or buy one item through ${name} on ${chain} and keep the activity on the same wallet.`;
  if (c.includes('gaming')) return `Play one session a week on ${name} on ${chain} and keep the in-game assets in the farming wallet.`;
  if (c.includes('launchpad')) return `Commit $${capital} to the next sale on ${name} on ${chain} and hold the allocation through the lock.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age, seven-day trend),
 * never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const chainNote = p.chains.length > 1 ? ` It also runs on ${p.chains.slice(1, 3).join(' and ')}, so repeat the deposit there once the first position is live.` : '';
  return [
    stepText(
      `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`,
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    stepText(
      `${actionFor(p, capital, chain)}${chainNote}`,
      `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      '15 minutes to set up',
    ),
    stepText(
      trendLine(p, capital),
      'no extra capital beyond the position',
      '5 minutes to check',
    ),
    stepText(
      `Make one qualifying action each week — a deposit, a borrow, a swap or a vote — from the same wallet.`,
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; never pay to claim.`,
      'no fee to check',
      '10 minutes',
    ),
    stepText(
      `Write the wallet, the dates and every transaction hash in a farm log, then unwind in reverse order when you exit.`,
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text. Anything that is not the shape the model
 *  scores is refused with the field that fails, so a bad input can never
 *  silently become a board. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const asOf = readDate(o.as_of, 'as_of');
  const source = readString(o.source, 'source');
  const floor = readPositiveInt(o.floor_usd, 'floor_usd');
  const protocolList = readArray(o.protocols, 'protocols');
  const watchlist = readArray(o.watchlist, 'watchlist');
  if (watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has a watchlist entry that is not a slug');
  }
  const protocols = protocolList.map((v, i) => readProtocol(v, i));
  return { as_of: asOf, source, floor_usd: floor, protocols, watchlist: watchlist as string[] };
}

/** A plain object, or a refusal naming the field it was read as. */
function readObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotError(`snapshot.json's ${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** An array, or a refusal naming the field it was read as. */
function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new SnapshotError(`snapshot.json has no ${field} array`);
  return value;
}

/** A string, or a refusal naming the field it was read as. */
function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new SnapshotError(`snapshot.json has no ${field}`);
  return value;
}

/** A YYYY-MM-DD date, or a refusal naming the field it was read as. */
function readDate(value: unknown, field: string): string {
  const s = readString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new SnapshotError(`snapshot.json's ${field} is not a date`);
  return s;
}

/** A positive safe integer, or a refusal naming the field it was read as. */
function readPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SnapshotError(`snapshot.json has no ${field}`);
  }
  return value;
}

/** A string field, or null when the record carries anything else. */
function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A finite number field, or null when the record carries anything else. */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One protocol entry out of a raw value: the ten fields, nothing else. */
function readProtocol(v: unknown, i: number): SnapshotProtocol {
  const p = readObject(v, `protocol ${i}`);
  if (typeof p.slug !== 'string' || typeof p.name !== 'string') {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug or a name`);
  }
  const tvl = nullableNumber(p.tvl_usd);
  if (tvl === null) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a TVL`);
  const chains = Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [];
  return {
    slug: p.slug,
    name: p.name,
    category: nullableString(p.category),
    chains,
    tvl_usd: tvl,
    change_7d: nullableNumber(p.change_7d),
    mcap_usd: nullableNumber(p.mcap_usd),
    listed_at: nullableString(p.listed_at),
    gecko_id: nullableString(p.gecko_id),
    symbol: nullableString(p.symbol),
  };
}

/** Why a board is not one the gate will take, or null when it is. The checks run
 *  in the order the gate lists them: coverage first, then ranks, then order, then
 *  a board that ranks nothing, then every row's farm steps and implied value. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    const noun = missing.length === 1 ? 'slug' : 'slugs';
    return `the board misses ${missing.length} watchlist ${noun}: ${shown}`;
  }
  const seen = new Set<number>();
  for (const r of board) {
    if (!Number.isSafeInteger(r.rank) || r.rank < 1 || r.rank > board.length) {
      return `${r.slug} carries rank ${r.rank}, outside 1..${board.length}`;
    }
    if (seen.has(r.rank)) return `rank ${r.rank} appears twice`;
    seen.add(r.rank);
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `rank ${byRank[i]!.rank} outranks rank ${byRank[i - 1]!.rank} on implied value`;
    }
  }
  const top = byRank[0]?.implied_value_usd;
  const bottom = byRank[byRank.length - 1]?.implied_value_usd;
  if (board.length >= 2 && top !== undefined && top === bottom) {
    return `all ${board.length} rows share the same implied value $${top}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of byRank) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `${r.slug} has a farm step of ${n} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
