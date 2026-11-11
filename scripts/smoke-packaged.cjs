const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const executable = path.resolve(__dirname, '../release-v1.1/win-unpacked/Presence Attendance.exe');
if (!fs.existsSync(executable)) throw new Error('Build the Windows application with npm run dist first.');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-packaged-smoke-'));
const child = spawn(executable, ['--smoke-test'], {
  env: { ...process.env, PRESENCE_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', data => { output += data; process.stdout.write(data); });
child.stderr.on('data', data => process.stderr.write(data));
const timeout = setTimeout(() => { console.error('Packaged startup timed out.'); child.kill(); process.exitCode = 1; }, 90000);
child.on('error', error => { console.error(error); clearTimeout(timeout); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timeout);
  const result = output.match(/PRESENCE_SMOKE_RESULT (\{[^\r\n]+\})/);
  if (code !== 0 || !result || !Object.values(JSON.parse(result[1])).every(Boolean)) process.exitCode = 1;
  else console.log('Packaged Windows executable passed startup, login, SQLite, offline assets, and secure-origin checks.');
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
