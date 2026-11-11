const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { VisionBackend } = require('../electron/vision-backend.cjs');

(async () => {
  const backend = new VisionBackend(path.resolve(__dirname, '../backend'));
  try {
    const health = await backend.request('health');
    assert.equal(health.ready, true); assert.equal(health.offline, true);
    const unauthorized = await fetch(`http://127.0.0.1:${backend.port}/health`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 403);
    await assert.rejects(() => backend.request('analyze', { frame: 'invalid image' }), /JPEG/);
    const original = backend.child;
    const exited = once(original, 'exit'); original.kill(); await exited;
    assert.equal((await backend.request('health')).ready, true);
    assert.notEqual(backend.child.pid, original.pid);
    const restarted = backend.child;
    const closed = once(restarted, 'exit');
    backend.stop(); await closed;
    console.log('PASS local service startup, token authorization, invalid-frame handling, crash recovery, and automatic shutdown.');
  } finally { backend.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
