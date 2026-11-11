const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, MODEL } = require('../electron/database.cjs');
const { FaceService, rankMatches } = require('../electron/face-service.cjs');
const vector = index => Array.from({ length: 128 }, (_, i) => i === index ? 1 : 0);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-face-unit-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  store.login({ username: 'admin', password: 'admin123' });
  let now = 1000000;
  let serial = 0;
  let descriptor = vector(0);
  let quality = true;
  const backend = { request: async operation => operation === 'health' ? { ready: true } : {
    model: MODEL, usable: quality, code: quality ? 'ready' : 'no_face', message: 'test frame', descriptor: quality ? descriptor : null,
    frameHash: `frame-${++serial}`, faceCount: quality ? 1 : 0,
  } };
  const faces = new FaceService(store, backend, () => now);
  const id = store.saveStudent({ student_id: 'A1', name: 'Enrolled student', course: 'CS', year: '1' }).id;
  const enroll = (target = id) => store.saveFace({ id: target, consent: true, descriptors: [vector(0), vector(0), vector(0)] });
  return { store, faces, backend, id, enroll, date: store.today(), advance: (ms = 650) => { now += ms; },
    descriptor: value => { descriptor = value; }, quality: value => { quality = value; },
    frame: async (sessionId, capture = false) => { now += 650; return faces.frame({ sessionId, frame: 'test', capture }); },
    cleanup: () => { faces.reset(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function matched(ctx) {
  const { sessionId } = await ctx.faces.begin({ mode: 'attendance', date: ctx.date });
  await ctx.frame(sessionId); await ctx.frame(sessionId);
  return (await ctx.frame(sessionId)).match;
}

test('old face-api enrollments are marked for upgrade and never silently treated as SFace', async c => {
  c.enroll(); c.store.openDay();
  c.store.db.prepare("UPDATE face_enrollments SET model='face-recognition-resnet-v1'").run();
  const student = c.store.students()[0]; assert.equal(student.has_face, 0); assert.equal(student.needs_face_upgrade, 1);
  assert.equal(c.store.faceStatus({ date: c.date }).needsUpgrade, 1);
  assert.equal(c.store.faceCandidates({ date: c.date }).length, 0);
  await assert.rejects(() => c.faces.begin({ mode: 'attendance', date: c.date }), /one-time re-enrollment/);
  assert.equal(c.store.records({}).length, 1);
});
test('roster exclusion is explicit and only Admin can append newly registered students', async c => {
  c.store.archiveStudent({ id: c.id, active: false }); c.store.openDay(); c.store.archiveStudent({ id: c.id, active: true }); c.enroll();
  assert.equal(c.store.faceStatus({ date: c.date }).notOnRoster.length, 1);
  await assert.rejects(() => c.faces.begin({ mode: 'attendance', date: c.date }), /roster/);
  c.store.login({ username: 'teacher', password: 'teacher123' }); assert.throws(() => c.store.includeStudentsToday(), /Only an Admin/);
  c.store.login({ username: 'admin', password: 'admin123' }); assert.equal(c.store.includeStudentsToday().added, 1);
  assert.equal(c.store.includeStudentsToday().added, 0); assert.equal(c.store.faceStatus({ date: c.date }).ready, 1);
  assert.ok(c.store.audit().some(row => row.action === 'roster_students_added'));
});
test('enrollment requires three consistent samples plus a separate successful verification', async c => {
  const { sessionId } = await c.faces.begin({ mode: 'enroll', studentId: c.id, consent: true });
  assert.throws(() => c.faces.saveEnrollment({ sessionId }), /fresh-frame verification/);
  for (let n = 1; n <= 3; n++) { const result = await c.frame(sessionId, true); assert.equal(result.sampleCount, n); assert.equal(result.descriptor, undefined); }
  assert.throws(() => c.faces.saveEnrollment({ sessionId }), /fresh-frame verification/);
  c.descriptor(vector(1)); assert.equal((await c.frame(sessionId, true)).code, 'inconsistent');
  c.descriptor(vector(0)); assert.equal((await c.frame(sessionId, true)).verified, true);
  c.faces.saveEnrollment({ sessionId }); assert.equal(c.store.students()[0].has_face, 1);
});
test('replaying an identical frame cannot collect enrollment samples', async c => {
  const { sessionId } = await c.faces.begin({ mode: 'enroll', studentId: c.id, consent: true });
  const original = c.backend.request;
  c.backend.request = async (...args) => ({ ...await original(...args), frameHash: 'same-image' });
  assert.equal((await c.frame(sessionId, true)).sampleCount, 1);
  const duplicate = await c.frame(sessionId, true); assert.equal(duplicate.sampleCount, 1); assert.equal(duplicate.code, 'fresh_frame');
});
test('unknown and ambiguous signatures never generate an identity proof', async c => {
  assert.equal(rankMatches(vector(1), [{ id: 'a', descriptors: [vector(0)] }]).code, 'unknown');
  assert.equal(rankMatches(vector(0), [{ id: 'a', descriptors: [vector(0)] }, { id: 'b', descriptors: [vector(0)] }]).code, 'ambiguous');
  c.enroll(); c.store.openDay(); const { sessionId } = await c.faces.begin({ mode: 'attendance', date: c.date });
  c.descriptor(vector(1)); const result = await c.frame(sessionId); assert.equal(result.code, 'unknown'); assert.equal(result.match, undefined);
});
test('quality failures reset the consecutive-match streak', async c => {
  c.enroll(); c.store.openDay(); const { sessionId } = await c.faces.begin({ mode: 'attendance', date: c.date });
  assert.equal((await c.frame(sessionId)).streak, 1);
  c.quality(false); assert.equal((await c.frame(sessionId)).streak, 0);
  c.quality(true); assert.equal((await c.frame(sessionId)).streak, 1);
  assert.equal((await c.frame(sessionId)).streak, 2);
  assert.ok((await c.frame(sessionId)).match?.proof);
  assert.equal(c.store.dashboard({}).present, 0);
});
test('face attendance requires a fresh single-use server proof and user confirmation', async c => {
  c.enroll(); c.store.openDay();
  const payload = { date: c.date, studentId: c.id, method: 'face', confirmed: true };
  assert.throws(() => c.faces.recordAttendance(payload), /missing/);
  const match = await matched(c);
  assert.throws(() => c.faces.recordAttendance({ ...payload, proof: match.proof, confirmed: false }), /Confirm/);
  c.faces.recordAttendance({ ...payload, proof: match.proof });
  assert.equal(c.store.records({})[0].method, 'face');
  assert.throws(() => c.faces.recordAttendance({ ...payload, proof: match.proof }), /missing/);
});
test('the same student can check in again with a fresh face proof', async c => {
  c.enroll(); c.store.openDay();
  const payload = { date: c.date, studentId: c.id, method: 'face', confirmed: true };
  let match = await matched(c);
  assert.equal(c.faces.recordAttendance({ ...payload, proof: match.proof }).checkinCount, 1);
  match = await matched(c);
  assert.equal(match.checkin_count, 1);
  assert.equal(c.faces.recordAttendance({ ...payload, proof: match.proof }).checkinCount, 2);
  const rows = c.store.records({});
  assert.equal(rows.length, 1); assert.equal(rows[0].checkin_count, 2);
  assert.equal(c.store.attendanceEvents({ date: c.date, studentId: c.id }).length, 2);
});
test('expired proofs and changed enrollments cannot save attendance', async c => {
  c.enroll(); c.store.openDay(); let match = await matched(c);
  c.advance(120001);
  assert.throws(() => c.faces.recordAttendance({ date: c.date, studentId: c.id, method: 'face', confirmed: true, proof: match.proof }), /expired/);
  match = await matched(c);
  c.store.saveFace({ id: c.id, consent: true, descriptors: [vector(1), vector(1), vector(1)] });
  assert.throws(() => c.faces.recordAttendance({ date: c.date, studentId: c.id, method: 'face', confirmed: true, proof: match.proof }), /changed/);
});
test('cancellation invalidates an in-flight inference response', async c => {
  c.enroll(); c.store.openDay(); const { sessionId } = await c.faces.begin({ mode: 'attendance', date: c.date });
  let finish;
  c.backend.request = () => new Promise(resolve => { finish = resolve; });
  const processing = c.faces.frame({ sessionId, frame: 'test' });
  c.faces.cancel({ sessionId });
  finish({ model: MODEL, usable: true, descriptor: vector(0) });
  await assert.rejects(() => processing, /expired/);
  assert.equal(c.store.dashboard({}).present, 0);
});
test('duplicate camera frames never satisfy consecutive recognition', async c => {
  c.enroll(); c.store.openDay(); const { sessionId } = await c.faces.begin({ mode: 'attendance', date: c.date });
  const original = c.backend.request;
  c.backend.request = async (...args) => ({ ...await original(...args), frameHash: 'unchanged' });
  for (let i = 0; i < 5; i++) { const result = await c.frame(sessionId); assert.equal(result.streak, 1); assert.equal(result.match, undefined); }
});

exports.run = async () => {
  for (const [name, fn] of tests) {
    const c = setup();
    try { await fn(c); console.log(`PASS ${name}`); } finally { c.cleanup(); }
  }
  console.log(`${tests.length}/${tests.length} face service workflow tests passed.`);
};
