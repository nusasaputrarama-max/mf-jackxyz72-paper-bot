// Fresh-coin momentum sniper with exit-cooldown and conviction-scaled stake,
// for the pump.fun paper replay (agent-fun/replay/v2), jackxyz72 24h sprint.
//
// Idea: most pump.fun curves bleed after launch, so the bot never buys a coin
// just for existing. It watches every curve's trade tape and only steps in
// when a coin that survived its first minutes shows fresh, accelerating buy
// pressure over a 60-slot window: real SOL flowing in, several distinct
// buyers, price climbing and sitting near its short-window high. One buy per
// coin, no pyramiding. A position is sold whole on the first of a stop loss,
// a trailing stop, a take-profit, a fade in flow, a whale dump, or a time
// limit. Two rules this bot adds over the plain sniper shape:
//
//   - Exit cooldown: after any exit on a coin, that coin is not re-entered
//     for `cooldownSlots` slots, so the bot never buys straight back into a
//     coin that just stopped it out.
//   - Conviction stake: a very strong tape (new-half inflow at least twice
//     the old half, with at least `stakeHiBuyers` distinct buyers) earns the
//     larger stake; everything else gets the base stake.
//
// A pacing probe keeps the run above the guardrail floor (20 coins with a
// round trip each) when momentum entries alone fall behind.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream, so the two grading
// runs produce identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minRise: number;
  /** Upper bound on that rise: skip coins that already ran too far. */
  maxRise: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Real SOL bounds of the curve at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Slots after an exit before the same coin may be entered again. */
  cooldownSlots: number;
  /** SOL for the single buy of one position (base conviction). */
  stakeSol: number;
  /** SOL for the single buy on a high-conviction tape. */
  stakeHiSol: number;
  /** Distinct buyers needed for the high-conviction stake. */
  stakeHiBuyers: number;
  /** New-half inflow multiple needed for the high-conviction stake. */
  stakeHiAccel: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out wide open. */
  buySlipBps: number;
  /** Exit: value below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit: value below peak * (1 - trail), once armed. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit: value above cost * (1 + takeProfit). */
  takeProfit: number;
  /** Fade lookback in slots. */
  fadeSpan: number;
  /** Exit when net SOL over the fade span falls below -fadeSol. */
  fadeSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  dumpSol: number;
  /** Exit after this many slots held. */
  maxHoldSlots: number;
  /** Guardrail floor: coins and fills the run must reach. Probes grind toward
   * these from the first batch (no pace scaling: the floor binds at the end
   * of the window, and a pace-scaled target only starts binding when it is
   * too late to catch up one probe at a time). */
  targetCoins: number;
  targetFills: number;
  /** Open positions kept free for probe round trips (the hard cap counts them too). */
  reserveSlots: number;
  /** SOL for one probe round trip. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

/** Tuned on the kit's dev window; prefer flat regions over a single best cell.
 * Entries are deliberately selective: on this market most coins bleed, so a
 * loose signal buys tops all day. The pacing probes only cover the
 * guardrail floor (20 coins) — the competition sets no minimum fill count,
 * so the probe targets stay just above the coin floor instead of chasing
 * hundreds of fills. */
