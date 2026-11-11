import React, { useEffect, useState } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ScanFace, LayoutDashboard, Users, CalendarCheck, ClipboardList, UserCog, Settings, LogOut, ArrowRight, ShieldCheck, HardDrive, Radio, LockKeyhole } from 'lucide-react';
import { AppProvider, useApp, api, Button, Field, Avatar } from './lib';
import Dashboard from './pages/Dashboard';
import Students from './pages/Students';
import Attendance from './pages/Attendance';
import Records from './pages/Records';
import Accounts from './pages/Accounts';
import SettingsPage from './pages/Settings';

function Login() {
  const { setUser } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try { setUser(await api('login', { username, password })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="login-page"><section className="login-story"><div className="brand"><span className="brand-mark"><ScanFace size={28} /></span>presence<span className="brand-period">.</span></div><div className="story-content"><div className="eyebrow">LESS ADMIN. MORE TEACHING.</div><h1>Every student.<br />Every day.<br /><span>Accounted for.</span></h1><p>A little less paperwork. A little more time for what matters. Your classroom attendance, all in one place.</p><div className="story-visual"><div className="face-frame"><ScanFace size={106} strokeWidth={1} /></div><div className="visual-tag"><ShieldCheck size={18} /> Private by design</div><div className="visual-line" /><span>FACE-ASSISTED · HUMAN-CONFIRMED</span></div></div><div className="login-footer"><HardDrive size={16} /> Stored on this computer. Available offline.</div></section><section className="login-form-side"><div className="login-form"><span className="overline"><span className="live-dot" /> WINDOWS DESKTOP</span><h2>Welcome back</h2><p>Sign in to your classroom workspace.</p><form onSubmit={submit}><Field label="Username"><input autoFocus autoComplete="username" required maxLength={60} value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter your username" /></Field><Field label="Password"><input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" /></Field>{error && <div className="inline-error" role="alert">{error}</div>}<Button type="submit" busy={busy} className="login-submit">Sign in <ArrowRight size={18} /></Button></form><div className="demo-accounts"><LockKeyhole size={18} /><div><strong>First-time demo access</strong><p>Admin: <code>admin / admin123</code><br />Teacher: <code>teacher / teacher123</code></p><small>Change passwords in Settings after your first login.</small></div></div><div className="local-note"><ShieldCheck size={15} /> No cloud. No server. Your data stays here.</div></div></section></div>;
}

const links = [
  ['/', 'Overview', LayoutDashboard], ['/attendance', 'Take attendance', CalendarCheck], ['/students', 'Students', Users],
  ['/records', 'Attendance records', ClipboardList], ['/accounts', 'Team accounts', UserCog, true], ['/settings', 'Settings & backup', Settings],
];
function Workspace() {
  const { user, setUser, notify } = useApp();
  const location = useLocation();
  const [loggingOut, setLoggingOut] = useState(false);
  const title = links.find(([path]) => path === location.pathname)?.[1] || 'Workspace';
  async function logout() {
    setLoggingOut(true);
    try { await api('logout'); setUser(null); } catch (e) { notify(e.message, 'error'); } finally { setLoggingOut(false); }
  }
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><ScanFace size={25} /></span>presence<span className="brand-period">.</span></div><div className="workspace-label">CLASSROOM WORKSPACE</div><nav aria-label="Main navigation">{links.filter(x => !x[3] || user.role === 'admin').map(([path, label, Icon]) => <NavLink key={path} to={path} end={path === '/'}><Icon size={19} /><span>{label}</span></NavLink>)}</nav><div className="sidebar-bottom"><div className="offline-card"><span className="offline-icon"><HardDrive size={19} /></span><div><strong>Local-first workspace</strong><p>Your records stay on this PC</p><span><i /> Offline ready</span></div></div><div className="sidebar-account"><Avatar name={user.username} /><div><strong>{user.username}</strong><small>{user.role === 'admin' ? 'Administrator' : 'Teacher'}</small></div><button className="icon-button" aria-label="Log out" onClick={logout} disabled={loggingOut}><LogOut size={18} /></button></div></div></aside><div className="workspace"><header className="topbar"><div>Workspace <span>/</span> <strong>{title}</strong></div><div className="topbar-right"><span className="local-pill"><Radio size={14} /> On-device storage</span><span className="topbar-divider" /><Avatar name={user.username} small /></div></header><main key={user.id}><Routes><Route path="/" element={<Dashboard />} /><Route path="/students" element={<Students />} /><Route path="/attendance" element={<Attendance />} /><Route path="/records" element={<Records />} /><Route path="/accounts" element={user.role === 'admin' ? <Accounts /> : <Navigate to="/" replace />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></main><footer className="workspace-footer"><span>Presence Attendance</span><span>Made for the classroom. Kept on your computer.</span></footer></div></div>;
}
function Session() {
  const { user, setUser, notify } = useApp();
  const [loading, setLoading] = useState(true);
  useEffect(() => { api('session').then(setUser).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="splash"><ScanFace size={42} /><h2>Opening your workspace…</h2></div>;
  return user ? <Workspace /> : <Login />;
}
export default function App() { return <AppProvider><HashRouter><Session /></HashRouter></AppProvider>; }
