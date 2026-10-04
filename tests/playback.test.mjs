import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activatePulse,
  disposeFootstep,
  installPlaybackAdapter,
  stopLocalFootsteps,
  MODULE_ID,
} from "../scripts/ambient-playback.mjs";

class Sound {
  constructor(src) {
    this.src = src;
    this.loaded = false;
    this.playing = false;
    this.plays = [];
    this.effects = [];
    this.duration = 0.2;
    this.context = { currentTime: 15.123 };
  }

  async load() {
    this.loaded = true;
  }

  async play(options) {
    this.plays.push(options);
    this.playing = true;
    return this;
  }

  async stop() {
    this.playing = false;
  }

  async fade() {}
  applyEffects(effects) {
    this.effects = effects;
  }
}

class Ambient {
  constructor(document) {
    this.document = document;
  }

  async sync(audible, volume, options = {}) {
    this.nativeCalls ??= [];
    this.nativeCalls.push({ audible, volume, options });

    if (!audible) {
      await this.sound?.stop();
      return;
    }

    await this.sound.load();
    this.applyEffects(options);

    if (!this.sound.playing) {
      await this.sound.play({ volume, offset: 0.123, loop: true, fade: 250 });
    }
  }

  applyEffects(options) {
    this.sound.applyEffects([
      options.muffled ? "muffled-effect" : "base-effect",
    ]);
  }

  initializeSoundSource() {}
}

function createPlaybackFixture(testContext) {
  const keys = ["CONFIG", "game", "canvas", "setTimeout", "clearTimeout"];

  const saved = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );

  const nativeSync = Ambient.prototype.sync;
  const timers = new Map();
  let serial = 0;

  testContext.after(() => {
    try {
      stopLocalFootsteps();
      assert.equal(timers.size, 0, "cleanup leaves no expiration timers");
    } finally {
      Ambient.prototype.sync = nativeSync;
      for (const [key, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete globalThis[key];
        }
      }
    }
  });

  globalThis.setTimeout = (callback, delay) => {
    const id = ++serial;
    timers.set(id, { callback, delay });
    return id;
  };

  globalThis.clearTimeout = (id) => timers.delete(id);
  const objectClass = Ambient;
  globalThis.CONFIG = { AmbientSound: { objectClass }, soundEffects: {} };
  globalThis.game = {
    time: { serverTime: 1000 },
    audio: { environment: {}, create: (options) => new Sound(options.src) },
  };
  globalThis.canvas = { ready: true, sounds: { refresh() {} } };

  installPlaybackAdapter();

  return { timers };
}

let documentSerial = 0;
function createAmbientSoundDocument(pulse = "first") {
  const flags = {
    managed: true,
    pulse,
    expiresAt: 5000,
    soundPath: "sounds/metal.ogg",
  };

  const ambientSoundDocument = {
    uuid: `Sound.test${++documentSerial}`,
    hidden: true,
    parent: { isView: true },
    effects: { base: { type: "" }, muffled: { type: "" } },
    getFlag: (module, key) => (module === MODULE_ID ? flags[key] : undefined),
    updateSource: (change) => Object.assign(ambientSoundDocument, change),
    flags,
  };

  return ambientSoundDocument;
}

test("generated sounds start at zero once, preserve native volume, and retrigger on a new pulse", async (testContext) => {
  createPlaybackFixture(testContext);

  const ambientSoundDocument = createAmbientSoundDocument();
  const ambient = new Ambient(ambientSoundDocument);

  ambientSoundDocument.object = ambient;
  activatePulse(ambientSoundDocument);
  await ambient.sync(true, 0.25, { muffled: true });

  assert.equal(ambient.sound.src, "sounds/metal.ogg");
  assert.equal(ambient.nativeCalls.at(-1).options.muffled, true);
  assert.deepEqual(ambient.sound.effects, ["muffled-effect"]);
  assert.deepEqual(ambient.sound.plays[0], {
    volume: 0.25,
    offset: 0,
    loop: false,
    fade: 0,
  });

  ambient.sound.playing = false; // Native clip end
  await ambient.sync(true, 0.25);
  assert.equal(ambient.sound.plays.length, 1);

  ambientSoundDocument.flags.pulse = "second";
  activatePulse(ambientSoundDocument);
  await ambient.sync(true, 0.4);

  assert.equal(ambient.sound.plays.length, 2);
  assert.equal(ambient.sound.plays[1].volume, 0.4);

  disposeFootstep(ambientSoundDocument);
});

