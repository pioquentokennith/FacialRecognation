const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, dateKey, exportCSV } = require('../electron/database.cjs');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-test-'));
  const filename = path.join(directory, 'test.sqlite');
  let clock = new Date(2026, 10, 10, 9, 30);
  const store = new Store(filename, () => clock);
  const admin = () => store.login({ username: 'admin', password: 'admin123' });
  const teacher = () => store.login({ username: 'teacher', password: 'teacher123' });
  const student = (number = 1, extra = {}) => store.saveStudent({ student_id: `ST-${number}`, name: `Student ${number}`, course: 'Computer Science', year: '1', ...extra }).id;
  const samples = Array.from({ length: 3 }, () => Array(128).fill(0.1));
  admin();
  return { store, admin, teacher, student, samples, filename, directory, date: dateKey(clock), advance: date => { clock = date; },
    cleanup: () => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('first-run accounts use salted hashes; sessions do not survive restart', ctx => {
  const { store, filename } = ctx;
  const row = store.db.prepare("SELECT * FROM users WHERE role='admin'").get();
  assert.notEqual(row.password_hash, 'admin123'); assert.equal(row.password_hash.length, 128); assert.equal(row.salt.length, 32);
  const second = new Store(filename); assert.equal(second.current(), null); second.close();
  assert.throws(() => store.login({ username: 'admin', password: 'wrong' }), /incorrect/);
  assert.equal(store.login({ username: ' ADMIN ', password: 'admin123' }).role, 'admin');
});
test('permissions reject privileged operations even when called directly', ctx => {
  const id = ctx.student(); ctx.teacher();
  for (const op of [() => ctx.store.saveStudent({}), () => ctx.store.archiveStudent({ id, active: false }), () => ctx.store.users(), () => ctx.store.saveFace({}), () => ctx.store.closeDay({ date: ctx.date }), () => ctx.store.audit()]) assert.throws(op, /Only an Admin/);
  ctx.store.logout(); assert.throws(() => ctx.store.students(), /log in/);
});
test('student IDs are case-insensitive unique and edits preserve internal references', ctx => {
  const id = ctx.student();
  assert.throws(() => ctx.student(2, { student_id: ' st-1 ' }), /already exists/);
  ctx.store.openDay();
  ctx.store.saveStudent({ id, student_id: 'NEW-ID', name: 'Renamed', course: 'Arts', year: '2' });
  const row = ctx.store.records({})[0];
  assert.equal(row.student_id, id); assert.equal(row.display_id, 'ST-1'); assert.equal(row.name, 'Student 1');
  assert.equal(ctx.store.students()[0].student_id, 'NEW-ID');
});
test('daily opening snapshots roster and excludes later registrations', ctx => {
  ctx.student(); ctx.store.openDay(); ctx.student(2);
  assert.equal(ctx.store.day({ date: ctx.date }).rows.length, 1);
  assert.throws(() => ctx.store.openDay(), /already/);
  assert.equal(ctx.store.dashboard({}).pending, 1);
});
test('confirmation, eligible roster, and date are required for check-in', ctx => {
  const id = ctx.student(); ctx.store.openDay(); const late = ctx.student(2);
  assert.throws(() => ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'manual' }), /Confirm/);
  assert.throws(() => ctx.store.recordAttendance({ date: ctx.date, studentId: late, method: 'manual', confirmed: true }), /not on/);
  assert.throws(() => ctx.store.recordAttendance({ date: '2026-11-09', studentId: id, method: 'manual', confirmed: true }), /date has changed/);
  assert.throws(() => ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'face', confirmed: true }), /enrollment/);
});
test('repeat manual check-ins are unlimited and keep full history', ctx => {
  const id = ctx.student(); ctx.teacher(); ctx.store.openDay();
  const payload = { date: ctx.date, studentId: id, method: 'manual', confirmed: true };
  assert.equal(ctx.store.recordAttendance(payload).checkinCount, 1);
  const first = ctx.store.records({})[0].checked_in_at;
  ctx.advance(new Date(2026, 10, 10, 10, 5));
  assert.equal(ctx.store.recordAttendance(payload).checkinCount, 2);
  assert.equal(ctx.store.recordAttendance(payload).checkinCount, 3);
  const rows = ctx.store.records({});
  assert.equal(rows.length, 1); assert.equal(rows[0].recorded_by, 'teacher'); assert.equal(rows[0].status, 'present');
  assert.equal(rows[0].checked_in_at, first); assert.equal(rows[0].checkin_count, 3);
  assert.ok(rows[0].last_checkin_at > first);
  const events = ctx.store.attendanceEvents({ date: ctx.date, studentId: id });
  assert.equal(events.length, 3); assert.equal(events[0].recorded_by, 'teacher');
  assert.ok(events[0].checked_in_at > events[2].checked_in_at);
  ctx.admin();
  assert.equal(ctx.store.audit().filter(e => e.action === 'attendance_recorded').length, 3);
  ctx.store.closeDay({ date: ctx.date });
  assert.throws(() => ctx.store.recordAttendance(payload), /must be open/);
});
test('admin reset clears check-in history and retains the audit trail', ctx => {
  const id = ctx.student(); ctx.store.openDay();
  const payload = { date: ctx.date, studentId: id, method: 'manual', confirmed: true };
  ctx.store.recordAttendance(payload); ctx.store.recordAttendance(payload);
  assert.equal(ctx.store.attendanceEvents({ date: ctx.date, studentId: id }).length, 2);
  ctx.store.correctAttendance({ date: ctx.date, studentId: id, status: 'pending', reason: 'Recorded in error' });
  assert.equal(ctx.store.attendanceEvents({ date: ctx.date, studentId: id }).length, 0);
  assert.equal(ctx.store.records({})[0].checkin_count, 0);
  assert.match(ctx.store.audit().find(e => e.action === 'attendance_corrected').after_json, /"checkins_removed":2/);
});
test('a real check-in fills the time on an Admin-corrected present record', ctx => {
  const id = ctx.student(); ctx.store.openDay();
  ctx.store.correctAttendance({ date: ctx.date, studentId: id, status: 'present', reason: 'Paper register' });
  assert.equal(ctx.store.records({})[0].checked_in_at, null);
  ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'manual', confirmed: true });
  const row = ctx.store.records({})[0];
  assert.equal(row.status, 'present'); assert.ok(row.checked_in_at); assert.equal(row.checkin_count, 1);
});
test('a version 1 database migrates and backfills existing present check-ins', ctx => {
  const id = ctx.student(); ctx.store.openDay();
  ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'manual', confirmed: true });
  const first = ctx.store.records({})[0].checked_in_at;
  ctx.store.db.exec('DROP INDEX attendance_event_lookup; DROP TABLE attendance_events; PRAGMA user_version = 1;');
  ctx.store.db.prepare('DELETE FROM schema_migrations WHERE version=2').run();
  ctx.store.close();
  const reopened = new Store(ctx.filename);
  try {
    assert.equal(reopened.db.pragma('user_version', { simple: true }), 2);
    reopened.login({ username: 'admin', password: 'admin123' });
    const rows = reopened.records({});
    assert.equal(rows.length, 1); assert.equal(rows[0].checkin_count, 1); assert.equal(rows[0].checked_in_at, first);
    const events = reopened.attendanceEvents({ date: ctx.date, studentId: id });
    assert.equal(events.length, 1); assert.equal(events[0].checked_in_at, first);
  } finally { reopened.close(); }
});
test('closing creates exactly missing absences with no fabricated check-in times', ctx => {
  const present = ctx.student(); ctx.student(2); ctx.store.openDay();
  ctx.store.recordAttendance({ date: ctx.date, studentId: present, method: 'manual', confirmed: true });
  ctx.store.closeDay({ date: ctx.date }); ctx.store.closeDay({ date: ctx.date });
  const rows = ctx.store.records({}); assert.equal(rows.length, 2);
  const absent = rows.find(r => r.status === 'absent'); assert.equal(absent.checked_in_at, null); assert.equal(absent.method, null);
  const stats = ctx.store.dashboard({}); assert.equal(stats.present, 1); assert.equal(stats.absent, 1); assert.equal(stats.pending, 0);
  assert.throws(() => ctx.store.recordAttendance({ date: ctx.date, studentId: absent.student_id, method: 'manual', confirmed: true }), /must be open/);
});
test('reopening replaces an absence in-place and re-closing is consistent', ctx => {
  const id = ctx.student(); ctx.store.openDay(); ctx.store.closeDay({ date: ctx.date });
  const before = ctx.store.records({})[0]; ctx.store.reopenDay({ date: ctx.date });
  ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'manual', confirmed: true });
  ctx.store.closeDay({ date: ctx.date });
  const rows = ctx.store.records({}); assert.equal(rows.length, 1); assert.equal(rows[0].id, before.id); assert.equal(rows[0].status, 'present');
});
test('historical correction requires an open day, a reason, and retains an audit trail', ctx => {
  const id = ctx.student(); ctx.store.openDay(); ctx.store.closeDay({ date: ctx.date });
  const payload = { date: ctx.date, studentId: id, status: 'present', reason: 'Paper register confirms presence' };
  assert.throws(() => ctx.store.correctAttendance(payload), /Reopen/);
  ctx.store.reopenDay({ date: ctx.date });
  assert.throws(() => ctx.store.correctAttendance({ ...payload, reason: '' }), /reason/);
  ctx.advance(new Date(2026, 10, 11, 10)); ctx.store.correctAttendance(payload);
  let row = ctx.store.records({})[0]; assert.equal(row.status, 'present'); assert.equal(row.checked_in_at, null); assert.equal(row.method, 'admin_correction');
  ctx.store.correctAttendance({ ...payload, status: 'pending' });
  row = ctx.store.records({})[0]; assert.equal(row.status, 'pending');
  assert.equal(ctx.store.audit().filter(e => e.action === 'attendance_corrected').length, 2);
  ctx.store.closeDay({ date: ctx.date }); assert.equal(ctx.store.records({})[0].status, 'absent');
});
test('midnight rejects a stale live check-in and local calendar keys stay local', ctx => {
  const id = ctx.student(); ctx.store.openDay(); ctx.advance(new Date(2026, 10, 11, 0, 1));
  assert.equal(ctx.store.today(), '2026-11-11');
  assert.throws(() => ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'manual', confirmed: true }), /date has changed/);
  assert.throws(() => ctx.store.day({ date: '2026-02-30' }), /valid date/);
});
test('face data validates consent and dimensions, persists, and deletes on archival', ctx => {
  const id = ctx.student();
  assert.throws(() => ctx.store.saveFace({ id, descriptors: ctx.samples, consent: false }), /Consent/);
  assert.throws(() => ctx.store.saveFace({ id, descriptors: [[1]], consent: true }), /samples/);
  ctx.store.saveFace({ id, descriptors: ctx.samples, consent: true }); ctx.store.openDay();
  assert.equal(ctx.store.faceCandidates({ date: ctx.date })[0].descriptors.length, 3);
  assert.throws(() => ctx.store.saveFace({ id, descriptors: [], consent: true }), /samples/);
  assert.equal(ctx.store.students()[0].has_face, 1);
  ctx.store.archiveStudent({ id, active: false });
  assert.equal(ctx.store.faceCandidates({ date: ctx.date }).length, 0); assert.equal(ctx.store.records({}).length, 1);
  ctx.store.archiveStudent({ id, active: true }); assert.equal(ctx.store.students()[0].has_face, 0);
});
test('permanent deletion is restricted by roster history', ctx => {
  const id = ctx.student(); ctx.store.openDay();
  assert.throws(() => ctx.store.deleteStudent({ id }), /Archive/);
  const fresh = ctx.student(2); ctx.store.saveFace({ id: fresh, descriptors: ctx.samples, consent: true }); ctx.store.deleteStudent({ id: fresh });
  assert.equal(ctx.store.students().length, 1); assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM face_enrollments').get().n, 0);
});
test('Teacher account deactivation and password reset preserve attribution', ctx => {
  ctx.store.saveUser({ username: 'NewTeacher', password: 'password123', active: true });
  const teacher = ctx.store.users().find(u => u.username === 'NewTeacher');
  assert.throws(() => ctx.store.saveUser({ username: 'newteacher', password: 'password123' }), /already exists/);
  ctx.store.resetPassword({ id: teacher.id, password: 'newpassword123' });
  assert.throws(() => ctx.store.login({ username: 'NewTeacher', password: 'password123' }), /incorrect/);
  ctx.store.login({ username: 'NewTeacher', password: 'newpassword123' });
  ctx.admin(); ctx.store.saveUser({ id: teacher.id, username: 'NewTeacher', active: false });
  assert.throws(() => ctx.store.login({ username: 'NewTeacher', password: 'newpassword123' }), /incorrect/);
  const admin = ctx.store.users().find(u => u.role === 'admin'); assert.throws(() => ctx.store.saveUser({ id: admin.id, username: 'other', active: false }), /permanent/);
});
test('password changes reject incorrect current password and persist', ctx => {
  assert.throws(() => ctx.store.changePassword({ currentPassword: 'wrong', newPassword: 'newpassword' }), /incorrect/);
  ctx.store.changePassword({ currentPassword: 'admin123', newPassword: 'newpassword' }); ctx.store.logout();
  assert.throws(() => ctx.admin(), /incorrect/); assert.equal(ctx.store.login({ username: 'admin', password: 'newpassword' }).role, 'admin');
});
test('filtered CSV exports derived pending rows, Unicode, escaped quotes, and formula protection', ctx => {
  ctx.student(1, { name: '=SUM(1,2)', course: 'Arts, "Media"\nDesign' }); ctx.student(2, { name: 'José 李' }); ctx.store.openDay();
  const filtered = ctx.store.records({ search: 'José', status: 'pending', from: ctx.date, to: ctx.date }); assert.equal(filtered.length, 1);
  const csv = exportCSV(ctx.store.records({}));
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes("\"'=SUM(1,2)\"")); assert.ok(csv.includes('"Arts, ""Media""\nDesign"')); assert.ok(csv.includes('José 李')); assert.ok(csv.includes('Not yet recorded')); assert.ok(csv.includes('Check-ins')); assert.ok(csv.includes('Last check-in time (local)'));
  assert.throws(() => ctx.store.records({ from: '2026-11-11', to: '2026-11-10' }), /start date/);
});
test('backup and restore preserve records and descriptors and clear the session', async ctx => {
  const id = ctx.student(); ctx.store.saveFace({ id, descriptors: ctx.samples, consent: true }); ctx.store.openDay();
  ctx.store.recordAttendance({ date: ctx.date, studentId: id, method: 'face', confirmed: true });
  const backup = path.join(ctx.directory, 'backup.sqlite'); await ctx.store.backup(backup);
  ctx.student(2); ctx.store.deleteFace({ id });
  const result = await ctx.store.restore(backup); assert.ok(fs.existsSync(result.recovery)); assert.equal(ctx.store.current(), null);
  ctx.admin(); assert.equal(ctx.store.students().length, 1); assert.equal(ctx.store.students()[0].has_face, 1); assert.equal(ctx.store.records({})[0].method, 'face');
  assert.equal(ctx.store.records({})[0].checkin_count, 1); assert.equal(ctx.store.attendanceEvents({ date: ctx.date, studentId: id }).length, 1);
  const recovered = new Store(result.recovery); recovered.login({ username: 'admin', password: 'admin123' }); assert.equal(recovered.students().length, 2); recovered.close();
});
test('invalid restore and attempts to overwrite the live database preserve working data', async ctx => {
  ctx.student(); const invalid = path.join(ctx.directory, 'invalid.sqlite'); fs.writeFileSync(invalid, 'not a database');
  await assert.rejects(() => ctx.store.restore(invalid)); assert.equal(ctx.store.students().length, 1);
  await assert.rejects(() => ctx.store.backup(ctx.filename), /different/);
  await assert.rejects(() => ctx.store.backup(ctx.filename + '-wal'), /different/);
});

