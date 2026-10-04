import { MODULE_ID, isFootstep } from "./ambient-playback.mjs";

/**
 * Ambient Sound document lifetime. Only the elected GM calls this class.
 */
export class FootstepSoundEmitters {
  constructor({
    isAuthority,
    mode,
    duration,
    randomID,
    now = () => game.time.serverTime,
    localize = (key) => game.i18n.localize(key),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
  }) {
    Object.assign(this, {
      isAuthority,
      mode,
      duration,
      randomID,
      now,
      localize,
      setTimer,
      clearTimer,
    });
    this.slots = new Map();
    this.tails = new Map();
    this.deletions = new Map();
    this.generation = 0;
  }

  emit(token, point, surface) {
    const generation = this.generation;
    const requestedAt = this.now();
    const previous = this.tails.get(token.uuid) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() =>
        this._emitStep(token, point, surface, generation, requestedAt),
      );
    this.tails.set(token.uuid, operation);
    operation
      .finally(() => {
        if (this.tails.get(token.uuid) === operation) {
          this.tails.delete(token.uuid);
        }
      })
      .catch(() => {});
    return operation;
  }

  /**
   * A queued step may outlive a reset, authority change, or token deletion.
   */
  _canEmit(token, generation) {
    return (
      this.isAuthority() &&
      generation === this.generation &&
      token.parent.tokens.has(token.id)
    );
  }

  async _emitStep(token, point, surface, generation, requestedAt) {
    const duration = await this.duration(surface.soundPath);
    if (!this._canEmit(token, generation) || this.now() - requestedAt > 500) {
      return;
    }


    const mode =
      surface.mode === "default" || surface.mode === undefined
        ? this.mode()
        : surface.mode;

    const reuse = mode === "reuse";
    let document = this.slots.get(token.uuid);

    if (document && !token.parent.sounds.has(document.id)) {
      document = null;
    }

    if (!reuse && document) {
      await token.parent.deleteEmbeddedDocuments("AmbientSound", [document.id]);

      this.slots.delete(token.uuid);
      document = null;

      if (!this._canEmit(token, generation)) {
        return;
      }
    }

    const soundPath = surface.soundPath;
    const identity = document?.getFlag(MODULE_ID, "slot") ?? this.randomID();

    // Native SoundsLayer groups identical paths. A unique, valid URL query
    // gives each slot its own group. The playback adapter loads the ORIGINAL
    // audio file URL, so this key never causes cache-busting audio downloads
    const path = `${soundPath}${soundPath.includes("?") ? "&" : "?"}footstep-sounds=${identity}`;
    const expiresAt = this.now() + duration * 1000 + 1000;

    const data = {
      name: this.localize("footstep-sounds.emitterName"),
      x: Math.round(point.x),
      y: Math.round(point.y),
      elevation: point.elevation,
      levels: point.level ? [point.level] : [],
      path,
      radius: surface.radius,
      volume: surface.volume,
      repeat: false,
      hidden: true,
      locked: true,
      easing: surface.easing ?? true,
      walls: surface.walls,
      effects: {
        base: { type: "", intensity: 5 },
        muffled: { type: "lowpass", intensity: 5 },
      },
      flags: {
        [MODULE_ID]: {
          managed: true,
          soundPath,
          slot: identity,
          pulse: this.randomID(),
          expiresAt,
          mode: reuse ? "reuse" : "createDelete",
        },
      },
    };

    if (reuse && document) {
      await document.update(data);
    } else {
      [document] = await token.parent.createEmbeddedDocuments("AmbientSound", [
        data,
      ]);
    }

    if (!document) {
      return;
    }

    if (!this._canEmit(token, generation)) {
      await this._discardLateWrite(token.parent, document);
      return;
    }

    if (reuse) {
      this.slots.set(token.uuid, document);
      return;
    }

    this._scheduleDeletion(token.parent, document, expiresAt);
  }

  async _discardLateWrite(scene, document) {
    if (!this.isAuthority()) {
      return;
    }
    await scene.deleteEmbeddedDocuments("AmbientSound", [document.id]);
  }

  _scheduleDeletion(scene, document, expiresAt) {
    const delay = Math.max(0, expiresAt - this.now());
    const timer = this.setTimer(
      () => this._deleteExpired(scene, document),
      delay,
    );
    this.deletions.set(document.uuid, timer);
  }

  async _deleteExpired(scene, document) {
    this.deletions.delete(document.uuid);
    if (!this.isAuthority() || !scene.sounds.has(document.id)) {
      return;
    }

    try {
      await scene.deleteEmbeddedDocuments("AmbientSound", [document.id]);
    } catch (error) {
      console.error(
        `${MODULE_ID} | ${this.localize("footstep-sounds.errors.removeFootstep")}`,
        error,
      );
    }
  }

  async removeToken(token) {
    const document = this.slots.get(token.uuid);
    this.slots.delete(token.uuid);

    if (
      document &&
      this.isAuthority() &&
      token.parent.sounds.has(document.id)
    ) {
      await token.parent.deleteEmbeddedDocuments("AmbientSound", [document.id]);
    }
  }

  async reset(scenes) {
    this.generation++;
    this.slots.clear();

    for (const timer of this.deletions.values()) {
      this.clearTimer(timer);
    }
    this.deletions.clear();

    // Wait for in-flight writes before sweeping, preventing late orphan documents
    await Promise.allSettled([...this.tails.values()]);
    if (!this.isAuthority()) {
      return;
    }

    for (const scene of scenes) {
      const ids = scene.sounds
        .filter(isFootstep)
        .map((document) => document.id);
      if (ids.length) {
        await scene.deleteEmbeddedDocuments("AmbientSound", ids);
      }
    }
  }
}
