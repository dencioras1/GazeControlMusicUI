/**
 * gaze-input.js — where gaze points and blinks come from.
 *
 * The rest of the interface never talks to the webcam or the mouse directly.
 * It listens to this module, which emits three kinds of events:
 *   'gaze'  {x, y, t}          a new gaze position in page pixels
 *   'blink' {start, end, duration, simulated}
 *                               one deliberate blink (natural blinks are filtered out)
 *   'eyes'  true | false        eyes just closed / opened (gaze is paused while closed)
 *
 * Two input sources, only one active at a time:
 *   - 'webgazer': WebGazer.js predicts where you look from the webcam image, and
 *                 BlinkDetector measures from the same face model how open your eyes are.
 *   - 'mouse':    for developing without a camera. The mouse pointer is the gaze
 *                 point, a left click or the B key is a blink (click twice quickly
 *                 for a double blink).
 */

// ---------------------------------------------------------------------------
// Blink detection
// ---------------------------------------------------------------------------

/*
 * Eye landmarks in the MediaPipe face mesh that WebGazer uses (468 points).
 * Per eye, six points: two eye corners and two pairs above/below the eye.
 * Order: [corner, top, top, corner, bottom, bottom].
 */
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE = [362, 385, 387, 263, 373, 380];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * "Eye aspect ratio": eye height divided by eye width. About 0.25-0.35 for an
 * open eye, close to 0 for a closed eye. Dividing by the width makes it
 * independent of how far you sit from the camera.
 */
function eyeOpenness(points, idx) {
  const [c1, t1, t2, c2, b2, b1] = idx.map((i) => points[i]);
  return (dist(t1, b1) + dist(t2, b2)) / (2 * dist(c1, c2));
}

/**
 * Turns per-frame eye openness into blink events.
 *
 * Everyone's eyes are a different shape, so instead of a fixed threshold it
 * learns your normal open value (median of recent frames) and counts the eyes
 * as closed when openness drops below a fraction of it. Only closures between
 * blink.minMs and blink.maxMs count, which filters out natural, quick blinks.
 */
class BlinkDetector {
  constructor(cfg, debug, onBlink, onEyes) {
    this.cfg = cfg;
    this.debug = debug;
    this.onBlink = onBlink;
    this.onEyes = onEyes;
    this.openSamples = [];   // recent openness values while the eyes were open
    this.closed = false;
    this.closedAt = 0;
  }

  /** Feed one camera frame of face landmarks. */
  update(points, now) {
    const value = (eyeOpenness(points, LEFT_EYE) + eyeOpenness(points, RIGHT_EYE)) / 2;
    if (!Number.isFinite(value)) return;

    if (!this.closed) {
      this.openSamples.push(value);
      if (this.openSamples.length > this.cfg.baselineSamples) this.openSamples.shift();
    }
    if (this.openSamples.length < this.cfg.warmupSamples) return;

    const sorted = [...this.openSamples].sort((a, b) => a - b);
    const baseline = sorted[Math.floor(sorted.length / 2)];

    if (!this.closed && value < baseline * this.cfg.closedRatio) {
      this.closed = true;
      this.closedAt = now;
      this.onEyes(true);
    } else if (this.closed && value > baseline * this.cfg.reopenRatio) {
      this.closed = false;
      this.onEyes(false);
      const duration = now - this.closedAt;
      if (duration >= this.cfg.minMs && duration <= this.cfg.maxMs) {
        this.onBlink({ start: this.closedAt, end: now, duration, simulated: false });
      } else if (this.debug?.logBlinks) {
        // Hidden by default: enable "Verbose" in the console's level filter to see these.
        const why = duration < this.cfg.minMs ? `shorter than ${this.cfg.minMs} ms (natural blink)` : `longer than ${this.cfg.maxMs} ms`;
        console.debug(`[eyes] closed for ${Math.round(duration)} ms: not a command, ${why}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Input sources
// ---------------------------------------------------------------------------

export class GazeInput {
  /** @param cfg the full CONFIG object */
  constructor(cfg) {
    this.cfg = cfg;
    this.mode = 'none';         // 'none' | 'mouse' | 'webgazer'
    this.eyesClosed = false;
    this.handlers = { gaze: [], blink: [], eyes: [] };
    this.cleanup = [];          // functions that undo the current source's setup
    this.blinkDetector = new BlinkDetector(
      cfg.blink,
      cfg.debug,
      (blink) => this.emit('blink', blink),
      (closed) => { this.eyesClosed = closed; this.emit('eyes', closed); },
    );
  }

  on(name, fn) { this.handlers[name].push(fn); }
  emit(name, data) { for (const fn of this.handlers[name]) fn(data); }

  /** Stop the current source (releases the webcam). */
  stop() {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.mode = 'none';
    this.eyesClosed = false;
  }

  /**
   * Mouse as gaze. Left clicks (and the B key) are blinks, except clicks inside
   * ignoreArea (the developer toolbar), so its buttons keep working normally.
   */
  useMouse(ignoreArea) {
    this.stop();
    const blink = () => {
      const now = performance.now();
      this.emit('blink', { start: now, end: now, duration: 0, simulated: true });
    };
    // An eye tracker sends gaze samples continuously, even when you look at one
    // spot. The mouse only sends events when it moves, so the latest position
    // is repeated at a steady rate; otherwise dwell would stop filling up while
    // the mouse rests on a target.
    let last = null;
    const onMove = (e) => { last = { x: e.clientX, y: e.clientY }; };
    const sampler = setInterval(() => {
      if (last) this.emit('gaze', { x: last.x, y: last.y, t: performance.now() });
    }, this.cfg.mouse.sampleMs);
    const onDown = (e) => {
      if (e.button !== 0 || ignoreArea.contains(e.target)) return;
      e.preventDefault();
      blink();
    };
    const onKey = (e) => { if ((e.key === 'b' || e.key === 'B') && !e.repeat) blink(); };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => {
      clearInterval(sampler);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    });
    this.mode = 'mouse';
  }

  /** Webcam eye tracking through WebGazer.js (asks for camera permission). */
  async useWebGazer() {
    this.stop();
    const wg = window.webgazer;
    wg.params.faceMeshSolutionPath = '/vendor/webgazer/mediapipe/face_mesh';
    wg.setRegression('ridge');
    wg.setGazeListener((data) => {
      // Gaze predictions are unreliable while the eyes are closed: skip them.
      if (this.mode !== 'webgazer' || !data || this.eyesClosed) return;
      this.emit('gaze', { x: data.x, y: data.y, t: performance.now() });
    });
    await wg.begin();
    wg.showPredictionPoints(false);       // the interface draws its own cursor
    wg.applyKalmanFilter(true);           // smooths the jittery predictions
    wg.removeMouseEventListeners();       // only learn from clicks during calibration
    this.mode = 'webgazer';

    // Blink detection: read the face landmarks whenever WebGazer has a new frame.
    let raf = 0, lastPoints = null;
    const loop = () => {
      const points = wg.getTracker()?.getPositions?.();
      if (points && points !== lastPoints && points.length >= 468) {
        lastPoints = points;
        this.blinkDetector.update(points, performance.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    this.cleanup.push(() => { cancelAnimationFrame(raf); wg.end(); });
  }
}