test('a storage write failure rolls back daily closure and preserves the open roster', ctx => {
  ctx.student(); ctx.student(2); ctx.store.openDay();
  ctx.store.db.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON attendance_records WHEN NEW.status='absent' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
  assert.throws(() => ctx.store.closeDay({ date: ctx.date }), /simulated storage failure/);
  const result = ctx.store.day({ date: ctx.date });
  assert.equal(result.day.state, 'open'); assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.status === 'pending'));
  assert.equal(ctx.store.audit().filter(e => e.action === 'day_closed').length, 0);
  ctx.store.db.exec('DROP TRIGGER simulate_failure');
  ctx.store.closeDay({ date: ctx.date }); assert.equal(ctx.store.dashboard({}).absent, 2);
});

test('a backup with an incompatible table schema is rejected before replacement', async ctx => {
  ctx.student(); const backup = path.join(ctx.directory, 'wrong-schema.sqlite'); await ctx.store.backup(backup);
  const Database = require('better-sqlite3');
  const altered = new Database(backup);
  altered.exec('ALTER TABLE students RENAME COLUMN name TO incompatible_name'); altered.close();
  await assert.rejects(() => ctx.store.restore(backup), /incompatible students schema/);
  assert.equal(ctx.store.students()[0].name, 'Student 1'); assert.equal(ctx.store.current().role, 'admin');
});

test('a failed face replacement keeps the previous saved descriptors', ctx => {
  const id = ctx.student(); ctx.store.saveFace({ id, descriptors: ctx.samples, consent: true });
  ctx.store.db.exec("CREATE TRIGGER simulate_face_failure BEFORE UPDATE ON face_enrollments BEGIN SELECT RAISE(ABORT,'simulated face save failure'); END");
  const replacement = Array.from({ length: 3 }, () => Array(128).fill(0.2));
  assert.throws(() => ctx.store.saveFace({ id, descriptors: replacement, consent: true }), /simulated face save failure/);
  ctx.store.openDay(); assert.deepEqual(ctx.store.faceCandidates({ date: ctx.date })[0].descriptors, ctx.samples);
  assert.equal(ctx.store.audit().filter(e => e.action === 'face_enrolled').length, 1);
});

exports.run = async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    const context = setup();
    try { await fn(context); console.log(`PASS ${name}`); passed++; }
    catch (error) { console.error(`FAIL ${name}`); throw error; }
    finally { context.cleanup(); }
  }
  console.log(`\n${passed}/${tests.length} database workflow tests passed.`);
};
