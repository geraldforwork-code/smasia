import { useEffect, useState, type ChangeEvent } from 'react';
import type { Ctx } from '../App';
import { QUERY_PRESETS, type QueryResult, type SqlStatus } from '../shared';
import { api, dateTime } from '../lib';
import { Btn, cx, Field, inputCls, Panel, Tag } from '../ui';

type Tab = 'query' | 'script' | 'connection';

export default function SqlHub(ctx: Ctx) {
  const [tab, setTab] = useState<Tab>('query');
  return (
    <div className="grid gap-4">
      <div className="flex border-b border-line">
        {([['query', 'Query Runner'], ['script', 'Schema Script (.sql)'], ['connection', 'Connection']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={cx('-mb-px border-b-2 px-4 py-2 text-xs font-bold uppercase tracking-wider', tab === id ? 'border-brand' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
        <div className="ml-auto flex items-center gap-2 px-2"><Tag v={ctx.state.sql.mode} label={ctx.state.sql.mode === 'MSSQL' ? 'Live SQL Server' : 'In-memory store'} /></div>
      </div>
      {tab === 'query' && <QueryRunner {...ctx} />}
      {tab === 'script' && <Script {...ctx} />}
      {tab === 'connection' && <Connection {...ctx} />}
    </div>
  );
}

function QueryRunner({ toast }: Ctx) {
  const [text, setText] = useState<string>(QUERY_PRESETS[0].sql);
  const [preset, setPreset] = useState<string>(QUERY_PRESETS[0].key);
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (sql = text, key = preset) => {
    setBusy(true); setErr(null);
    // Only send the preset key while the text is untouched, so in-memory mode never answers an edited query with the preset's rows.
    const unchanged = QUERY_PRESETS.find((p) => p.key === key)?.sql === sql;
    try { setRes(await api<QueryResult>('/api/sql-query', { sql, preset: unchanged ? key : undefined })); }
    catch (e) { setRes(null); setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4">
      <Panel title="Interactive T-SQL Query Runner"
        actions={QUERY_PRESETS.map((p) => (
          <Btn key={p.key} className={cx(preset === p.key && text === p.sql && 'border-brand')} onClick={() => { setText(p.sql); setPreset(p.key); run(p.sql, p.key); }}>{p.label}</Btn>
        ))}>
        <textarea value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); }}
          className="h-56 w-full resize-y border border-line bg-zinc-950 p-3 font-mono text-[13px] leading-5 text-emerald-300 outline-none focus:border-brand" />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Btn kind="primary" onClick={() => run()} disabled={busy}>{busy ? 'Executing…' : '▶ Execute (Ctrl+Enter)'}</Btn>
          <Btn onClick={() => navigator.clipboard.writeText(text).then(() => toast('Query copied'))}>Copy</Btn>
          <span className="text-xs text-muted">Ad-hoc statements run in a transaction that is always rolled back: read-only by design.</span>
        </div>
      </Panel>
      {err && <div className="border border-red-600 bg-red-600/10 p-3 font-mono text-sm text-red-700 dark:text-red-400">Msg: {err}</div>}
      {res && (
        <Panel pad={false} title="Results" actions={<span className="font-mono text-xs text-muted">({res.rows.length} rows affected) · {res.ms} ms · <Tag v={res.mode} /></span>}>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 bg-panel">
                <tr>{res.columns.map((c) => <th key={c} className="border-b border-line px-3 py-2 text-left font-bold">{c}</th>)}</tr>
              </thead>
              <tbody>
                {res.rows.map((r, i) => (
                  <tr key={i} className="border-b border-line/60 hover:bg-canvas">
                    {res.columns.map((c) => <td key={c} className="whitespace-nowrap px-3 py-1.5">{fmt(r[c])}</td>)}
                  </tr>
                ))}
                {!res.rows.length && <tr><td className="p-4 text-muted" colSpan={res.columns.length || 1}>(0 rows)</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

const fmt = (v: unknown) => (v === null || v === undefined ? 'NULL' : v instanceof Object ? JSON.stringify(v) : String(v));

function Script({ state, toast, refresh }: Ctx) {
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<string>('/api/sql-script').then(setSql).catch((e) => toast(e.message, true)); }, [toast]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([sql], { type: 'application/sql' }));
    Object.assign(document.createElement('a'), { href: url, download: 'StoreInventoryDB.sql' }).click();
    URL.revokeObjectURL(url);
  };
  const deploy = async () => {
    if (!confirm(`Deploy tables, procedures, trigger and seed data to ${state.sql.database} on ${state.sql.host}? Existing objects are kept; procedures and the trigger are replaced.`)) return;
    setBusy(true);
    try { const s = await api<SqlStatus>('/api/sql-deploy', {}); toast(s.schemaReady ? 'Schema deployed. App now runs on SQL Server.' : 'Deployed, but schema check failed', !s.schemaReady); await refresh(); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <Panel title="StoreInventoryDB · DDL, Stored Procedures, Trigger & Seed"
      actions={<>
        <Btn onClick={() => navigator.clipboard.writeText(sql).then(() => toast('Script copied to clipboard'))}>Copy</Btn>
        <Btn onClick={download}>Download .sql</Btn>
        <Btn kind="primary" disabled={!state.sql.connected || busy} onClick={deploy} title={state.sql.connected ? '' : 'Connect to SQL Server first'}>{busy ? 'Deploying…' : 'Deploy to server'}</Btn>
      </>}>
      <p className="mb-3 text-xs text-muted">Run in SSMS, Azure Data Studio or Azure SQL. Idempotent. Contains dbo.Products, dbo.Inventory, dbo.StockMovements, dbo.Invoices, dbo.InvoiceItems, dbo.AppUsers, dbo.AlertNotifications, dbo.sp_ProcessBarcodeScan, dbo.sp_IngestInvoiceBatch, dbo.sp_AdjustStock and dbo.trg_CheckLowStock.</p>
      <pre className="max-h-[640px] overflow-auto border border-line bg-zinc-950 p-3 font-mono text-[12px] leading-5 text-zinc-200">{sql || 'Loading…'}</pre>
    </Panel>
  );
}

function Connection({ state, toast, refresh }: Ctx) {
  const s = state.sql;
  const [f, setF] = useState({ host: s.host === 'localhost' && !s.connected ? 'localhost' : s.host, port: s.port, database: s.database, user: s.user === 'Windows authentication' ? '' : s.user, password: '', encrypt: true, trustServerCertificate: true, trusted: s.user === 'Windows authentication' || s.host.includes('\\') });
  const [connStr, setConnStr] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const server = f.host.includes('\\') ? f.host : `${f.host},${f.port}`;
  const preview = f.trusted
    ? `Driver={ODBC Driver 18 for SQL Server};Server=${server};Database=${f.database};Trusted_Connection=yes;Encrypt=${f.encrypt ? 'yes' : 'no'};TrustServerCertificate=${f.trustServerCertificate ? 'yes' : 'no'};`
    : `Server=${server};Database=${f.database};User Id=${f.user};Password=********;Encrypt=${f.encrypt};TrustServerCertificate=${f.trustServerCertificate}`;
  const body = { ...f, connectionString: connStr.trim() || undefined };
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : k === 'port' ? Number(e.target.value) : e.target.value });

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { setResult(await fn()); } catch (e) { setResult(`ERROR: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const ping = () => act(async () => {
    const r = await api<{ ok: boolean; latencyMs?: number; version?: string; db?: string; ready?: boolean; error?: string }>('/api/sql-health', body);
    return r.ok ? `PING OK · ${r.latencyMs} ms · ${r.db} · schema ${r.ready ? 'deployed' : 'NOT deployed'}\n${r.version}` : `PING FAILED · ${r.error}`;
  });
  const connect = () => act(async () => {
    const st = await api<SqlStatus>('/api/sql-config', body);
    await refresh();
    toast(st.connected ? 'Connected to SQL Server' : 'Connection failed', !st.connected);
    return JSON.stringify(st, null, 2);
  });
  const disconnect = () => act(async () => { await api('/api/sql-config', { disconnect: true }); await refresh(); return 'Disconnected. Using the in-memory store.'; });
  const health = () => act(async () => JSON.stringify(await api<SqlStatus>('/api/sql-health'), null, 2));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Connection Configurator">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Host or HOST\INSTANCE"><input value={f.host} onChange={set('host')} className={cx(inputCls, 'font-mono')} /></Field>
          <Field label="Port"><input type="number" value={f.port} onChange={set('port')} className={cx(inputCls, 'font-mono')} /></Field>
          <Field label="Database"><input value={f.database} onChange={set('database')} className={cx(inputCls, 'font-mono')} /></Field>
          <Field label="Username"><input value={f.user} disabled={f.trusted} onChange={set('user')} autoComplete="off" className={cx(inputCls, 'font-mono')} /></Field>
          <Field label="Password"><input type="password" value={f.password} disabled={f.trusted} onChange={set('password')} autoComplete="new-password" className={cx(inputCls, 'font-mono')} /></Field>
          <div className="flex flex-col justify-end gap-1 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.trusted} onChange={set('trusted')} className="accent-[#c8102e]" /> Windows authentication</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.encrypt} onChange={set('encrypt')} className="accent-[#c8102e]" /> Encrypt</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.trustServerCertificate} onChange={set('trustServerCertificate')} className="accent-[#c8102e]" /> Trust server certificate</label>
          </div>
        </div>
        <div className="mt-3">
          <Field label="Connection string (overrides fields when set)">
            <textarea value={connStr} onChange={(e) => setConnStr(e.target.value)} placeholder={preview} spellCheck={false}
              className="h-20 w-full border border-line bg-canvas p-2 font-mono text-xs outline-none focus:border-brand" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn onClick={ping} disabled={busy}>Ping test</Btn>
          <Btn kind="primary" onClick={connect} disabled={busy}>Connect & use</Btn>
          <Btn onClick={health} disabled={busy}>GET /api/sql-health</Btn>
          {s.connected && <Btn kind="danger" onClick={disconnect} disabled={busy}>Disconnect</Btn>}
        </div>
        <p className="mt-3 text-xs text-muted">Credentials go only to this store's Express server and are held in memory for the session. For a permanent setup put them in <code className="font-mono">.env</code> (see .env.example).</p>
      </Panel>

      <Panel title="Live Status">
        <dl className="grid grid-cols-2 gap-px bg-line text-sm">
          {[
            ['Mode', s.mode], ['Connected', s.connected ? 'YES' : 'NO'], ['Server', `${s.host}:${s.port}`], ['Database', s.database],
            ['Schema', s.schemaReady ? 'Deployed' : 'Not deployed'], ['Latency', s.latencyMs !== null ? `${s.latencyMs} ms` : '—'],
            ['Checked', dateTime(s.checkedAt)], ['Version', s.version ?? '—'],
          ].map(([k, v]) => (
            <div key={k} className="bg-panel p-2">
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{k}</dt>
              <dd className="truncate font-mono font-semibold" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
        {s.error && <div className="mt-3 border border-amber-500 p-2 font-mono text-xs text-amber-700 dark:text-amber-400">{s.error}</div>}
        {result && <pre className="mt-3 max-h-72 overflow-auto border border-line bg-zinc-950 p-3 font-mono text-xs text-zinc-200">{result}</pre>}
      </Panel>
    </div>
  );
}
