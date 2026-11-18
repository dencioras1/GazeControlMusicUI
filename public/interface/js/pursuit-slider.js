/**
 * pursuit-slider.js — a knob-like control for one number, operated by gaze.
 *
 * Layout: a large dial with the value in the middle, and two small circles on
 * the dial's edge on opposite sides: '+' on the right, '−' on the left.
 *
 * Interaction ("smooth pursuit": your eyes follow a moving object):
 *   1. Look at '+' or '−' until it is armed, then blink.
 *   2. Both circles start travelling around the dial ('+' clockwise,
 *      '−' counter-clockwise) and the value keeps going up or down.
 *   3. Keep following the circle you blinked on with your eyes.
 *   4. Look away (longer than pursuit.graceMs) and it stops: the value is set
 *      and the circles return to their start position.
 *
 * While the slider runs, all other gaze targets are frozen so nothing else
 * gets activated by accident.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Geometry in SVG units (200 x 200, centred on 0, 0)
const DIAL_R = 70;     // circle the knobs travel on
const KNOB_R = 18;     // size of the + and − circles

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export class PursuitSlider {
  /**
   * @param container        element the slider is placed in
   * @param options.id       prefix for gaze target ids
   * @param options.label    name shown under the value
   * @param options.min, max, step, value
   * @param options.format   (value) => text shown in the middle
   * @param options.onChange (value) => void, called on every change
   * @param options.targets  GazeTargets instance
   * @param options.group    gaze target group (only active while visible)
   * @param options.cfg      CONFIG.pursuit
   * @param options.debug    CONFIG.debug
   * @param options.getCursorRadius () => current cursor radius in px
   */
  constructor(container, opts) {
    Object.assign(this, opts);
    this.angle = 0;          // how far the knobs have travelled (degrees)
    this.active = null;      // { dir: +1 | -1 } while being followed

    this.svg = svgEl('svg', { viewBox: '-100 -100 200 200', class: 'pursuit-svg' });
    this.svg.appendChild(svgEl('circle', { r: DIAL_R, class: 'dial' }));
    this.valueText = svgEl('text', { y: -4, class: 'pursuit-value' });
    const labelText = svgEl('text', { y: 18, class: 'pursuit-label' });
    labelText.textContent = this.label;
    this.svg.append(this.valueText, labelText);

    this.knobs = [+1, -1].map((dir) => {
      const g = svgEl('g', { class: 'knob' });
      g.appendChild(svgEl('circle', { r: KNOB_R }));
      const t = svgEl('text', { class: 'knob-label' });
      t.textContent = dir > 0 ? '+' : '−';
      g.appendChild(t);
      this.svg.appendChild(g);
      return { dir, g };
    });
    container.appendChild(this.svg);

    // Screen geometry, refreshed when the slider changes size. Call measure()
    // after making the slider visible (app.js does this when opening the dialog).
    this.geom = { cx: 0, cy: 0, scale: 1 };
    new ResizeObserver(() => this.measure()).observe(this.svg);
    window.addEventListener('resize', () => this.measure());
    this.measure();

    for (const k of this.knobs) {
      this.targets.add({
        id: `${this.id}-${k.dir > 0 ? 'plus' : 'minus'}`,
        el: k.g,
        group: this.group,
        contains: (x, y) => {
          const p = this.knobScreenPos(k.dir);
          return Math.hypot(x - p.x, y - p.y) <= KNOB_R * this.geom.scale;
        },
        onBlink: () => this.start(k.dir),
      });
    }
    this.render();
  }

  /** Read the slider's current position and size on screen. */
  measure() {
    const r = this.svg.getBoundingClientRect();
    this.geom = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, scale: Math.min(r.width, r.height) / 200 };
  }

  /** Knob centre in SVG units. '+' starts at the right (90°), '−' at the left (270°). */
  knobPos(dir) {
    const deg = (dir > 0 ? 90 : 270) + this.angle;
    const a = ((deg - 90) * Math.PI) / 180;
    return [DIAL_R * Math.cos(a), DIAL_R * Math.sin(a)];
  }

  knobScreenPos(dir) {
    const [x, y] = this.knobPos(dir);
    const { cx, cy, scale } = this.geom;
    return { x: cx + x * scale, y: cy + y * scale };
  }

  render() {
    this.valueText.textContent = this.format(this.value);
    for (const k of this.knobs) {
      const [x, y] = this.knobPos(k.dir);
      k.g.setAttribute('transform', `translate(${x} ${y})`);
      k.g.classList.toggle('following', !!this.active && this.active.dir === k.dir);
    }
  }

  setValue(v) {
    this.value = Math.min(this.max, Math.max(this.min, v));
    this.render();
  }

  /** Start following: called by a blink on '+' (dir +1) or '−' (dir -1). */
  start(dir) {
    if (this.active) return 'pursuit already running';
    this.active = { dir, lastOnTarget: performance.now(), stepAcc: 0, last: performance.now() };
    this.targets.setFrozen(true);
    this.render();
    const tick = () => {
      if (!this.active) return;
      this.update(performance.now());
      if (this.active) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return `start ${this.label} pursuit: ${dir > 0 ? 'increase (+)' : 'decrease (−)'} from ${this.format(this.value)}`;
  }

  /** One animation frame while following. */
  update(now) {
    const a = this.active;
    const dt = Math.min(now - a.last, 100) / 1000;
    a.last = now;

    // Move both knobs ('+' clockwise, '−' counter-clockwise)
    this.angle = (this.angle + a.dir * this.cfg.degPerSecond * dt + 360) % 360;

    // Change the value at a steady rate
    a.stepAcc += this.cfg.stepsPerSecond * dt;
    while (a.stepAcc >= 1) {
      a.stepAcc -= 1;
      const before = this.value;
      this.setValue(this.value + a.dir * this.step);
      if (this.value !== before) this.onChange(this.value);
    }

    // Is the gaze still on the knob that was blinked on?
    const gaze = this.targets.lastPoint;
    const p = this.knobScreenPos(a.dir);
    const tolerance = KNOB_R * this.geom.scale + this.getCursorRadius() * this.cfg.followFactor;
    if (gaze && Math.hypot(gaze.x - p.x, gaze.y - p.y) <= tolerance) a.lastOnTarget = now;

    if (now - a.lastOnTarget > this.cfg.graceMs) this.stop();
    else this.render();
  }

  /** Stop following: the value stays, the knobs return to their start. */
  stop() {
    if (this.debug?.logBlinks) console.info(`[pursuit] ${this.label} stopped (gaze left the circle): set to ${this.format(this.value)}`);
    this.active = null;
    this.angle = 0;
    this.targets.setFrozen(false);
    this.render();
  }
}
