# Verification Gate (Layer 2)

Turns "the producer says it finished" into "the producer's output was objectively accepted" — producer ≠ grader; grader tier ≥ producer tier; one shared gate code path serves both wirings (GA-5).

## Definition of Done

A DoD is an `[acceptance] ... [/acceptance]` block (alias `[dod] ... [/dod]`). **Both** the open and close tags are required (strict); a block missing either tag is silently ignored.

### Directives

```
[acceptance]
check: <kind> [key=value | key="quoted value"]   # repeatable
criteria: <free text>                              # repeatable; non-empty
deliverable: <path or description>                 # last one wins
kind: <enum>                                       # parsed; always re-derived — see Normalization
[/acceptance]
```

### Check kinds

| kind | required keys | optional keys |
|---|---|---|
| `run` | `command` | `expect` (substring in stdout/stderr; exit 0 also required) |
| `fileExists` | `path` | — |
| `schemaMatch` | `path` (JSON file to check), `schema` (inline `{…}` or path to JSON file) | — |
| `testsPass` | — | `command` (default `npm test`) |
| `buildPasses` | — | `command` (default `npm run build`) |
| `lintClean` | — | `command` (default `npm run lint`) |

`run` commands must be on the allowlist (`npm` / `npx` / `pnpm` / `yarn` / `bun` / `node` / `tsc` / `tsx` / `vitest` / `jest` / `eslint` / `prettier`) and must not contain shell metacharacters. Per-check timeout applies to all `run` calls.

### Normalization

The `kind` directive is always **re-derived** from the block's contents — the literal `kind:` value is parsed but ignored:

| condition | derived kind |
|---|---|
| has any `check:` directive | `deterministic` |
| has `criteria:` only | `checker` |
| neither | `none` |

This makes a vacuous always-pass deterministic DoD structurally impossible and prevents a SKIP from being smuggled in via an empty block.

## DoD Sourcing

### Mode A — on-the-fly (dispatch)

Parse the `[acceptance]` block from the dispatch text. If none is present, **auto-infer** one (`inferDoD`):

- Categorises the task: `bugfix` / `refactor` / `writeFile` / `impl` / `test` / `unknown`.
- Adds command-backed checks only when a command hint is available; otherwise falls back to a `checker` DoD whose criterion summarises the dispatch.
- Inference is never vacuous; source is recorded as `inferred`.

`verify.requireExplicitDoD: true` disables inference and demands an explicit block instead.

### Mode B — plan annotation

The plan's own `[acceptance]` block is the DoD (source `annotation`). A non-trivial plan task with no acceptance block is a strict plan-authoring error.

### Proportional skip (GA-6)

A **trivial** dispatch carrying only an **auto-inferred** DoD is skipped. An **explicit** or **annotation** block is always verified regardless of how the dispatch is classified.

### No-files-changed skip

A native `Task()` dispatch is also skipped when all three hold: the DoD is **inferred**, its kind is **checker** (no deterministic checks to run), and the delegation **changed no files**. Inference always synthesizes a criterion from the task's first line, so without this rule a research delegation gets graded against an imperative it was never meant to satisfy, and legitimate findings come back with a false "not accepted" note.

**Know the trade.** This is a property of the delegation, not of its intent, and the two are indistinguishable under an inferred DoD. An *implementation* delegation that reports success but writes no files is skipped by the same rule, so the grader no longer gets a chance to flag "claims the work is done but changed nothing". If you want that case verified, give the dispatch an explicit `[acceptance]` block: explicit and annotation DoDs are always verified, and a `check:` directive makes the DoD deterministic rather than checker-only, so neither condition above is met.

## Artefact

The gate verifies the artefact attributed to the producer session:

```
{
  changedFiles:      // files written/edited by the producer — not a global git diff
  finalReturnText:   // the producer's final return text
  declaredOutputs:   // outputs the producer explicitly declared
}
```

## Verdict

```ts
{
  pass:      boolean
  method:    "deterministic" | "checker" | "none"
  reasons:   string[]
  evidence?: string
  skipped?:  boolean
}
```

