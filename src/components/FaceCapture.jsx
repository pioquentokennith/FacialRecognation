import React, { useEffect, useRef, useState } from 'react';
import { Camera, ScanFace, VideoOff, Check, ShieldCheck, RotateCcw } from 'lucide-react';
import { api, useAction, Button, Badge } from '../lib';

export default function FaceCapture({ mode, student, date, onComplete, onMatch }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const sessionRef = useRef(null);
  const alive = useRef(true);
  const operation = useRef(0);
  const timer = useRef(null);
  const captureRequested = useRef(false);
  const captureFeedback = useRef(null);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sampleCount, setSampleCount] = useState(0);
  const [verified, setVerified] = useState(false);
  const [consent, setConsent] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const { busy, run } = useAction();
  const enrolling = mode === 'enroll';

  function stop(cancelSession = true) {
    operation.current++;
    clearTimeout(timer.current);
    captureRequested.current = false;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (cancelSession && sessionRef.current) {
      api('cancelFaceScan', { sessionId: sessionRef.current }).catch(() => {});
      sessionRef.current = null;
    }
    if (alive.current) { setRunning(false); setWorking(false); setCapturing(false); }
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stop(); };
  }, []);

  function drawOverlay(result, width, height) {
    const canvas = overlayRef.current;
    if (!canvas) return;
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    if (!result.box) return;
    const { x, y, width: w, height: h } = result.box;
    context.strokeStyle = result.usable ? '#79e2b7' : '#ffd174';
    context.lineWidth = 3;
    context.strokeRect(x * width, y * height, w * width, h * height);
    context.fillStyle = '#ffffff';
    for (const [px, py] of result.points || []) {
      context.beginPath(); context.arc(px * width, py * height, 3, 0, Math.PI * 2); context.fill();
    }
  }
  async function scan(ticket) {
    if (!alive.current || ticket !== operation.current || !streamRef.current) return;
    try {
      const video = videoRef.current;
      if (!video?.videoWidth || video.readyState < 2) { timer.current = setTimeout(() => scan(ticket), 250); return; }
      const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
      const ratio = Math.min(640 / video.videoWidth, 480 / video.videoHeight, 1);
      canvas.width = Math.round(video.videoWidth * ratio); canvas.height = Math.round(video.videoHeight * ratio);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const capture = captureRequested.current;
      captureRequested.current = false;
      const result = await api('processFaceFrame', { sessionId: sessionRef.current, frame: canvas.toDataURL('image/jpeg', 0.9), capture });
      if (!alive.current || ticket !== operation.current) return;
      if (capture) setCapturing(false);
      if (enrolling && capture && ['fresh_frame', 'inconsistent'].includes(result.code)) captureFeedback.current = { text: result.message, until: Date.now() + 5000 };
      setAnalysis(result); setMessage(captureFeedback.current?.until > Date.now() ? captureFeedback.current.text : result.message); setError('');
      setSampleCount(result.sampleCount); setVerified(result.verified);
      drawOverlay(result, canvas.width, canvas.height);
      if (result.code === 'matched') {
        stop();
        onMatch(result.match);
        return;
      }
      if (result.verified) { stop(false); return; }
      timer.current = setTimeout(() => scan(ticket), 300);
    } catch (e) {
      if (!alive.current || ticket !== operation.current) return;
      stop(); setError(e.message); setMessage('Scanning stopped. Resolve the message above, then retry.');
    }
  }
  async function start() {
    if (working || running) return;
    stop();
    const ticket = ++operation.current;
    setWorking(true); setError(''); setAnalysis(null); setSampleCount(0); setVerified(false);
    captureFeedback.current = null;
    setMessage('Starting the offline MediaPipe + SFace service…');
    try {
      const session = await api('beginFaceScan', { mode: enrolling ? 'enroll' : 'attendance', studentId: student?.id, date, consent });
      if (!alive.current || ticket !== operation.current) { api('cancelFaceScan', { sessionId: session.sessionId }).catch(() => {}); return; }
      sessionRef.current = session.sessionId;
      setMessage('Connecting to your camera…');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable. Open the desktop application.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      if (!alive.current || ticket !== operation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      for (const track of stream.getVideoTracks()) track.onended = () => {
        if (alive.current && ticket === operation.current) { stop(); setError('The camera disconnected. Reconnect it and start scanning again.'); }
      };
      videoRef.current.srcObject = stream;
      let playbackTimeout;
      try {
        await Promise.race([videoRef.current.play(), new Promise((_, reject) => {
          playbackTimeout = setTimeout(() => reject(new Error('The camera is connected but is not providing video. Reconnect it and retry.')), 15000);
        })]);
      } finally { clearTimeout(playbackTimeout); }
      if (!alive.current || ticket !== operation.current) return;
      setRunning(true); setWorking(false); setMessage('Scanning continuously. Keep one face in view.');
      scan(ticket);
    } catch (e) {
      if (!alive.current || ticket !== operation.current) return;
      stop();
      setError(({ NotAllowedError: 'Camera permission was denied. Enable desktop camera access in Windows Settings → Privacy & security → Camera, then retry.', NotFoundError: 'No camera was found. Connect a webcam or use manual attendance.', NotReadableError: 'The camera is busy. Close other camera applications and retry.' })[e.name] || e.message);
      setMessage('');
    }
  }
  function restart() { stop(); setSampleCount(0); setVerified(false); setAnalysis(null); setMessage('Start the camera to capture a new enrollment.'); setError(''); }
  function capture() { if (!running || capturing) return; captureFeedback.current = null; captureRequested.current = true; setCapturing(true); }

  return <div className="face-capture">
    <div className="scanner-engine"><ScanFace size={17} /><strong>MediaPipe + SFace</strong><Badge status="present">Offline AI</Badge></div>
    {enrolling && <><p className="form-intro">Capture three clear samples of <strong>{student.name}</strong> with small changes in angle. Then verify with a separate, fresh capture. Photographs are not saved.</p>
      {!!student.needs_face_upgrade && <div className="info-strip">This student’s older face registration needs one-time re-enrollment for the new recognition model.</div>}
      <label className="checkbox-line"><input type="checkbox" checked={consent} disabled={busy} onChange={e => { setConsent(e.target.checked); if (!e.target.checked) restart(); }} /> The student consents to local face enrollment and understands it can be deleted.</label></>}
    <div className={`camera-stage live-scanner ${running ? 'running' : ''}`}>
      <video ref={videoRef} autoPlay playsInline muted aria-label="Live webcam preview" />
      <canvas ref={overlayRef} className="face-overlay" aria-hidden="true" />
      {!running && <div className="camera-overlay"><div className="camera-icon">{verified ? <ShieldCheck size={46} /> : <ScanFace size={46} strokeWidth={1.3} />}</div><h3>{working ? 'Starting offline recognition…' : verified ? 'Enrollment verified' : 'Ready to recognize your students'}</h3><p>{verified ? 'Save this verified enrollment to finish.' : 'Keep your whole face visible, with light in front of you.'}</p></div>}
      {running && <span className="camera-live"><i /> {enrolling ? 'LIVE ENROLLMENT' : 'SCANNING CONTINUOUSLY'}</span>}
    </div>
    <div className="camera-controls">
      {!running ? <Button onClick={start} busy={working} disabled={verified || (enrolling && !consent)}><Camera size={17} /> Start camera</Button> : <>
        {enrolling && <Button onClick={capture} busy={capturing} disabled={!analysis?.usable}><ScanFace size={18} /> {sampleCount < 3 ? `Capture sample ${sampleCount + 1} of 3` : 'Verify with fresh capture'}</Button>}
        <Button variant="secondary" onClick={() => { stop(); if (enrolling) { setSampleCount(0); setVerified(false); } setMessage('Camera stopped. Start again when ready.'); }}><VideoOff size={16} /> Stop camera</Button>
      </>}
      {enrolling && <div className="sample-progress">{[0, 1, 2].map(i => <span className={sampleCount > i ? 'captured' : ''} key={i}>{sampleCount > i ? <Check size={15} /> : i + 1}</span>)}<span className={verified ? 'captured' : ''} title="Fresh-capture verification">{verified ? <Check size={15} /> : 'V'}</span></div>}
    </div>
    {message && <div className={`scan-feedback ${analysis?.usable ? 'good' : ''}`} role="status"><span>{message}</span>{!enrolling && running && <div className="scan-steps" aria-label={`${analysis?.streak || 0} of 3 consistent matches`}>{[1, 2, 3].map(i => <i key={i} className={(analysis?.streak || 0) >= i ? 'complete' : ''} />)}</div>}</div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {analysis && <details className="scan-diagnostics"><summary>Scan diagnostics</summary><div><span>Faces detected: <strong>{analysis.faceCount}</strong></span><span>Result: <strong>{analysis.code.replaceAll('_', ' ')}</strong></span>{analysis.quality && <><span>Brightness: {analysis.quality.brightness}/255</span><span>Sharpness: {analysis.quality.sharpness}</span></>}{Number.isFinite(analysis.score) && <span>Cosine similarity: {analysis.score.toFixed(3)} · required ≥ {(analysis.threshold || 0.45).toFixed(2)} (not an accuracy percentage)</span>}{analysis.latencyMs && <span>Local processing: {analysis.latencyMs} ms</span>}</div></details>}
    {enrolling ? <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={restart}><RotateCcw size={16} /> Start over</Button><Button disabled={!verified || !consent} busy={busy} onClick={() => run(() => api('saveFaceEnrollment', { sessionId: sessionRef.current }), 'Verified face enrollment saved.', () => { stop(); onComplete(); })}>Save face enrollment</Button></div> : <div className="camera-disclaimer"><ShieldCheck size={17} /><span>Three consistent live frames are required. Attendance is saved only after confirmation.</span></div>}
  </div>;
}
