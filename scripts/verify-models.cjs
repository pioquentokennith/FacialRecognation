const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const dir = path.join(__dirname, '../public/models');
  const hashes = JSON.parse(fs.readFileSync(path.join(dir, 'checksums.json'), 'utf8'));
  for (const [name, expected] of Object.entries(hashes)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    if (actual !== expected) throw new Error(`Model checksum mismatch: ${name}`);
  }
  for (const name of ['tiny_face_detector', 'face_landmark_68', 'face_recognition']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, `${name}_model-weights_manifest.json`), 'utf8'));
    for (const group of manifest) for (const shard of group.paths) {
      if (!hashes[shard] || !fs.existsSync(path.join(dir, shard))) throw new Error(`Missing model shard: ${shard}`);
    }
  }
  console.log('Offline model manifests, shards, and checksums verified.');
} catch (error) { console.error(`${error.message}\nRun npm run models to download the complete offline models.`); process.exitCode = 1; }
