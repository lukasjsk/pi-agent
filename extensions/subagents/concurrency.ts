// Concurrency cap + queue for extension-wide spawn slots (spec §R8.3–R8.4 semantics,
// requirements R9.1–R9.2): at most `maxConcurrent` children run at once; excess spawns
// queue FIFO and start as slots free up. A failing child never cancels siblings — each
// queued/running entry tracks only its own abort signal. Pure module — no pi imports.

/** Extension-wide default cap (spec §R8.3). */
export const DEFAULT_MAX_CONCURRENT = 4;

export class SpawnScheduler {
	readonly maxConcurrent: number;
	private running = 0;
	private readonly queue: Array<() => void> = [];

	constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
		if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
		}
		this.maxConcurrent = maxConcurrent;
	}

	/** Children currently executing. */
	get runningCount(): number {
		return this.running;
	}

	/** Spawns waiting for a slot. */
	get queuedCount(): number {
		return this.queue.length;
	}

	/**
	 * Run `fn` when a slot is free (immediately if one is open, otherwise FIFO).
	 *
	 * `signal` is the entry's own abort signal (the platform's per-tool-call signal):
	 *   - aborted before start → resolves `makeCancelled()` without ever calling `fn`
	 *   - aborted while queued → leaves the queue and resolves `makeCancelled()` (queue drains)
	 *   - aborted after start  → `fn` owns the signal (the child session cancels itself);
	 *     the scheduler stays out of the way and returns `fn`'s real result
	 *
	 * `onQueued` fires once when the entry is placed in the queue, with the number of
	 * entries ahead of it (0 = next in line).
	 */
	run<T>(
		fn: () => Promise<T>,
		signal: AbortSignal | undefined,
		makeCancelled: () => T,
		onQueued?: (ahead: number) => void,
	): Promise<T> {
		if (signal?.aborted) return Promise.resolve(makeCancelled());
		if (this.running < this.maxConcurrent) return this.start(fn);
		return new Promise<T>((resolve) => {
			let started = false;
			const onAbort = () => {
				if (started) return; // running child cancels itself via the shared signal
				const index = this.queue.indexOf(entry);
				if (index >= 0) this.queue.splice(index, 1);
				signal?.removeEventListener("abort", onAbort);
				resolve(makeCancelled());
			};
			const entry = () => {
				started = true;
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) {
					resolve(makeCancelled());
					return;
				}
				this.start(fn).then(resolve);
			};
			onQueued?.(this.queue.length);
			this.queue.push(entry);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Take a slot, run fn, free the slot, and pump the queue. */
	private start<T>(fn: () => Promise<T>): Promise<T> {
		this.running++;
		return fn().finally(() => {
			this.running--;
			this.pump();
		});
	}

	private pump(): void {
		while (this.running < this.maxConcurrent && this.queue.length > 0) {
			this.queue.shift()!();
		}
	}
}

/**
 * Parse the extension config file's maxConcurrent (`~/.pi/agent/configs/subagents.json`,
 * following the footer extension's config precedent). Returns undefined for missing,
 * non-JSON, or invalid values so callers fall back to the default. Config shape:
 * `{ "maxConcurrent": <positive integer> }` — unknown fields are ignored.
 */
export function parseMaxConcurrent(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const value = (parsed as Record<string, unknown>).maxConcurrent;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}
