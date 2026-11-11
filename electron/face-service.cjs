const { randomUUID, createHash } = require('node:crypto');
const { MODEL } = require('./database.cjs');

const MATCH_THRESHOLD = 0.45;
const MATCH_MARGIN = 0.08;
const ENROLL_THRESHOLD = 0.5;
const STABLE_FRAMES = 3;
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / Math.max(Math.sqrt(aa * bb), 1e-12);
}
function similarity(descriptor, samples) {
  const scores = samples.map(sample => cosine(descriptor, sample)).sort((a, b) => b - a);
  return scores.slice(0, 2).reduce((sum, score) => sum + score, 0) / Math.min(2, scores.length);
}
function rankMatches(descriptor, candidates) {
  const ranked = candidates.map(student => ({ student, score: similarity(descriptor, student.descriptors) })).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { code: 'no_enrollment', score: null };
  const best = ranked[0];
  if (best.score < MATCH_THRESHOLD) return { code: 'unknown', score: best.score };
  const margin = ranked[1] ? best.score - ranked[1].score : null;
  if (margin !== null && margin < MATCH_MARGIN) return { code: 'ambiguous', score: best.score, margin };
  return { code: 'candidate', student: best.student, score: best.score, margin };
}
const fingerprint = candidate => createHash('sha256').update(JSON.stringify(candidate.descriptors)).digest('hex');

