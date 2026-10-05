import { useCallback, useEffect, useRef, useState } from 'react';
import { can, PERMISSIONS, ROLE_LABEL, type AppState, type Perm, type Role, type User } from './shared';
import { api, dateTime, loadPush, pushNotify, savePush, setApiUser, sound, time, type PushSettings } from './lib';
import { Btn, cx, Modal, Tag } from './ui';
import Dashboard from './views/Dashboard';
import Scanner from './views/Scanner';
import Inventory from './views/Inventory';
import AuditLog from './views/AuditLog';
import Invoices from './views/Invoices';
import SqlHub from './views/SqlHub';
import PurchaseOrders from './views/PurchaseOrders';
import Forecast from './views/Forecast';

export type View = 'dashboard' | 'scanner' | 'inventory' | 'audit' | 'invoices' | 'purchasing' | 'forecast' | 'sql';
export interface Ctx {
  state: AppState;
  user: User;
  refresh: () => Promise<void>;
  go: (v: View) => void;
  toast: (msg: string, bad?: boolean) => void;
}

const NAV: { id: View; label: string; perm: Perm }[] = [
  { id: 'dashboard', label: 'Dashboard', perm: 'dashboard' },
  { id: 'scanner', label: 'Scan Station', perm: 'lookup' },
  { id: 'inventory', label: 'Inventory', perm: 'lookup' },
  { id: 'forecast', label: 'Forecast', perm: 'forecast' },
  { id: 'purchasing', label: 'Purchase Orders', perm: 'purchaseOrders' },
  { id: 'invoices', label: 'Invoice Intake', perm: 'invoices' },
  { id: 'audit', label: 'Movement Audit', perm: 'movements' },
  { id: 'sql', label: 'T-SQL Hub', perm: 'sqlHub' },
];
const HOME: Record<Role, View> = { ADMIN: 'dashboard', CLERK: 'invoices', CASHIER: 'scanner' };

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [userId, setUserId] = useState(1);
  const [view, setView] = useState<View>('dashboard');
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState<'perms' | 'push' | null>(null);
  const [toastMsg, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [push, setPush] = useState<PushSettings>(loadPush);
  const lastAlert = useRef<number | null>(null);

  setApiUser(userId);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);

  const toast = useCallback((msg: string, bad?: boolean) => {
    setToast({ msg, bad });
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try { setState(await api<AppState>('/api/state')); } catch (e) { toast((e as Error).message, true); }
  }, [toast]);

  // ponytail: 3s polling keeps every terminal in sync; switch to SSE if the store runs many terminals.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // New alerts → native notification (+ chime), once per alert per device.
  useEffect(() => {
    if (!state) return;
    const max = Math.max(0, ...state.alerts.map((a) => a.id));
    if (lastAlert.current === null) { lastAlert.current = max; return; }
    const fresh = state.alerts.filter((a) => a.id > lastAlert.current! && !a.ack);
    lastAlert.current = Math.max(lastAlert.current, max);
    const shown = fresh.filter((a) => !push.criticalOnly || a.severity === 'CRITICAL');
    if (push.enabled) shown.forEach((a) => pushNotify(`SM ASIA · ${a.severity === 'CRITICAL' ? 'OUT OF STOCK' : 'Low stock'}`, a.message, `alert-${a.id}`));
    if (push.sound && shown.length) sound.lowStock();
  }, [state, push]);

  if (!state) return <div className="grid h-screen place-items-center font-mono text-sm text-muted">Connecting to StoreInventoryDB…</div>;

  const user = state.users.find((u) => u.id === userId) ?? state.users[0];
  const nav = NAV.filter((n) => can(user.role, n.perm));
  const current = nav.some((n) => n.id === view) ? view : HOME[user.role];
  const unread = state.alerts.filter((a) => !a.ack);
  const ctx: Ctx = { state, user, refresh, go: setView, toast };

  const switchUser = (u: User) => { setUserId(u.id); setApiUser(u.id); setView(HOME[u.role]); setDrawer(false); };
  const ack = async (id: number | null) => { await api('/api/alerts/ack', { id }); refresh(); };

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-line bg-panel">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center bg-brand font-black tracking-tight text-white">SM</div>
            <div>
              <div className="text-lg font-black leading-5 tracking-[0.18em]">SM ASIA</div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Store #104 · SM Asia Enterprises Inc. · Lloydminster, SK</div>
            </div>
          </div>

          <SqlBadge state={state} onClick={can(user.role, 'sqlHub') ? () => setView('sql') : undefined} />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex border border-line" role="group" aria-label="Employee session">
              {state.users.map((u) => (
                <button key={u.id} onClick={() => switchUser(u)} title={ROLE_LABEL[u.role]}
                  className={cx('px-3 py-1.5 text-left', u.id === user.id ? 'bg-ink text-canvas' : 'hover:bg-canvas')}>
                  <div className="text-xs font-semibold">{u.name}</div>
                  <div className="text-[9px] uppercase tracking-wider opacity-70">{u.role}</div>
                </button>
              ))}
            </div>
            <Btn onClick={() => setModal('perms')} title="Permission matrix">Access</Btn>
            <button onClick={() => setDrawer((d) => !d)} aria-label={`Notifications, ${unread.length} unread`}
              className="relative grid h-9 w-9 place-items-center border border-line hover:border-ink">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
              {unread.length > 0 && (
                <span className={cx('badge-pulse absolute -right-2 -top-2 min-w-5 px-1 font-mono text-[10px] font-bold leading-5 text-white',
                  unread.some((a) => a.severity === 'CRITICAL') ? 'bg-red-600' : 'bg-amber-500')}>{unread.length}</span>
              )}
            </button>
            <button onClick={() => setDark((d) => !d)} aria-label="Toggle dark mode" className="grid h-9 w-9 place-items-center border border-line font-mono text-xs hover:border-ink">
              {dark ? '☀' : '☾'}
            </button>
          </div>
        </div>
        <nav className="flex overflow-x-auto border-t border-line px-2">
          {nav.map((n) => (
            <button key={n.id} onClick={() => setView(n.id)}
              className={cx('whitespace-nowrap border-b-2 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.12em]',
                current === n.id ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink')}>
              {n.label}
            </button>
          ))}
          <div className="ml-auto hidden items-center px-3 text-[10px] uppercase tracking-[0.14em] text-muted md:flex">
            {user.name} · {ROLE_LABEL[user.role]}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-[1600px] p-4">
        {current === 'dashboard' && <Dashboard {...ctx} />}
        {current === 'scanner' && <Scanner {...ctx} />}
        {current === 'inventory' && <Inventory {...ctx} />}
        {current === 'audit' && <AuditLog {...ctx} />}
        {current === 'invoices' && <Invoices {...ctx} />}
        {current === 'purchasing' && <PurchaseOrders {...ctx} />}
        {current === 'forecast' && <Forecast {...ctx} />}
        {current === 'sql' && <SqlHub {...ctx} />}
      </main>

      {/* Notification drawer */}
      {drawer && (
        <aside className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-md flex-col border-l border-line bg-panel shadow-2xl">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.12em]">Stock Alerts <span className="text-muted">({unread.length} unread)</span></h2>
            <div className="flex gap-2">
              {can(user.role, 'pushConfig') && <Btn onClick={() => setModal('push')}>Settings</Btn>}
              <Btn onClick={() => ack(null)} disabled={!unread.length}>Mark all read</Btn>
              <button onClick={() => setDrawer(false)} aria-label="Close" className="h-9 w-9 border border-line text-lg hover:border-ink">×</button>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto">
            {state.alerts.length === 0 && <p className="p-6 text-center text-sm text-muted">No alerts. Stock levels are above every reorder point.</p>}
            {state.alerts.map((a) => (
              <div key={a.id} className={cx('border-b border-line px-4 py-3', a.ack && 'opacity-50')}>
                <div className="flex items-center justify-between gap-2">
                  <Tag v={a.severity} />
                  <span className="font-mono text-[10px] text-muted">{dateTime(a.ts)}</span>
                </div>
                <p className="mt-1.5 text-sm">{a.message}</p>
                <div className="mt-2 flex gap-2">
                  {can(user.role, 'poCreate') && <Btn kind="primary" onClick={() => { setView('purchasing'); setDrawer(false); }}>Create PO</Btn>}
                  {can(user.role, 'invoices') && <Btn onClick={() => { setView('invoices'); setDrawer(false); }}>Reorder via Invoice</Btn>}
                  {!a.ack && <Btn onClick={() => ack(a.id)}>Acknowledge</Btn>}
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      {modal === 'perms' && <PermsModal state={state} user={user} onClose={() => setModal(null)} refresh={refresh} toast={toast} />}
      {modal === 'push' && <PushModal push={push} setPush={(p) => { setPush(p); savePush(p); }} onClose={() => setModal(null)} />}

      {toastMsg && (
        <div role="status" className={cx('fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 border px-4 py-3 text-sm font-semibold shadow-xl',
          toastMsg.bad ? 'border-red-700 bg-red-700 text-white' : 'border-ink bg-ink text-canvas')}>{toastMsg.msg}</div>
      )}
    </div>
  );
}

function SqlBadge({ state, onClick }: { state: AppState; onClick?: () => void }) {
  const s = state.sql;
  const live = s.mode === 'MSSQL';
  return (
    <button onClick={onClick} disabled={!onClick} className="flex items-center gap-3 border border-line px-3 py-1.5 text-left enabled:hover:border-ink">
      <span className={cx('h-2.5 w-2.5', live ? 'bg-emerald-500' : s.connected ? 'bg-amber-500' : 'bg-red-600')} />
      <span>
        <span className="block font-mono text-[11px] font-semibold">
          {live ? `SQL SERVER ${/SQL Server (\d{4})/.exec(s.version ?? '')?.[1] ?? ''} · LIVE` : s.connected ? 'SQL SERVER · SCHEMA MISSING' : 'SQL SERVER · OFFLINE'}
        </span>
        <span className="block font-mono text-[10px] text-muted">
          {live || s.connected ? `${s.host.includes('\\') ? s.host : `${s.host}:${s.port}`} · ${s.database}${s.latencyMs !== null ? ` · ${s.latencyMs}ms` : ''}` : `:${s.port} · ${s.database} · in-memory fallback`}
        </span>
      </span>
    </button>
  );
}

function PermsModal({ state, user, onClose, refresh, toast }: { state: AppState; user: User; onClose: () => void; refresh: () => Promise<void>; toast: Ctx['toast'] }) {
  const admin = can(user.role, 'users');
  const roles: Role[] = ['ADMIN', 'CLERK', 'CASHIER'];
  const setRole = async (id: number, role: Role) => {
    try { await api(`/api/users/${id}`, { role }, 'PATCH'); await refresh(); toast('Role updated'); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Modal title="Role-Based Access Control" onClose={onClose} wide>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Permission</th>
              {roles.map((r) => <th key={r} className="px-3 py-2 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{ROLE_LABEL[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {(Object.keys(PERMISSIONS) as Perm[]).map((p) => (
              <tr key={p} className="border-b border-line/60">
                <td className="px-3 py-2">{PERMISSIONS[p].label}</td>
                {roles.map((r) => (
                  <td key={r} className="px-3 py-2 text-center font-mono">
                    {can(r, p) ? <span className="text-emerald-600 dark:text-emerald-400">■ GRANT</span> : <span className="text-muted">□ —</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="mb-2 mt-6 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Employee roles {admin ? '' : '(admin only)'}</h3>
      <div className="grid gap-2 md:grid-cols-3">
        {state.users.map((u) => (
          <div key={u.id} className="border border-line p-3">
            <div className="font-semibold">{u.name}</div>
            <div className="mb-2 text-xs text-muted">{u.title}</div>
            <select value={u.role} disabled={!admin} onChange={(e) => setRole(u.id, e.target.value as Role)}
              className="h-9 w-full border border-line bg-canvas px-2 text-sm">
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function PushModal({ push, setPush, onClose }: { push: PushSettings; setPush: (p: PushSettings) => void; onClose: () => void }) {
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  const enable = async () => {
    if (!('Notification' in window)) return;
    const p = await Notification.requestPermission();
    setPerm(p);
    setPush({ ...push, enabled: p === 'granted' });
  };
  const test = () => {
    if (push.sound) sound.lowStock();
    const sent = pushNotify('SM ASIA · Test Alert', `Test fired at ${time(new Date().toISOString())}. Store #104 alerts are reaching this device.`, 'test');
    if (!sent) alert('Browser notifications are not granted on this device. Enable them first.');
  };
  const row = (label: string, k: keyof PushSettings, disabled = false) => (
    <label className="flex items-center justify-between border-b border-line/60 py-3 text-sm">
      {label}
      <input type="checkbox" className="h-4 w-4 accent-[#c8102e]" checked={push[k]} disabled={disabled} onChange={(e) => setPush({ ...push, [k]: e.target.checked })} />
    </label>
  );
  return (
    <Modal title="Push Notification Settings" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between border border-line p-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Browser permission (this device)</div>
          <div className="font-mono text-sm">{perm.toUpperCase()}</div>
        </div>
        {perm !== 'granted' && perm !== 'unsupported' && <Btn kind="primary" onClick={enable}>Enable Web Push</Btn>}
      </div>
      {row('Show native device notifications', 'enabled', perm !== 'granted')}
      {row('Only CRITICAL (out-of-stock) alerts', 'criticalOnly')}
      {row('Audible chime on new alerts', 'sound')}
      <div className="mt-4 flex justify-end gap-2">
        <Btn kind="primary" onClick={test}>Fire Test Alert</Btn>
      </div>
      <p className="mt-3 text-xs text-muted">Settings are stored per device. Alerts fire while this app is open in a tab; background delivery with the tab closed would need a service worker plus a push server.</p>
    </Modal>
  );
}
