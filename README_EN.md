# dsh-biomni

[简体中文](./README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: a **persistent Python interpreter** per session, provisioned with [Biomni](https://github.com/snap-stanford/Biomni)'s biomedical tool library, plus a Settings page that reports honestly what that interpreter can **actually** do.

No fork of the harness, and nothing patches its core. It is an ordinary out-of-tree bundle composed into a profile.

```sh
dsh plugin --profile web add dsh-biomni
```

---

## What it does

One model-facing tool, `run_python`, backed by **a single Python process per session**. Packages imported in one call, dataframes loaded in one call, and models fitted in one call are all still bound in the next. The agent builds up state in small steps instead of resending one large script — the execution model Biomni's agent depends on.

Three things sit around that tool, and none is optional:

| | What | Why it is needed |
|---|---|---|
| System-prompt section | Declares the interpreter and the module inventory | Registering the tool is not enough — measured: the model reaches for bash |
| `bash` guard | Denies shell invocations of `python` / `pip` | The prompt fixes only the FIRST choice; mid-task the model still falls back |
| Environment probe | The `/biomni` command + the Settings page | "module imports" and "function is callable" are two different numbers |

---

## Why a plugin rather than a port

Biomni's kernel is three things, and only the first two are worth reproducing:

| Biomni | What it is | Here |
|---|---|---|
| `run_python_repl` | one interpreter whose namespace persists across the agent's turns | the `run_python` tool |
| `biomni/tool/*.py` | ~200 domain functions across 20 modules, MIT licensed | reused as ordinary libraries inside that interpreter |
| `ToolRetriever` | picks a relevant subset of tools for the prompt, because 200+ schemas do not fit context | **not** reproduced — see below |
| `<execute>` / `<solution>` tags | a text protocol that pre-dates reliable function calling | **not** reproduced — dsh has native tool calling |

**The prompt lists modules, not functions.** All ~183 of them would not fit, and they do not need to: the interpreter is persistent, so the model introspects with `dir()` and `inspect.signature()` for the cost of one call, and that never goes stale. This is a cheaper answer to the problem Biomni solves with a retrieval layer — and the observed loop is exactly guess → introspect → correct.

---

## Install

### 1. Build an interpreter that has Biomni

Biomni's library wants Python 3.11+ and about 1 GB of dependencies. The system python3 on macOS is 3.9 and cannot take it.

```sh
python3.11 -m venv .venv
.venv/bin/pip install -r python/requirements-biomni.txt
```

### 2. Install the plugin

```sh
dsh plugin --profile web add dsh-biomni
```

The CLI reads this package's `dsh.bundle.patch` declaration and appends `dsh-biomni` to `dsh.profile.bundles` — no profile file edits.

From source:

```sh
pnpm install && pnpm build
scripts/install.sh web /abs/path/to/.venv/bin/python
```

### 3. Point it at that interpreter

Start `dsh --profile web`, open **Settings → Biomni**, and set the Python interpreter to `/abs/path/to/.venv/bin/python`. The change applies without a restart: running interpreters are retired, and the next call starts with an empty namespace.

Equivalently, in `$DSH_HOME/settings.yaml`:

```yaml
biomni:
  python: /abs/path/to/.venv/bin/python
  timeoutMs: 600000
  guardShellPython: true
```

---

## The Settings page, and why it works

**This is the most important advance over the earlier exploration.**

On dsh 0.1.0-rc.6, `packages/host/apiproxy` filters `settings.describe` through a hardcoded allowlist:

```ts
const WEB_SETTINGS_NAMESPACES = ['agent-loop', 'shell', 'locale',
  'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek']
```

commented "a future registration does not become remotely readable or writable by default". There is no config field and no extension point — a third-party namespace resolves `status: 'unavailable'`. Any settings card **built on that RPC** can neither read nor write, and must render nothing. That is exactly how the earlier settings card died.

The way around it is not to patch the allowlist. It is to **not use that RPC**:

- the **host half** owns the namespace through `ctx.settings.register(ns, PrefsSchema)` **in-process** (where no allowlist applies), then serves it over the plugin's own `/biomni/api` routes, whose handlers call `settings.describe()` / `settings.update()` directly;
- the **client half** registers a whole **settings SECTION** through `ctx.slots.inject('settings.section', …)` and reads/writes through those routes.

Writes keep the seam's revision guard, so a concurrent write is still refused (409) rather than clobbered. The routes carry the same Host-header trust fence as the `/api` gateway (loopback or a configured `trustedHosts` authority), which same-origin browser access passes naturally.

The mechanism was learned from [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar). This plugin does **not** depend on it — it just follows the same route.

> Related: `webServer` / `webRuntime` are deliberately **absent** from the plugin's top-level `inject`. They carry the Settings page only, and a headless profile has neither; listing them would keep the whole plugin from activating there, taking `run_python` down with a UI nobody asked for. The routes mount from a child fiber, so both deployments work.

---

## The environment probe: importable ≠ callable

Biomni declares three dependencies — pydantic, langchain, python-dotenv. Everything its tools actually need is undeclared, and it hides behind **two independent gates**:

| gate | mechanism | cost | result |
|---|---|---:|---|
| 1 | module-level imports | ~276 MB | 18 of 21 modules importable |
| 2 | lazy imports inside function bodies | +796 MB | functions blocked: 90 → 26 (of 312) |

**Gate 1 is all-or-nothing per module.** Heavy imports sit at the top of most tool modules, so a module either imports fully or not at all — there is no installing "just what one function needs". `genetics`, `genomics`, and `bioimaging` stay out; their dependencies (torch, esm, SimpleITK, nnunet) are genuinely large.

Worse, `biomni.tool.__init__` imports `biomni.utils`, so **`tqdm` and `pandas` gate every module at once**. Without them all 21 fail identically, and the error names neither.

**Gate 2 is the one that will surprise you.** A module that imports cleanly can still have functions that raise `ModuleNotFoundError` when called, because they import lazily in the body. No module-level analysis finds these. It is not a long tail either — `scipy` alone gates 43 functions, `scikit-image` 18, `opencv` 10.

This was found the way it usually is: an agent ran `literature.query_pubmed`, which needs `pymed`, got nothing, and **quietly hand-rolled its own PubMed client instead**. **Importable is not callable**, and an agent that works around a missing dependency produces an answer that looks fine and did not come from the validated tool. The prompt now tells the model to report the missing package rather than substitute for it.

So the Settings page shows importable and callable as **two separate numbers**, lists what blocks each, and hands over the `pip install` line that would buy back the most functions. `/biomni` prints the same report on the command line.

### Some tools call their own LLM

`query_uniprot` and a few others translate a natural-language prompt into a query by calling a model *inside the tool*, defaulting to Anthropic and failing with a missing-package error until configured. This is narrow — 4 call sites across `database.py` and `genomics.py`, out of 183 functions — but it matters architecturally: those calls bypass `ctx.llm`, so they get no telemetry, no cost accounting, and no provider swap from dsh's side.

Biomni's `get_llm` accepts a `Custom` source with `base_url` and `api_key`, and the call sites read `default_config`, so pointing them at DeepSeek's OpenAI-compatible endpoint is the likely fix. Unresolved for now; the other 179 functions are pure API and compute wrappers and are unaffected.

---

## Making the model actually use it

This was **measured**, not assumed.

With `run_python` advertised alongside 25 other tools, the agent reached for `bash` and ran `python3 -c ...` — the *system* interpreter, which has none of the library. Sharpening the tool description to say so explicitly did not change the outcome: the description reached the model, and the model still chose `bash`.

Two mechanisms fixed it, in this order:

1. **A system-prompt section** (`ctx.systemPrompt`, order 120) declaring the interpreter and the module inventory. This fixed the *initial* choice.
2. **A `ctx.tools.guard`** denying `bash` commands that invoke `python`/`pip`, with a reason that names the alternative. Needed because guidance fixed the first choice but not the *fallback*: mid-task the agent still tried `bash python3 -c`, then `source .venv/bin/activate && python3 -c`. A denial corrects it inside the loop, where a prompt cannot.

The guard is anchored to command positions, so `grep python notes.txt` and `--with-python=/usr/bin/python3` pass through; both directions are pinned by tests.

After both, the same research task ran as 3 `run_python` calls and nothing else.

---

## Confinement

The worker's argv is wrapped by `ctx.sandbox` under the policy from `ctx.sandboxPolicy`, so it inherits the deployment's file-effect confinement (Seatbelt on macOS, bwrap/Landlock on Linux). Verified under dsh's real `workspace-write` profile: workspace and temp writes succeed, writes outside are denied and surface to the model as a normal `PermissionError`.

Two honest limits:

- **The sandbox vocabulary covers file effects only.** It expresses no network policy — dsh's own README says so. Biomni-style tools call external APIs freely, and confinement does not constrain that.
- **Policy is resolved when the worker starts**, not per call. A worker already running keeps the confinement it was born with; a mode change takes effect after a reset.

---

## Configuration

| Key | Layer | Default | Meaning |
|---|---|---|---|
| `python` | user settings | `python3` | Interpreter for each session worker. Changing it retires running interpreters. |
| `timeoutMs` | user settings | `600000` | Wall-clock limit for one snippet; a timeout resets the interpreter. |
| `guardShellPython` | user settings | `true` | Deny bash commands that invoke python or pip. |
| `description` | composition row | see `src/prompt.ts` | Model-facing tool description. |
| `guidance` | composition row | see `src/prompt.ts` | Prompt section describing the interpreter and its library; empty disables it. |

The first three are **user settings** (the Settings page / `settings.yaml`), resolved per access so an edit applies at once. The last two are **composition config** (`cordis.patch.yml`), deliberately not user settings: their text rides the request prefix, and editing it mid-session would cost the KV cache.

---

## Development

```sh
pnpm install
pnpm build          # tsc for types + tsdown for lib
pnpm typecheck
pnpm test           # no biomni needed
DSH_BIOMNI_PYTHON=/abs/path/.venv/bin/python pnpm run test:biomni
```

The biomni lane skips rather than fails when the interpreter has no biomni, so the default test run works on a bare interpreter.

### Two install channels

The same `src/client/index.tsx` compiles into two bundles; only the registered id and the file name differ, so they cannot drift:

| Artifact | Channel | Registered id |
|---|---|---|
| `lib/client.js` | profile bundle | `dsh-biomni` (the package name — client-modules compose on it) |
| `lib/client-registry.js` | plugin registry (`dsh.plugin.json`) | `dsh-external/dsh-biomni` (the manifest id — the registry's `arrive()` requires bundle id === plugin id) |

The failure mode here is **silent**: a bundle whose id does not match its channel simply never activates, with no error anywhere. `tests/bundle.spec.ts` is what pins it.

### Build-time purity gate

The client bundle may not value-import non-allowlisted `@deepseek-ai/*` packages (the `dsh-client-bundle-purity` plugin in `tsdown.config.ts`), nor any Node builtin. `import type {}` is erased and never reaches the gate — types can be shared freely, runtime symbols cannot.

---

## Status

The execution kernel, the Settings page, and the environment probe work and are covered by tests. Next up is polish on the domain tool library, and the argument for whether a retrieval layer is worth building.

## License

MIT
