// Replay Runner: a confirmation-momentum paper trader for agent-fun/replay/v2.
//
// Idea: never buy a launch blind. A coin must first prove it is alive — several
// distinct wallets buying, net SOL flowing in, price already up from creation but
// not vertical — and only then do we take one fixed stake. Winners are ridden with
// a trailing stop so a 2-5x runner pays for many small losers; losers are cut by a
// hard stop, a hold cap, a creator dump, or flow going cold. One buy per coin, no
// adds, no clock, no randomness: a pure function of the batches it is fed.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface RunnerParams {
  /** Youngest age (slots since create) at which a first buy may be decided. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** Fixed stake per coin, lamports. */
  stakeLamports: number;
  /** Smallest buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time, lamports. */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buys in the create slot: lamports window. */
  minCreatorBuyLamports: number;
  maxCreatorBuyLamports: number;
  /** Distinct non-creator buyers that must have bought before entry. */
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by a crowd is a dump waiting to happen. */
  maxBuyers: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxSingleSellBps: number;
  /** Price now over the create price, as bps: window a coin must sit in to be bought. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindowSlots: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Cumulative net SOL bought since creation (all buys minus non-creator sells), at least: the surge signature. */
  minCumulativeNetLamports: number;
  /** The real-SOL crossing counts as fresh for this many slots after it. */
  maxCrossAgeSlots: number;
  /** Creator sold before entry: never buy the coin. */
  skipCreatorSold: boolean;
  /** Slippage allowed on buys, bps. */
  buySlippageBps: number;
  /** Take profit: sell everything once value is this far over cost, bps. */
  takeProfitBps: number;
  /** Stop loss: sell everything once value is this far under cost, bps. */
  stopLossBps: number;
  /** Trailing stop: once up at least this far, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while we hold. */
  exitOnCreatorSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: RunnerParams = {
  minAgeSlots: 0,
  maxAgeSlots: 1_000_000,
  stakeLamports: 500_000_000,
  minBuyLamports: 10_000_000,
  minRealSolLamports: 40_000_000_000,
  maxRealSolLamports: 70_000_000_000,
  minCreatorBuyLamports: 0,
  maxCreatorBuyLamports: 2_000_000_000,
  minBuyers: 5,
  maxBuyers: 10_000,
  maxSingleSellBps: 10_000,
  minRunupBps: 1_000,
  maxRunupBps: 60_000,
  flowWindowSlots: 12,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  minCumulativeNetLamports: 5_000_000_000,
  maxCrossAgeSlots: 30,
  skipCreatorSold: true,
  buySlippageBps: 10_000,
  takeProfitBps: 2_000,
  stopLossBps: 1_500,
  trailArmBps: 1_000_000,
  trailBps: 1_000,
  maxHoldSlots: 300,
  exitOnCreatorSell: true,
  staleSlots: 200,
  exitFlowLamports: 1_000_000_000_000,
};

const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface WatchedCoin {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  createVq: bigint;
  createVt: bigint;
  creatorBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  /** Lamports bought on the coin since creation (every buy, creator included). */
  bought: bigint;
  soldByOthers: bigint;
  worstSingleSellBps: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  recent: TapeTick[];
  boughtOnce: boolean;
  /** Slot the coin's real SOL reserve first reached minRealSolLamports, null until it does. */
  crossSlot: number | null;
  /** Never consider it again (exited, filtered out for good, or completed). */
  closed: boolean;
  complete: boolean;
}

interface OpenTrade {
  openedSlot: number;
  txPaid: bigint;
  bestValue: bigint;
  creatorSoldAtOpen: boolean;
}

export interface Runner {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createRunner(params: RunnerParams = DEFAULT_PARAMS): Runner {
  const P = params;
  const coins = new Map<Pubkey, WatchedCoin>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Mints with a sell already in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          creator: e.creator,
          createVq: BigInt(e.virtual_quote_reserves),
          createVt: BigInt(e.virtual_token_reserves),
          creatorBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          worstSingleSellBps: 0n,
          creatorSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          crossSlot: null,
          closed: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.crossSlot === null && BigInt(e.real_quote_reserves) >= BigInt(P.minRealSolLamports)) {
          c.crossSlot = e.slot;
        }
        const isCreator = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isCreator && e.slot === c.createdSlot) c.creatorBuy += sol;
          else if (!isCreator) c.buyers.add(e.user);
        } else if (isCreator) {
          c.creatorSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.worstSingleSellBps) c.worstSingleSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.closed = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, and distinct buyers, over the last flowWindowSlots slots. */
  function recentFlow(c: WatchedCoin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      noteEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold fills: track tx fees paid per open trade, open trades on filled buys,
      // drop trades the harness closed for us (client ids starting with '_').
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const t = open.get(f.mint);
        if (f.status !== 'rejected' && t !== undefined) t.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && t === undefined) {
          open.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            bestValue: 0n,
            creatorSoldAtOpen: coins.get(f.mint)?.creatorSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      // Exits first: every held position is re-priced and checked against its exits.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let t = open.get(mint);
        if (t === undefined) {
          t = { openedSlot: state.slot, txPaid: txFee, bestValue: 0n, creatorSoldAtOpen: c?.creatorSold ?? false };
          open.set(mint, t);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = sellValueLamports(pos.token_amount, mk.vq, mk.vt) - txFee;
        const basis = pos.cost_lamports + t.txPaid;
        if (value > t.bestValue) t.bestValue = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.takeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.stopLossBps))) exit = true;
          if (
            t.bestValue * BPS >= basis * (BPS + BigInt(P.trailArmBps)) &&
            value * BPS <= t.bestValue * (BPS - BigInt(P.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - t.openedSlot >= P.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (P.exitOnCreatorSell && c.creatorSold && !t.creatorSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (recentFlow(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.closed = true;
      }

      // Entries: one fixed stake per coin that passes every filter.
      let free = state.freeCashLamports();
      let openCount = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.closed || c.complete || c.boughtOnce) continue;
        const age = state.slot - c.createdSlot;
        if (age > P.maxAgeSlots) {
          c.closed = true;
          continue;
        }
        if (age < P.minAgeSlots) continue;
        if (c.crossSlot === null || state.slot - c.crossSlot > P.maxCrossAgeSlots) continue;
        if (openCount >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (P.skipCreatorSold && c.creatorSold) {
          c.closed = true;
          continue;
        }
        const realSol = curve.real_quote_reserves;
        if (realSol < BigInt(P.minRealSolLamports) || realSol > BigInt(P.maxRealSolLamports)) continue;
        if (c.creatorBuy < BigInt(P.minCreatorBuyLamports) || c.creatorBuy > BigInt(P.maxCreatorBuyLamports)) continue;
        if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.worstSingleSellBps > BigInt(P.maxSingleSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vt <= 0n || c.createVt <= 0n) continue;
        const runup = (vq * c.createVt * BPS) / (vt * c.createVq);
        if (runup < BigInt(P.minRunupBps) || runup > BigInt(P.maxRunupBps)) continue;
        const flow = recentFlow(c, state.slot);
        if (flow.net < BigInt(P.minFlowLamports) || flow.buyers < P.minRecentBuyers) continue;
        const cumulativeNet = c.bought - c.soldByOthers;
        if (cumulativeNet < BigInt(P.minCumulativeNetLamports)) continue;
        const sizeCap = state.maxBuyLamports(c.mint);
        const amount = stake < sizeCap ? stake : sizeCap;
        if (amount < minBuy) continue;
        if (free < amount + txFee) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + txFee;
        c.boughtOnce = true;
        openCount += 1;
      }
      return orders;
    },
  };
}
