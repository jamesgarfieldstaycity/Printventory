'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 8000;

const INSPECT_OPTIONS = { depth: 3, maxArrayLength: 20, maxStringLength: 2000, breakLength: 160 };

// Field names whose value is a credential, in JSON ("k":"v"), JS inspect (k: 'v'),
// form-encoded (k=v) or header (K: v) form. The optional \\? before quotes covers JSON
// that has itself been embedded in a JSON string (an error message holding a response).
const SECRET_FIELD_RE = /((?:\\?["'])?\b(?:x-shopify-access-token|access_token|client_secret|refresh_token)(?:\\?["'])?\s*[:=]\s*)(\\?["']?)[^"'\s&,}\\]+/gi;

function redactLogText(text) {
  return String(text)
    .replace(/https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+/gi, '[discord-webhook]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[api-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    // Shopify Admin API tokens: shpat_ (access), shpca_ (custom app), shpss_ (shared secret), shppa_ (private app)
    .replace(/\bshp(?:at|ca|ss|pa)_[A-Za-z0-9]+/gi, '[shopify-token]')
    .replace(SECRET_FIELD_RE, '$1$2[redacted]');
}

function clampLine(text) {
  if (text.length <= MAX_LINE_CHARS) return text;
  return `${text.slice(0, MAX_LINE_CHARS)} …[${text.length - MAX_LINE_CHARS} more chars]`;
}

function formatArgs(args) {
  try {
    return util.format(...args.map((arg) => {
      if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean' || arg == null) {
        return arg;
      }
      if (arg instanceof Error) return arg.stack || arg.message;
      return util.inspect(arg, INSPECT_OPTIONS);
    }));
  } catch (_) {
    return args.map((arg) => {
      try { return String(arg); } catch (err) { return '[unprintable]'; }
    }).join(' ');
  }
}

function formatLogLine(level, message) {
  return `${new Date().toISOString()} [${level}] ${clampLine(redactLogText(message))}\n`;
}

function readLogTail(filePath, maxBytes = TAIL_BYTES) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  if (!stat.size) return '';
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
      text = '[earlier log truncated]\n' + text;
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function logsZipFilename(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `printventory-logs-${stamp}.zip`;
}

function createCapture(options = {}) {
  const state = {
    installed: false,
    appBuffer: [],
    consoleBuffer: [],
    appBufferBytes: 0,
    consoleBufferBytes: 0,
    directory: null,
    appPath: null,
    consolePath: null,
    appStream: null,
    consoleStream: null,
    appBytes: 0,
    consoleBytes: 0,
    appRotating: false,
    consoleRotating: false,
    appPending: null,
    consolePending: null,
    saving: false,
    attached: new WeakSet()
  };

  function pushBuffer(kind, line) {
    const lines = kind === 'app' ? state.appBuffer : state.consoleBuffer;
    const key = kind === 'app' ? 'appBufferBytes' : 'consoleBufferBytes';
    lines.push(line);
    state[key] += line.length;
    while (state[key] > MAX_BUFFER_BYTES && lines.length > 1) {
      state[key] -= lines.shift().length;
    }
  }

  function writeLine(kind, line) {
    if (!state.directory) {
      pushBuffer(kind, line);
      return;
    }
    if (kind === 'app' ? state.appRotating : state.consoleRotating) {
      const pending = kind === 'app' ? state.appPending : state.consolePending;
      if (pending) pending.push(line);
      return;
    }
    const stream = kind === 'app' ? state.appStream : state.consoleStream;
    if (!stream) return;
    stream.write(line);
    if (kind === 'app') state.appBytes += line.length;
    else state.consoleBytes += line.length;
    const gaveUp = kind === 'app' ? state.appRotateGaveUp : state.consoleRotateGaveUp;
    if (!gaveUp && (kind === 'app' ? state.appBytes : state.consoleBytes) >= MAX_FILE_BYTES) {
      rotate(kind);
    }
  }

  function rotate(kind) {
    const rotatingKey = kind === 'app' ? 'appRotating' : 'consoleRotating';
    if (state[rotatingKey]) return;
    state[rotatingKey] = true;
    const currentPath = kind === 'app' ? state.appPath : state.consolePath;
    const stream = kind === 'app' ? state.appStream : state.consoleStream;
    const pending = [];
    if (kind === 'app') state.appPending = pending;
    else state.consolePending = pending;
    const finish = () => {
      const previous = `${currentPath}.1`;
      let renamed = !fs.existsSync(currentPath);
      try { fs.rmSync(previous, { force: true }); } catch (_) { /* ignore */ }
      try {
        if (fs.existsSync(currentPath)) {
          fs.renameSync(currentPath, previous);
          renamed = true;
        }
      } catch (_) { /* keep writing the current file if it is still locked */ }
      const next = fs.createWriteStream(currentPath, { flags: 'a' });
      next.on('error', () => {});
      let nextBytes = 0;
      if (!renamed) {
        try { nextBytes = fs.statSync(currentPath).size; } catch (_) { nextBytes = MAX_FILE_BYTES; }
      }
      if (kind === 'app') {
        state.appStream = next;
        state.appBytes = nextBytes;
        state.appRotating = false;
        state.appPending = null;
        if (!renamed) state.appRotateGaveUp = true;
      } else {
        state.consoleStream = next;
        state.consoleBytes = nextBytes;
        state.consoleRotating = false;
        state.consolePending = null;
        if (!renamed) state.consoleRotateGaveUp = true;
      }
      for (const queued of pending) {
        next.write(queued);
        if (kind === 'app') state.appBytes += queued.length;
        else state.consoleBytes += queued.length;
      }
    };
    if (stream) stream.end(finish);
    else finish();
  }

  function appendApp(level, args) {
    writeLine('app', formatLogLine(level, formatArgs(args)));
  }

  function appendConsole(level, message, sourceId, lineNumber) {
    let suffix = '';
    if (sourceId) {
      const base = path.basename(String(sourceId).split('?')[0]);
      suffix = lineNumber != null && lineNumber !== '' ? ` (${base}:${lineNumber})` : ` (${base})`;
    }
    writeLine('console', formatLogLine(level || 'info', `${message || ''}${suffix}`));
  }

  function beginCapture() {
    if (state.installed) return;
    state.installed = true;
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      console[level] = (...args) => {
        try { appendApp(level === 'log' ? 'info' : level, args); } catch (_) { /* keep logging */ }
        return original.apply(console, args);
      };
    }
  }

  function openLogDirectory(directory) {
    if (state.directory) return;
    fs.mkdirSync(directory, { recursive: true });
    state.directory = directory;
    state.appPath = path.join(directory, 'app.log');
    state.consolePath = path.join(directory, 'console.log');
    state.appStream = fs.createWriteStream(state.appPath, { flags: 'a' });
    state.consoleStream = fs.createWriteStream(state.consolePath, { flags: 'a' });
    state.appStream.on('error', () => {});
    state.consoleStream.on('error', () => {});
    try {
      state.appBytes = fs.statSync(state.appPath).size;
      state.consoleBytes = fs.statSync(state.consolePath).size;
    } catch (_) {
      state.appBytes = 0;
      state.consoleBytes = 0;
    }
    const header = formatLogLine('info', `--- log session ${process.pid} ---`);
    state.appStream.write(header);
    state.appBytes += header.length;
    if (state.appBuffer.length) {
      const pending = state.appBuffer.join('');
      state.appStream.write(pending);
      state.appBytes += pending.length;
      state.appBuffer = [];
      state.appBufferBytes = 0;
    }
    if (state.consoleBuffer.length) {
      const pending = state.consoleBuffer.join('');
      state.consoleStream.write(pending);
      state.consoleBytes += pending.length;
      state.consoleBuffer = [];
      state.consoleBufferBytes = 0;
    }
  }

  function attachWebContents(webContents) {
    if (!webContents || state.attached.has(webContents)) return;
    state.attached.add(webContents);
    webContents.on('console-message', (details, level, message, line, sourceId) => {
      try {
        const text = details && typeof details.message === 'string' ? details.message : message;
        const lvl = (details && details.level) || ['debug', 'info', 'warning', 'error'][level] || 'info';
        const src = (details && details.sourceId) || sourceId;
        const lineNo = details && details.lineNumber != null ? details.lineNumber : line;
        appendConsole(lvl, text, src, lineNo);
      } catch (_) { /* ignore */ }
    });
  }

  function flushStream(stream) {
    return new Promise((resolve) => {
      if (!stream || stream.destroyed || stream.writableEnded) {
        resolve();
        return;
      }
      stream.write('', () => resolve());
    });
  }

  async function createLogsZip(version, tailBytes = TAIL_BYTES) {
    const JSZip = require('jszip');
    await Promise.all([flushStream(state.appStream), flushStream(state.consoleStream)]);
    // Redact again on the way out: lines are redacted as they are written, but log files
    // from earlier versions on disk were not (they can hold Shopify tokens).
    const appLog = redactLogText([
      readLogTail(state.appPath ? `${state.appPath}.1` : '', tailBytes),
      readLogTail(state.appPath, tailBytes),
      state.appBuffer.join('')
    ].filter(Boolean).join(''));
    const consoleLog = redactLogText([
      readLogTail(state.consolePath ? `${state.consolePath}.1` : '', tailBytes),
      readLogTail(state.consolePath, tailBytes),
      state.consoleBuffer.join('')
    ].filter(Boolean).join(''));
    const system = [
      `Printventory ${version || 'unknown'}`,
      `Electron ${process.versions.electron || 'unknown'}`,
      `Chrome ${process.versions.chrome || 'unknown'}`,
      `Node ${process.versions.node || 'unknown'}`,
      `Platform ${process.platform} ${process.arch}`,
      `OS ${os.release()}`,
      `Captured ${new Date().toISOString()}`
    ].join('\n') + '\n';
    const zip = new JSZip();
    zip.file('app.log', appLog || '(no app logs captured)\n');
    zip.file('console.log', consoleLog || '(no console logs captured)\n');
    zip.file('system.txt', system);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  // Desktop "Save Logs...": zip the (redacted) logs and write them wherever the user
  // chooses. Nothing is uploaded; the user decides who, if anyone, receives the file.
  async function saveLogs({ dialog, parentWindow, version, defaultDirectory } = {}) {
    if (state.saving) return { saved: false };
    state.saving = true;
    const parent = parentWindow && !parentWindow.isDestroyed?.() ? parentWindow : undefined;
    try {
      const filename = logsZipFilename();
      const choice = await dialog.showSaveDialog(parent, {
        title: 'Save Logs',
        defaultPath: defaultDirectory ? path.join(defaultDirectory, filename) : filename,
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
      });
      if (!choice || choice.canceled || !choice.filePath) return { saved: false };

      const zipBuffer = await createLogsZip(version, TAIL_BYTES);
      await fs.promises.writeFile(choice.filePath, zipBuffer);
      await dialog.showMessageBox(parent, {
        type: 'info',
        title: 'Save Logs',
        message: 'Printventory logs were saved.',
        detail: `${choice.filePath}\n\nPasswords and API tokens are removed from the logs, but check the file before sharing it.`
      });
      return { saved: true, filePath: choice.filePath };
    } catch (error) {
      const detail = redactLogText(error && error.message ? error.message : String(error)).slice(0, 500);
      if (dialog && dialog.showMessageBox) {
        await dialog.showMessageBox(parent, {
          type: 'error',
          title: 'Save Logs',
          message: 'Could not save Printventory logs.',
          detail
        });
      }
      return { saved: false, error: detail };
    } finally {
      state.saving = false;
    }
  }

  return {
    beginCapture,
    openLogDirectory,
    attachWebContents,
    appendApp,
    appendConsole,
    createLogsZip,
    saveLogs
  };
}

module.exports = {
  createCapture,
  redactLogText,
  readLogTail,
  formatLogLine,
  logsZipFilename
};
