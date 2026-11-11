const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class VisionBackend {
  constructor(directory) { this.directory = directory; this.child = null; this.port = null; this.starting = null; this.stopped = false; }
  async start() {
    if (this.stopped) throw new Error('The recognition service is shutting down.');
    if (this.port) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const executable = path.join(this.directory, 'runtime/python.exe');
      if (!fs.existsSync(executable)) { reject(new Error('Offline recognition runtime is missing. Run npm run backend:setup, or reinstall the application.')); return; }
      this.token = randomBytes(32).toString('hex');
      const child = spawn(executable, ['-B', '-u', path.join(this.directory, 'server.py')], {
        cwd: this.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PRESENCE_BACKEND_TOKEN: this.token, PYTHONDONTWRITEBYTECODE: '1', TF_CPP_MIN_LOG_LEVEL: '2', MPLBACKEND: 'Agg' },
      });
      this.child = child;
      let output = ''; let errors = ''; let ready = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error('The offline recognition engine took too long to start. Retry or repair the installation.')); }, 60000);
      child.stderr.on('data', data => { errors = (errors + data).slice(-2500); });
      child.stdout.on('data', data => {
        output += data;
        let end;
        while ((end = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          try {
            const info = JSON.parse(line);
            if (info.ready && Number.isInteger(info.port) && info.port > 0 && info.port < 65536) {
              ready = true; this.port = info.port; clearTimeout(timeout); resolve();
            }
          } catch { /* Native library startup messages are not protocol records. */ }
        }
      });
      child.on('error', error => { clearTimeout(timeout); reject(new Error(`Offline recognition could not start: ${error.message}`)); });
      child.on('exit', code => {
        clearTimeout(timeout);
        if (this.child === child) { this.port = null; this.child = null; }
        if (!ready) reject(new Error(`Offline recognition failed to start (${code}). ${errors.includes('ModuleNotFoundError') ? 'A bundled Python dependency is missing.' : errors.slice(-700)}`));
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async request(operation, payload = {}) {
    await this.start();
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
      });
    } catch { throw new Error('The local face service is unavailable or timed out. Stop scanning and retry.'); }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The offline face engine could not process the request.');
    return data;
  }
  stop() {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2500);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    this.port = null;
  }
}
module.exports = { VisionBackend };
