import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  MovementScheduler,
  movementWaypoints,
  sampleSteps,
  surfaceAt,
} from "../scripts/movement.mjs";

const point = (x, y = 0) => ({ x, y, elevation: 0 });

const deferred = () => {
  let resolve;
  const promise = new Promise((callback) => {
    resolve = callback;
  });
  return { promise, resolve };
};

function fixture() {
  const timers = new Map();
  const emitted = [];
  let serial = 0;

  const scheduler = new MovementScheduler({
    emit: (_token, step, surface) => emitted.push({ step, surface }),
    resolveSurface: (_token, step) => ({
      soundPath: step.x <= 100 ? "metal" : "wood",
    }),
    isCurrent: () => true,
    setTimer: (callback, delay) => {
      const id = ++serial;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });

  return { timers, emitted, scheduler, token: { uuid: "Token.test" } };
}

test("V14 single-destination keyboard moves include the origin and emit a step", async () => {
  const { scheduler, emitted, token } = fixture();
  const end = deferred();

  const movement = {
    method: "keyboard",
    origin: point(0),
    passed: { waypoints: [point(100)] },
    animation: {
      started: Promise.resolve(),
      ended: end.promise,
      duration: 100,
    },
  };

  const points = movementWaypoints(movement);
  assert.deepEqual(points, [point(0), point(100)]);

  await scheduler.schedule(token, movement, points, 100);
  end.resolve();
  await Promise.resolve();
  assert.deepEqual(emitted.map((event) => event.step.x), [100]);
});

test("V14 drag paths retain their first segment; empty passed paths remain empty", () => {
  const points = movementWaypoints({
    origin: point(0),
    passed: { waypoints: [point(100), point(200)] },
  });

  assert.deepEqual(
    sampleSteps(points, 100).steps.map((step) => step.x),
    [100, 200],
  );

  assert.deepEqual(
    movementWaypoints({ origin: point(0), passed: { waypoints: [] } }),
    [],
  );
});

test("keyboard movement replacement does not cancel committed animation on stopToken", async () => {
  const source = await readFile(
    new URL("../scripts/main.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/Hooks\.on\(["']stopToken["']/.test(source), false);

  const { scheduler, emitted, token } = fixture();
  const firstEnd = deferred();
  const secondEnd = deferred();
  await scheduler.schedule(
    token,
    {
      method: "keyboard",
      animation: {
        started: Promise.resolve(),
        ended: firstEnd.promise,
        duration: 100,
      },
    },
    [point(0), point(50)],
    100,
  );

  // Core stops the first movement when replacing it, but its committed
  // animation still completes. The second half-stride must keep the carry.
  const second = scheduler.schedule(
    token,
    {
      method: "keyboard",
      animation: {
        started: firstEnd.promise,
        ended: secondEnd.promise,
        duration: 100,
      },
    },
    [point(50), point(100)],
    100,
  );

  firstEnd.resolve();
  await second;
  secondEnd.resolve();
  await Promise.resolve();

  assert.deepEqual(emitted.map((event) => event.step.x), [100]);
  assert.equal(scheduler.jobs.size, 0);
});

test("one square emits once; a long drag follows turns in its path", () => {
  assert.deepEqual(sampleSteps([point(0), point(100)], 100).steps, [
    { ...point(100), level: undefined, fraction: 1 },
  ]);

  const result = sampleSteps([point(0), point(200), point(200, 200)], 100);
  assert.deepEqual(
    result.steps.map(({ x, y }) => [x, y]),
    [
      [100, 0],
      [200, 0],
      [200, 100],
      [200, 200],
    ],
  );

  assert.deepEqual(
    result.steps.map((step) => step.fraction),
    [0.25, 0.5, 0.75, 1],
  );
});

test("partial free movement carries across moves; diagonal motion stays continuous", () => {
  const first = sampleSteps([point(0), point(40)], 100);
  assert.equal(first.steps.length, 0);
  assert.equal(first.carry, 40);

  const next = sampleSteps([point(40), point(120)], 100, first.carry);
  assert.equal(next.steps.length, 1);
  assert.equal(next.steps[0].x, 100);
  assert.equal(next.carry, 20);

  const diagonal = sampleSteps([point(0), point(100, 100)], 100);
  assert.ok(Math.abs(diagonal.steps[0].x - 70.710678) < 1e-5);
  assert.equal(sampleSteps([point(0), point(0)], 100).steps.length, 0);
});

test("smallest enabled Region wins; hidden and disabled surfaces are ignored", () => {
  const region = (id, area, soundPath, extra = {}) => ({
    id,
    area,
    hidden: false,
    testPoint: () => true,
    behaviors: [{ type: "surface", disabled: false, system: { soundPath } }],
    ...extra,
  });

  const regions = [
    region("wood", 500, "wood.ogg"),
    region("metal", 100, "metal.ogg"),
    region("hidden", 1, "secret.ogg", { hidden: true }),
    region("disabled", 1, "off.ogg", {
      behaviors: [{ type: "surface", disabled: true }],
    }),
  ];

  assert.equal(surfaceAt(regions, point(0), "surface").soundPath, "metal.ogg");
  assert.equal(surfaceAt([], point(0), "surface"), null);
});

test("drag steps use animation timing and resolve surfaces at each step", async () => {
  const { scheduler, timers, emitted, token } = fixture();
  const end = deferred();
  await scheduler.schedule(
    token,
    {
      animation: {
        started: Promise.resolve(),
        ended: end.promise,
        duration: 400,
      },
    },
    [point(0), point(200)],
    100,
  );

  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [200, 400]);

  for (const timer of [...timers.values()]) {
    timer.callback();
  }
  end.resolve();
  await Promise.resolve();

  assert.deepEqual(emitted.map((event) => event.surface.soundPath), ["metal", "wood"]);
  assert.equal(scheduler.jobs.size, 0);
});

test("held-key movements queued behind animations do not cancel earlier steps", async () => {
  const { scheduler, emitted, token } = fixture();
  const firstEnd = deferred();
  const secondEnd = deferred();

  await scheduler.schedule(
    token,
    {
      animation: {
        started: Promise.resolve(),
        ended: firstEnd.promise,
        duration: 100,
      },
    },
    [point(0), point(100)],
    100,
  );

  const second = scheduler.schedule(
    token,
    {
      animation: {
        started: firstEnd.promise,
        ended: secondEnd.promise,
        duration: 100,
      },
    },
    [point(100), point(200)],
    100,
  );

  firstEnd.resolve();
  await second;
  secondEnd.resolve();
  await Promise.resolve();

  assert.deepEqual(emitted.map((event) => event.step.x), [100, 200]);
  assert.equal(scheduler.jobs.size, 0);
});

test("clearing the scheduler cancels pending footsteps including waiting animations", async () => {
  const { scheduler, timers, emitted, token } = fixture();
  const start = deferred();
  const end = deferred();

  const waiting = scheduler.schedule(
    token,
    {
      animation: { started: start.promise, ended: end.promise, duration: 500 },
    },
    [point(0), point(300)],
    100,
  );

  scheduler.clear();
  start.resolve();
  await waiting;
  end.resolve();
  await Promise.resolve();

  assert.equal(emitted.length, 0);
  assert.equal(timers.size, 0);
});
