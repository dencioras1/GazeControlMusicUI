/**
 * gaze-targets.js — turns gaze points and blinks into actions on UI elements.
 *
 * Every gaze-controllable thing (pie segment, button, slider circle) registers
 * itself here as a "target":
 *
 *   targets.add({
 *     id: 'play',                     // unique name
 *     el: element or [elements],      // gets CSS classes for visual feedback
 *     contains: (x, y) => boolean,    // is page point (x, y) on this target?
 *     onBlink: () => 'what it did',   // optional: single blink; the returned text is logged
 *     onDoubleBlink: () => '...',     // optional: double blink
 *     group: 'main',                  // only targets in the active group(s) react
 *   });
 *
 * How a target is activated (the two gaze gestures):
 *   1. Fixation: the area cursor (a circle around the gaze point) rests on the
 *      target. The target that covers the largest share of the circle (at least
 *      gaze.minOverlap, or the gaze point is inside it) is "in focus" and its
 *      dwell progress fills up. Looking away drains it slowly instead of
 *      resetting it, so jittery gaze doesn't throw away progress.
 *   2. When the progress is full (after the dwell time) the target is "armed".
 *      A blink while it is armed activates it.
 *
 * Because the gaze prediction jumps around while the eyes close, a blink is
 * applied to the target that was armed shortly BEFORE the eyes closed
 * (gaze.blinkLookbackMs), looked up in a short history.
 *
 * CSS classes set on target elements:
 *   gaze-focus      the target is in focus
 *   gaze-armed      dwell complete: a blink will activate it
 *   gaze-activated  briefly, right after activation
 */

// Fixed sample points spread evenly over a circle of radius 1 (sunflower
// pattern). Scaled by the cursor radius they estimate which share of the
// cursor circle covers each target.
const DISK = (() => {
  const n = 150, golden = Math.PI * (3 - Math.sqrt(5)), pts = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n), a = i * golden;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
})();

const elementsOf = (t) => (Array.isArray(t.el) ? t.el : [t.el]).filter(Boolean);

export class GazeTargets {
  /**
   * @param cursorEl  element drawn as the area cursor
   * @param settings  live settings object: { dwellMs, cursorRadius }
   * @param cfg       CONFIG.gaze and CONFIG.blink, as { gaze, blink }
   */
  constructor({ cursorEl, settings, cfg }) {
    this.cursorEl = cursorEl;
    this.settings = settings;
    this.cfg = cfg;

    this.targets = new Map();          // id -> target
    this.activeGroups = new Set(['main']);
    this.progress = new Map();         // id -> dwell progress 0..1
    this.focusId = null;               // target currently in focus
    this.armed = false;                // focus target's dwell is complete
    this.frozen = false;               // true while a pursuit slider is being followed
    this.lastPoint = null;             // latest gaze point {x, y}
    this.lastTime = 0;
    this.history = [];                 // [{t, id, armed}] for the blink lookback
    this.pendingDouble = null;         // first blink of a possible double blink
  }

  // ----- registering -----

  add(target) { this.targets.set(target.id, { group: 'main', ...target }); }
  remove(id) { this.targets.delete(id); }

  /** Only targets in these groups react (e.g. ['modal'] while a dialog is open). */
  setActiveGroups(groups) {
    this.activeGroups = new Set(groups);
    this.resetState();
  }

  /** Freeze focus and blinks (used while a pursuit slider is followed). */
  setFrozen(frozen) {
    this.frozen = frozen;
    this.resetState();
  }

  resetState() {
    this.setFocus(null, false);
    this.progress.clear();
    this.history = [];
    if (this.pendingDouble) clearTimeout(this.pendingDouble.timer);
    this.pendingDouble = null;
    this.lastTime = 0;
  }

  activeTargets() {
    return [...this.targets.values()].filter((t) => this.activeGroups.has(t.group));
  }

  // ----- fixation -----

  /** Process one gaze sample (page pixels). */
  handleGaze(x, y, now) {
    this.lastPoint = { x, y };
    const radius = this.settings.cursorRadius;
    if (this.frozen) { this.drawCursor(x, y, radius, 0, false); return; }

    // Share of the cursor circle on each active target.
    const active = this.activeTargets();
    const counts = new Map();
    for (const [dx, dy] of DISK) {
      const px = x + dx * radius, py = y + dy * radius;
      const hit = active.find((t) => t.contains(px, py));
      if (hit) counts.set(hit.id, (counts.get(hit.id) || 0) + 1);
    }
    let best = null, bestShare = -1;
    for (const t of active) {
      const share = (counts.get(t.id) || 0) / DISK.length;
      const qualifies = share >= this.cfg.gaze.minOverlap || t.contains(x, y);
      if (qualifies && share > bestShare) { best = t; bestShare = share; }
    }

    // Fill the focused target, drain all others.
    const dt = this.lastTime ? Math.min(now - this.lastTime, this.cfg.gaze.maxDtMs) : 0;
    this.lastTime = now;
    const step = dt / this.settings.dwellMs;
    for (const t of active) {
      const old = this.progress.get(t.id) || 0;
      const p = best && t.id === best.id
        ? Math.min(1, old + step)
        : Math.max(0, old - step * this.cfg.gaze.decayFactor);
      if (p > 0) this.progress.set(t.id, p); else this.progress.delete(t.id);
    }

    const progress = best ? this.progress.get(best.id) || 0 : 0;
    const armed = progress >= 1;
    this.setFocus(best ? best.id : null, armed);
    this.drawCursor(x, y, radius, progress, armed);

    this.history.push({ t: now, id: this.focusId, armed, progress });
    while (this.history.length && now - this.history[0].t > this.cfg.gaze.historyMs) this.history.shift();
  }

