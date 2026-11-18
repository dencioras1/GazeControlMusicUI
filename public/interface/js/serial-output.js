/**
 * serial-output.js — the ONLY place where the interface talks to the RhythmSquid.
 *
 * STATUS: not active. The driver board does not react yet (hardware problem),
 * so SEND_TO_DEVICE is false. Every function below already builds the bytes it
 * would send and, with LOG_TO_CONSOLE on, prints them in the browser console
 * (F12 → Console), so you can check them. Search for "TODO(serial)" to find
 * every spot that still needs a decision.
 *
 * How the connection works, in simple terms:
 *   - The laptop and the Arduino are connected with a USB cable (the Arduino's
 *     USB-B port). To the computer this looks like a "serial port": a line
 *     that carries bytes (numbers 0-255) one after another.
 *   - The Web Serial API lets a web page open that port directly (Chrome or
 *     Edge only; the browser asks you to pick the port). A port can only be
 *     open in one program at a time: disconnect the "Serial sender" page first.
 *   - The Arduino understands 3-byte messages, defined in
 *     rhythmsquid/software/RhythmSquid/include/SerialControlInterface.h:
 *       90 nn 7F   pad on    nn = step * 8 + tapper  (both counted from 0)
 *       90 nn 00   pad off
 *       90 nn 7F   nn = 64-71: one test hit on tapper nn - 64
 *       B0 30-37 v strike force of tapper 0-7, v = 0-127
 *       B0 38 v    tempo, v = 0-127, 0 = stopped
 *     (bytes written in hexadecimal: 90 = 144, 7F = 127, 38 = 56)
 *
 * Open design question — who keeps time?
 *   A) The Arduino runs its own sequencer (current firmware). The page only
 *      sends pad on/off and tempo. Simple, but the Arduino has no pause and no
 *      "go back to beat 1" command, and its clock is not synced to the page.
 *   B) The page keeps time (sequencer.js) and sends a test hit per tapper on
 *      every beat. Page and device always agree, but the firmware's test hit
 *      has a fixed strike force, and USB timing adds some jitter.
 *   The functions below follow A where the firmware supports it; stepPlayed()
 *   is the hook for B.
 */

const SEND_TO_DEVICE = false;   // TODO(serial): set to true once the hardware works
const LOG_TO_CONSOLE = true;     // print every message that would be sent
const BAUD_RATE = 115200;        // must match RS485_BAUD / CONTROL_BAUD in the firmware's Config.h

let port = null;
let writer = null;

const hex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Ask the user to pick the Arduino's port and open it. Call from a click handler. */
export async function connect() {
  if (!('serial' in navigator)) throw new Error('Web Serial is not supported in this browser (use Chrome or Edge)');
  port = await navigator.serial.requestPort();
  await port.open({ baudRate: BAUD_RATE });
  writer = port.writable.getWriter();
}

export async function disconnect() {
  writer?.releaseLock();
  await port?.close();
  port = null;
  writer = null;
}

/** Send raw bytes (or only log them while SEND_TO_DEVICE is false). */
async function send(bytes, description) {
  if (LOG_TO_CONSOLE) console.debug(`[serial] ${hex(bytes)}   ${description}${SEND_TO_DEVICE ? '' : '  (not sent)'}`);
  if (!SEND_TO_DEVICE || !writer) return;
  await writer.write(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// Hooks called by app.js. Each one is a place where output must be generated.
// ---------------------------------------------------------------------------

/** A note was added or removed in the beat pie. */
export function noteChanged(tapper, step, on) {
  // TODO(serial): approach A. The firmware's tapper order may be reversed on the
  // physical outputs (DrumSequencer.cpp sends channel 7 - ch); check which
  // solenoid moves once the hardware works.
  const note = step * 8 + tapper;
  send([0x90, note, on ? 0x7F : 0x00], `tapper ${tapper + 1}, beat ${step + 1}: ${on ? 'on' : 'off'}`);
}

/** All notes of one tapper were cleared (double blink on the beat pie hub). */
export function sequenceCleared(tapper, steps) {
  for (let step = 0; step < steps; step++) {
    send([0x90, step * 8 + tapper, 0x00], `tapper ${tapper + 1}, beat ${step + 1}: off (clear)`);
  }
}

/** Play / pause / stop. */
export function transportChanged(state, bpm) {
  // TODO(serial): the firmware's tempo value (0-127) is not in beats per minute;
  // the conversion is unknown. 51 is the firmware's startup default.
  // TODO(serial): pause and stop look the same to the firmware (tempo 0); it
  // cannot jump back to beat 1 on stop.
  const DEVICE_TEMPO = 51;
  const value = state === 'playing' ? DEVICE_TEMPO : 0;
  send([0xB0, 0x38, value], `tempo ${value} (${state}, page tempo ${bpm} BPM)`);
}

/** A beat was played by the page's own clock (sequencer.js). */
export function stepPlayed(step, tappers) {
  // TODO(serial): approach B would send a test hit for every tapper here:
  //   for (const t of tappers) send([0x90, 64 + t, 0x7F], `test hit tapper ${t + 1}`);
  // Unused with approach A, because the Arduino plays the pattern itself.
}