class FaceService {
  constructor(store, backend, clock = () => Date.now()) {
    this.store = store; this.backend = backend; this.clock = clock; this.sessions = new Map(); this.proofs = new Map();
  }
  reset() { this.sessions.clear(); this.proofs.clear(); }
  getSession(id) {
    const user = this.store.require();
    const session = this.sessions.get(id);
    if (!session || session.owner !== user.id || this.clock() - session.created > 15 * 60000) {
      this.sessions.delete(id); throw new Error('This scan has expired. Start the camera again.');
    }
    if (session.mode === 'enroll') this.store.require(true);
    return session;
  }
  async health() { this.store.require(); return this.backend.request('health'); }
  async begin({ mode, studentId, date, consent }) {
    const user = this.store.require(mode === 'enroll');
    if (!['enroll', 'attendance'].includes(mode)) throw new Error('Invalid scanning mode.');
    if (mode === 'enroll') {
      if (consent !== true) throw new Error('Student consent is required before face enrollment.');
      if (!this.store.db.prepare('SELECT 1 FROM students WHERE id=? AND active=1').get(studentId)) throw new Error('Choose an active student.');
    } else {
      const candidates = this.store.faceCandidates({ date });
      if (!candidates.length) {
        const status = this.store.faceStatus({ date });
        if (status.needsUpgrade) throw new Error('Saved faces need one-time re-enrollment for MediaPipe + SFace. Ask the Admin to re-enroll them under Students.');
        if (status.notOnRoster.length) throw new Error('No enrolled students are on today’s roster. Ask the Admin to include newly registered students on Take Attendance.');
        throw new Error('No usable face enrollments are on today’s roster. Ask the Admin to enroll and verify a student first.');
      }
    }
    await this.backend.request('health');
    if (this.store.require().id !== user.id) throw new Error('The login session changed. Please start scanning again.');
    this.sessions.clear(); this.proofs.clear();
    const id = randomUUID();
    this.sessions.set(id, { id, owner: user.id, mode, studentId, date, consent, created: this.clock(), samples: [], hashes: new Set(), verified: false,
      streak: 0, lastStudent: null, lastHash: null, lastAt: 0, firstAt: 0, lastCapture: 0, processing: false });
    return { sessionId: id, model: MODEL, sampleCount: 0, verified: false, requiredFrames: STABLE_FRAMES };
  }
  cancel({ sessionId }) {
    const user = this.store.require();
    const session = this.sessions.get(sessionId);
    if (session?.owner === user.id) this.sessions.delete(sessionId);
    return true;
  }
  async frame({ sessionId, frame, capture = false }) {
    const session = this.getSession(sessionId);
    if (session.processing) throw new Error('A frame is already being processed.');
    if (session.finished) throw new Error('This scan is complete. Start a new scan.');
    session.processing = true;
    try {
      const analysis = await this.backend.request('analyze', { frame });
      this.getSession(sessionId); // A logout, restore, or cancellation invalidates in-flight work.
      if (analysis.model !== MODEL) throw new Error('The face engine and application models do not match. Repair the installation.');
      const { descriptor, frameHash, ...result } = analysis;
      result.sampleCount = session.samples.length; result.verified = session.verified; result.streak = session.streak; result.requiredFrames = STABLE_FRAMES;
      if (!analysis.usable) { session.streak = 0; session.lastStudent = null; result.streak = 0; return result; }
      if (!Array.isArray(descriptor) || descriptor.length !== 128 || descriptor.some(x => !Number.isFinite(x))) throw new Error('Invalid face signature from the local engine.');
      const now = this.clock();
      if (session.mode === 'enroll') {
        if (!capture || session.verified) return { ...result, code: session.verified ? 'verified' : 'ready', message: session.verified ? 'Enrollment verified. Save to finish.' : session.samples.length < 3 ? 'Face is clear. Capture a sample with a slight change in angle.' : 'Three samples ready. Capture a fresh frame to verify enrollment.' };
        if (session.hashes.has(frameHash) || now - session.lastCapture < 600) return { ...result, code: 'fresh_frame', message: 'Move slightly, hold still, then capture a fresh frame. Repeated images cannot verify enrollment.' };
        const score = session.samples.length ? similarity(descriptor, session.samples) : 1;
        if (score < ENROLL_THRESHOLD) return { ...result, code: 'inconsistent', score, threshold: ENROLL_THRESHOLD, message: 'This capture does not agree with the saved samples. Keep the same person in view, or start enrollment again.' };
        session.lastCapture = now; session.hashes.add(frameHash);
        if (session.samples.length < 3) {
          session.samples.push(descriptor);
          return { ...result, sampleCount: session.samples.length, code: 'sample_captured', message: session.samples.length < 3 ? 'Sample captured. Change your angle slightly for the next one.' : 'Three samples captured. Now look at the camera for a fresh verification capture.' };
        }
        session.verified = true;
        return { ...result, verified: true, code: 'verified', score, threshold: ENROLL_THRESHOLD, message: 'Fresh-frame verification passed. Save this enrollment to enable face-assisted attendance.' };
      }
      const candidates = this.store.faceCandidates({ date: session.date });
      const match = rankMatches(descriptor, candidates);
      result.score = match.score; result.threshold = MATCH_THRESHOLD; result.margin = match.margin;
      if (match.code !== 'candidate') {
        session.streak = 0; session.lastStudent = null;
        const messages = { unknown: 'Face detected, but it does not match the enrolled students. Face the camera; if this continues, ask the Admin to re-enroll your face.', ambiguous: 'Two registrations are too similar to distinguish. Ask the Admin to check enrollment or use manual attendance.', no_enrollment: 'No current face enrollments remain on today’s roster. Ask the Admin to check the roster and enrollment.' };
        return { ...result, streak: 0, code: match.code, message: messages[match.code] };
      }
      if (session.lastStudent !== match.student.id || now - session.lastAt > 3000) {
        session.streak = 0; session.firstAt = now;
      }
      if (frameHash !== session.lastHash && now - session.lastAt >= 250) session.streak++;
      session.lastStudent = match.student.id; session.lastHash = frameHash; session.lastAt = now;
      result.streak = Math.min(STABLE_FRAMES, session.streak);
      if (session.streak < STABLE_FRAMES || now - session.firstAt < 1000) return { ...result, code: 'checking', message: `Consistent match ${result.streak}/${STABLE_FRAMES}. Keep looking at the camera…` };
      const token = randomUUID();
      this.proofs.set(token, { owner: session.owner, studentId: match.student.id, date: session.date, expires: now + 120000, fingerprint: fingerprint(match.student) });
      session.finished = true;
      return { ...result, code: 'matched', message: 'Consistent match found. Confirm the student before saving attendance.', match: {
        id: match.student.id, display_id: match.student.display_id, name: match.student.name,
        checkin_count: match.student.checkin_count, last_checkin_at: match.student.last_checkin_at,
        last_utc_offset: match.student.last_utc_offset, proof: token,
      } };
    } finally { session.processing = false; }
  }
  saveEnrollment({ sessionId }) {
    const session = this.getSession(sessionId);
    if (session.mode !== 'enroll' || !session.verified || session.processing) throw new Error('Capture three samples and pass fresh-frame verification before saving.');
    this.store.saveFace({ id: session.studentId, descriptors: session.samples, consent: session.consent, model: MODEL });
    this.sessions.delete(sessionId);
    return true;
  }
  recordAttendance(payload) {
    const user = this.store.require();
    if (payload.method === 'face') {
      const proof = this.proofs.get(payload.proof);
      if (!proof || proof.owner !== user.id || proof.studentId !== payload.studentId || proof.date !== payload.date || proof.expires < this.clock()) throw new Error('Face confirmation has expired or is missing. Scan again before saving.');
      const current = this.store.faceCandidates({ date: payload.date }).find(x => x.id === payload.studentId);
      if (!current || fingerprint(current) !== proof.fingerprint) throw new Error('Face enrollment changed after scanning. Scan again.');
    }
    const result = this.store.recordAttendance(payload);
    if (payload.proof) this.proofs.delete(payload.proof);
    return result;
  }
}
module.exports = { FaceService, rankMatches, cosine, similarity, MATCH_THRESHOLD, MATCH_MARGIN, STABLE_FRAMES };
