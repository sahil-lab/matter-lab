/**
 * A small typed request/response layer over Web Workers.
 *
 * Every numerical engine runs in a worker so that a long calculation can never stall the camera or
 * the editor. Calculations are synchronous inside their worker, so a running job cannot hear a
 * "please stop" message; cancelling therefore ends the worker itself, which always works and takes
 * effect at once. The next call starts a fresh worker.
 */

/** Handlers a worker exposes: one parameter object in, a result (or a promise of one) out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkerMethods = Record<string, (params: any, progress: (value: any) => void) => unknown>;

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

type RpcResponse =
  | { readonly id: number; readonly type: 'progress'; readonly value: unknown }
  | { readonly id: number; readonly type: 'result'; readonly value: unknown }
  | { readonly id: number; readonly type: 'error'; readonly name: string; readonly message: string; readonly data?: unknown };

/** The job was stopped on request. Not a failure of the calculation. */
export class JobCancelledError extends Error {
  constructor(message = 'The calculation was cancelled.') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

/** An error raised inside a worker, carried across with its original name and any structured data. */
export class WorkerError extends Error {
  constructor(
    name: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = name;
  }
}

export interface CallOptions<P = unknown> {
  /** Receives whatever the handler reports while it runs. */
  readonly onProgress?: (value: P) => void;
  /** Aborting stops the job immediately. */
  readonly signal?: AbortSignal;
}

interface Pending {
  readonly id: number;
  readonly request: RpcRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress?: (value: unknown) => void;
}

/** What a handler reports while it runs: the argument type of its `progress` callback. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProgressOf<F> = F extends (params: any, progress: (value: infer P) => void) => unknown ? P : unknown;

/** Main-thread handle to one worker. Calls run one at a time, in order. */
export class WorkerClient<M extends WorkerMethods> {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;

  constructor(
    private readonly spawn: () => Worker,
    private readonly label: string,
  ) {}

  call<K extends keyof M & string>(method: K, params: Parameters<M[K]>[0], options: CallOptions<ProgressOf<M[K]>> = {}): Promise<Awaited<ReturnType<M[K]>>> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new JobCancelledError());
        return;
      }
      const job: Pending = {
        id: this.nextId++,
        request: { id: 0, method, params },
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress as ((value: unknown) => void) | undefined,
      };
      options.signal?.addEventListener('abort', () => this.cancel(job), { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  /** True while a call is running or waiting. */
  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = this.spawn();
      worker.onmessage = (event: MessageEvent<RpcResponse>) => this.onMessage(event.data);
      worker.onerror = (event) => this.onCrash(event.message || `The ${this.label} worker stopped unexpectedly.`);
      worker.onmessageerror = () => this.onCrash(`The ${this.label} worker sent a message that could not be read.`);
      this.worker = worker;
    }
    return this.worker;
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    try {
      this.ensureWorker().postMessage({ ...job.request, id: job.id } satisfies RpcRequest);
    } catch (error) {
      this.active = null;
      job.reject(error instanceof Error ? error : new Error(String(error)));
      this.pump();
    }
  }

  private onMessage(message: RpcResponse): void {
    const job = this.active;
    if (!job || message.id !== job.id) return;
    if (message.type === 'progress') {
      job.onProgress?.(message.value);
      return;
    }
    this.active = null;
    if (message.type === 'result') job.resolve(message.value);
    else job.reject(new WorkerError(message.name, message.message, message.data));
    this.pump();
  }

  private onCrash(reason: string): void {
    const job = this.active;
    this.active = null;
    this.worker?.terminate();
    this.worker = null;
    job?.reject(new WorkerError('WorkerCrash', reason));
    this.pump();
  }

  private cancel(job: Pending): void {
    if (this.active === job) {
      // The only reliable way to stop a synchronous calculation: end its thread.
      this.worker?.terminate();
      this.worker = null;
      this.active = null;
      job.reject(new JobCancelledError());
      this.pump();
      return;
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      job.reject(new JobCancelledError());
    }
  }

  /** Ends the worker and rejects everything outstanding. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    const outstanding = this.active ? [this.active, ...this.queue] : [...this.queue];
    this.active = null;
    this.queue.length = 0;
    for (const job of outstanding) job.reject(new JobCancelledError('The worker was shut down.'));
  }
}

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<RpcRequest>) => void) | null;
}

const handedOver = new WeakMap<object, Transferable[]>();

/**
 * Worker side: marks buffers of a handler's result to be handed to the caller rather than copied.
 * The worker can no longer read them afterwards, so only buffers it will not use again qualify.
 */
export function transferring<T extends object>(value: T, buffers: readonly ArrayBufferLike[]): T {
  handedOver.set(value, [...new Set(buffers)].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer));
  return value;
}

/** Worker side: answers each request with the matching handler's result or its error. */
export function serve<M extends WorkerMethods>(methods: M): void {
  const scope = self as unknown as WorkerScope;
  scope.onmessage = async (event) => {
    const { id, method, params } = event.data;
    try {
      const handler = methods[method];
      if (!handler) throw new Error(`Unknown method "${method}".`);
      const value = await handler(params, (progress) => scope.postMessage({ id, type: 'progress', value: progress } satisfies RpcResponse));
      const transfer = typeof value === 'object' && value !== null ? handedOver.get(value) : undefined;
      scope.postMessage({ id, type: 'result', value } satisfies RpcResponse, transfer ?? []);
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      // Engines attach structured details (for example why a system is unsupported) as own properties.
      let data: unknown;
      try {
        data = JSON.parse(JSON.stringify(e));
      } catch {
        data = undefined;
      }
      scope.postMessage({ id, type: 'error', name: e.name, message: e.message, data } satisfies RpcResponse);
    }
  };
}
