# dsh-plugin-price-aware

**Let your coding agent know what it costs.**

[dsh](https://github.com/deepseek-ai/deepseek-harness) meters tokens well and money not at all. There is no price table, no `/cost`, no balance call, no spend cap anywhere in the harness — the `tokenUsage` projection counts `uncachedInput / output / cacheRead / cacheWrite`, and then the bill happens to whoever owns the account.

This plugin closes that gap:

- the model **reads its own unit price, the account balance, and this session's running bill** every turn;
- before an expensive step it **quotes three tiers** — A minimal / B done / C thorough — each with a token estimate, a money figure and an honest error band;
- it **stops and asks** when the money is about to get real, offering continue / downgrade to flash / narrow the scope / defer to off-peak / stop;
- it knows DeepSeek's **peak vs off-peak pricing** (workday 09:00–12:00 and 14:00–18:00 Beijing is 2×) and its **cache-hit price** (0.02 vs 1 CNY per 1M on flash), so "run the bulk job after 18:00" is a number, not a vibe.

MIT · TypeScript · zero runtime dependencies beyond `@deepseek-ai/cordis`.

---

## Install

```bash
dsh plugin add github:121212165/dsh-plugin-price-aware
```

or from a local checkout (`dsh plugin add ./dsh-plugin-price-aware`), or pin a commit:

```bash
dsh plugin add github:121212165/dsh-plugin-price-aware#main
```

Discovery for community plugins is the GitHub topic `dsh-plugin`. From a local checkout:

```bash
dsh plugin add ./dsh-plugin-price-aware
```

Then restart `dsh`. `/money` should print prices. The mount lives in `cordis.patch.yml`; every field is documented there and in [Configuration](#configuration).

## What the model sees

`injectIntoPrompt: true` adds one dynamic context block per turn — 110 tokens, ¥0.0005 at peak pro rates, and a test fails if it grows past 260:

```
钱: deepseek-v4-pro 单价(每百万 token, CNY) 输入 4.5/9 · 缓存命中 0.15 · 输出 13.5/27【当前高峰，价×2】
钱: 大批量动作等 1h30m 后（错峰可省一半）
钱: 账户余额 ¥41.20 · 本会话已花 ¥3.84/¥10.00（模式 normal） · 34 轮 · 缓存命中 71%
纪律: 单步预计 ≥ ¥1.50 时，先给 A/B/C 三档让用户选档再开工；不重复读大文件，保持前缀稳定以命中缓存；能用 flash 解决就别用 pro。
```

If the model is not in the price table, the block says so and forbids itself from inventing a number. An estimate you cannot defend is worse than no estimate.

## Commands and tools

| Name | Who calls it | What it does |
|---|---|---|
| `/money` | you | unit price, balance, session bill, remaining budget |
| `/budget [5]` | you | read the policy; changing it prints the config edit instead of silently mutating your cap |
| `/estimate <kind> [turns] [residentK]` | you | A/B/C quote for a task shape |
| `price_status` | the model | same facts, callable mid-task before it commits to something expensive |
| `quote_task` | the model | A/B/C quote for a task it is about to start |

## How the estimate works (and where it is wrong)

An agent turn does not cost "the prompt you typed". It costs the whole history re-sent, times the number of turns:

```
promptTokens = turns × resident + growth × turns × (turns − 1) / 2
```

`resident` (system prompt + tool schemas + history) is what actually burns you: a 14-turn refactor with 20k resident tokens re-sends ~462k prompt tokens, and only the cache-discounted part of that is cheap. The estimator prices that shape, splits it into cached/uncached/output, and applies the model's current regime.

Default error band is ±35–60%. Above `reconThresholdMajor` (default ¥0.5) the plugin offers to spend a small read-only recon pass — which tightens the band to ±12% and costs under a quarter of the job it is pricing. Below that threshold, paying to estimate is a bad trade and it says so.

**A quote is only an upper bound if the model stops talking.** The live test found a whole-file generation that filled every cap it was given, 4320 → 6263 tokens, twice. `quoteTrust()` therefore labels each figure as a bound or a floor based on that model's observed `selfFinishedRate`, and `escalateCap()` turns the retry into a priced experiment instead of a fake estimate.

`calibrate()` learns from your own history: feed it `{predicted, actual}` pairs and it returns the median correction (median, not mean, so one 5× outlier does not bend future quotes).

## Configuration

```yaml
price-aware:
  mode: normal            # economy ¥2 · normal ¥10 · max uncapped · custom below
  sessionCapMajor: 10     # whole currency units; only read when mode: custom
  warnPercent: 75         # this fraction of the cap triggers the ask
  taskAskMajor: 1.5       # one step above this gets an A/B/C quote first
  balanceFloorMajor: 3    # stop before draining the account below this
  holidays: ['2026-10-01'] # Beijing dates billed off-peak
  prices:
    - id: jiyuan/deepseek-v4-flash     # provider-scoped rows beat generic ones
      currency: CNY
      perMillion: { cacheRead: 0.5, uncachedInput: 3, output: 12 }
```

Relay and reseller endpoints are first-class: your provider's price is not DeepSeek's price, so a `prices` row is how you say so. Until you do, the plugin refuses to quote in currency.

## Using the core without dsh

`src/pricing`, `ledger`, `gate` and `estimate` are pure. `import { costOf, resolveModel, DEEPSEEK_CATALOG } from 'dsh-plugin-price-aware/pricing'` and you have the same money math for your own harness, dashboard or CI budget check.

## Development

```bash
npm install   # dsh types land in node_modules so the wiring typechecks for real
npm run check # typecheck + 74 tests + build
```

The plugin's `apply()` compiles against the actual `@deepseek-ai/dsh-*` declaration files, and `lib/index.js` imports clean. What is **not** verified is a live mount inside a running `dsh` session — that needs an installed harness (this machine's `~/.dsh` profile symlinks currently point at a deleted clone).

## Verified against a live paid endpoint

5 rounds, real money, real gateway (TokenRhythm / 基元律动, ¥18 of credits), driven entirely through this plugin's own code:

| | 结果 |
|---|---|
| Spent | **¥2.95** measured across 59 billed calls, until the gateway answered `402 余额不足` while the local ledger still believed **¥15.05** was left |
| Price source | `/v1/models` publishes CNY rates → `catalogFromProviderModels()` ingests any self-reporting gateway |
| Official-sheet assumption would have been wrong | relay `deepseek-v4-flash-0731` = ¥3/9/0.1 per 1M vs DeepSeek's own ¥1/4/0.02 — **3× under-billed** if matched by name |
| Cache | `cached_tokens` was **0 in every call**, including 3 identical 3.7k-token prefixes → this gateway eats no prefix discount; `cacheableShare` must be 0 here |
| Reasoning | up to **100% of `completion_tokens` invisible**; several round-2 calls billed a full cap and returned 0 characters |
| Cost per useful output | best ¥0.0032/千可见字符, worst ¥9.53/千 — a **~3000× spread** the token-price table alone cannot see |
| Deliverable | `report/content.js`, 10 287 chars, passes `vm.Script`, covers all 6 F1 sub-requirements |
| Ranking by cost per *parseable* file | `deepseek-v4-flash-0731` ¥0.048 · `minimax-m2.7` ¥0.077 · `qwen3.7-max` ¥0.090 · `deepseek-v4-pro-0813` ¥0.148 — and 8 models took money and delivered **zero** parseable files |
| Final calibration | median bias ×0.858 with headroom reported against the quote, not the bill |

The headline is that **prompt discipline is a cost control**: the same model, same cap (6263) and same task filled the cap and truncated in round 4, then self-finished at 2904 tokens for ¥0.028 in round 5 after the system prompt forbade fences and prose. Reproduce with `node examples/live-run.ts && node examples/live-run2.ts && node examples/live-run3.ts && node examples/live-run4.ts && node examples/live-run5.ts`; every run writes to `report/`.

## Known limitations

- **The bundled price table is a dated snapshot** (`asOf` in `src/pricing/catalog.ts`, DeepSeek's page as of 2026-09-21). After 45 days the block admits it may be stale. For gateways that publish rates on `/v1/models`, use `catalogFromProviderModels()` instead of the snapshot — that path is the one the live test exercised.
- **Chinese public holidays default to an empty list.** Weekday peak hours are correct; a holiday that should bill off-peak will bill peak until you add it. Guessing a holiday calendar into a billing path is worse than an honest gap.
- **Peak windows are configurable but not provider-aware.** Any provider with different peak rules needs `peakMinutes` changes at the rules layer.
- **A local ledger is not a balance.** When the provider has no credits endpoint, `spentMicros` drifts from reality with every unpriced call, discount, or billing rule we do not know about. In the live test the gateway refused for lack of funds while our books said 84% of the budget remained. The plugin must say "as far as I can see" wherever it states remaining money, and `/money` shows how many events went unpriced.

- **`dsh` is a developer preview** with no ABI stability promise. `@deepseek-ai/dsh-base` is pinned for typechecking; expect churn between alpha tags.
- **Cache-write tokens are priced at zero** because DeepSeek's prompt cache is automatic and unbilled. Anthropic-style providers that bill cache writes at 1.25× need `perMillion.cacheWrite` set.
- **The gate can only speak where dsh lets it.** Today that is `tools/pre-execute`; a hard per-request cap would need a model-call veto, which the harness reserves for its own loop.

## Credit discipline, stated plainly

This plugin cannot make the harness refuse a request, and it will not pretend to. What it does is make the price visible early enough that the model can pick a cheaper plan, and you can pick a cheaper tier, before the tokens are gone.

## License

MIT
