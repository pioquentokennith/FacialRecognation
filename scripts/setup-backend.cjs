const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'backend/runtime');
const models = path.join(root, 'backend/models');
const pythonVersion = '3.13.16';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, data);
  console.log(`Downloaded ${path.basename(destination)} (${data.length} bytes)`);
  return crypto.createHash('sha256').update(data).digest('hex');
}
(async () => {
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(models, { recursive: true });
  const python = path.join(runtime, 'python.exe');
  if (!fs.existsSync(python)) {
    const zip = path.join(runtime, 'python.zip');
    await download(`https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`, zip);
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${runtime}' -Force`]);
    fs.unlinkSync(zip);
  }
  fs.writeFileSync(path.join(runtime, 'python313._pth'), 'python313.zip\n.\n..\nLib/site-packages\nimport site\n');
  if (!fs.existsSync(path.join(runtime, 'Lib/site-packages/pip'))) {
    const installer = path.join(runtime, 'get-pip.py');
    await download('https://bootstrap.pypa.io/get-pip.py', installer);
    run(python, [installer, '--no-warn-script-location']); fs.unlinkSync(installer);
  }
  const lock = path.join(root, 'backend/requirements.lock.txt');
  run(python, ['-m', 'pip', 'install', '--only-binary=:all:', '--no-warn-script-location', '-r', fs.existsSync(lock) ? lock : path.join(root, 'backend/requirements.txt')]);
  const freeze = spawnSync(python, ['-m', 'pip', 'freeze'], { encoding: 'utf8' });
  if (freeze.status !== 0) throw new Error('Could not lock backend dependencies.');
  fs.writeFileSync(lock, freeze.stdout);
  const sources = {
    'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    'face_recognition_sface_2021dec.onnx': 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    'SFACE_LICENSE': 'https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_recognition_sface/LICENSE',
    'MEDIAPIPE_LICENSE': 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE',
  };
  const checksums = {};
  for (const [name, url] of Object.entries(sources)) {
    const file = path.join(models, name);
    checksums[name] = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : await download(url, file);
  }
  fs.writeFileSync(path.join(models, 'checksums.json'), JSON.stringify(checksums, null, 2));
  run(python, ['-c', 'import mediapipe, cv2, numpy; print("Offline runtime ready:", mediapipe.__version__, cv2.__version__, numpy.__version__)']);
})().catch(error => { console.error(error); process.exitCode = 1; });
