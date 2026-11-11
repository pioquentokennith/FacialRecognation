const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const base = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';
const files = [
  'tiny_face_detector_model-weights_manifest.json', 'tiny_face_detector_model-shard1',
  'face_landmark_68_model-weights_manifest.json', 'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json', 'face_recognition_model-shard1', 'face_recognition_model-shard2',
];
(async () => {
  const dir = path.join(__dirname, '../public/models');
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {};
  for (const name of files) {
    const response = await fetch(base + name);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(path.join(dir, name), data);
    hashes[name] = crypto.createHash('sha256').update(data).digest('hex');
    console.log(`${name}: ${data.length} bytes`);
  }
  const license = await fetch('https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/LICENSE');
  if (!license.ok) throw new Error('Could not download model distribution license');
  fs.writeFileSync(path.join(dir, 'LICENSE'), await license.text());
  fs.writeFileSync(path.join(dir, 'checksums.json'), JSON.stringify(hashes, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
