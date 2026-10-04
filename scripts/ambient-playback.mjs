export const MODULE_ID = "footstep-sounds";
const states = new Map();
const expirations = new Map();
const WRAPPED = Symbol.for(`${MODULE_ID}.AmbientSound.sync`);

export function isFootstep(document) {
  return document?.getFlag(MODULE_ID, "managed") === true;
}

function isPulseActive(document) {
  return (
    isFootstep(document) &&
    document.getFlag(MODULE_ID, "expiresAt") > game.time.serverTime
  );
}

function createOneShotSound(ambient, state, soundPath) {
  const sound = game.audio.create({
    src: soundPath,
    context: game.audio.environment,
    singleton: false,
  });

  const nativePlay = sound.play;
  sound.play = async (options = {}) => {
    if (
      state.disposed ||
      state.consumed ||
      !isPulseActive(ambient.document) ||
      state.pulse !== ambient.document.getFlag(MODULE_ID, "pulse")
    ) {
      return sound;
    }
    state.consumed = true;

    return nativePlay.call(sound, {
      ...options,
      offset: 0,
      loop: false,
      fade: 0,
    });
  };

  return sound;
}

/**
 * Core v14 sync always requests looping playback at an ambient phase.
 * Preserve core sync/effects, but constrain play on THIS Sound instance only.
 * No private core members, global Sound patch, or second playback path.
 */
export function installPlaybackAdapter() {
  const prototype = CONFIG.AmbientSound.objectClass.prototype;
  const nativeSync = prototype.sync;
  if (nativeSync[WRAPPED]) {
    return;
  }

  async function syncFootstep(isAudible, volume, options = {}) {
    if (!isFootstep(this.document)) {
      return nativeSync.call(this, isAudible, volume, options);
    }

    let state = states.get(this);
    if (!state) {
      state = {
        tail: Promise.resolve(),
        pulse: null,
        soundPath: null,
        consumed: false,
        disposed: false,
      };
      states.set(this, state);
    }

    const pulse = this.document.getFlag(MODULE_ID, "pulse");
    state.tail = state.tail.catch(reportError).then(async () => {
      if (state.disposed) {
        return;
      }

      if (state.pulse !== pulse) {
        await nativeSync.call(this, false, 0, { fade: 0 });
        const soundPath = this.document.getFlag(MODULE_ID, "soundPath");

        if (state.soundPath !== soundPath) {
          const sound = createOneShotSound(this, state, soundPath);
          this.sound = sound;
          state.sound = sound;
          state.soundPath = soundPath;
        }

        // A native path update can replace the public Sound reference before
        // this hook runs. Reclaim only our own generated emitter's instance.
        this.sound = state.sound;
        state.pulse = pulse;
        state.consumed = false;
      }

      return nativeSync.call(
        this,
        isAudible && isPulseActive(this.document) && !this.document.hidden,
        volume,
        { ...options, fade: 0 },
      );
    });

    return state.tail.catch(reportError);
  }

  Object.defineProperty(syncFootstep, WRAPPED, { value: true });
  prototype.sync = syncFootstep;
}

export function reportError(error) {
  console.error(`${MODULE_ID} |`, error);
}

/**
 * Persisted documents are always hidden. Enable only an active pulse locally.
 */
export function activatePulse(document) {
  if (!isFootstep(document) || !document.parent.isView) {
    return;
  }

  const previous = expirations.get(document.uuid);
  if (previous) {
    clearTimeout(previous);
  }

  document.updateSource({ hidden: !isPulseActive(document) });
  document.object?.initializeSoundSource();

  if (canvas.ready) {
    canvas.sounds.refresh({ fade: 0 });
  }

  if (isPulseActive(document)) {
    const pulse = document.getFlag(MODULE_ID, "pulse");
    const duration = Math.max(
      0,
      document.getFlag(MODULE_ID, "expiresAt") - game.time.serverTime,
    );

    const timer = setTimeout(() => {
      expirations.delete(document.uuid);
      if (document.getFlag(MODULE_ID, "pulse") !== pulse) {
        return;
      }
      document.updateSource({ hidden: true });
      document.object?.initializeSoundSource();
      document.object?.sync(false, 0, { fade: 0 }).catch(reportError);
    }, duration);
    expirations.set(document.uuid, timer);
  } else {
    expirations.delete(document.uuid);
  }
}

export function disposeFootstep(document) {
  if (!isFootstep(document)) {
    return;
  }

  clearTimeout(expirations.get(document.uuid));
  expirations.delete(document.uuid);

  const ambient =
    document.object ??
    [...states.keys()].find((object) => object.document === document);
  const state = states.get(ambient);

  if (state) {
    state.disposed = true;
    states.delete(ambient);
    ambient.sound?.stop({ fade: 0 }).catch(reportError);
  }
}

export function stopLocalFootsteps() {
  for (const [ambient, state] of states) {
    state.disposed = true;
    ambient.document.updateSource({ hidden: true });
    ambient.sound?.stop({ fade: 0 }).catch(reportError);
  }
  states.clear();
  for (const timer of expirations.values()) {
    clearTimeout(timer);
  }
  expirations.clear();
}
