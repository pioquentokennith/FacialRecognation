import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { api, useApp, useAction, useQuery, Button, Confirm, QueryState } from '../lib';

export default function FaceReadiness({ date }) {
  const { user, notify } = useApp();
  const query = useQuery('faceStatus', { date });
  const { run, busy } = useAction();
  const [confirm, setConfirm] = useState(false);
  const data = query.data;
  return <div className="face-readiness"><QueryState query={query}>{data && <>
    <div><ShieldCheck size={19} /><strong>{data.ready} face enrollment{data.ready !== 1 ? 's' : ''} ready on this roster</strong></div>
    {data.needsUpgrade > 0 && <p>{data.needsUpgrade} student{data.needsUpgrade !== 1 ? 's need' : ' needs'} one-time face re-enrollment for MediaPipe + SFace. <Link className="text-link" to="/students">View students</Link></p>}
    {data.missingEnrollment > 0 && <p>{data.missingEnrollment} active student{data.missingEnrollment !== 1 ? 's have' : ' has'} no saved face enrollment. Manual check-in remains available.</p>}
    {data.notOnRoster.length > 0 && <div className="roster-warning"><p>{data.notOnRoster.length} active student{data.notOnRoster.length !== 1 ? 's are' : ' is'} outside this saved roster: {data.notOnRoster.slice(0, 4).map(x => x.name).join(', ')}{data.notOnRoster.length > 4 ? '…' : ''}.</p>{user.role === 'admin' ? <Button variant="secondary" onClick={() => setConfirm(true)}><UserPlus size={15} /> Include newly registered students</Button> : <p>Ask the Admin to include newly registered students before scanning them today.</p>}</div>}
  </>}</QueryState>{confirm && <Confirm title="Include newly registered students?" label="Include in today’s roster" busy={busy} onClose={() => setConfirm(false)} onConfirm={() => run(() => api('includeStudentsToday', { date }), null, result => { notify(`${result.added} students added to today’s roster.`); setConfirm(false); })}><p>This adds active students missing from today’s open roster. Existing roster details and attendance are preserved. This change is recorded in the audit history.</p></Confirm>}</div>;
}
