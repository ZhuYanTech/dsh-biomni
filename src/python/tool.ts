/**
 * The model-facing `run_python` tool, backed by one owner-scoped persistent
 * Python worker.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renderFrame } from './channel.ts'
import type { Retirement, WorkerOwner, WorkerPool } from './workers.ts'

/** What the model is told when its interpreter had to be replaced. */
export const RESET_NOTICE
  = 'The persistent Python interpreter was reset; the next call starts with an empty namespace.'

/**
 * What the model is told about an interpreter that went away between calls.
 *
 * It has to be told. The alternative is a namespace that silently emptied
 * itself, and a model that reasons on from a dataframe it loaded an hour ago
 * and no longer has — the same class of failure as an unadvertised missing
 * dependency, arrived at from the other direction. The notice therefore says
 * what happened, why, and what to do about it, and leads the output rather
 * than trailing it.
 */
export function retirementNotice(retirement: Retirement): string {
  const minutes = Math.max(1, Math.round(retirement.idleMs / 60_000))
  const why = retirement.reason === 'idle'
    ? `this session's Python interpreter was idle for about ${minutes} minute${minutes === 1 ? '' : 's'} and was retired to free memory`
    : 'the configured Python interpreter changed, so this session\'s previous one was retired'
  return `Note: ${why}. This call ran in a NEW interpreter with an empty namespace — imports, dataframes, and fitted models from earlier calls are gone. Re-run whatever setup you still need before relying on it.`
}

/** The live settings slice the tool reads on every call. */
export interface RunPythonSettings {
  readonly timeoutMs: number
}

/**
 * Serialize operations per owner. One interpreter cannot run two snippets at
 * once, so calls for the same agent queue rather than interleave.
 *
 * Both settlements chain (`then(op, op)`): a failed call must not strand the
 * queue behind a rejected promise.
 */
export function createSerializer(): <T>(owner: object, operation: () => Promise<T>) => Promise<T> {
  const queues = new WeakMap<object, Promise<unknown>>()
  return async <T>(owner: object, operation: () => Promise<T>): Promise<T> => {
    const prior = queues.get(owner) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(owner, tail)
    try {
      return await run
    } finally {
      if (queues.get(owner) === tail) queues.delete(owner)
    }
  }
}

/**
 * Build the `run_python` tool definition.
 * @param workers - the owner-scoped interpreter pool.
 * @param settings - live settings (read per call, so an edit applies at once).
 * @param description - the model-facing description from the composition row.
 */
export function runPythonTool(
  workers: WorkerPool,
  settings: RunPythonSettings,
  description: string,
): ToolDefinition {
  const serialized = createSerializer()

  return defineTool({
    name: 'run_python',
    description,
    parameters: {
      code: { type: 'string', required: true, description: 'Python source to execute.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (args.code.trim().length === 0) throw new Error('code must be a non-empty string')
      const owner = exec.agent as WorkerOwner | undefined
      if (owner === undefined) throw new Error('run_python requires an owning agent session')

      return serialized(owner, async () => {
        exec.signal.throwIfAborted()
        const timeoutMs = settings.timeoutMs
        const timeout = AbortSignal.timeout(timeoutMs)
        const signal = AbortSignal.any([exec.signal, timeout])
        const worker = await workers.get(owner)
        const notice = worker.retiredBecause === undefined
          ? ''
          : `${retirementNotice(worker.retiredBecause)}\n\n`
        try {
          const frame = renderFrame(await worker.channel.request(args.code, signal))
          return `${notice}${frame}`
        } catch (cause) {
          // The interpreter's state is unknowable after a timeout or a crash,
          // so it is replaced rather than handed back in an unclear condition.
          await workers.reset(owner)
          const reason = timeout.aborted
            ? `execution exceeded ${timeoutMs}ms`
            : String((cause as Error | undefined)?.message ?? cause)
          return `${notice}${reason}\n${RESET_NOTICE}`
        } finally {
          // The idle clock runs from the END of a call: armed only at the
          // start, a snippet that takes longer than the timeout would retire
          // the interpreter it is still running in.
          workers.touch(owner)
        }
      })
    },
  })
}