export const DEFAULT_PARAMS: Params = {
  window: 60,
  minNetSol: 2.5,
  minBuys: 6,
  minBuyers: 6,
  minRise: 0.08,
  maxRise: 0.6,
  accel: 0.8,
  nearHigh: 0.97,
  minRealSol: 1.5,
  maxRealSol: 80,
  minAgeSlots: 600,
  cooldownSlots: 300,
  stakeSol: 0.1,
  stakeHiSol: 1.0,
  stakeHiBuyers: 12,
  stakeHiAccel: 2,
  minBuySol: 0.02,
  buySlipBps: 5000,
  stopLoss: 0.1,
  trail: 0.15,
  trailArm: 0.08,
  takeProfit: 0.15,
  fadeSpan: 15,
  fadeSol: 0.8,
  dumpSol: 2.5,
  maxHoldSlots: 900,
  targetCoins: 22,
  targetFills: 50,
  reserveSlots: 1,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Open {
  opened: number;
  peak: number;
  invested: number;
  filled: boolean;
  leaving: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once bought. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  const keep = p.window + 10;

  const tapeFor = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `span` slots. */
  const netFlow = (t: Tape, now: number, span: number): number => {
    let net = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tk = t.ticks[i]!;
      if (tk.slot <= now - span) break;
      net += tk.buy ? tk.sol : -tk.sol;
    }
    return net;
  };

  /**
   * Entry signal on a curve's tape at slot `now`, given its real SOL reserves.
   * Returns 0 for no entry, 1 for a base-conviction entry, 2 for a
   * high-conviction entry (stronger inflow, more distinct buyers).
   */
  const entrySignal = (t: Tape, now: number, realSol: number): number => {
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return 0;
    if (t.created === null || now - t.created < p.minAgeSlots) return 0;
    if (now - t.lastExit < p.cooldownSlots) return 0;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let start = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tk of t.ticks) {
      if (tk.slot <= from) {
        start = tk.price;
        continue;
      }
      if (start < 0) start = tk.price;
      const signed = tk.buy ? tk.sol : -tk.sol;
      if (tk.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tk.buy) {
        buySol += tk.sol;
        buys++;
        buyers.set(tk.user, (buyers.get(tk.user) ?? 0) + tk.sol);
      } else {
        sellSol += tk.sol;
      }
      if (tk.price > high) high = tk.price;
      last = tk.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return 0;
    if (buySol - sellSol < p.minNetSol) return 0;
    if (start <= 0) return 0;
    const rise = last / start - 1;
    if (rise < p.minRise || rise > p.maxRise) return 0;
    if (last < high * p.nearHigh) return 0;
    if (netNew <= 0 || netNew < p.accel * netOld) return 0;
    if (buyers.size >= p.stakeHiBuyers && netNew >= p.stakeHiAccel * Math.max(netOld, 0)) return 2;
    return 1;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigDump = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          touched.add(e.mint);
          if (!e.is_buy && sol >= p.dumpSol) bigDump.add(e.mint);
        }
      }
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // 1. Exits first: stop loss, trailing stop, take profit, fade, whale dump, time.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            open.delete(mint);
            const t = tapeFor(mint);
            if (o.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.complete) continue;
        const tokens = Number(pos.token_amount);
        const value =
          ((tokens * Number(curve.virtual_quote_reserves)) / (Number(curve.virtual_token_reserves) + tokens) / LAMPORTS) *
            (1 - CURVE_FEE) -
          tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > o.peak) o.peak = value;
        let leave = o.leaving;
        if (!leave && value < cost * (1 - p.stopLoss)) leave = true;
        if (!leave && o.peak >= cost * (1 + p.trailArm) && value < o.peak * (1 - p.trail)) leave = true;
        if (!leave && value > cost * (1 + p.takeProfit)) leave = true;
        if (!leave && netFlow(tapeFor(mint), now, p.fadeSpan) < -p.fadeSol) leave = true;
        if (!leave && bigDump.has(mint)) leave = true;
        if (!leave && now - o.opened > p.maxHoldSlots) leave = true;
        if (!leave) continue;
        o.leaving = true;
        let sellFlying = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellFlying = true;
        }
        if (sellFlying) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe sells: dump the whole probe as soon as its buy has landed.
      for (const [mint, bought] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!bought) probes.set(mint, true);
      }

      // 3. Entries: one buy per coin, only on a live momentum signal.
      // The stake scales with the signal's conviction (see entrySignal).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap || room <= p.reserveSlots) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingMints.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= 1) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const signal = entrySignal(t, now, realSol);
        if (signal === 0) continue;
        const headroom = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        const stake = signal === 2 ? p.stakeHiSol : p.stakeSol;
        let amount = Math.min(headroom, stake);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        room--;
        open.set(mint, { opened: now, peak: 0, invested: amount, filled: false, leaving: false });
        t.entries++;
      }

      // 4. Probe buys: when fills or coins lag the floor, open a tiny round trip.
      if (probes.size < p.maxProbes && room > 0) {
        const needCoins = myCoins.size < p.targetCoins;
        const needFills = myFills < p.targetFills;
        if (needCoins || needFills) {
          const minReal = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