**Fail-closed.** Any error, timeout, unparseable grader reply, or non-independent grader yields `pass: false` with a reason. A skipped verdict is never a pass.

## Deterministic Verifier

Runs checks via an injected exec/fs seam. Key invariants:

- Command allowlist enforced; shell metacharacters rejected; per-check timeout applied.
- Whole-repo checks (`testsPass`, `buildPasses`, `lintClean`) run under a per-workspace mutex — concurrent verifications on the same repo cannot race.
- Empty checks array → SKIPPED (never PASS).

## Checker (Independent Grader) Verifier

Builds a skeptical grading prompt from the DoD criteria + assembled artefact and dispatches to a **fresh** grader session:

- Structural producer ≠ grader guarantee, plus a defensive sessionID-inequality check.
- Grader tier = `atLeastProducerTier(producer)`, raised to `verify.minGraderTier`, never below the producer.
- Grader temperature pinned via a `chat.params` hook (default `0`).
- Prompt is anti-rubber-stamp: cite evidence per criterion, default to FAIL on any uncertainty, no benefit of the doubt.
- Grader must return strict one-line JSON `{"pass":boolean,"reasons":[...]}` — unparseable response → FAIL.
- All artefact text, file paths, declared outputs, and grader reasons are scrubbed before reaching or leaving the grader.

## Two Wirings, One Gate (GA-5)

### (i) verify-dispatch — advisory

Observes the built-in `task` tool's after-hook (`<task_result>` text + child session's changed files), runs the gate, and appends a scrubbed forcing note when not accepted. Cannot retry a `task` call that already finished.

### (ii) `delegate` tool — authoritative

The plugin-owned `delegate` tool produces via the OpenCode client, runs the gate, and on FAIL hands off to the Layer-3 escalation ladder. Returns only an accepted result or an honest `status: unmet`. Never returns a fake pass.

## `verify` config keys

| key | default | notes |
|---|---|---|
| `require` | `"whenDoDPresent"` | `"never"` disables the gate entirely; `"always"` auto-infers when no block is present |
| `preferDeterministic` | `true` | — |
| `graderPolicy` | `"atLeastProducerTier"` | — |
| `minGraderTier` | — | Floor on grader tier regardless of producer |
| `graderTemperature` | `0` | — |
| `requireExplicitDoD` | `false` | Mode A: `true` = demand explicit block, no inference |

Full schema: see `docs/CONFIG_REFERENCE.md`.

## Examples

### Deterministic (derived kind: `deterministic`)

```
[acceptance]
deliverable: src/parser.ts
check: fileExists path=src/parser.ts
check: buildPasses
check: testsPass command="npm test -- --testPathPattern=parser"
check: run command="node -e \"require('./src/parser')\"" expect="loaded"
[/acceptance]
```

### Checker (derived kind: `checker`)

```
[acceptance]
deliverable: docs/ARCHITECTURE.md
criteria: Document covers data flow from ingestion to storage with a sequence diagram.
criteria: Every public API surface is listed with request/response shape.
criteria: No section is a copy-paste of the dispatch prompt.
[/acceptance]
```

### Mixed — checks win (derived kind: `deterministic`)

```
[dod]
deliverable: src/auth/token.ts
check: fileExists path=src/auth/token.ts
check: lintClean
check: testsPass
criteria: Token expiry is configurable and defaults to 15 minutes per spec.
[/dod]
```

> Because checks are present the block is `deterministic`; the `criteria:` line does not trigger a grader pass. Add a separate `[acceptance]` block with criteria only if an independent grader review is also required.

### Explicit block on a trivially classified dispatch

```
[acceptance]
deliverable: scripts/migrate.ts
check: fileExists path=scripts/migrate.ts
check: run command="npx tsx scripts/migrate.ts --dry-run" expect="0 rows affected"
[/acceptance]
```

> Even if the dispatch would be classified trivial by GA-6, an explicit block is always verified.

## See also

- `docs/CONFIG_REFERENCE.md` — full schema for the `verify` block and all enforcement keys.
- `docs/ESCALATION.md` — Layer 3: what happens after the gate returns `pass: false`.
