const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const base = path.resolve(__dirname, '../backend');
  for (const file of ['runtime/python.exe', 'runtime/python313.dll', 'runtime/Lib/site-packages/mediapipe/__init__.py', 'runtime/Lib/site-packages/cv2/__init__.py']) {
    if (!fs.existsSync(path.join(base, file))) throw new Error(`Missing backend dependency: ${file}`);
  }
  const hashes = JSON.parse(fs.readFileSync(path.join(base, 'models/checksums.json'), 'utf8'));
  for (const [file, expected] of Object.entries(hashes)) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(base, 'models', file))).digest('hex');
    if (hash !== expected) throw new Error(`Offline model checksum failed: ${file}`);
  }
  fs.mkdirSync(path.resolve(__dirname, '../public-desktop'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../public/icon.png'), path.resolve(__dirname, '../public-desktop/icon.png'));
  console.log('Bundled Python, MediaPipe, OpenCV, and offline model checksums verified.');
} catch (error) { console.error(`${error.message}\nRun npm run backend:setup before building.`); process.exitCode = 1; }
