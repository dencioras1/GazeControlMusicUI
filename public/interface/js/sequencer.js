/**
 * sequencer.js — the music data and the playback clock.
 *
 * Data: a grid of tappers x steps. pattern[tapper][step] is true when that
 * tapper hits on that beat.
 *
 * Playback runs in the browser: every beat the clock fires a 'step' event with
 * the tappers that hit on it. The page uses it for visual feedback; later it
 * can also drive the device (see serial-output.js).
 *
 * Transport:
 *   play()   start, or continue from where it was paused
 *   pause()  stop at the current position
 *   stop()   stop and go back to the first beat
 *
 * Events (subscribe with on(name, fn)):
 *   'step'      { step, tappers }   a beat was played
 *   'pattern'   { tapper, step }    a note changed (step = null: whole tapper cleared)
 *   'select'    tapper              another tapper was selected
 *   'transport' state               'playing' | 'paused' | 'stopped'
 */
export class Sequencer {
  /** @param cfg CONFIG.sequencer */
  constructor(cfg) {
    this.tappers = cfg.tappers;
    this.steps = cfg.steps;
    this.bpm = cfg.bpm;
    this.pattern = Array.from({ length: this.tappers }, () => Array(this.steps).fill(false));
    this.selected = 0;           // tapper shown in the beat pie
    this.state = 'stopped';
    this.position = 0;           // next beat to play
    this.lastStep = null;        // beat played most recently (null after stop)
    this.timer = null;
    this.handlers = { step: [], pattern: [], select: [], transport: [] };
  }

  on(name, fn) { this.handlers[name].push(fn); }
  emit(name, data) { for (const fn of this.handlers[name]) fn(data); }

  /** Duration of one beat in ms. */
  get stepMs() { return 60000 / this.bpm; }

  // ----- pattern -----

  select(tapper) {
    this.selected = tapper;
    this.emit('select', tapper);
  }

  toggle(tapper, step) {
    this.pattern[tapper][step] = !this.pattern[tapper][step];
    this.emit('pattern', { tapper, step });
  }

  clear(tapper) {
    this.pattern[tapper].fill(false);
    this.emit('pattern', { tapper, step: null });
  }

  hasNotes(tapper) { return this.pattern[tapper].some(Boolean); }

  // ----- transport -----

  play() {
    if (this.state === 'playing') return;
    this.setState('playing');
    // Self-correcting timer: each beat is scheduled from the planned time of the
    // previous one, so small setTimeout delays don't add up over time.
    let next = performance.now();
    const tick = () => {
      this.playStep();
      next += this.stepMs;
      this.timer = setTimeout(tick, Math.max(0, next - performance.now()));
    };
    tick();
  }

  pause() {
    if (this.state !== 'playing') return;
    clearTimeout(this.timer);
    this.setState('paused');
  }

  stop() {
    clearTimeout(this.timer);
    this.position = 0;
    this.lastStep = null;
    this.setState('stopped');
  }

  setState(state) {
    this.state = state;
    this.emit('transport', state);
  }

  playStep() {
    const step = this.position;
    const tappers = [];
    for (let t = 0; t < this.tappers; t++) if (this.pattern[t][step]) tappers.push(t);
    this.lastStep = step;
    this.position = (step + 1) % this.steps;
    this.emit('step', { step, tappers });
  }
}