  setFocus(id, armed) {
    if (id !== this.focusId) {
      const old = this.targets.get(this.focusId);
      if (old) for (const el of elementsOf(old)) el.classList.remove('gaze-focus', 'gaze-armed');
      this.focusId = id;
    }
    const t = this.targets.get(id);
    if (t) for (const el of elementsOf(t)) {
      el.classList.add('gaze-focus');
      el.classList.toggle('gaze-armed', armed);
    }
    this.armed = armed;
  }

  drawCursor(x, y, radius, progress, armed) {
    const c = this.cursorEl;
    c.style.display = 'block';
    c.style.width = c.style.height = `${2 * radius}px`;
    c.style.transform = `translate(${x - radius}px, ${y - radius}px)`;
    c.style.setProperty('--dwell', progress.toFixed(3));
    c.classList.toggle('armed', armed);
  }

  hideCursor() { this.cursorEl.style.display = 'none'; }

  // ----- blinks -----

  /**
   * Debug output for blinks (CONFIG.debug.logBlinks), in the browser console.
   * Every line starts with [blink #n] so all lines about one blink can be found together.
   */
  log(msg) {
    if (this.cfg.debug?.logBlinks) console.info(`%c[blink #${this.blinkNo}]%c ${msg}`, 'color:#9cc4ff;font-weight:bold', '');
  }

  /** Process one blink from GazeInput. */
  handleBlink(blink) {
    this.blinkNo = (this.blinkNo || 0) + 1;
    const kind = blink.simulated ? 'click' : `blink (${Math.round(blink.duration)} ms)`;
    const sincePrev = this.lastBlinkEnd != null ? blink.end - this.lastBlinkEnd : Infinity;
    this.lastBlinkEnd = blink.end;
    const quickRepeat = sincePrev <= this.cfg.blink.doubleWindowMs;
    const gap = quickRepeat ? `, ${Math.round(sincePrev)} ms after the previous one` : '';

    if (this.frozen) { this.log(`${kind}${gap} ignored: a pursuit slider is being followed`); return; }

    // Which target was armed just before the eyes closed?
    let entry;
    if (blink.simulated) {
      entry = { id: this.focusId, armed: this.armed, progress: this.progress.get(this.focusId) || 0 };
    } else {
      const before = blink.start - this.cfg.gaze.blinkLookbackMs;
      entry = [...this.history].reverse().find((h) => h.t <= before) || this.history[0];
    }
    if (!entry || !entry.id) { this.log(`${kind}${gap} ignored: not looking at any target`); return; }
    if (!entry.armed) {
      this.log(`${kind}${gap} ignored: looking at "${entry.id}" but dwell is only `
        + `${Math.round(entry.progress * 100)}% (needs 100%, ${this.settings.dwellMs} ms)`);
      return;
    }
    const target = this.targets.get(entry.id);
    if (!target || !this.activeGroups.has(target.group)) {
      this.log(`${kind}${gap} ignored: "${entry.id}" is no longer active`);
      return;
    }

    if (!target.onDoubleBlink) {
      const note = quickRepeat ? ' (quick repeat, but this target has no double-blink action: counted as single)' : '';
      if (target.onBlink) this.activate(target, 'onBlink', `single ${kind}${gap}${note}`);
      else this.log(`single ${kind} on "${target.id}": no action defined`);
      return;
    }

    // Target has a double-blink action: wait briefly for a second blink.
    const pending = this.pendingDouble;
    if (pending && pending.id === target.id && blink.end - pending.time <= this.cfg.blink.doubleWindowMs) {
      clearTimeout(pending.timer);
      this.pendingDouble = null;
      this.activate(target, 'onDoubleBlink', `DOUBLE ${kind}${gap}`);
      return;
    }
    if (pending) clearTimeout(pending.timer);
    this.log(`${kind} on "${target.id}": waiting ${this.cfg.blink.doubleWindowMs} ms for a second blink`);
    this.pendingDouble = {
      id: target.id,
      time: blink.end,
      timer: setTimeout(() => {
        this.pendingDouble = null;
        if (target.onBlink) this.activate(target, 'onBlink', 'no second blink → single blink');
        else this.log(`no second blink → single blink on "${target.id}": no single-blink action defined`);
      }, this.cfg.blink.doubleWindowMs),
    };
  }

  /**
   * Run a target's action. Handlers may return a short text describing what
   * they did; it is shown in the debug log.
   */
  activate(target, handler, gesture) {
    this.progress.set(target.id, 0);       // a new full dwell is needed to activate again
    if (target.id === this.focusId) this.setFocus(target.id, false);
    for (const el of elementsOf(target)) {
      el.classList.add('gaze-activated');
      setTimeout(() => el.classList.remove('gaze-activated'), 250);
    }
    const result = target[handler]();
    this.log(`${gesture} on "${target.id}" → ${result || '(action ran)'}`);
  }
}
