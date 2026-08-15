/**
 * The model-facing `run_python` tool, backed by one owner-scoped persistent
 * Python worker.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renderFrame } from './channel.ts'
import type { WorkerOwner, WorkerPool } from './workers.ts'

/** What the model is told when its interpreter had to be replaced. */
export const RESET_NOTICE
  = 'The persistent Python interpreter was reset; the next call starts with an empty namespace.'

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
        try {
          return renderFrame(await worker.channel.request(args.code, signal))
        } catch (cause) {
          // The interpreter's state is unknowable after a timeout or a crash,
          // so it is replaced rather than handed back in an unclear condition.
          await workers.reset(owner)
          const reason = timeout.aborted
            ? `execution exceeded ${timeoutMs}ms`
            : String((cause as Error | undefined)?.message ?? cause)
          return `${reason}\n${RESET_NOTICE}`
        }
      })
    },
  })
}
