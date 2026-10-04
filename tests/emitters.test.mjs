import assert from "node:assert/strict";
import { test } from "node:test";
import { FootstepSoundEmitters } from "../scripts/emitters.mjs";

function fixture(mode) {
  let serial = 0;
  const calls = [];
  const timers = [];
  const documents = new Map();
  const scene = {
    tokens: new Set(["one", "two"]),
    sounds: {
      has: (id) => documents.has(id),
      filter: (filter) => [...documents.values()].filter(filter),
    },
    async createEmbeddedDocuments(type, data) {
      calls.push({ operation: "create", type, data });
      return data.map((value) => {
        const document = {
          id: `doc${++serial}`,
          uuid: `Sound.doc${serial}`,
          data: value,
          getFlag: (module, key) => document.data.flags[module][key],
          async update(changes) {
            calls.push({ operation: "update", data: changes });
            document.data = changes;
          },
        };
        documents.set(document.id, document);
        return document;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      calls.push({ operation: "delete", type, ids });
      for (const id of ids) {
        documents.delete(id);
      }
    },
  };

  const emitters = new FootstepSoundEmitters({
    localize: (key) => key,
    isAuthority: () => true,
    mode: () => mode,
    duration: async () => 0.2,
    randomID: () => `random${++serial}`,
    now: () => 1000,
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });

  const token = { id: "one", uuid: "Token.one", parent: scene };
  const surface = {
    soundPath: "sounds/metal.ogg",
    radius: 30,
    volume: 0.5,
    walls: true,
  };
  const point = { x: 50, y: 50, elevation: 0, level: "floor" };

  return { calls, timers, scene, emitters, token, surface, point, documents };
}

test("Create per step creates one native document per step then deletes only its own documents", async () => {
  const context = fixture("createDelete");
  await context.emitters.emit(context.token, context.point, context.surface);
  await context.emitters.emit(
    context.token,
    { ...context.point, x: 150 },
    context.surface,
  );

  assert.equal(context.calls.filter((call) => call.operation === "create").length, 2);
  assert.equal(context.timers.length, 2);
  assert.equal(context.timers[0].delay, 1200);

  for (const timer of context.timers) {
    await timer.callback();
  }
  assert.equal(context.documents.size, 0);
});

test("Reuse per token reuses one stored-hidden document per token, preserving separate path groups", async () => {
  const context = fixture("reuse");
  await context.emitters.emit(context.token, context.point, context.surface);
  const first = [...context.documents.values()][0].data;

  await context.emitters.emit(
    context.token,
    { ...context.point, x: 150 },
    context.surface,
  );

  await context.emitters.emit(
    { id: "two", uuid: "Token.two", parent: context.scene },
    context.point,
    context.surface,
  );
  assert.equal(context.calls.filter((call) => call.operation === "create").length, 2);
  assert.equal(context.calls.filter((call) => call.operation === "update").length, 1);

  const data = [...context.documents.values()].map((doc) => doc.data);
  assert.equal(data[0].path, first.path);
  assert.notEqual(data[0].path, data[1].path);
  assert.notEqual(data[0].flags["footstep-sounds"].pulse, first.flags["footstep-sounds"].pulse);

  for (const document of data) {
    assert.equal(document.hidden, true);
    assert.equal(document.repeat, false);
    assert.equal(document.flags["footstep-sounds"].soundPath, "sounds/metal.ogg");
    assert.equal(JSON.stringify(document).includes("Token."), false);
  }
});

test("reset during an in-flight create removes late writes without touching regular sounds", async () => {
  const context = fixture("reuse");
  const regular = { id: "regular", getFlag: () => undefined };

  context.documents.set(regular.id, regular);
  const create = context.scene.createEmbeddedDocuments;
  let release;
  let entered;

  const started = new Promise((resolve) => {
    entered = resolve;
  });

  context.scene.createEmbeddedDocuments = async (...args) => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return create(...args);
  };

  const emitting = context.emitters.emit(
    context.token,
    context.point,
    context.surface,
  );

  await started;
  const resetting = context.emitters.reset([context.scene]);
  release();
  await Promise.all([emitting, resetting]);

  assert.deepEqual([...context.documents.keys()], ["regular"]);
});

test("deleting a token while creating its reuse slot does not leave an orphan", async () => {
  const context = fixture("reuse");
  const create = context.scene.createEmbeddedDocuments;

  context.scene.createEmbeddedDocuments = async (...args) => {
    context.scene.tokens.delete(context.token.id);
    return create(...args);
  };
  await context.emitters.emit(context.token, context.point, context.surface);

  assert.equal(context.documents.size, 0);
  assert.equal(context.emitters.slots.size, 0);
});

test("a non-authoritative client writes no documents", async () => {
  const context = fixture("createDelete");
  context.emitters.isAuthority = () => false;
  await context.emitters.emit(context.token, context.point, context.surface);

  assert.equal(context.calls.length, 0);
});

test("surface overrides win over the world default in both directions", async () => {
  for (const [world, override] of [
    ["createDelete", "reuse"],
    ["reuse", "createDelete"],
  ]) {
    const context = fixture(world);

    await context.emitters.emit(context.token, context.point, {
      ...context.surface,
      mode: override,
    });

    await context.emitters.emit(context.token, context.point, {
      ...context.surface,
      mode: override,
    });

    assert.equal(
      context.calls.filter((call) => call.operation === "create").length,
      override === "createDelete" ? 2 : 1,
    );
    assert.equal(
      context.calls.filter((call) => call.operation === "update").length,
      override === "reuse" ? 1 : 0,
    );
    assert.equal(context.timers.length, override === "createDelete" ? 2 : 0);
  }
});

test("following a changed world default retires reuse slots without sharing paths", async () => {
  const context = fixture("reuse");
  let world = "reuse";

  context.emitters.mode = () => world;
  await context.emitters.emit(context.token, context.point, {
    ...context.surface,
    mode: "default",
  });

  const old = [...context.documents.values()][0];
  world = "createDelete";

  await context.emitters.emit(context.token, context.point, {
    ...context.surface,
    mode: "default",
  });

  assert.equal(context.documents.has(old.id), false);
  assert.equal(context.emitters.slots.size, 0);
  assert.notEqual([...context.documents.values()][0].data.path, old.data.path);

  world = "reuse";
  await context.emitters.emit(context.token, context.point, {
    ...context.surface,
    mode: "reuse",
  });

  assert.equal(context.documents.size, 2);

  await context.timers[0].callback();
  assert.equal(context.documents.size, 1, "Per-step cleanup must not delete the new reuse slot");
});

test("both strategies pass native easing through and default unset surfaces to enabled", async () => {
  for (const mode of ["createDelete", "reuse"]) {
    const context = fixture(mode);

    for (const easing of [undefined, false, true]) {
      await context.emitters.emit(context.token, context.point, {
        ...context.surface,
        easing,
      });

      const write = context.calls
        .filter((call) => call.operation !== "delete")
        .at(-1);

      const data = write.operation === "create" ? write.data[0] : write.data;

      assert.equal(data.easing, easing ?? true);
      assert.equal(data.walls, context.surface.walls);
      assert.equal(data.volume, context.surface.volume);
    }
  }
});
