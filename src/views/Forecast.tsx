import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Ctx } from '../App';
import { can, forecast, HISTORY_DAYS, type Forecast as Fc, type SalesHistory } from '../shared';
import { api, dateTime, money, money0, sound } from '../lib';
import { Btn, cx, Panel, Stat, Table, Tag } from '../ui';
import SalesImportModal from './SalesImport';

const HORIZONS = [7, 14, 30, 60];

export default function Forecast({ state, user, refresh, toast, go }: Ctx) {
  const [hist, setHist] = useState<SalesHistory | null>(null);
  const [horizon, setHorizon] = useState(14);
  const [onlyNeed, setOnlyNeed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const canDelete = can(user.role, 'salesImport');
  // Delete one import (or all): stock it deducted is added back, then its sales lines are removed so the day(s) can be re-imported.
  const removeImport = async (i: SalesHistory['imports'][number] | null) => {
    const what = i ? `the import of ${i.fileName} (${i.periodFrom}${i.periodTo !== i.periodFrom ? ` → ${i.periodTo}` : ''})` : 'ALL imported Epos Now sales';
    if (!confirm(`Delete ${what}?

Any stock these sales deducted is added back (recorded on the stock cards), and the sales are removed from the forecast. You can import the file(s) again afterwards.`)) return;
    setBusy('delete');
    try {
      const r = await api<{ linesDeleted: number; unitsRestored: number; history: SalesHistory }>(i ? `/api/sales-imports/${i.id}` : '/api/sales-imports', undefined, 'DELETE');
      setHist(r.history);
      toast(`Deleted ${r.linesDeleted} sales lines; ${r.unitsRestored} units added back to stock`);
      await refresh();
    } catch (e) { toast((e as Error).message, true); }
    finally { setBusy(null); }
  };
  const num = (n: number) => (Number.isInteger(n) ? n : n.toFixed(1));

  const load = useCallback(() => api<SalesHistory>('/api/forecast').then(setHist).catch((e) => toast(e.message, true)), [toast]);
  // Refetch when stock moves (new sales arrive via the 3s state poll).
  useEffect(() => { load(); }, [load, state.movements[0]?.id]);

  const rows = useMemo(() => {
    if (!hist) return [];
    const empty = Array(HISTORY_DAYS).fill(0);
    return state.products
      .map((p) => forecast(p, hist.series[p.id] ?? empty, hist.spanDays, horizon, state.purchaseOrders))
      .sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) || b.needCases - a.needCases || a.product.name.localeCompare(b.product.name));
  }, [hist, horizon, state.products, state.purchaseOrders]);

  if (!hist) return <Panel title="Demand Forecast"><p className="py-10 text-center text-sm text-muted">Loading sales history…</p></Panel>;

  const shown = rows.filter((r) => !onlyNeed || r.needCases > 0);
  const withSales = rows.filter((r) => r.sold28 > 0);
  const atRisk = rows.filter((r) => r.daysOfCover !== null && r.daysOfCover <= horizon);
  const needs = rows.filter((r) => r.needCases > 0);
  const byVendor = Object.entries(needs.reduce<Record<string, Fc[]>>((g, r) => ((g[r.product.vendor] ??= []).push(r), g), {}));
  const maxDaily = Math.max(1, ...rows.flatMap((r) => r.daily));

  const createPo = async (vendor: string, items: Fc[]) => {
    setBusy(vendor);
    try {
      const r = await api<{ poNo: string }>('/api/purchase-orders', {
        vendor, notes: `Forecast re-order: ${horizon}-day demand + safety stock`,
        lines: items.map((f) => ({ productId: f.product.id, qty: f.needCases })),
      });
      sound.success();
      toast(`${r.poNo} created for ${vendor}`);
      await refresh();
      go('purchasing');
    } catch (e) { sound.error(); toast((e as Error).message, true); }
    finally { setBusy(null); }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Forecast horizon</span>
        <div className="flex border border-line">
          {HORIZONS.map((h) => (
            <button key={h} onClick={() => setHorizon(h)} className={cx('px-4 py-2 font-mono text-xs font-bold', h === horizon ? 'bg-ink text-canvas' : 'hover:bg-canvas')}>{h} days</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
          <input type="checkbox" checked={onlyNeed} onChange={(e) => setOnlyNeed(e.target.checked)} className="accent-[#c8102e]" /> Needs re-order only
        </label>
        {can(user.role, 'salesImport') && <Btn kind="primary" onClick={() => setImporting(true)}>Import EPOS sales report</Btn>}
        <span className="ml-auto font-mono text-xs text-muted">Based on {hist.spanDays} day{hist.spanDays === 1 ? '' : 's'} of POS history (window {HISTORY_DAYS} days)</span>
      </div>

      {hist.spanDays < 7 && (
        <div className="border border-amber-500 bg-amber-500/10 p-3 text-sm">
          <b>Limited history.</b> The store has only {hist.spanDays} day{hist.spanDays === 1 ? '' : 's'} of recorded movements, so forecasts are rough and marked <Tag v="LOW" label="Low data" />.
          Import Epos Now sales reports for the last few weeks to give it real history; the 7-day trend weighting starts after a week of data.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="SKUs with sales" value={`${withSales.length} / ${rows.length}`} sub={`in the last ${Math.min(hist.spanDays, HISTORY_DAYS)} days`} />
        <Stat label={`Stockouts within ${horizon} days`} value={atRisk.length} sub="at the current sales rate" tone={atRisk.length ? 'bad' : undefined} />
        <Stat label={`Forecast demand · ${horizon}d`} value={`${Math.round(rows.reduce((s, r) => s + r.demand, 0))} EA`}
          sub={`${money0(rows.reduce((s, r) => s + r.demand * r.product.unitPrice, 0))} at retail`} />
        <Stat label="Suggested re-order" value={`${needs.reduce((s, r) => s + r.needCases, 0)} CS`}
          sub={`${money0(needs.reduce((s, r) => s + r.needCases * r.product.caseCost, 0))} at case cost · ${needs.length} SKUs`} tone={needs.length ? 'warn' : undefined} />
      </div>

      {byVendor.length > 0 && can(user.role, 'poCreate') && (
        <Panel title="Turn Forecast into Purchase Orders">
          <div className="grid gap-2 md:grid-cols-3">
            {byVendor.map(([vendor, items]) => (
              <div key={vendor} className="flex items-center justify-between gap-3 border border-line p-3">
                <div>
                  <div className="text-sm font-bold">{vendor}</div>
                  <div className="font-mono text-xs text-muted">{items.length} SKUs · {items.reduce((s, f) => s + f.needCases, 0)} CS · {money(items.reduce((s, f) => s + f.needCases * f.product.caseCost, 0))}</div>
                </div>
                <Btn kind="primary" disabled={!!busy} onClick={() => createPo(vendor, items)}>{busy === vendor ? 'Creating…' : 'Create PO'}</Btn>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title={`Product Forecast · ${shown.length} SKUs`} pad={false}>
        <Table head={[`Daily sales · ${HISTORY_DAYS}d`, 'Product', '7d', '28d', 'Avg / day', 'On hand', 'Days of cover', 'Stockout', `Demand ${horizon}d`, 'On order', 'Suggest', '']} empty="No products need re-ordering for this horizon.">
          {shown.map((f) => {
            const p = f.product;
            const cover = f.daysOfCover;
            return (
              <tr key={p.id}>
                <td><Sparkline daily={f.daily} max={maxDaily} name={p.name} /></td>
                <td className="font-medium">{p.name}<div className="font-mono text-[10px] text-muted">{p.vendor} · {p.packSize}</div></td>
                <td className="font-mono tabular-nums">{num(f.sold7)}</td>
                <td className="font-mono tabular-nums">{num(f.sold28)}</td>
                <td className="font-mono tabular-nums">{f.perDay ? f.perDay.toFixed(1) : '—'}</td>
                <td className="font-mono tabular-nums">{p.onHand} EA</td>
                <td className={cx('font-mono tabular-nums', cover !== null && cover <= horizon && 'font-bold text-red-600 dark:text-red-400')}>
                  {cover === null ? (p.targetLevel === 0 ? '—' : p.onHand === 0 ? '0' : '∞') : cover >= 999 ? '999+' : cover.toFixed(1)}
                </td>
                <td className="whitespace-nowrap font-mono text-xs">{p.targetLevel === 0 ? '—' : p.onHand === 0 ? 'OUT NOW' : f.stockoutDate && cover! <= 365 ? f.stockoutDate : '—'}</td>
                <td className="font-mono tabular-nums">{Math.round(f.demand)} EA</td>
                <td className="font-mono tabular-nums">{f.onOrder ? `${f.onOrder} CS` : '—'}</td>
                <td className="font-mono tabular-nums">{f.needCases ? <b>{f.needCases} CS</b> : '—'}</td>
                <td className="whitespace-nowrap">
                  {f.product.targetLevel === 0 && <Tag v="UNSET" label="Not tracked" />} {f.lowData && <Tag v="LOW" label="Low data" />} {f.sold28 === 0 && <Tag v="NO_SALES" label="No sales" />}
                </td>
              </tr>
            );
          })}
        </Table>
      </Panel>

      <p className="text-xs text-muted">
        Method: forecast rate = 60% of the last-7-day sales rate + 40% of the {HISTORY_DAYS}-day rate (only days the store has been recording count).
        Suggested cases = {horizon}-day demand + reorder point (safety stock) − on hand − on order, rounded up to whole cases.
        Demand = imported Epos Now sales + checkout scans in this app (don't use both for the same sales); intake, counts and adjustments don't count.
      </p>

      <Panel title={`EPOS Sales Imports · ${hist.imports.length}`} pad={false}
        actions={canDelete && hist.imports.length > 0 && <Btn kind="danger" disabled={!!busy} onClick={() => removeImport(null)}>Delete all imported sales</Btn>}>
        <Table head={['Imported', 'File', 'Period', 'Product-days', 'Units', 'By', ...(canDelete ? [''] : [])]} empty="No sales reports imported yet.">
          {hist.imports.map((i) => (
            <tr key={i.id}>
              <td className="whitespace-nowrap font-mono text-xs">{dateTime(i.importedAt)}</td>
              <td className="font-mono text-xs">{i.fileName}</td>
              <td className="whitespace-nowrap font-mono text-xs">{i.periodFrom} → {i.periodTo}</td>
              <td className="font-mono tabular-nums">{i.rows}</td>
              <td className="font-mono tabular-nums">{Math.round(i.units).toLocaleString('en-CA')}</td>
              <td>{i.importedBy}</td>
              {canDelete && <td><Btn kind="danger" disabled={!!busy} onClick={() => removeImport(i)}>Delete</Btn></td>}
            </tr>
          ))}
        </Table>
      </Panel>

      {importing && <SalesImportModal products={state.products} role={user.role} toast={toast} onClose={() => setImporting(false)} onDone={(h) => { setHist(h); setImporting(false); refresh(); }} />}
    </div>
  );
}

/** 28 daily bars, single series; native tooltip per day. Bars grow from the baseline. */
function Sparkline({ daily, max, name }: { daily: number[]; max: number; name: string }) {
  const w = 4, gap = 1, h = 28;
  const today = new Date();
  return (
    <svg width={daily.length * (w + gap)} height={h} role="img" aria-label={`${name}: ${daily.reduce((s, n) => s + n, 0)} sold in ${daily.length} days`} className="block text-brand">
      <line x1={0} x2={daily.length * (w + gap)} y1={h - 0.5} y2={h - 0.5} stroke="var(--line)" />
      {daily.map((n, i) => {
        const bh = n ? Math.max(2, (n / max) * (h - 2)) : 0;
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (daily.length - 1 - i));
        return (
          <g key={i}>
            <rect x={i * (w + gap)} y={0} width={w + gap} height={h} fill="transparent">
              <title>{`${d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}: ${n} sold`}</title>
            </rect>
            {bh > 0 && <rect x={i * (w + gap)} y={h - 1 - bh} width={w} height={bh} fill="currentColor" pointerEvents="none" />}
          </g>
        );
      })}
    </svg>
  );
}
