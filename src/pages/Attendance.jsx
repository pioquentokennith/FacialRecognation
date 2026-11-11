import React, { useState } from 'react';
import { CalendarDays, ScanFace, MousePointer2, Play, LockKeyhole, UnlockKeyhole, CheckCircle2 } from 'lucide-react';
import { api, useQuery, useAction, useApp, today, displayDate, displayTime, PageHeader, Button, Badge, QueryState, Empty, StudentName, SearchBox, Confirm } from '../lib';
import FaceCapture from '../components/FaceCapture';
import FaceReadiness from '../components/FaceReadiness';

export default function Attendance() {
  const { user } = useApp();
  const admin = user.role === 'admin';
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState('manual');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(null);
  const query = useQuery('day', { date });
  const { busy, run } = useAction();
  const day = query.data?.day;
  const rows = query.data?.rows || [];
  const live = date === today() && day?.state === 'open';
  const filtered = rows.filter(row => `${row.name} ${row.display_id} ${row.course}`.toLowerCase().includes(search.toLowerCase()));
  function saveConfirmed() {
    const { type, student } = confirm;
    if (type === 'record') run(() => api('recordAttendance', {
      date, studentId: student.id || student.student_id, method: confirm.method, proof: student.proof, confirmed: true,
    }), `Attendance saved for ${student.name}.`, () => setConfirm(null));
    else run(() => api(type === 'open' ? 'openDay' : type === 'close' ? 'closeDay' : 'reopenDay', { date }),
      `Attendance ${type === 'open' ? 'opened' : type === 'close' ? 'closed' : 'reopened'}.`, () => setConfirm(null));
  }
  return <>
    <PageHeader title="Take attendance" description="One student at a time. One less thing to worry about.">
      <label className="date-control"><CalendarDays size={17} /><input type="date" aria-label="Attendance date" value={date} max={today()} onChange={e => { if (e.target.value) { setDate(e.target.value); setConfirm(null); } }} /></label>
    </PageHeader>
    <QueryState query={query}>
      <section className="day-bar"><div><span className="day-icon"><CalendarDays size={22} /></span><div><strong>{displayDate(date)}</strong><p>{day ? `${rows.length} students on the saved roster` : 'Open attendance to save today’s eligible student roster'}</p></div>{day && <Badge status={day.state} />}</div>
        <div>{!day && date === today() && <Button busy={busy} onClick={() => setConfirm({ type: 'open' })}><Play size={16} /> Open today’s attendance</Button>}
          {admin && day?.state === 'open' && <Button variant="secondary" onClick={() => setConfirm({ type: 'close' })}><LockKeyhole size={16} /> Close attendance</Button>}
          {admin && day?.state === 'closed' && <Button variant="secondary" onClick={() => setConfirm({ type: 'reopen' })}><UnlockKeyhole size={16} /> Reopen day</Button>}
        </div>
      </section>
      {!day ? <section className="panel"><Empty title={date === today() ? 'A new day starts here' : 'No attendance day on this date'}>{date === today() ? 'Register your students first, then open attendance to save the roster.' : 'Choose an existing day to review it, or return to today to start attendance.'}</Empty></section> : <>
        {day.state === 'closed' && <div className="info-strip"><LockKeyhole size={18} /> This day is closed. An Admin can reopen it to make corrections.</div>}
        {date !== today() && <div className="info-strip">Historical changes are made by an Admin on the Attendance Records page after reopening the day.</div>}
        {live && <section className="panel attendance-entry">
          <div className="list-toolbar"><div className="tabs"><button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}><MousePointer2 size={17} /> Manual check-in</button><button className={mode === 'face' ? 'active' : ''} onClick={() => setMode('face')}><ScanFace size={18} /> Face-assisted</button></div><span className="muted small-text">Identity confirmation required</span></div>
          {mode === 'face' ? <><FaceReadiness date={date} /><div className="camera-panel"><FaceCapture mode="attendance" date={date} onMatch={student => setConfirm({ type: 'record', student, method: 'face' })} /></div></> : <div className="manual-intro"><div><h3>A name is all you need.</h3><p>Find the student below, then select Check in and confirm their identity.</p></div><SearchBox value={search} onChange={setSearch} placeholder="Find a student on today’s roster…" /></div>}
        </section>}
        <section className="panel"><div className="panel-header"><div><h2>Daily roster <span className="count-pill">{rows.length}</span></h2><p>{rows.filter(r => r.status === 'present').length} present · {rows.filter(r => r.status === 'absent').length} absent · {rows.filter(r => r.status === 'pending').length} not yet recorded</p></div>{(!live || mode === 'face') && <SearchBox value={search} onChange={setSearch} placeholder="Search roster…" />}</div>
          {filtered.length ? <div className="table-scroll"><table><thead><tr><th>Student</th><th>Course</th><th>Status</th><th>Check-in time</th>{live && <th className="align-right">Action</th>}</tr></thead><tbody>{filtered.map(row => <tr key={row.student_id}><td><StudentName row={row} /></td><td>{row.course}</td><td><Badge status={row.status} /></td><td className="mono">{displayTime(row)}</td>{live && <td className="align-right">{row.status === 'present' ? <span className="checked-label"><CheckCircle2 size={16} /> Recorded</span> : <Button variant="secondary" onClick={() => setConfirm({ type: 'record', student: { ...row, id: row.student_id }, method: 'manual' })}>Check in</Button>}</td>}</tr>)}</tbody></table></div> : <Empty title={search ? 'No matching students' : 'This day has an empty roster'}>{search ? 'Try a different name or Student ID.' : 'The Admin can include newly registered students using the Face-assisted roster controls.'}</Empty>}
        </section>
      </>}
    </QueryState>
    {confirm && <Confirm title={confirm.type === 'record' ? 'Confirm student identity' : confirm.type === 'open' ? 'Open today’s attendance?' : confirm.type === 'close' ? 'Close attendance for this day?' : 'Reopen attendance?'} onClose={() => setConfirm(null)} onConfirm={saveConfirmed} busy={busy} label={confirm.type === 'record' ? 'Confirm & save attendance' : 'Confirm'}>
      {confirm.type === 'record' ? <><StudentName row={{ ...confirm.student, display_id: confirm.student.display_id || confirm.student.student_id }} /><p>Please confirm that <strong>{confirm.student.name}</strong> is the student checking in. This will record them as present on {displayDate(date)}.</p>{confirm.method === 'face' && <div className="form-note">Multiple live frames matched this enrollment. Confirm the identity before saving. This confirmation expires after two minutes.</div>}</> : <p>{confirm.type === 'open' ? 'All currently active students will be added to the daily roster. An Admin can explicitly include newly registered students later, with an audit record.' : confirm.type === 'close' ? 'Students on this roster without attendance will be marked absent. Further check-ins are blocked until an Admin reopens the day.' : 'The saved roster stays the same. Existing absent records remain until corrected or replaced by a confirmed check-in.'}</p>}
    </Confirm>}
  </>;
}
