/**
 * app.js — builds the gaze interface and connects all parts.
 *
 * Parts (each in its own file):
 *   GazeInput      gaze points + blinks, from the webcam or the mouse
 *   GazeTargets    decides which UI element is looked at and activates it on a blink
 *   Sequencer      the 8 x 8 pattern and the playback clock
 *   PieMenu        the tapper pie (left) and the beat pie (right)
 *   PursuitSlider  the dwell-time and cursor-size controls
 *   serial-output  hooks where messages to the RhythmSquid will be sent
 *
 * Data flow:
 *   GazeInput --gaze/blink--> GazeTargets --onBlink--> Sequencer (change data)
 *   Sequencer --events--> render functions below (update what you see)
 *                     \--> serial-output (send to the device)
 */
import { CONFIG } from './config.js';
import { GazeInput } from './gaze-input.js';
import { GazeTargets } from './gaze-targets.js';
import { Sequencer } from './sequencer.js';
import { PieMenu } from './pie-menu.js';
import { PursuitSlider } from './pursuit-slider.js';
import { runCalibration } from './calibration.js';
import * as serialOut from './serial-output.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/** Live settings, changed by the pursuit sliders and read by GazeTargets. */
const settings = {
  dwellMs: CONFIG.gaze.defaultDwellMs,
  cursorRadius: CONFIG.gaze.defaultCursorRadius,
};

const gazeInput = new GazeInput(CONFIG);
const targets = new GazeTargets({ cursorEl: $('gazeCursor'), settings, cfg: CONFIG });
const seq = new Sequencer(CONFIG.sequencer);

// ---------------------------------------------------------------------------
// Pies
// ---------------------------------------------------------------------------

/** Left: one segment per tapper. Blink on a segment to select that tapper. */
const tapperPie = new PieMenu($('tapperPie'), {
  id: 'tapperPie',
  labels: Array.from({ length: seq.tappers }, (_, i) => String(i + 1)),
  targets,
  onSegmentBlink: (i) => { seq.select(i); return `select tapper ${i + 1}`; },
});

/** Right: one segment per beat of the selected tapper. Blink toggles a note,
 *  double blink on the hub clears the tapper's sequence. */
const beatPie = new PieMenu($('beatPie'), {
  id: 'beatPie',
  labels: Array.from({ length: seq.steps }, (_, i) => String(i + 1)),
  targets,
  onSegmentBlink: (step) => {
    seq.toggle(seq.selected, step);
    return `note ${seq.pattern[seq.selected][step] ? 'ON' : 'OFF'}: tapper ${seq.selected + 1}, beat ${step + 1}`;
  },
  onHubDoubleBlink: () => { seq.clear(seq.selected); return `clear all beats of tapper ${seq.selected + 1}`; },
});

// ---------------------------------------------------------------------------
// Buttons (Play / Pause / Stop / Dwell / Cursor)
// ---------------------------------------------------------------------------

/** Registers a plain element as a gaze button. */
function addButton(id, onBlink, group = 'main') {
  const el = $(id);
  targets.add({
    id,
    el,
    group,
    onBlink,
    contains: (x, y) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },
  });
}

// Each action returns a short description for the blink debug log.
addButton('btnPlay', () => { const was = seq.state; seq.play(); return was === 'playing' ? 'play (already playing)' : `play (from beat ${seq.lastStep + 1})`; });
addButton('btnPause', () => { const was = seq.state; seq.pause(); return was === 'playing' ? `pause at beat ${seq.lastStep + 1}` : `pause (not playing, nothing to do)`; });
addButton('btnStop', () => { seq.stop(); return 'stop, back to beat 1'; });
addButton('btnDwell', () => { openSettings('dwell'); return 'open dwell-time slider'; });
addButton('btnCursor', () => { openSettings('cursor'); return 'open cursor-size slider'; });

// ---------------------------------------------------------------------------
// Settings dialog with the pursuit sliders
// ---------------------------------------------------------------------------

const sliders = {
  dwell: new PursuitSlider($('sliderDwell'), {
    id: 'sliderDwell', label: 'dwell time', group: 'modal-dwell',
    ...CONFIG.settings.dwell, value: settings.dwellMs,
    format: (v) => `${v} ms`,
    onChange: (v) => { settings.dwellMs = v; renderButtons(); },
    targets, cfg: CONFIG.pursuit, debug: CONFIG.debug, getCursorRadius: () => settings.cursorRadius,
  }),
  cursor: new PursuitSlider($('sliderCursor'), {
    id: 'sliderCursor', label: 'cursor size', group: 'modal-cursor',
    ...CONFIG.settings.cursor, value: settings.cursorRadius,
    format: (v) => `${v} px`,
    onChange: (v) => { settings.cursorRadius = v; renderButtons(); },
    targets, cfg: CONFIG.pursuit, debug: CONFIG.debug, getCursorRadius: () => settings.cursorRadius,
  }),
};

addButton('btnDone', () => { closeSettings(); return `close settings (dwell ${settings.dwellMs} ms, cursor ${settings.cursorRadius} px)`; }, 'modal');

