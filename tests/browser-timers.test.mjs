import assert from "node:assert/strict";
import { test } from "node:test";
import { FootstepSoundEmitters } from "../scripts/emitters.mjs";
import { MovementScheduler } from "../scripts/movement.mjs";

test("default timers retain the browser receiver for movement and deletion", async () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = [];
  const cleared = [];

  globalThis.setTimeout = function(callback, delay) {
    assert.equal(this, globalThis, "browser timer called with an illegal receiver");
    const timer = {callback, delay};
    timers.push(timer);
    return timer;
  };

  globalThis.clearTimeout = function(timer) {
    assert.equal(this, globalThis, "browser timer called with an illegal receiver");
    cleared.push(timer);
  };

  try {
    const sounds = new Map();
    const scene = {
      tokens: new Set(["token"]),
      sounds,
      async createEmbeddedDocuments(type, [data]) {
        const document = { id: "sound", uuid: "Sound.sound", data };
        sounds.set(document.id, document);
        return [document];
      },
      async deleteEmbeddedDocuments(type, ids) {
        for (const id of ids) {
          sounds.delete(id);
        }
      },
    };

    const token = { id: "token", uuid: "Token.token", parent: scene };
    const surface = {
      soundPath: "step.ogg",
      radius: 30,
      volume: 0.5,
      walls: true,
    };

    const emitters = new FootstepSoundEmitters({
      isAuthority: () => true,
      mode: () => "createDelete",
      localize: (key) => key,
      duration: async () => 0.2,
      randomID: () => "id",
      now: () => 1000,
    });

    const emitted = [];
    let end;

    const movement = {
      animation: {
        started: Promise.resolve(),
        ended: new Promise((resolve) => {
          end = resolve;
        }),
        duration: 1000,
      },
    };

    const scheduler = new MovementScheduler({
      isCurrent: () => true,
      resolveSurface: () => surface,
      emit: (...args) => {
        const promise = emitters.emit(...args);
        emitted.push(promise);
        return promise;
      },
    });

    await scheduler.schedule(
      token,
      movement,
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      100,
    );

    assert.deepEqual(timers.map(timer => timer.delay), [500, 1000]);
    assert.equal(sounds.size, 0);

    timers[0].callback();
    await emitted[0];

    assert.equal(sounds.size, 1, "first step emits before animation ends");
    assert.equal(timers[2].delay, 1200);

    await timers[2].callback();
    assert.equal(sounds.size, 0, "create/delete removes the generated document");

    scheduler.clear();
    assert.ok(cleared.includes(timers[1]));

    end();
    await Promise.resolve();
    assert.equal(emitted.length, 1, "cancelled movement does not flush late steps");
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