test("ordinary Ambient Sounds delegate unchanged; expiry and native hearing gate playback", async (testContext) => {
  createPlaybackFixture(testContext);

  const native = new Ambient({ getFlag: () => undefined });
  native.sound = new Sound("regular.ogg");
  await native.sync(true, 0.7, { fade: 123 });

  assert.equal(native.sound.plays[0].loop, true);
  assert.equal(native.nativeCalls[0].options.fade, 123);

  const ambientSoundDocument = createAmbientSoundDocument();
  const ambient = new Ambient(ambientSoundDocument);
  ambientSoundDocument.object = ambient;
  activatePulse(ambientSoundDocument);

  await ambient.sync(false, 0);
  assert.equal(ambient.sound.plays.length, 0);

  ambientSoundDocument.flags.expiresAt = 900;
  await ambient.sync(true, 1);
  assert.equal(ambient.sound.plays.length, 0);

  disposeFootstep(ambientSoundDocument);
});

test("same-file Ambient Sounds get independent voices and scene teardown stops both", async (testContext) => {
  const { timers } = createPlaybackFixture(testContext);

  const ambientSoundDocuments = [createAmbientSoundDocument(), createAmbientSoundDocument()];
  for (const ambientSoundDocument of ambientSoundDocuments) {
    ambientSoundDocument.object = new Ambient(ambientSoundDocument);
    activatePulse(ambientSoundDocument);
    await ambientSoundDocument.object.sync(true, 0.5);
  }

  assert.notEqual(ambientSoundDocuments[0].object.sound, ambientSoundDocuments[1].object.sound);
  stopLocalFootsteps();
  assert.equal(timers.size, 0);
  for (const ambientSoundDocument of ambientSoundDocuments) {
    assert.equal(ambientSoundDocument.hidden, true);
    assert.equal(ambientSoundDocument.object.sound.playing, false);
  }
});

test("installing the adapter twice does not wrap native sync twice", (testContext) => {
  createPlaybackFixture(testContext);
  const installed = Ambient.prototype.sync;
  installPlaybackAdapter();
  assert.equal(Ambient.prototype.sync, installed);
});

test("expiration timer hides and stops a playing footstep", async (testContext) => {
  const { timers } = createPlaybackFixture(testContext);
  const ambientSoundDocument = createAmbientSoundDocument();

  ambientSoundDocument.object = new Ambient(ambientSoundDocument);
  activatePulse(ambientSoundDocument);

  await ambientSoundDocument.object.sync(true, 0.5);
  const [id, timer] = [...timers][0];
  assert.equal(timer.delay, 4000);

  game.time.serverTime = 5000;
  timers.delete(id);
  timer.callback();

  await ambientSoundDocument.object.sync(false, 0);
  assert.equal(ambientSoundDocument.hidden, true);
  assert.equal(ambientSoundDocument.object.sound.playing, false);
  assert.equal(timers.size, 0);
});

test("retrigger cancels expiration and a stale callback cannot stop the new pulse", async (testContext) => {
  const { timers } = createPlaybackFixture(testContext);
  const ambientSoundDocument = createAmbientSoundDocument();

  ambientSoundDocument.object = new Ambient(ambientSoundDocument);
  activatePulse(ambientSoundDocument);

  await ambientSoundDocument.object.sync(true, 0.5);
  const [oldId, oldTimer] = [...timers][0];
  ambientSoundDocument.flags.pulse = "second";
  activatePulse(ambientSoundDocument);

  await ambientSoundDocument.object.sync(true, 0.5);
  assert.equal(timers.has(oldId), false);

  oldTimer.callback();
  assert.equal(ambientSoundDocument.hidden, false);
  assert.equal(ambientSoundDocument.object.sound.playing, true);

  // The callback should leave the new pulse's timer registered for cleanup.
  disposeFootstep(ambientSoundDocument);
  assert.equal(timers.size, 0);
});

test("changing the sound path replaces and stops the previous independent voice", async (testContext) => {
  createPlaybackFixture(testContext);
  const ambientSoundDocument = createAmbientSoundDocument();

  ambientSoundDocument.object = new Ambient(ambientSoundDocument);
  activatePulse(ambientSoundDocument);

  await ambientSoundDocument.object.sync(true, 0.5);
  const previous = ambientSoundDocument.object.sound;
  ambientSoundDocument.flags.soundPath = "sounds/wood.ogg";
  ambientSoundDocument.flags.pulse = "wood";
  activatePulse(ambientSoundDocument);

  await ambientSoundDocument.object.sync(true, 0.5);
  assert.notEqual(ambientSoundDocument.object.sound, previous);
  assert.equal(previous.playing, false);
  assert.equal(ambientSoundDocument.object.sound.src, "sounds/wood.ogg");
  assert.equal(ambientSoundDocument.object.sound.plays.length, 1);
});
