/**
 * The shell-python guard.
 *
 * Registering the tool is not enough, and this was measured rather than
 * assumed. With `run_python` advertised alongside 25 other tools, the agent
 * reached for `bash` and ran `python3 -c ...` — the SYSTEM interpreter, which
 * has none of the library. Sharpening the tool description did not change the
 * outcome: the description reached the model, and the model still chose bash.
 *
 * A system-prompt section (see prompt.ts) fixed the INITIAL choice. It did not
 * fix the FALLBACK: mid-task the agent still tried `bash python3 -c`, then
 * `source .venv/bin/activate && python3 -c`. A denial corrects it inside the
 * loop, where a prompt cannot.
 *
 * ## What this guard is actually for
 *
 * The invariant worth defending is **not** "no Python in the shell". It is
 * "no Python in the WRONG interpreter". Those come apart, and the difference
 * decides how this file is written.
 *
 * A pattern-matched denial can never be complete: `uv run`, `conda run`,
 * `poetry run`, a shell script, a Makefile — every release adds another way to
 * start an interpreter, and a guard whose correctness depends on enumerating
 * them all is a guard that quietly stops working. So the rule here is:
 *
 *   - a command that would reach a DIFFERENT interpreter is denied, and the
 *     denial names the one to use instead;
 *   - a command that names THIS session's configured interpreter by absolute
 *     path is allowed through. It reaches the right library and the right
 *     Python; all it loses is the persistent namespace, which is a degraded
 *     result rather than a wrong one.
 *
 * That escape hatch is what keeps a missed pattern from being a correctness
 * failure. It exists only when the interpreter is configured as an absolute
 * path: with the default bare `python3`, the "configured interpreter" IS the
 * system one the guard exists to keep the model away from, so nothing is
 * allowed.
 *
 * `pip` is never allowed by that hatch, at any path. Installing into the
 * session's venv mid-task is precisely what the denial asks the model to route
 * to the operator instead.
 *
 * The remaining gap is stated plainly because it cannot be closed from here:
 * a bash tool whose PATH put the configured venv first would make even an
 * unmatched `python3` reach the right interpreter, which would retire this
 * guard's correctness role entirely. DSH exposes no seam for a plugin to set
 * the bash tool's environment, and this plugin does not patch the harness, so
 * the escape hatch above is as close as it gets.
 */
import type { ToolGuard } from '@deepseek-ai/dsh-tools'

/**
 * Commands that run another command, so what follows them is a command
 * position too. `conda run -n env python -c ...` reaches the wrong interpreter
 * just as surely as a bare `python3`, and the head-of-segment test alone never
 * sees it.
 *
 * Flags are not parsed. Once one of these appears in a segment, any later
 * interpreter token in that same segment counts as an invocation — the flags
 * of these wrappers vary too much to model, and a wrapper appearing in prose
 * is rare enough that the looser test costs nothing.
 */
const WRAPPERS = new Set([
  'command', 'conda', 'env', 'exec', 'hatch', 'mamba', 'micromamba', 'nice',
  'nohup', 'pdm', 'pipenv', 'pipx', 'poetry', 'rye', 'stdbuf', 'sudo', 'time',
  'timeout', 'uv', 'uvx', 'xargs',
])

/**
 * An interpreter or installer name: `python`, `python3.11`, `pip3`, `pip3.11`.
 * The optional `@version` suffix covers the form the `uv`/`uvx` family accepts
 * (`uvx python@3.11`), which names an interpreter this session does not own.
 */
const INTERPRETER = /^(python|pip)[0-9.]*(@[\w.+-]+)?$/

/** A `NAME=value` prefix, which precedes the real command rather than being one. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/

/**
 * Shell metacharacters that end one command and begin another. Splitting on
 * these is what makes `grep python notes.txt` safe while
 * `cd x && .venv/bin/activate && python3 -c ...` is not: only a token in
 * command position is considered.
 */
