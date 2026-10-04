/**
 * V14 passed waypoints exclude the origin, including single-key moves.
 */
export function movementWaypoints(movement) {
  if (!movement.origin || !movement.passed.waypoints.length) {
    return [];
  }
  return [movement.origin, ...movement.passed.waypoints];
}

/**
 * Sample planar movement once per stride, carrying partial strides between moves.
 */
export function sampleSteps(points, stride, carry = 0) {
  const steps = [];
  if (!(stride > 0) || points.length < 2) {
    return { steps, carry };
  }

  const lengths = points
    .slice(1)
    .map((point, index) =>
      Math.hypot(point.x - points[index].x, point.y - points[index].y),
    );

  const total = lengths.reduce((sum, length) => sum + length, 0);
  let travelled = 0;
  let remaining = stride - (carry % stride);

  for (let index = 0; index < lengths.length; index++) {
    const from = points[index];
    const to = points[index + 1];
    const length = lengths[index];
    if (length === 0) {
      continue;
    }

    let offset = remaining;
    while (offset <= length + 1e-6) {
      const fraction = Math.min(offset / length, 1);
      steps.push({
        x: from.x + (to.x - from.x) * fraction,
        y: from.y + (to.y - from.y) * fraction,
        elevation:
          (from.elevation ?? 0) +
          ((to.elevation ?? 0) - (from.elevation ?? 0)) * fraction,
        level: to.level,
        fraction: Math.min((travelled + offset) / total, 1),
      });
      offset += stride;
    }
    remaining = offset - length;
    travelled += length;
  }

  return { steps, carry: (stride - remaining + stride) % stride };
}

/**
 * The smallest configured Region wins overlaps; IDs make ties deterministic.
 */
export function surfaceAt(regions, point, behaviorType) {
  const matches = [];
  for (const region of regions) {
    if (region.hidden || !region.testPoint(point)) {
      continue;
    }

    for (const behavior of region.behaviors) {
      if (
        behavior.type === behaviorType &&
        !behavior.disabled &&
        behavior.system.soundPath
      ) {
        matches.push({ region, behavior });
        break;
      }
    }
  }

  matches.sort(
    (a, b) =>
      a.region.area - b.region.area || a.region.id.localeCompare(b.region.id),
  );

  return matches[0]?.behavior.system ?? null;
}

/**
 * Schedule only a committed movement; no permanent ticker or preview handling.
 */
export class MovementScheduler {
  constructor({
    emit,
    resolveSurface,
    isCurrent,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
  }) {
    this.emit = emit;
    this.resolveSurface = resolveSurface;
    this.isCurrent = isCurrent;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.jobs = new Map();
    this.carry = new Map();
  }

  async schedule(token, movement, points, stride) {
    let jobs = this.jobs.get(token.uuid);
    if (!jobs) {
      jobs = new Set();
      this.jobs.set(token.uuid, jobs);
    }

    const job = { movement, timers: new Set(), pending: [], started: false };
    jobs.add(job);
    const current = () => jobs.has(job) && this.isCurrent(token);

    try {
      await movement.animation.started;
    } catch (error) {
      this._finish(token.uuid, job);
      throw error;
    }

    if (!current()) {
      return;
    }

    const sampled = sampleSteps(
      points,
      stride,
      this.carry.get(token.uuid) ?? 0,
    );

    this.carry.set(token.uuid, sampled.carry);
    job.pending = [...sampled.steps];
    job.started = true;
    const duration = Math.max(0, movement.animation.duration);
    const play = (step) => this._playStep(token, job, step, current);

    movement.animation.ended
      .then(() => {
        this._completeMovement(token, job, current);
      })
      .catch(() => this.cancel(token.uuid, { forget: true }));

    for (const step of sampled.steps) {
      if (duration === 0) {
        play(step);
      } else {
        const timer = this.setTimer(() => {
          job.timers.delete(timer);
          play(step);
        }, duration * step.fraction);

        job.timers.add(timer);
      }
    }
  }

  _playStep(token, job, step, current) {
    if (!current() || !job.pending.includes(step)) {
      return;
    }
    job.pending.splice(job.pending.indexOf(step), 1);

    const surface = this.resolveSurface(token, step);
    if (surface) {
      this.emit(token, step, surface);
    }
  }

  _completeMovement(token, job, current) {
    if (!current()) {
      return;
    }

    for (const step of [...job.pending]) {
      this._playStep(token, job, step, current);
    }
    this._finish(token.uuid, job);
  }

  _finish(key, job) {
    for (const timer of job.timers) {
      this.clearTimer(timer);
    }

    const jobs = this.jobs.get(key);
    jobs?.delete(job);

    if (jobs?.size === 0) {
      this.jobs.delete(key);
    }
  }

  cancel(key, { forget = false } = {}) {
    const jobs = this.jobs.get(key);
    if (jobs) {
      for (const job of [...jobs]) {
        this._finish(key, job);
      }
    }

    if (forget) {
      this.carry.delete(key);
    }
  }

  clear() {
    for (const key of this.jobs.keys()) {
      this.cancel(key);
    }
    this.carry.clear();
  }
}
