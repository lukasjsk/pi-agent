import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_CONCURRENT, parseMaxConcurrent, SpawnScheduler } from "./concurrency.ts";

/** Deferred promise handle for driving concurrent tasks deterministically. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

test("cap: only maxConcurrent tasks run at once; the rest queue", async () => {
	const scheduler = new SpawnScheduler(2);
	const gates = [deferred(), deferred(), deferred(), deferred()];
	let started = 0;
	const results: number[] = [];
	const promises = gates.map((gate, i) =>
		scheduler.run(async () => {
			started++;
			await gate.promise;
			return i * 10;
		}).then((v) => results.push(v as number)),
	);
	await Promise.resolve(); // let microtasks settle
	assert.equal(started, 2);
	assert.equal(scheduler.runningCount, 2);
	assert.equal(scheduler.queuedCount, 2);

	gates[0].resolve(); // free a slot → first queued entry starts
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(started, 3);
	assert.equal(scheduler.queuedCount, 1);

	gates[1].resolve();
	gates[2].resolve();
	gates[3].resolve();
	await Promise.all(promises);
	assert.equal(scheduler.runningCount, 0);
	assert.equal(scheduler.queuedCount, 0);
	assert.deepEqual(results.sort((a, b) => a - b), [0, 10, 20, 30]);
});

test("queue drains FIFO", async () => {
	const scheduler = new SpawnScheduler(1);
	const order: string[] = [];
	const gate = deferred();
	const first = scheduler.run(async () => {
		await gate.promise;
		return "first";
	});
	const second = scheduler.run(async () => {
		order.push("second-ran");
		return "second";
	});
	const third = scheduler.run(async () => {
		order.push("third-ran");
		return "third";
	});
	gate.resolve();
	assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
	assert.deepEqual(order, ["second-ran", "third-ran"]); // FIFO, not LIFO
});

test("Esc while queued: entry resolves cancelled, fn never runs, slot untouched", async () => {
	const scheduler = new SpawnScheduler(1);
	const gate = deferred();
	const running = scheduler.run(async () => {
		await gate.promise;
		return "ran";
	});

	const controller = new AbortController();
	const queued = scheduler.run(
		async () => "should-never-run",
		controller.signal,
		() => "cancelled-while-queued",
	);
	controller.abort();
	assert.equal(await queued, "cancelled-while-queued");
	assert.equal(scheduler.queuedCount, 0);

	gate.resolve();
	assert.equal(await running, "ran");
	assert.equal(scheduler.runningCount, 0);
});

test("onQueued reports the number of entries ahead", async () => {
	const scheduler = new SpawnScheduler(1);
	const gate = deferred();
	const hold = scheduler.run(() => gate.promise);
	const aheadSeen: number[] = [];
	scheduler.run(async () => "b", undefined, () => undefined as never, (ahead) => aheadSeen.push(ahead));
	scheduler.run(async () => "c", undefined, () => undefined as never, (ahead) => aheadSeen.push(ahead));
	assert.deepEqual(aheadSeen, [0, 1]);
	gate.resolve();
	await hold;
});

test("already-aborted signal: immediate cancelled, fn never runs", async () => {
	const scheduler = new SpawnScheduler(4);
	const controller = new AbortController();
	controller.abort();
	let ran = false;
	const result = await scheduler.run(
		async () => {
			ran = true;
			return "ran";
		},
		controller.signal,
		() => "cancelled",
	);
	assert.equal(result, "cancelled");
	assert.equal(ran, false);
});

test("abort after start is ignored by the scheduler; the real result is returned", async () => {
	const scheduler = new SpawnScheduler(1);
	const gate = deferred<boolean>();
	const controller = new AbortController();
	const promise = scheduler.run(
		async () => {
			controller.abort(); // the child "cancels itself" and resolves with its own result
			return await gate.promise;
		},
		controller.signal,
		() => "cancelled-marker",
	);
	gate.resolve(true);
	assert.equal(await promise, true); // NOT the cancelled marker
});

test("a throwing task frees its slot and the queue keeps flowing", async () => {
	const scheduler = new SpawnScheduler(1);
	const gate = deferred();
	let secondRan = false;
	const first = scheduler.run(async () => {
		await gate.promise;
		throw new Error("boom");
	}).catch((e: unknown) => (e as Error).message);
	const second = scheduler.run(async () => {
		secondRan = true;
		return "second";
	});
	gate.resolve();
	assert.equal(await first, "boom");
	assert.equal(await second, "second");
	assert.equal(secondRan, true);
	assert.equal(scheduler.runningCount, 0);
});

test("sibling failure never cancels siblings (§R9.1)", async () => {
	const scheduler = new SpawnScheduler(4);
	const failGate = deferred();
	const okGate = deferred();
	const failing = scheduler.run(async () => {
		await failGate.promise;
		throw new Error("child blew up");
	}).catch((e: unknown) => (e as Error).message);
	const ok = scheduler.run(async () => {
		await okGate.promise;
		return "sibling-completed";
	});
	failGate.resolve();
	okGate.resolve();
	assert.equal(await failing, "child blew up");
	assert.equal(await ok, "sibling-completed");
});

test("invalid caps are rejected", () => {
	assert.throws(() => new SpawnScheduler(0));
	assert.throws(() => new SpawnScheduler(-1));
	assert.throws(() => new SpawnScheduler(1.5));
	assert.throws(() => new SpawnScheduler(Number.NaN));
	assert.equal(new SpawnScheduler().maxConcurrent, DEFAULT_MAX_CONCURRENT);
});

test("parseMaxConcurrent accepts only positive integers", () => {
	assert.equal(parseMaxConcurrent(undefined), undefined);
	assert.equal(parseMaxConcurrent(""), undefined);
	assert.equal(parseMaxConcurrent("not json"), undefined);
	assert.equal(parseMaxConcurrent('{"maxConcurrent": 6}'), 6);
	assert.equal(parseMaxConcurrent('{"maxConcurrent": 1}'), 1);
	assert.equal(parseMaxConcurrent('{"maxConcurrent": 0}'), undefined);
	assert.equal(parseMaxConcurrent('{"maxConcurrent": -2}'), undefined);
	assert.equal(parseMaxConcurrent('{"maxConcurrent": 2.5}'), undefined);
	assert.equal(parseMaxConcurrent('{"maxConcurrent": "3"}'), undefined);
	assert.equal(parseMaxConcurrent("[]"), undefined);
	assert.equal(parseMaxConcurrent('{"other": 5}'), undefined);
});
