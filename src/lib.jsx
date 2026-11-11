import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { X, LoaderCircle, Search, Inbox, AlertCircle, CheckCircle2 } from 'lucide-react';

export async function api(action, payload = {}) {
  if (!window.desktop) throw new Error('Open Presence using the desktop application, not a web browser.');
  const result = await window.desktop[action](payload);
  if (!result.ok) throw new Error(result.error || 'The operation could not be completed.');
  return result.data;
}
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
export const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export const displayDate = value => value ? new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
export const displayTime = row => row.checked_in_at
  ? new Date(new Date(row.checked_in_at).getTime() + (row.utc_offset || 0) * 60000).toISOString().slice(11, 19) : '—';
export const initials = name => name?.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?';
export const methodName = value => ({ manual: 'Manual', face: 'Face-assisted', admin_correction: 'Admin correction' }[value] || '—');

export function useQuery(action, payload = {}) {
  const { revision } = useApp();
  const key = JSON.stringify(payload);
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: '' }));
    api(action, JSON.parse(key)).then(data => { if (!cancelled) setState({ data, loading: false, error: '' }); })
      .catch(error => { if (!cancelled) setState({ data: null, loading: false, error: error.message }); });
    return () => { cancelled = true; };
  }, [action, key, revision, attempt]);
  return { ...state, retry: () => setAttempt(x => x + 1) };
}
export function useAction() {
  const { notify, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const run = async (operation, message, after) => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    try {
      const result = await operation();
      if (!result?.canceled) { refresh(); if (message) notify(message); await after?.(result); }
      return result;
    } catch (error) { notify(error.message, 'error'); }
    finally { guard.current = false; setBusy(false); }
  };
  return { busy, run };
}
export function Button({ children, busy, className = '', variant = 'primary', ...props }) {
  return <button {...props} disabled={props.disabled || busy} className={`button ${variant} ${className}`}>{busy && <LoaderCircle size={16} className="spin" />}{children}</button>;
}
export function PageHeader({ eyebrow = 'YOUR CLASSROOM, CONNECTED LOCALLY', title, description, children }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}</div></div>;
}
export function Field({ label, children, hint }) {
  const generatedId = useId();
  const id = children.props.id || generatedId;
  return <div className="field"><label htmlFor={id}>{label}</label>{React.cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function SearchBox({ value, onChange, placeholder = 'Search students…' }) {
  return <div className="search-box"><Search size={18} /><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} /></div>;
}
export function Badge({ status, children }) {
  return <span className={`badge ${status}`}><span className="badge-dot" />{children || ({ present: 'Present', absent: 'Absent', pending: 'Not yet recorded', open: 'Open', closed: 'Closed' }[status] || status)}</span>;
}
export function Avatar({ name, small = false }) { return <span className={`avatar ${small ? 'small' : ''}`}>{initials(name)}</span>; }
export function StudentName({ row }) {
  return <div className="person"><Avatar name={row.name} /><div><strong>{row.name}</strong><small>{row.display_id || row.student_id}</small></div></div>;
}
export function Empty({ title = 'Nothing here yet', children }) {
  return <div className="empty"><div className="empty-icon"><Inbox size={26} /></div><h3>{title}</h3><p>{children}</p></div>;
}
export function QueryState({ query, children }) {
  if (query.loading) return <div className="loading" role="status"><LoaderCircle className="spin" size={22} /> Loading your records…</div>;
  if (query.error) return <div className="error-box" role="alert"><AlertCircle size={20} /><span>{query.error}</span><Button variant="secondary" onClick={query.retry}>Retry</Button></div>;
  return children;
}
export function Modal({ title, children, onClose, wide = false, busy = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    const cancel = event => { event.preventDefault(); if (!busyRef.current) closeRef.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby="modal-title"><div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20} /></button></div><div className="modal-body">{children}</div></dialog>;
}
export function Confirm({ title, children, onConfirm, onClose, busy, label = 'Confirm', danger = false }) {
  return <Modal title={title} onClose={onClose} busy={busy}><div className="confirm-copy">{children}</div><div className="form-actions"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{label}</Button></div></Modal>;
}
export function Toast({ toast, dismiss }) {
  useEffect(() => { if (!toast) return; const timer = setTimeout(dismiss, toast.type === 'error' ? 9000 : 5000); return () => clearTimeout(timer); }, [toast, dismiss]);
  if (!toast) return null;
  return <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>{toast.type === 'error' ? <AlertCircle size={21} /> : <CheckCircle2 size={21} />}<span>{toast.text}</span><button aria-label="Dismiss notification" onClick={dismiss}><X size={17} /></button></div>;
}
export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState(null);
  const refresh = useCallback(() => setRevision(x => x + 1), []);
  const notify = useCallback((text, type = 'success') => setToast({ text, type, id: Date.now() }), []);
  const dismiss = useCallback(() => setToast(null), []);
  return <AppContext.Provider value={{ user, setUser, revision, refresh, notify }} >{children}<Toast toast={toast} dismiss={dismiss} /></AppContext.Provider>;
}