const SEPARATORS = /[\n;&|()`]+/

/** The final path component, so `/usr/bin/python3` is recognized as `python3`. */
function basename(token: string): string {
  const cut = token.lastIndexOf('/')
  return cut < 0 ? token : token.slice(cut + 1)
}

/** Whether a token names a Python interpreter or pip, at any path. */
function isInterpreter(token: string): boolean {
  return INTERPRETER.test(basename(token))
}

/** Whether a token names pip specifically, which no path makes acceptable. */
function isPip(token: string): boolean {
  return basename(token).startsWith('pip')
}

/**
 * Every interpreter invocation in one command, as the tokens that name them.
 *
 * A token counts when it is the head of a command segment (after stripping
 * environment assignments), or when it follows a wrapper in the same segment.
 */
export function interpreterInvocations(command: string): string[] {
  const found: string[] = []

  for (const segment of command.split(SEPARATORS)) {
    const tokens = segment.trim().split(/\s+/).filter(token => token !== '')
    let head = true
    let afterWrapper = false

    for (const token of tokens) {
      if (head && ASSIGNMENT.test(token)) continue
      if (WRAPPERS.has(basename(token))) {
        afterWrapper = true
        head = false
        continue
      }
      if ((head || afterWrapper) && isInterpreter(token)) {
        found.push(token)
        // Keep scanning: `python -m pip install` should report both positions
        // no more than once, but `uv run python x && pip install y` splits into
        // separate segments and each is reported on its own.
        head = false
        continue
      }
      // A non-wrapper, non-interpreter token ends the head position. Anything
      // later in the segment is an argument, not a command — unless a wrapper
      // already opened the segment up.
      head = false
    }
  }

  return found
}

/**
 * Whether an invocation is the session's own interpreter, named by absolute
 * path — the one bypass that reaches the right library.
 *
 * Requires the CONFIGURED interpreter to be absolute: a bare `python3` names
 * the system interpreter, which is the thing being guarded against, so it can
 * never authorize itself.
 */
export function isConfiguredInterpreter(token: string, python: string): boolean {
  if (!python.startsWith('/')) return false
  if (isPip(token)) return false
  return token === python
}

/** The denial reason, which must name the alternative to be actionable. */
export function denialFor(python: string): string {
  const parts = [
    'Denied: this session\'s Python lives behind the run_python tool, not the shell.',
    'The shell reaches a different interpreter that does not have the biomedical',
    'libraries installed and cannot see state from earlier calls, so this would',
    'have failed or silently used the wrong environment.',
    'Call run_python with the code instead.',
  ]
  if (python.startsWith('/')) {
    // Naming the path makes a retry in bash correct rather than merely denied.
    // It costs the persistent namespace, which is why run_python comes first.
    parts.push(
      `If you genuinely need a separate process, ${python} is this session's interpreter`,
      'and reaches the same libraries — but it starts empty and keeps nothing.',
    )
  }
  parts.push(
    'To install a package, ask the operator — the interpreter is provisioned',
    'outside the session.',
  )
  return parts.join(' ')
}

/**
 * The legacy single-pattern test, kept exported because it documents the shape
 * this guard used to have and is still the fastest way to ask "does this
 * command mention an interpreter in command position at all".
 */
export const SHELL_PYTHON = /(?:^|[\n;&|(]|&&|\|\|)[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*(?:sudo[ \t]+)?(python[0-9.]*|pip[0-9.]*)\b/

/**
 * Build the guard. Registered unconditionally and gated INSIDE, so the
 * `guardShellPython` setting can be toggled without re-registering.
 * @param enabled - reads the live setting on every call.
 * @param python - reads the live interpreter setting on every call, so the
 *   allowed bypass tracks a changed setting without re-registering either.
 */
export function shellPythonGuard(enabled: () => boolean, python: () => string): ToolGuard {
  return (execution) => {
    if (!enabled() || execution.name !== 'bash') return undefined
    const command = (execution.arguments as { command?: unknown } | null)?.command
    if (typeof command !== 'string') return undefined

    const invocations = interpreterInvocations(command)
    if (invocations.length === 0) return undefined

    // Allowed only when EVERY invocation is the configured interpreter: one
    // wrong interpreter in a chain is enough to produce a wrong result.
    const configured = python()
    if (invocations.every(token => isConfiguredInterpreter(token, configured))) return undefined

    return denialFor(configured)
  }
}
