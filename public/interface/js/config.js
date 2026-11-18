/**
 * config.js — every tunable number of the gaze interface, in one place.
 *
 * While experimenting you should only need to change values here. Each value
 * is used by exactly one module (named in the comment), so it is easy to find
 * out what a change will affect.
 */
export const CONFIG = {
  /** Sequencer (sequencer.js) */
  sequencer: {
    tappers: 8,          // number of solenoids / tappers on the RhythmSquid
    steps: 8,            // beats in the loop (8 beats = 2 bars of 4/4)
    bpm: 100,            // playback speed in beats per minute
  },

  /** Gaze targets and the area cursor (gaze-targets.js) */
  gaze: {
    defaultDwellMs: 800,      // how long you must look at a target before a blink counts
    defaultCursorRadius: 80,  // radius of the area cursor (circle around the gaze point), px
    minOverlap: 0.3,          // share of the cursor circle that must cover a target (0-1)
    decayFactor: 0.5,         // looking away drains dwell progress at this fraction of the fill speed
    maxDtMs: 200,             // gaps between gaze samples longer than this don't count as dwell
    blinkLookbackMs: 150,     // a blink is applied to the target you looked at this long before the eyes closed
    historyMs: 1500,          // how much gaze history is kept for that lookup
  },

  /** Ranges of the two pursuit sliders (app.js) */
  settings: {
    dwell:  { min: 200, max: 2000, step: 50 },  // ms
    cursor: { min: 20,  max: 250,  step: 5 },   // px
  },

  /** Blink detection from the webcam (gaze-input.js) */
  blink: {
    closedRatio: 0.6,      // eyes count as closed when their openness drops below 60% of normal
    reopenRatio: 0.7,      // ...and as open again above 70% (gap avoids flickering)
    minMs: 200,            // shorter closures are natural blinks and are ignored
    maxMs: 1000,           // longer closures are resting eyes, not a command
    doubleWindowMs: 700,   // two blinks within this time form a double blink
    baselineSamples: 90,   // camera frames used to learn your normal (open) eye openness
    warmupSamples: 20,     // no blinks are detected until this many frames were seen
  },

  /** Mouse mode (gaze-input.js) */
  mouse: {
    sampleMs: 33,          // the mouse position is sent as a gaze sample this often (~30 per second, like the eye tracker)
  },

  /** Debug output in the browser console (F12 → Console) */
  debug: {
    logBlinks: true,       // log every blink: single/double, which target, and what it did
  },

  /** Pursuit slider (pursuit-slider.js) */
  pursuit: {
    degPerSecond: 30,      // how fast the +/- circles travel around the dial (30 = one full turn in 12 s)
    stepsPerSecond: 6,     // how many value steps per second while following
    graceMs: 300,          // you may look off the moving circle this long before it stops
    followFactor: 0.5,     // extra tolerance: this fraction of the cursor radius counts as "on" the circle
  },
};
