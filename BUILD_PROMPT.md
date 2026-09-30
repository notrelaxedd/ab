# Venture Engine — Claude Code Build Prompt (v1)

Run Claude Code in an empty folder named `venture-engine`, save this file there as `BUILD_PROMPT.md`, and say:
"Read BUILD_PROMPT.md and start Phase 1."

---

## 1. What you're building

Venture Engine is an autonomous system that turns business ideas into live, revenue-generating digital products with **no human approval at any step**. It ideates, researches, specs, builds, launches, markets (including paid Meta ads), measures, and then scales, iterates, or kills each venture on its own.

The owner only does one-time account setup. Safety comes from three layers that do not depend on the model behaving:

1. **Code-enforced budgets.** Claude Code `PreToolUse` hooks deny any spend-capable tool call that would exceed the venture's or the portfolio's remaining budget.
2. **Reviewer agent.** A separate, read-only Claude run must pass every irreversible action against written policy files.
3. **Platform caps.** An account spending limit in Meta and a low-limit card, set by the owner outside this code.

Everything runs on Claude Code headless (`claude -p`) using the owner's Claude Max subscription. `ANTHROPIC_API_KEY` must be unset in every process the worker spawns, or usage bills the API instead.

## 2. Ground rules for you (the builder)

- Build in the phases in §10. At the end of each phase: run the tests, show results, list anything I must do by hand, then stop and wait.
- Don't guess CLI flags or MCP tool names. Check `claude --help`, the Claude Code docs, and each MCP server's live tool list before hardcoding anything. Record real tool names and parameters in `docs/mcp-tools.md`.
- Money limits are enforced by code, never by prompts.
- Secrets are handled by worker code and environment variables only. Never pass a secret through a model prompt or tool input. The worker (not the model) sets Vercel env vars for each venture.
- Fail closed. If a guard can't tell whether an action is safe (unknown tool, missing venture ID, Supabase unreachable, unparseable input), deny it.
- Stack: TypeScript, Node 20+, Supabase, Next.js 14 App Router + Tailwind + shadcn/ui for anything web, Vercel for hosting, zod at every JSON boundary.
- Record every non-obvious choice in `docs/decisions.md`.

## 3. Repo layout

```
venture-engine/
  BUILD_PROMPT.md
  CLAUDE.md                  # standing context for every run
  .mcp.json                  # all servers; per-stage subsets generated from it
  .claude/
    settings.json            # hooks + base permissions
    agents/                  # strategist, researcher, builder-frontend, builder-backend,
                             # builder-content, launcher, marketer, ads-manager,
                             # analyst, support, reviewer
  policies/                  # content, prohibited categories, ads, spend
  prompts/stages/            # one prompt file per stage
  hooks/                     # kill-switch-guard, budget-guard, action-logger (+ tests)
  worker/                    # orchestrator (index, scheduler, decide, lib/claude, lib/ledger)
  template/                  # venture starter app
  supabase/migrations/
  ventures/                  # per-venture working dirs + git worktrees (gitignored)
  docs/                      # mcp-tools, decisions, RUNBOOK, SETUP
```

## 4. Data model (Supabase)

Write as migrations. RLS on everything; only the worker uses the service-role key.

