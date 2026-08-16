/**
 * Per-call framing over the worker's newline-delimited JSON stdio.
 *
 * The worker claims a private `dup` of fd 1 for protocol frames before any user
 * code runs, so no amount of printing from the model's code can corrupt the
 * framing (see python/worker.py). This side therefore treats an unparsable line
 * as a worker bug rather than leaked program output.
 */
import { randomUUID } from 'node:crypto'
import type { SubprocessHandle } from '../context-types.ts'

/** One executed snippet's result, as the worker reports it. */
export interface WorkerFrame {
  id: string
  ok: boolean
  /** Everything the code wrote to stdout and stderr, captured at fd level. */
  output: string
  /** `repr` of the trailing bare expression, when the snippet ends in one. */
  value: string | null
  /** Formatted traceback with the worker's own frames stripped. */
  error: string | null
  /** Whether `output` hit the worker's character cap. */
  truncated: boolean
}

interface Waiter {
  resolve: (frame: WorkerFrame) => void
  reject: (cause: unknown) => void
}

export class WorkerChannel {
  readonly #handle: SubprocessHandle
  readonly #pending = new Map<string, Waiter>()
  #buffer = ''

  constructor(handle: SubprocessHandle) {
    this.#handle = handle
    handle.stdout.setEncoding('utf8')
    handle.stdout.on('data', chunk => { this.#ingest(chunk) })
    // A worker that dies mid-request must reject that request rather than leave
    // the tool awaiting a reply that can never arrive.
    void handle.done.then(
      outcome => { this.#fail(new Error(`python worker exited (code ${outcome.exitCode})`)) },
      (cause: unknown) => { this.#fail(cause) },
    )
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.trim().length > 0) this.#deliver(line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  #deliver(line: string): void {
    let frame: WorkerFrame
    try {
      frame = JSON.parse(line) as WorkerFrame
    } catch {
      // The worker guards fd 1 against user code, so an unparsable line means a
      // worker bug rather than leaked program output. Drop it.
      return
    }
    const waiter = this.#pending.get(frame.id)
    if (waiter === undefined) return
    this.#pending.delete(frame.id)
    waiter.resolve(frame)
  }

  #fail(cause: unknown): void {
    for (const waiter of this.#pending.values()) waiter.reject(cause)
    this.#pending.clear()
  }

  /** Send one snippet and await its frame. */
  request(code: string, signal: AbortSignal): Promise<WorkerFrame> {
    const id = randomUUID()
    return new Promise<WorkerFrame>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason as Error)
        return
      }
      const onAbort = (): void => {
        this.#pending.delete(id)
        reject(signal.reason as Error)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const settled = <T>(settle: (value: T) => void) => (value: T): void => {
        signal.removeEventListener('abort', onAbort)
        settle(value)
      }
      this.#pending.set(id, { resolve: settled(resolve), reject: settled(reject) })
      this.#handle.stdin.write(JSON.stringify({ id, code }) + '\n', (error) => {
        if (error === undefined || error === null) return
        const waiter = this.#pending.get(id)
        if (waiter === undefined) return
        this.#pending.delete(id)
        waiter.reject(error)
      })
    })
  }
}

/** Render one worker frame as the model-facing result string. */
export function renderFrame(frame: WorkerFrame): string {
  const parts: string[] = []
  if (frame.output.length > 0) parts.push(frame.output.replace(/\n$/, ''))
  if (frame.truncated) parts.push('[output clipped]')
  if (frame.value !== null && frame.value !== undefined) parts.push(frame.value)
  if (frame.error !== null && frame.error !== undefined) parts.push(frame.error.replace(/\n$/, ''))
  if (parts.length === 0) return '(no output)'
  return parts.join('\n')
}
