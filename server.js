import express from 'express';
import { SerialPort } from 'serialport';

const HTTP_PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static('public'));
// WebGazer.js + its MediaPipe face-mesh assets, served locally (no CDN needed)
app.use('/vendor/webgazer', express.static('node_modules/webgazer/dist'));

// The RhythmSquid talks in binary 3-byte messages, not text (protocol:
// rhythmsquid/software/RhythmSquid/include/SerialControlInterface.h).
// Sending: the text box takes hex bytes ("90 00 7F") and sends exactly those.
// Receiving: bytes are split into messages and logged as hex + a description.

let port = null;       // currently open SerialPort
const log = [];        // recent log entries
let nextLogId = 1;     // entries are fetched by id (many arrive in the same ms)
const LOG_MAX = 2000;

// kind: 'info' | 'tx' (sent) | 'led' (pad light) | 'cc' (fader) | 'dimmer' | 'raw'
function pushLog(kind, line) {
  log.push({ id: nextLogId++, time: Date.now(), kind, line });
  if (log.length > LOG_MAX) log.shift();
}

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// "90 00 7F" / "0x90,0x00,0x7f" -> Buffer [0x90, 0x00, 0x7F]
function parseHex(text) {
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('Message is empty');
  return Buffer.from(tokens.map((t) => {
    const m = /^(?:0x)?([0-9a-f]{1,2})$/i.exec(t);
    if (!m) throw new Error(`"${t}" is not a hex byte (use 00-FF, e.g. 90 00 7F)`);
    return parseInt(m[1], 16);
  }));
}

const LED_NAMES = { 0: 'off', 1: 'playhead + hit', 3: 'hit', 5: 'playhead' };

function describeControl(status, d1, d2) {
  if (status === 0x90 && d1 < 64)
    return { kind: 'led', text: `pad ${d1} (ch ${(d1 % 8) + 1}, step ${Math.floor(d1 / 8) + 1}) light: ${LED_NAMES[d2] ?? d2}` };
  if (status === 0xB0 && d1 >= 48 && d1 <= 55)
    return { kind: 'cc', text: `ch ${d1 - 47} strike force = ${d2}` };
  if (status === 0xB0 && d1 === 56)
    return { kind: 'cc', text: `tempo = ${d2}` };
  return { kind: 'raw', text: 'unknown message' };
}

// Splits the incoming byte stream into:
//  - control messages: status byte (0x80-0xFE) + 2 data bytes
//  - dimmer packets for the driver board: FF FF board len(4) cmd ch value checksum
//  - stray bytes that belong to neither (logged as-is)
function createRxParser() {
  let msg = [];       // control message in progress
  let dimmer = null;  // dimmer packet in progress, or null
  let stray = [];

  const flushStray = () => {
    if (stray.length) pushLog('raw', `< ${hex(stray)}   (not part of a message)`);
    stray = [];
  };
  const dropPartialMsg = () => {
    if (msg.length) pushLog('raw', `< ${hex(msg)}   (incomplete message)`);
    msg = [];
  };

  function feed(byte) {
    if (dimmer) {
      if (dimmer.length === 1 && byte !== 0xFF) {
        stray.push(0xFF);  // lone FF, not a packet header
        dimmer = null;
        feed(byte);
        return;
      }
      dimmer.push(byte);
      const len = dimmer[3];
      if (dimmer.length === 4 && len > 32) {  // corrupt length, don't swallow the stream
        stray.push(...dimmer);
        dimmer = null;
      } else if (dimmer.length >= 4 && dimmer.length === 4 + len) {
        const text = len === 4
          ? `dimmer packet: board ${dimmer[2]}, ch ${dimmer[5]}, value ${dimmer[6]}`
          : 'dimmer packet';
        pushLog('dimmer', `< ${hex(dimmer)}   ${text}`);
        dimmer = null;
      }
      return;
    }

    if (byte === 0xFF) {
      flushStray();
      dropPartialMsg();
      dimmer = [byte];
      return;
    }

    if (byte >= 0x80) {
      flushStray();
      dropPartialMsg();
      msg = [byte];
      return;
    }

    if (msg.length) {
      msg.push(byte);
      if (msg.length === 3) {
        const { kind, text } = describeControl(msg[0], msg[1], msg[2]);
        pushLog(kind, `< ${hex(msg)}   ${text}`);
        msg = [];
      }
      return;
    }

    stray.push(byte);
  }

  return (chunk) => {
    for (const byte of chunk) feed(byte);
    flushStray();  // show stray bytes promptly instead of waiting for the next message
  };
}

// List available serial ports (Arduinos usually show up as /dev/ttyACM* or /dev/ttyUSB*)
app.get('/api/ports', async (_req, res) => {
  try {
    // Put USB devices (Arduinos) first, legacy /dev/ttyS* ports last
    const isUsb = (p) => /ttyACM|ttyUSB|usbmodem|usbserial|COM/i.test(p.path) || p.vendorId;
    const ports = (await SerialPort.list()).sort((a, b) => !!isUsb(b) - !!isUsb(a));
    res.json({ ports, open: port?.isOpen ? port.path : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open (connect to) a serial port. The RhythmSquid runs at 115200.
app.post('/api/connect', async (req, res) => {
  const { path, baudRate = 115200 } = req.body || {};
  if (!path) return res.status(400).json({ error: 'No port path given' });

  try {
    if (port?.isOpen) await new Promise((r) => port.close(() => r()));

    port = new SerialPort({ path, baudRate: Number(baudRate), autoOpen: false });
    await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));

    port.on('data', createRxParser());
    port.on('close', () => pushLog('info', '[port closed]'));
    port.on('error', (err) => pushLog('info', `[error] ${err.message}`));

    pushLog('info', `[connected to ${path} @ ${baudRate}]`);
    res.json({ ok: true, path });
  } catch (err) {
    port = null;
    res.status(500).json({ error: err.message });
  }
});

// Close the serial port
app.post('/api/disconnect', (_req, res) => {
  if (!port?.isOpen) return res.json({ ok: true });
  port.close((err) => (err ? res.status(500).json({ error: err.message }) : res.json({ ok: true })));
});

// Send hex bytes to the Arduino, exactly as typed (no newline added)
app.post('/api/send', (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== 'string') return res.status(400).json({ error: 'Message is empty' });

  let bytes;
  try { bytes = parseHex(message); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  if (!port?.isOpen) return res.status(400).json({ error: 'Not connected to a serial port' });

  port.write(bytes, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    port.drain(() => {
      pushLog('tx', `> ${hex(bytes)}`);
      res.json({ ok: true });
    });
  });
});

// Log entries newer than ?since=<id> (polled by the page)
app.get('/api/log', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(log.filter((l) => l.id > since));
});

app.listen(HTTP_PORT, () => {
  console.log(`Open http://localhost:${HTTP_PORT} in your browser`);
});