- **settings** (single row): `kill_switch` (default false), `dry_run` (default true), `monthly_budget_usd`, `venture_budget_usd`, `max_active_ventures` (default 3), `max_concurrency` (default 2), `auto_refund_limit_usd`, `brand_domain`, `support_email`, `owner_email`, and the decision thresholds in §8.
- **ideas**: `source` (owner | generated), `text`, `scorecard` jsonb, `score`, `status` (queued | scored | rejected | promoted).
- **ventures**: `slug`, `name`, `idea_id`, `stage`, `status` (active | paused | killed | scaling), `budget_cap_usd`, `iteration_count`, `repo_path`, `url`, `vercel_project_id`, `stripe_product_id`, `meta_campaign_ids` jsonb, `mailerlite_group_id`, `spec` jsonb, `launched_at`, `killed_at`, `kill_reason`.
- **tasks**: `venture_id`, `stage`, `status` (pending | running | done | failed | deferred), `attempt`, `run_after`, `claude_session_id`, `input` jsonb, `output` jsonb, `error`, `locked_by`, `locked_at`.
- **ledger**: `venture_id`, `category` (ads | runtime_ai | other), `kind` (reservation | actual | release), `amount_usd`, `source`, `ref`.
- **actions_log**: every MCP write call: `venture_id`, `task_id`, `tool_name`, `input` jsonb (secrets redacted), `decision` (allowed | denied), `reason`.
- **reviews**: `task_id`, `venture_id`, `action`, `target_ref` (e.g. campaign ID), `verdict` (pass | block), `reasons` jsonb.
- **metrics_daily**: `venture_id`, `date`, `visitors`, `signups`, `checkouts`, `orders`, `revenue_usd`, `refunds_usd`, `ad_spend_usd`, `impressions`, `clicks`, `cpa_usd`, `roas`.
- **learnings**: portfolio-wide lessons from killed and scaled ventures; fed into ideation.
- **digests**: weekly summaries.

Also:
- Function `claim_task(worker_id)` — claims the oldest runnable task using `FOR UPDATE SKIP LOCKED`.
- View `venture_spend` — remaining = cap − actuals − open reservations.
- View `monthly_spend` — portfolio spend this calendar month vs `monthly_budget_usd`.

## 5. Worker

A long-running Node process managed by pm2.

**Loop (every 60 s):**
1. If `kill_switch` is on, claim nothing.
2. While running tasks < `max_concurrency`: `claim_task`, run it.
3. Scheduler enqueues recurring tasks (§7).

**`worker/lib/claude.ts`** is the only code that spawns Claude:
- Command shape (verify every flag against the installed version):
  `claude -p <task prompt> --output-format json --model <model> --max-turns <n> --append-system-prompt <stage prompt> --mcp-config <stage mcp file> --strict-mcp-config --allowedTools <stage allowlist> --disallowedTools <stage denylist>`
  Add `--max-budget-usd` per stage if the installed version supports it.
- `cwd` = the venture's working directory.
- Env: `VENTURE_ID`, `TASK_ID`, `STAGE`, `DRY_RUN`, plus the Supabase URL and key the hooks need. Explicitly delete `ANTHROPIC_API_KEY`.
- Never use `--dangerously-skip-permissions`. Use allowlists (e.g. `Bash(git:*)`, `Bash(npm:*)`, `Bash(npx:*)`, `Bash(gh:*)`) and `--permission-mode acceptEdits`.
- The agent's final message must contain one JSON block matching the stage's zod schema. If it's invalid, resume the same session once (`--resume <session_id>`) asking for a corrected block, then fail.
- Usage-limit or rate-limit errors: mark the task `deferred`, set `run_after` with exponential backoff (30 min → 5 h cap), and don't count it as an attempt.
- Per-stage timeouts; kill the child process on timeout.
- Max 3 attempts per task. After that the venture goes to `paused` and it's reported in the weekly digest.
- Generate `.mcp.<stage>.json` so each stage only sees the servers it needs.

## 6. Guardrails

### 6.1 Hooks (`.claude/settings.json` + `hooks/`)

- **kill-switch-guard** (PreToolUse; all `mcp__` write tools and `Bash`): deny if `kill_switch` is on.
- **budget-guard** (PreToolUse; matcher built from the real spend-capable tool names in `docs/mcp-tools.md`):
  - Deny if `VENTURE_ID` is missing.
  - Compute the maximum spend the call could cause: daily budget × days until end date, or lifetime budget; enabling a paused campaign counts its full remaining budget; budget increases count the delta.
  - Deny if that exceeds the venture's remaining budget or the portfolio's remaining monthly budget.
  - Deny all ad writes while `dry_run` is true.
  - Deny any campaign or ad set create/update without an explicit budget and end date.
  - Deny enabling any campaign unless `reviews` has a `pass` for that exact campaign ID.
  - On allow, write a `reservation` to the ledger.
- **action-logger** (PostToolUse; all `mcp__` tools): write to `actions_log`.
- Hooks return Claude Code's documented deny format with a clear reason so the agent can adapt.
- Unit-test every hook with fixture inputs, including malformed ones.

