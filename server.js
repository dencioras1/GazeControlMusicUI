import express from 'express';
import { SerialPort, ReadlineParser } from 'serialport';

const HTTP_PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static('public'));

let port = null;       // currently open SerialPort
const log = [];        // recent lines received from the Arduino

function pushLog(line) {
  log.push({ time: Date.now(), line });
  if (log.length > 200) log.shift();
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

// Open (connect to) a serial port
app.post('/api/connect', async (req, res) => {
  const { path, baudRate = 9600 } = req.body || {};
  if (!path) return res.status(400).json({ error: 'No port path given' });

  try {
    if (port?.isOpen) await new Promise((r) => port.close(() => r()));

    port = new SerialPort({ path, baudRate: Number(baudRate), autoOpen: false });
    await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));

    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => pushLog(line.trim()));
    port.on('close', () => pushLog('[port closed]'));
    port.on('error', (err) => pushLog(`[error] ${err.message}`));

    pushLog(`[connected to ${path} @ ${baudRate}]`);
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

// Send a string to the Arduino (a newline is appended so the sketch can read line by line)
app.post('/api/send', (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== 'string' || message.length === 0)
    return res.status(400).json({ error: 'Message is empty' });
  if (!port?.isOpen) return res.status(400).json({ error: 'Not connected to a serial port' });

  port.write(message + '\n', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    port.drain(() => {
      pushLog(`> ${message}`);
      res.json({ ok: true });
    });
  });
});

// Recent serial output (polled by the page)
app.get('/api/log', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(log.filter((l) => l.time > since));
});

app.listen(HTTP_PORT, () => {
  console.log(`Open http://localhost:${HTTP_PORT} in your browser`);
});
