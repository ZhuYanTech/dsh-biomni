/**
 * The shell-python guard's boundaries. Both directions are pinned: the guard
 * must catch interpreter INVOCATIONS without swallowing commands that merely
 * mention Python, because a guard that over-denies is worse than no guard —
 * the model cannot route around it and cannot tell why.
 *
 * The third direction is newer and matters as much: an invocation of THIS
 * session's own interpreter, by absolute path, is allowed. That is what keeps
 * a pattern this guard has not learned yet from being a correctness failure
 * rather than a degraded one.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { interpreterInvocations, shellPythonGuard } from '../src/guard.ts'

const VENV = '/opt/bio/.venv/bin/python'

const guard = shellPythonGuard(() => true, () => 'python3')
const denies = (command: string): boolean =>
  typeof guard({ name: 'bash', arguments: { command } } as unknown as ToolExecution) === 'string'

/** A guard configured with an absolute interpreter, which enables the bypass. */
const configured = shellPythonGuard(() => true, () => VENV)
const deniesConfigured = (command: string): boolean =>
  typeof configured({ name: 'bash', arguments: { command } } as unknown as ToolExecution) === 'string'

describe('shell python guard', () => {
  it.each([
    'python3 -c "print(1)"',
    'python -m pip install x',
    'pip install pandas',
    'cd /tmp && python3 script.py',
    'source .venv/bin/activate && python3 -c "import biomni"',
    'FOO=1 python3 x.py',
    'ls; python3 -c "1"',
    'sudo pip3 install x',
    'true || python3 x.py',
    '(python3 x.py)',
  ])('denies %s', (command) => {
    expect(denies(command)).toBe(true)
  })

  // The wrapper forms. Every one of these reaches an interpreter that is not
  // this session's, and every one slipped past the original head-anchored
  // pattern — which is why the guard now treats what follows a wrapper as a
  // command position too.
  it.each([
    'uv run python -c "1"',
    'uvx python@3.11 -c "1"',
    'conda run -n bio python -c "1"',
    'micromamba run -n bio python3 x.py',
    'poetry run python x.py',
    'pipenv run python x.py',
    'pdm run python x.py',
    'hatch run python x.py',
    'rye run python x.py',
    'pipx run python x.py',
    'nohup python3 x.py',
    'timeout 30 python3 x.py',
    'nice -n 10 python3 x.py',
    'xargs python3 < list.txt',
    'env PYTHONPATH=. python3 x.py',
    'echo hi | python3',
  ])('denies the wrapped form %s', (command) => {
    expect(denies(command)).toBe(true)
  })

  it.each([
    'grep -rn python notes.txt',
    'ls python_scripts/',
    'echo "use python"',
    './configure --with-python=/usr/bin/python3',
    'cat requirements.txt',
    'git commit -m "python cleanup"',
    'rg pip package.json',
    // The CLI tools Biomni's software library advertises run through bash and
    // must stay untouched: the guard is about interpreters, not about the shell.
    'samtools view -b in.sam > out.bam',
    'bwa mem ref.fa reads.fq | samtools sort -o out.bam',
    'Rscript -e "library(DESeq2)"',
  ])('allows %s', (command) => {
    expect(denies(command)).toBe(false)
  })

  describe('the configured-interpreter bypass', () => {
    it('allows this session\'s own interpreter by absolute path', () => {
      // It reaches the right library and the right Python. All it loses is the
      // persistent namespace, which is a degraded result, not a wrong one.
      expect(deniesConfigured(`${VENV} -c "import biomni"`)).toBe(false)
      expect(deniesConfigured(`cd /tmp && ${VENV} script.py`)).toBe(false)
    })

    it('still denies any OTHER interpreter', () => {
      expect(deniesConfigured('python3 -c "1"')).toBe(true)
      expect(deniesConfigured('/usr/bin/python3 -c "1"')).toBe(true)
      expect(deniesConfigured('uv run python -c "1"')).toBe(true)
    })

    it('denies a chain mixing the right interpreter with a wrong one', () => {
      // One wrong interpreter in a chain is enough to produce a wrong result,
      // so the allowance requires EVERY invocation to be the configured one.
      expect(deniesConfigured(`${VENV} a.py && python3 b.py`)).toBe(true)
    })

    it('never allows pip, at any path', () => {
      // Installing into the session's venv mid-task is exactly what the denial
      // asks the model to route to the operator instead.
      expect(deniesConfigured('/opt/bio/.venv/bin/pip install x')).toBe(true)
    })

    it('does not open up when the interpreter is a bare name', () => {
      // With the default `python3`, the "configured interpreter" IS the system
      // one the guard exists to keep the model away from.
      expect(denies('python3 -c "1"')).toBe(true)
    })
  })

  it('names the alternative in its denial', () => {
    const reason = guard({ name: 'bash', arguments: { command: 'python3 -c "1"' } } as unknown as ToolExecution)
    expect(reason).toMatch(/run_python/)
  })

  it('names the interpreter path when there is one to name', () => {
    // A denial that names the path makes a retry in bash correct rather than
    // merely blocked.
    const reason = configured({ name: 'bash', arguments: { command: 'python3 -c "1"' } } as unknown as ToolExecution)
    expect(reason).toContain(VENV)
  })

  it('leaves other tools alone', () => {
    expect(guard({ name: 'read', arguments: { path: '/x/python3' } } as unknown as ToolExecution))
      .toBeUndefined()
  })

  it('ignores a non-string command', () => {
    expect(guard({ name: 'bash', arguments: { command: 42 } } as unknown as ToolExecution))
      .toBeUndefined()
    expect(guard({ name: 'bash', arguments: null } as unknown as ToolExecution))
      .toBeUndefined()
  })

  it('reads the setting live, so toggling it needs no re-registration', () => {
    let enabled = false
    const toggled = shellPythonGuard(() => enabled, () => 'python3')
    const call = { name: 'bash', arguments: { command: 'python3 -c "1"' } } as unknown as ToolExecution
    expect(toggled(call)).toBeUndefined()
    enabled = true
    expect(typeof toggled(call)).toBe('string')
  })

  it('reads the interpreter live too', () => {
    let python = 'python3'
    const live = shellPythonGuard(() => true, () => python)
    const call = { name: 'bash', arguments: { command: `${VENV} x.py` } } as unknown as ToolExecution
    expect(typeof live(call)).toBe('string')
    python = VENV
    expect(live(call)).toBeUndefined()
  })
})

describe('interpreterInvocations', () => {
  it('reports each invocation in a chain', () => {
    expect(interpreterInvocations('python3 a.py && pip install b')).toEqual(['python3', 'pip'])
  })

  it('reports nothing for a command that only mentions python', () => {
    expect(interpreterInvocations('grep python notes.txt')).toEqual([])
  })

  it('keeps the token as written, so a path can be compared', () => {
    expect(interpreterInvocations('/opt/v/bin/python -c 1')).toEqual(['/opt/v/bin/python'])
  })
})
