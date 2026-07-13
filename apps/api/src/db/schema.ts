import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

// Local historical-candle store for backtesting. Populated by the
// backtest-data module's /backtest/data/sync endpoint (fetched from Upstox).
// The unique index on (instrumentKey, timeframe, ts) makes re-syncing an
// overlapping range idempotent (onConflictDoNothing upserts).
export const candles = sqliteTable(
  'candles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instrumentKey: text('instrument_key').notNull(),
    // v2: raw Upstox interval ('1minute','30minute','day','week','month').
    // v3: composed as '{interval}{unit}' e.g. '1minutes', '1days'.
    timeframe: text('timeframe').notNull(),
    ts: integer('ts').notNull(), // candle open time, epoch ms
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    volume: integer('volume'),
    // Open interest — Upstox returns it as the 7th candle element (candle[6]).
    // 0 for equity; meaningful for F&O (futures/options). Nullable for safety.
    oi: integer('oi'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    instTfTsIdx: uniqueIndex('candles_inst_tf_ts_idx').on(t.instrumentKey, t.timeframe, t.ts),
  }),
)

export type Candle = typeof candles.$inferSelect
export type NewCandle = typeof candles.$inferInsert