### 6.2 Reviewer (`.claude/agents/reviewer.md`)

- Read-only tools only: Read, Grep, Glob, WebFetch, read-only MCP tools. Runs as its own `claude -p` process on Opus.
- Required before: going live (production deploy + live payments), enabling any ad, raising any budget, scaling.
- Checks the action against `policies/*.md`. Outputs `{ verdict, reasons, required_fixes }`.
- Block → task returns to the previous stage with the fixes. Two blocks on the same action → kill the venture.

### 6.3 Policies (`policies/`) — write these first

- **content-policy.md**: no health or medical claims; no income or financial-results claims; no fake reviews, testimonials, or scarcity; no other companies' trademarks or brand names; no copyrighted characters or lyrics; no impersonation; accurate pricing and descriptions; visible refund policy; terms and privacy pages; email only to people who opted in.
- **prohibited-categories.md**: physical goods (v1), regulated or licensed products, supplements, adult, gambling, crypto or trading, weapons, anything aimed at minors, legal/medical/financial advice.
- **ads-policy.md**: Meta advertising policy checklist; no special ad categories in v1; no before/after claims; no copy that asserts personal attributes ("Are you struggling with…").
- **spend-policy.md**: mirrors the numeric limits in `settings`.

## 7. Stages

v1 scope: **digital products and simple micro-tools** sold with a one-time price or subscription. No physical goods.

**IDEATE** — when fewer than 5 ideas are queued. Strategist (Opus). Tools: WebSearch, WebFetch, `learnings` table. Output: 10 ideas inside v1 scope and policy.

**RESEARCH** — for each new idea. Lead on Opus spawns parallel researcher subagents on Sonnet. Tools: WebSearch, WebFetch. Output scorecard: demand evidence with URLs, competitors and their prices, differentiation, price point, build effort (1–5), best channel, ad angles, risks, policy check, score 0–100. Below 70 → rejected.

**SPEC** — top-scored idea, only if active ventures < `max_active_ventures`. Strategist (Opus). No MCPs. Output: `venture.config` values (name, slug, offer, price, deliverable), PRD, landing copy, legal-page inputs, 3 ad angles, success metrics.

**BUILD** — Sonnet. Lead copies `template/` into `ventures/<slug>`, then runs 3 builder subagents in parallel, each in its own git worktree: frontend/landing, backend/checkout/delivery, content/SEO/legal. Lead merges.
MCPs: Supabase (shared "ventures" project, one schema per venture `v_<slug>`; never create new projects), Stripe (test mode product + price), Vercel (preview deploy + build logs), Playwright (end-to-end check).
Output: preview URL + passing e2e (landing → checkout with Stripe test card → delivery).

**REVIEW_LAUNCH** — reviewer. Pass/block.

**LAUNCH** — only if review passed and `dry_run` is false. Launcher (Sonnet).
- Vercel: production deploy at `<slug>.<brand_domain>`. Worker code injects live env vars.
- Stripe: live product and price.
- MailerLite: group + signup form.
- PostHog: verify events are arriving.
Output: live URL, verified events.

**MARKET** — after launch; these run in parallel:
- Content: SEO pages committed and deployed.
- Email: MailerLite welcome sequence.
- Creative: Canva MCP makes 3–5 ad creatives from the spec's angles.
- Ads-manager: Meta Ads MCP creates the campaign **paused**, with budget and end date → reviewer → enable. Hooks enforce everything in §6.1.

**MEASURE** — daily 06:00. Analyst (Sonnet). PostHog, Stripe, and Meta insights (read-only) → one `metrics_daily` row per venture.

**DECIDE** — after MEASURE. Rules in §8 run in code first. The strategist (Opus) is called only to plan ITERATE changes.

**OPTIMIZE_ADS** — every 72 h per campaign. Ads-manager (Sonnet). Pause ads over target CPA after minimum spend; shift budget to winners within cap. Max one change per campaign per 72 h to protect Meta's learning phase.

