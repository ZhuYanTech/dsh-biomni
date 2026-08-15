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
 */
import type { ToolGuard } from '@deepseek-ai/dsh-tools'

/**
 * A shell command that INVOKES an interpreter, rather than merely mentioning
 * one. Anchored to command positions — start of line, or after a separator — so
 * `grep python notes.txt` and `--with-python=/usr/bin/python3` are left alone,
 * while `cd x && source .venv/bin/activate && python3 -c ...` is caught.
 *
 * The optional `NAME=value` prefix covers env-prefixed invocations
 * (`PYTHONPATH=. python3 x.py`), and `sudo` covers the escalated form.
 */
export const SHELL_PYTHON = /(?:^|[\n;&|(]|&&|\|\|)[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*(?:sudo[ \t]+)?(python[0-9.]*|pip[0-9.]*)\b/

/** The denial reason, which must name the alternative to be actionable. */
export const SHELL_PYTHON_DENIAL = [
  'Denied: this session\'s Python lives behind the run_python tool, not the shell.',
  'The shell reaches a different interpreter that does not have the biomedical',
  'libraries installed and cannot see state from earlier calls, so this would',
  'have failed or silently used the wrong environment.',
  'Call run_python with the code instead. To install a package, ask the operator —',
  'the interpreter is provisioned outside the session.',
].join(' ')

/**
 * Build the guard. Registered unconditionally and gated INSIDE, so the
 * `guardShellPython` setting can be toggled without re-registering.
 * @param enabled - reads the live setting on every call.
 */
export function shellPythonGuard(enabled: () => boolean): ToolGuard {
  return (execution) => {
    if (!enabled() || execution.name !== 'bash') return undefined
    const command = (execution.arguments as { command?: unknown } | null)?.command
    if (typeof command !== 'string' || !SHELL_PYTHON.test(command)) return undefined
    return SHELL_PYTHON_DENIAL
  }
}
