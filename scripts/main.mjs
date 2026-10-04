import {
  MODULE_ID,
  activatePulse,
  disposeFootstep,
  installPlaybackAdapter,
  isFootstep,
  reportError,
  stopLocalFootsteps,
} from "./ambient-playback.mjs";
import {
  MovementScheduler,
  movementWaypoints,
  surfaceAt,
} from "./movement.mjs";
import { FootstepSoundEmitters } from "./emitters.mjs";

const BEHAVIOR_TYPE = `${MODULE_ID}.surface`;
const durations = new Map();
let scheduler;
let emitters;
let resetting = false;
let resetQueue = Promise.resolve();
let activeGMId;

function isAuthority() {
  return game.users.activeGM?.id === game.user.id;
}

async function getClipDuration(soundPath) {
  if (!durations.has(soundPath)) {
    const promise = (async () => {
      const sound = game.audio.create({
        src: soundPath,
        context: game.audio.environment,
        singleton: false,
      });
      await sound.load();

      if (
        !sound.loaded ||
        !Number.isFinite(sound.duration) ||
        sound.duration <= 0 ||
        sound.duration > 5
      ) {
        throw new Error(
          game.i18n.format("footstep-sounds.errors.clipDuration", {
            soundPath,
          }),
        );
      }

      return sound.duration;
    })();

    durations.set(soundPath, promise);
    promise.catch(() => durations.delete(soundPath));
  }
  return durations.get(soundPath);
}

function reset() {
  scheduler.clear();
  stopLocalFootsteps();

  resetting = true;
  const pending = resetQueue
    .catch(reportError)
    .then(() => emitters.reset(game.scenes));
  resetQueue = pending;

  return pending.finally(() => {
    if (resetQueue === pending) {
      resetting = false;
    }
  });
}

function preloadScene() {
  for (const region of canvas.scene.regions) {
    for (const behavior of region.behaviors) {
      if (
        behavior.type === BEHAVIOR_TYPE &&
        !behavior.disabled &&
        behavior.system.soundPath
      ) {
        getClipDuration(behavior.system.soundPath).catch(reportError);
      }
    }
  }
}

function registerSurfaceBehavior() {
  const { RegionBehaviorType } = foundry.data.regionBehaviors;
  const { FilePathField, NumberField, BooleanField, StringField } =
    foundry.data.fields;

  class FootstepSurface extends RegionBehaviorType {
    static defineSchema() {
      return {
        mode: new StringField({
          required: true,
          nullable: false,
          initial: "default",
          choices: {
            default: "footstep-sounds.fields.mode.default",
            createDelete: "footstep-sounds.settings.mode.createDelete",
            reuse: "footstep-sounds.settings.mode.reuse",
          },
          label: "footstep-sounds.fields.mode.label",
          hint: "footstep-sounds.fields.mode.hint",
        }),
        soundPath: new FilePathField({
          categories: ["AUDIO"],
          label: "footstep-sounds.fields.soundPath.label",
          hint: "footstep-sounds.fields.soundPath.hint",
        }),
        radius: new NumberField({
          required: true,
          nullable: false,
          initial: 30,
          min: 0.1,
          label: "footstep-sounds.fields.radius.label",
          hint: "footstep-sounds.fields.radius.hint",
        }),
        volume: new NumberField({
          required: true,
          nullable: false,
          initial: 0.5,
          min: 0,
          max: 1,
          label: "footstep-sounds.fields.volume.label",
          hint: "footstep-sounds.fields.volume.hint",
        }),
        easing: new BooleanField({
          initial: true,
          label: "footstep-sounds.fields.easing.label",
          hint: "footstep-sounds.fields.easing.hint",
        }),
        walls: new BooleanField({
          initial: true,
          label: "footstep-sounds.fields.walls.label",
          hint: "footstep-sounds.fields.walls.hint",
        }),
      };
    }
  }
  CONFIG.RegionBehavior.dataModels[BEHAVIOR_TYPE] = FootstepSurface;
  CONFIG.RegionBehavior.typeLabels[BEHAVIOR_TYPE] =
    "footstep-sounds.behavior.surface";
  CONFIG.RegionBehavior.typeIcons[BEHAVIOR_TYPE] = "fa-solid fa-shoe-prints";
  CONFIG.RegionBehavior.typeHints[BEHAVIOR_TYPE] =
    "footstep-sounds.behavior.hint";
}

Hooks.once("init", () => {
  registerSurfaceBehavior();
  installPlaybackAdapter();

  game.settings.register(MODULE_ID, "mode", {
    name: "footstep-sounds.settings.mode.name",
    hint: "footstep-sounds.settings.mode.hint",
    scope: "world",
    config: true,
    type: String,
    default: "createDelete",
    choices: {
      createDelete: "footstep-sounds.settings.mode.createDelete",
      reuse: "footstep-sounds.settings.mode.reuse",
    },
  });
});

Hooks.once("ready", () => {
  activeGMId = game.users.activeGM?.id;
  emitters = new FootstepSoundEmitters({
    isAuthority,
    mode: () => game.settings.get(MODULE_ID, "mode"),
    duration: getClipDuration,
    randomID: () => foundry.utils.randomID(),
  });
  scheduler = new MovementScheduler({
    emit: (token, point, surface) =>
      emitters.emit(token, point, surface).catch(reportError),
    resolveSurface: (token, point) =>
      surfaceAt(token.parent.regions, point, BEHAVIOR_TYPE),
    isCurrent: (token) =>
      !resetting &&
      isAuthority() &&
      canvas.ready &&
      token.parent === canvas.scene &&
      token.parent.tokens.has(token.id),
  });
  reset().catch(reportError);
  if (canvas.ready) {
    preloadScene();
  }
});

Hooks.on("moveToken", (token, movement) => {
  if (
    !scheduler ||
    resetting ||
    !isAuthority() ||
    !canvas.ready ||
    token.parent !== canvas.scene
  ) {
    return;
  }

  const waypoints = movementWaypoints(movement);
  if (
    waypoints.length < 2 ||
    waypoints.some(
      (point) =>
        point.teleport || CONFIG.Token.movement.actions[point.action]?.teleport,
    )
  ) {
    scheduler.cancel(token.uuid, { forget: true });
    return;
  }

  const points = waypoints.map((point) => ({
    ...token.getCenterPoint(point),
    elevation: point.elevation,
    level: point.level,
  }));

  scheduler
    .schedule(token, movement, points, token.parent.grid.size)
    .catch(reportError);
});

Hooks.on("deleteToken", (token) => {
  scheduler?.cancel(token.uuid, { forget: true });
  emitters?.removeToken(token).catch(reportError);
});

Hooks.on("createAmbientSound", activatePulse);

Hooks.on("preUpdateAmbientSound", (document, changes) => {
  if (isFootstep(document)) {
    changes.hidden = true;
  }
});

Hooks.on("updateAmbientSound", (document, changes) => {
  if (
    isFootstep(document) &&
    foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.pulse`)
  ) {
    activatePulse(document);
  }
});

Hooks.on("deleteAmbientSound", disposeFootstep);

Hooks.on("canvasTearDown", () => {
  if (emitters) {
    reset().catch(reportError);
  }
});

Hooks.on("canvasReady", () => {
  if (scheduler) {
    preloadScene();
    for (const document of canvas.scene.sounds) {
      activatePulse(document);
    }
  }
});

Hooks.on("userConnected", () => {
  const current = game.users.activeGM?.id;
  if (emitters && current !== activeGMId) {
    activeGMId = current;
    reset().catch(reportError);
  }
});

window.addEventListener("pagehide", stopLocalFootsteps);