/** Show the dialog with one slider; only its targets and "Done" react. */
function openSettings(which) {
  $('sliderDwell').hidden = which !== 'dwell';
  $('sliderCursor').hidden = which !== 'cursor';
  $('modal').classList.add('show');
  sliders[which].measure();             // its size is only known once visible
  targets.setActiveGroups(['modal', `modal-${which}`]);
}

function closeSettings() {
  $('modal').classList.remove('show');
  targets.setActiveGroups(['main']);
}

// ---------------------------------------------------------------------------
// Rendering: keep what you see in line with the sequencer state
// ---------------------------------------------------------------------------

const STATE_TEXT = { playing: '▶ playing', paused: '❚❚ paused', stopped: '■ stopped' };

function renderTapperPie() {
  for (let t = 0; t < seq.tappers; t++) {
    tapperPie.setSegmentClass(t, 'selected', t === seq.selected);
    tapperPie.setSegmentClass(t, 'has-notes', seq.hasNotes(t));
  }
  tapperPie.setHubText('Tappers', STATE_TEXT[seq.state]);
}

function renderBeatPie() {
  const row = seq.pattern[seq.selected];
  for (let s = 0; s < seq.steps; s++) {
    beatPie.setSegmentClass(s, 'note', row[s]);
    beatPie.setSegmentClass(s, 'playhead', s === seq.lastStep);
  }
  beatPie.setHubText(`Tapper ${seq.selected + 1}`, 'double blink: clear');
  $('beatPieTitle').textContent = `Beats of tapper ${seq.selected + 1}`;
}

function renderButtons() {
  $('btnPlay').classList.toggle('active', seq.state === 'playing');
  $('btnPause').classList.toggle('active', seq.state === 'paused');
  $('dwellValue').textContent = `${settings.dwellMs} ms`;
  $('cursorValue').textContent = `${settings.cursorRadius} px`;
}

// ---------------------------------------------------------------------------
// Sequencer events -> screen + device
// ---------------------------------------------------------------------------

seq.on('select', () => { renderTapperPie(); renderBeatPie(); });

seq.on('pattern', ({ tapper, step }) => {
  renderTapperPie();
  renderBeatPie();
  if (step === null) serialOut.sequenceCleared(tapper, seq.steps);
  else serialOut.noteChanged(tapper, step, seq.pattern[tapper][step]);
});

seq.on('transport', (state) => {
  renderTapperPie();
  renderBeatPie();
  renderButtons();
  serialOut.transportChanged(state, seq.bpm);
});

seq.on('step', ({ step, tappers }) => {
  // Light up every tapper that hits on this beat, for most of the beat.
  const flashMs = Math.min(250, seq.stepMs * 0.6);
  for (const t of tappers) tapperPie.flashSegment(t, 'playing', flashMs);
  renderBeatPie();
  serialOut.stepPlayed(step, tappers);
});

// ---------------------------------------------------------------------------
// Gaze input -> targets
// ---------------------------------------------------------------------------

gazeInput.on('gaze', ({ x, y, t }) => targets.handleGaze(x, y, t));
gazeInput.on('blink', (blink) => targets.handleBlink(blink));
gazeInput.on('eyes', (closed) => $('gazeCursor').classList.toggle('eyes-closed', closed));

// ---------------------------------------------------------------------------
// Developer toolbar (operated with the mouse by the experimenter)
// ---------------------------------------------------------------------------

function setStatus(text) { $('devStatus').textContent = text; }

function renderDevBar() {
  const wg = gazeInput.mode === 'webgazer';
  $('devEye').disabled = wg;
  $('devMouse').disabled = gazeInput.mode === 'mouse';
  $('devCalibrate').disabled = !wg;
  $('devCamera').disabled = !wg;
}

$('devMouse').onclick = () => {
  gazeInput.useMouse($('devbar'));
  targets.resetState();
  setStatus('Input: mouse — move = gaze, click or B = blink (click twice quickly = double blink)');
  renderDevBar();
};

$('devEye').onclick = async () => {
  setStatus('Starting eye tracker… allow camera access');
  try {
    await gazeInput.useWebGazer();
    targets.resetState();
    window.webgazer.showVideoPreview($('devCamera').checked);
    setStatus('Input: eye tracker — calibrate first. Blinks shorter than '
      + `${CONFIG.blink.minMs} ms are ignored, so blink deliberately.`);
  } catch (e) {
    setStatus(`Eye tracker failed: ${e?.message || e}`);
    $('devMouse').onclick();
  }
  renderDevBar();
};

$('devCalibrate').onclick = async () => {
  const before = [...targets.activeGroups];
  targets.setActiveGroups([]);          // nothing reacts to gaze during calibration
  const done = await runCalibration(window.webgazer);
  targets.setActiveGroups(before);
  setStatus(done ? 'Calibration done' : 'Calibration cancelled');
};

$('devCamera').onchange = () => {
  if (gazeInput.mode === 'webgazer') window.webgazer.showVideoPreview($('devCamera').checked);
};

window.addEventListener('beforeunload', () => gazeInput.stop());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

renderTapperPie();
renderBeatPie();
renderButtons();
$('devMouse').onclick();   // start in mouse mode, so the page works without a camera
