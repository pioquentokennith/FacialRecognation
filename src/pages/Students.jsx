import React, { useState } from 'react';
import { Plus, ScanFace, Pencil, Archive, RotateCcw, Trash2, ShieldCheck } from 'lucide-react';
import { api, useApp, useQuery, useAction, PageHeader, Button, SearchBox, QueryState, Empty, StudentName, Badge, Modal, Field, Confirm } from '../lib';
import FaceCapture from '../components/FaceCapture';

function StudentForm({ student, onClose }) {
  const [form, setForm] = useState(student ? { id: student.id, student_id: student.student_id, name: student.name, course: student.course, year: student.year } : { student_id: '', name: '', course: '', year: '' });
  const { busy, run } = useAction();
  const set = key => e => setForm({ ...form, [key]: e.target.value });
  return <Modal title={student ? 'Edit student' : 'Register a student'} onClose={onClose} busy={busy}>
    <p className="form-intro">Start with the essentials. Face enrollment is optional and can be added after registration.</p>
    <form onSubmit={e => { e.preventDefault(); run(() => api('saveStudent', form), student ? 'Student updated.' : 'Student registered. You can now add face enrollment.', onClose); }}>
      <Field label="Student ID"><input autoFocus required maxLength={60} value={form.student_id} onChange={set('student_id')} placeholder="e.g. 2026-001" /></Field>
      <Field label="Full name"><input required maxLength={160} value={form.name} onChange={set('name')} placeholder="e.g. Alex Santos" /></Field>
      <div className="form-grid"><Field label="Course"><input required maxLength={100} value={form.course} onChange={set('course')} placeholder="e.g. BS Computer Science" /></Field><Field label="Year level"><input required maxLength={40} value={form.year} onChange={set('year')} placeholder="e.g. 1st year" /></Field></div>
      <div className="form-note"><ShieldCheck size={17} /> Student IDs are unique. Changes won’t rewrite historical reports.</div>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>{student ? 'Save changes' : 'Register student'}</Button></div>
    </form>
  </Modal>;
}

export default function Students() {
  const { user } = useApp();
  const admin = user.role === 'admin';
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [form, setForm] = useState(null);
  const [face, setFace] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const query = useQuery('students', { search, archived });
  const { busy, run } = useAction();
  function executeConfirm() {
    const { type, row } = confirm;
    const request = type === 'archive' || type === 'reactivate' ? () => api('archiveStudent', { id: row.id, active: type === 'reactivate' }) : () => api(type === 'face' ? 'deleteFace' : 'deleteStudent', { id: row.id });
    run(request, type === 'face' ? 'Face enrollment deleted.' : 'Student record updated.', () => setConfirm(null));
  }
  return <>
    <PageHeader title="Your students" description="A familiar face starts with a verified student enrollment.">{admin && <Button onClick={() => setForm({})}><Plus size={18} /> Register student</Button>}</PageHeader>
    {!!query.data?.some(row => row.needs_face_upgrade) && <div className="upgrade-notice"><ScanFace size={23} /><div><strong>New offline face engine: MediaPipe + SFace</strong><p>Older face registrations need one-time re-enrollment. Open the face icon, capture three samples, and pass the fresh-capture check. Student details and attendance history stay available.</p></div></div>}
    <section className="panel">
      <div className="list-toolbar"><div className="tabs"><button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>Active students</button><button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>Archived</button></div><SearchBox value={search} onChange={setSearch} placeholder="Search ID, name, course, or year…" /></div>
      <QueryState query={query}>
        {query.data?.length ? <>
          <div className="table-scroll"><table><thead><tr><th>Student</th><th>Course</th><th>Year level</th><th>Face enrollment</th>{admin && <th className="align-right">Actions</th>}</tr></thead><tbody>{query.data.map(row => <tr key={row.id}>
            <td><StudentName row={row} /></td><td>{row.course}</td><td>{row.year}</td>
            <td><Badge status={row.has_face ? 'present' : row.needs_face_upgrade ? 'pending' : 'neutral'}>{row.has_face ? 'Enrolled · SFace' : row.needs_face_upgrade ? 'Re-enrollment required' : 'Manual only'}</Badge></td>
            {admin && <td><div className="row-actions">
              <button className="icon-button" title="Edit student" aria-label={`Edit ${row.name}`} onClick={() => setForm(row)}><Pencil size={16} /></button>
              {!archived && <button className="icon-button" title={row.has_face ? 'Replace verified face enrollment' : 'Enroll and verify face'} aria-label={`Enroll face for ${row.name}`} onClick={() => setFace(row)}><ScanFace size={18} /></button>}
              {!!(row.has_face || row.needs_face_upgrade) && <button className="text-button danger-text" onClick={() => setConfirm({ type: 'face', row })}>Remove face</button>}
              <button className="icon-button" title={archived ? 'Reactivate student' : 'Archive student'} aria-label={`${archived ? 'Reactivate' : 'Archive'} ${row.name}`} onClick={() => setConfirm({ type: archived ? 'reactivate' : 'archive', row })}>{archived ? <RotateCcw size={16} /> : <Archive size={16} />}</button>
              {archived && <button className="icon-button danger-text" title="Permanently delete (only without history)" aria-label={`Delete ${row.name}`} onClick={() => setConfirm({ type: 'delete', row })}><Trash2 size={16} /></button>}
            </div></td>}
          </tr>)}</tbody></table></div>
          <div className="table-footer">{query.data.length} {archived ? 'archived' : 'active'} student{query.data.length !== 1 ? 's' : ''}<span>Face enrollment includes a fresh-capture verification check.</span></div>
        </> : <Empty title={search ? 'No matching students' : archived ? 'No archived students' : 'Meet your new classroom roster'}>{search ? 'Try another name, Student ID, or course.' : archived ? 'Archived students retain their historical records.' : 'Register your first student to get started.'}</Empty>}
      </QueryState>
    </section>
    <div className="info-strip"><ShieldCheck size={18} /><span>If today is already open, the Admin can include newly registered students using the Face-assisted roster controls on Take Attendance.</span></div>
    {form && <StudentForm student={form.id ? form : null} onClose={() => setForm(null)} />}
    {face && <Modal title={`Face enrollment · ${face.name}`} onClose={() => setFace(null)} wide><FaceCapture mode="enroll" student={face} onComplete={() => setFace(null)} /></Modal>}
    {confirm && <Confirm title={{ archive: 'Archive this student?', reactivate: 'Reactivate this student?', face: 'Delete face enrollment?', delete: 'Permanently delete student?' }[confirm.type]} onClose={() => setConfirm(null)} busy={busy} onConfirm={executeConfirm} danger={confirm.type !== 'reactivate'} label={confirm.type === 'reactivate' ? 'Reactivate student' : 'Confirm removal'}>
      <strong>{confirm.row.name}</strong><p>{({ archive: 'This removes their face data and excludes them from future rosters. Existing daily rosters and attendance history stay intact.', reactivate: 'This student will join future daily rosters. Face enrollment must be captured again if previously deleted.', face: 'All saved face descriptors will be removed. Manual attendance remains available.', delete: 'This is available only for students with no daily roster or attendance history. Otherwise, keep the student archived.' })[confirm.type]}</p>
    </Confirm>}
  </>;
}
