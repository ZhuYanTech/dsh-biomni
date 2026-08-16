/**
 * The shell-python guard's boundaries. Both directions are pinned: the guard
 * must catch interpreter INVOCATIONS without swallowing commands that merely
 * mention Python, because a guard that over-denies is worse than no guard —
 * the model cannot route around it and cannot tell why.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { shellPythonGuard } from '../src/guard.ts'

const guard = shellPythonGuard(() => true)
const denies = (command: string): boolean =>
  typeof guard({ name: 'bash', arguments: { command } } as unknown as ToolExecution) === 'string'

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

  it.each([
    'grep -rn python notes.txt',
    'ls python_scripts/',
    'echo "use python"',
    './configure --with-python=/usr/bin/python3',
    'cat requirements.txt',
    'git commit -m "python cleanup"',
    'rg pip package.json',
  ])('allows %s', (command) => {
    expect(denies(command)).toBe(false)
  })

  it('names the alternative in its denial', () => {
    const reason = guard({ name: 'bash', arguments: { command: 'python3 -c "1"' } } as unknown as ToolExecution)
    expect(reason).toMatch(/run_python/)
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
    const toggled = shellPythonGuard(() => enabled)
    const call = { name: 'bash', arguments: { command: 'python3 -c "1"' } } as unknown as ToolExecution
    expect(toggled(call)).toBeUndefined()
    enabled = true
    expect(typeof toggled(call)).toBe('string')
  })
})