**SUPPORT** — every 2 h. Support agent (Sonnet).
- Gmail MCP: only threads sent to `support+<slug>@`.
- Refunds ≤ `auto_refund_limit_usd` are issued via Stripe without argument.
- Larger requests are refunded if non-delivery or a defect is plausible; otherwise reply politely with the policy.

**KILL** — when DECIDE says kill. Launcher (Sonnet).
- Meta: pause everything.
- Stripe: deactivate product and prices.
- MailerLite: stop sequences.
- Vercel: replace the site with a "no longer available" page.
- Write a `learnings` row and archive the venture.

**DIGEST** — Fridays 17:00. Analyst (Sonnet). Email to `owner_email` only, plus a `digests` row. Contents per venture: spend, revenue, ROAS, stage changes, kills and why, reviewer blocks, errors.

## 8. Decision rules (`worker/decide.ts`, thresholds in `settings`)

- Day 14 after launch, visitors < 300 → ITERATE_MARKETING (max 2 iterations).
- Visitors ≥ 300 and checkout conversion < 1% → ITERATE_OFFER: price, copy, or deliverable (max 2).
- ROAS ≥ 1.5 over trailing 7 days with ≥ 5 orders → SCALE: raise cap 50% within the portfolio budget, after reviewer pass.
- Day 30, revenue < total spend, and no improving 7-day trend → KILL.
- Spend reaches cap with ROAS < 1 → KILL immediately.
- Iteration limit reached without meeting thresholds → KILL.
- Every KILL and SCALE writes a `learnings` row.

## 9. Venture template (`template/`)

Next.js 14 App Router, Tailwind, shadcn/ui. Everything is driven by `venture.config.ts` (name, tagline, offer, price, deliverable type, copy blocks, legal inputs, colors).

- Landing page: hero, benefits, pricing, FAQ, MailerLite email capture.
- Stripe Checkout via an API route; every session tagged `metadata.venture_id`. The success page verifies the session server-side, then delivers the product (signed Supabase Storage download URL or account access).
- PostHog and Meta Pixel with events: PageView, Lead, InitiateCheckout, Purchase.
- Terms, privacy, and refund pages generated from config.
- SEO: metadata, sitemap, OG images, `/guides/[slug]` for content pages.
- Optional runtime AI for products that need it: Gemini `gemini-2.5-flash` via API key, with a per-venture monthly cap tracked in the ledger (`runtime_ai`). Never route customer traffic through the owner's Claude subscription.
- Playwright e2e covering the full purchase flow in Stripe test mode.

## 10. Build phases (stop after each)

**Phase 1 — Foundation.** Migrations, settings row (`dry_run` true, `kill_switch` false), worker loop, `claim_task`, `lib/claude.ts` with a no-op stage, pm2 config.
Tests: two workers never claim the same task; kill switch stops new claims within one tick; a simulated usage-limit error defers the task correctly.

**Phase 2 — Guardrails.** `.mcp.json`, per-stage configs, real tool names recorded in `docs/mcp-tools.md`, all hooks with unit tests, `policies/*.md`, reviewer agent.
Tests: over-budget ad call denied; enabling without a review denied; unknown spend tool denied; ad writes denied while `dry_run` is true; malformed hook input denied.
Tell me when to authenticate each MCP server interactively.

**Phase 3 — Template.** Build `template/` and its e2e test.

**Phase 4 — Ideate → Launch, dry run.** One venture from an idea I give you to a preview URL with passing e2e and a reviewer pass. No live payments, no ads.

**Phase 5 — Market, Measure, Decide, Optimize, Support, Kill.** Test ads with `dry_run` on (hooks must deny every write). After I flip `dry_run` off, run one campaign at the smallest budget Meta allows.

**Phase 6 — Ops.**
- Scheduler and weekly digest.
- `docs/RUNBOOK.md`: start/stop, kill switch, re-authenticating MCPs, common failures.
- `docs/SETUP.md`: my one-time checklist.
- A read-only `/ventures` page plus a kill-switch toggle for my Life OS dashboard (Next.js 14), reading the same Supabase tables with a restricted key.

## 11. What to ask me

Only ask me for: items in `docs/SETUP.md`, the numeric limits in `settings`, and the first seed idea (optional). Decide everything else yourself and log it in `docs/decisions.md`.
