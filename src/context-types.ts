/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context augmentation both halves share. A third-party plugin resolves
 * outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module 'cordis'` augmentations do not reach this Context — and the
 * npm cordis package does not declare the DSH-vendored runtime members
 * (`ctx.effect`, service properties). The members below mirror the actual
 * runtime shapes this plugin touches. Drift from upstream is contained here.
 *
 * Where DSH publishes the real types (`@deepseek-ai/dsh-tools`), they are used
 * directly rather than mirrored. The mirrors exist only for the host services
 * whose packages are not published: subprocess, sandbox, sandboxPolicy,
 * systemPrompt, commands.
 *
 * This file must stay FREE of Node.js types (`node:http`, `Buffer`): it is part
 * of the CLIENT-reachable declaration graph, so a Node import here would leak
 * into browser-only consumer builds. The webServer faces are therefore
 * structural mirrors (the host casts at the few boundaries that need real Node
 * types).
 */
import type { Context } from 'cordis'
import type { ToolDefinition, ToolGuard } from '@deepseek-ai/dsh-tools'

// ── HTTP (webserver) ────────────────────────────────────────────────────────

/**
 * The request face route handlers see (structural subset of node's
 * IncomingMessage: the URL/method/header reads and the async body iteration
 * `readJsonBody` uses).
 */
export interface BiomniHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/**
 * The response face route handlers write to (structural subset of node's
 * ServerResponse).
 */
export interface BiomniHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface BiomniWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: BiomniHttpRequest, res: BiomniHttpResponse) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface BiomniWebServer {
  register(route: BiomniWebRoute): () => void
}

/**
 * The web runtime service face (mirror of @deepseek-ai/dsh-web-app's
 * WebRuntimeValues): the bind-derived trust list the /api gateway's fence
 * accepts — LAN IP literals sampled when the server binds all interfaces, plus
 * explicit `--trusted-host` authorities.
 */
export interface BiomniWebRuntime {
  trustedHosts: readonly string[]
}

// ── Subprocess and confinement ──────────────────────────────────────────────

/** A collected stream's batch read (`readFrom(0)` returns the whole buffer). */
export interface CollectedStream {
  readFrom(offset: number): { text: string }
}

/** How one spawned process settled. */
export interface SubprocessOutcome {
  exitCode: number
}

/** A live spawned process. */
export interface SubprocessHandle {
  stdin: {
    write(chunk: string, callback: (error?: Error | null) => void): void
  }
  stdout: {
    setEncoding(encoding: string): void
    on(event: 'data', listener: (chunk: string) => void): void
  }
  /** Settles when the process exits; rejects when it could not be started. */
  done: Promise<SubprocessOutcome>
  /** Streams collected under a `{ maxBytes }` stdio policy, readable after settlement. */
  collected: {
    stdout?: CollectedStream
    stderr?: CollectedStream
  }
  /** Request termination (SIGTERM, escalating after `graceMs`). */
  terminate(): void
  waitForExit(): Promise<SubprocessOutcome>
}

/** One stream's disposition in a spawn request. */
export type StdioSpec = 'pipe' | 'ignore' | 'inherit' | { maxBytes: number }

/** A spawn request. */
export interface SpawnOptions {
  argv: string[]
  cwd: string
  stdio: {
    stdin?: StdioSpec
    stdout?: StdioSpec
    stderr?: StdioSpec
  }
  /** How long SIGTERM is given before the escalation, in milliseconds. */
  graceMs?: number
  signal?: AbortSignal
  env?: Record<string, string>
}

/** The subprocess service face. */
export interface BiomniSubprocessService {
  spawn(options: SpawnOptions): SubprocessHandle
}

/**
 * The deployment's file-effect confinement mode. `danger-full-access` means no
 * confinement is applied at all.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The resolved confinement policy. */
export interface SandboxPolicy {
  mode: SandboxMode
  workspaceRoot: string
}

/** The sandbox policy service face. */
export interface BiomniSandboxPolicyService {
  resolve(): SandboxPolicy
}

/**
 * The sandbox service face: wraps an argv in the platform confinement helper
 * (Seatbelt on macOS, bwrap/Landlock on Linux). The vocabulary covers FILE
 * EFFECTS ONLY — it expresses no network policy, which matters here because
 * Biomni-style tools call external APIs freely.
 */
export interface BiomniSandboxService {
  confine(argv: string[], policy: { mode: SandboxMode; workspaceRoot: string }): { argv: string[] }
}

// ── Prompt, commands, tools ─────────────────────────────────────────────────

/** The system prompt service face. */
export interface BiomniSystemPromptService {
  /**
   * Contribute one prompt section. `order` 100–199 is the convention for tool
   * guidance, after the deployment persona.
   */
  section(section: { name: string; order: number; text: string }): () => void
}

/** One slash-command invocation. */
export interface CommandInvocation {
  signal: AbortSignal
}

/** What a slash command hands back to the UI. */
export type CommandResult =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }

/** The slash-command registry face. */
export interface BiomniCommandsService {
  register(command: {
    name: string
    description: string
    /** Whether the invocation text is written into the session log. */
    recordInput?: boolean
    handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult
  }): () => void
}

/** The tools service face (register/guard from the published ToolRuntime). */
export interface BiomniToolsService {
  register(definition: ToolDefinition): () => void
  guard(guard: ToolGuard): () => void
}

/** The settings service face (mirror of @deepseek-ai/dsh-settings' SettingsProvider). */
export interface BiomniSettingsService {
  /**
   * Register one namespace schema (the resolved value layers schema defaults,
   * then the composition base, then the user document).
   */
  register<T>(
    ns: string,
    schema: unknown,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart' },
  ): {
    get(): T
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
    update(patch: object): Promise<void>
    replace(section: object): Promise<void>
  }
  /** Redacted descriptors of every registered namespace (secrets stripped). */
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value?: unknown
    base?: unknown
    user?: unknown
    applies: 'live' | 'restart'
    revision: number
  }>
  /** Service-level merge write with the revision guard (a stale writer is refused). */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

// ── Client-side services ────────────────────────────────────────────────────

/** Registration options passed to `ctx.slots.register` (subset of the real options). */
export interface BiomniSlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  priority?: number
  locale?: string
  registrant?: string
  /** Business-face factory; args depend on the slot scope. */
  inject?: (...args: any[]) => Record<string, unknown>
  children?: Record<string, unknown>
}

/** The client slots service face (register returns the disposer). */
export interface BiomniSlotsService {
  register(options: BiomniSlotRegisterOptions, component: unknown): () => void
  /**
   * Run a callback for each declaration lifetime of a slot (the runtime
   * SlotRegistry.inject): a no-op while the slot is undeclared, so the settings
   * section registration waits for the settings shell to declare it.
   */
  inject(key: string, callback: () => () => void): () => void
}

/**
 * The client locale service face (mirror of @deepseek-ai/dsh-client-locale's
 * LocaleRuntime). The active locale is the Host-backed preference
 * (`locale.preference` in settings.yaml), not the raw browser language.
 */
export interface BiomniLocaleService {
  /** Current immutable locale snapshot (uSES-safe; `active` is 'zh' | 'en' today). */
  getSnapshot(): { active: string }
  /** Subscribe to snapshot changes (locale switch or dictionary registration). */
  subscribe(fn: () => void): () => void
  /** Register one locale's dictionary for a namespace; returns the disposer. */
  register(ns: string, locale: string, dict: Record<string, string>): () => void
}

declare module 'cordis' {
  interface Context {
    webServer: BiomniWebServer
    webRuntime: BiomniWebRuntime
    subprocess: BiomniSubprocessService
    sandbox: BiomniSandboxService
    sandboxPolicy: BiomniSandboxPolicyService
    systemPrompt: BiomniSystemPromptService
    commands: BiomniCommandsService
    tools: BiomniToolsService
    settings: BiomniSettingsService
    /** Client side only. */
    slots: BiomniSlotsService
    /** Client side only. */
    locale: BiomniLocaleService
    /**
     * Register a lifecycle callback (DSH-vendored cordis): runs at plugin
     * activation; its returned cleanup runs at disposal.
     */
    effect(fn: () => void | (() => void) | Promise<void> | (() => Promise<void>), label?: string): void
    /** Activate a child fiber once the named services are available. */
    inject(services: string[], callback: (ctx: Context) => void): void
  }
}

export type { Context }
