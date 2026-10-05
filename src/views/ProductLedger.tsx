import { useEffect, useState } from 'react';
import { MOVEMENT_LABEL, POST_LABEL, marginPct, stockStatus, summarizeLedger, unitCost, type MovementType, type Product, type ProductLedger } from '../shared';
import { api, cases, dateTime, money } from '../lib';
import { download, toCsv } from '../catalogIO';
import { Btn, cx, Modal, Table, Tag } from '../ui';

const PERIODS = [{ d: 7, l: '7 days' }, { d: 30, l: '30 days' }, { d: 90, l: '90 days' }, { d: 0, l: 'All time' }];
const TYPES = Object.keys(MOVEMENT_LABEL) as MovementType[];

/** Stock card: every IN and OUT for one product with running balance, plus Epos Now till sales. */
export default function ProductLedgerModal({ p, onClose, toast }: { p: Product; onClose: () => void; toast: (m: string, bad?: boolean) => void }) {
  const [ledger, setLedger] = useState<ProductLedger | null>(null);
  const [days, setDays] = useState(30);
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all');

  // Refetch when the product's stock changes (state poll passes a fresh product object).
  useEffect(() => {
    api<ProductLedger>(`/api/products/${p.id}/ledger`).then(setLedger).catch((e) => toast(e.message, true));
  }, [p.id, p.onHand, toast]);

  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const sinceDate = since?.slice(0, 10) ?? '';
  const sum = ledger ? summarizeLedger(ledger.movements, p.onHand, since) : null;
  const sales = ledger?.sales.filter((s) => !sinceDate || s.date >= sinceDate) ?? [];
  // Till sales (or the part of them) that did not change stock: shown in the list as greyed OUT lines, balance unchanged.
  const notDeducted = sales.filter((x) => x.qty - x.posted > 0).map((x) => ({
    date: x.date, qty: +(x.qty - x.posted).toFixed(3), file: x.fileName,
    reason: x.status ? POST_LABEL[x.status] : 'Imported without "deduct from stock"',
    ts: new Date(+x.date.slice(0, 4), +x.date.slice(5, 7) - 1, +x.date.slice(8, 10), 23, 59).toISOString(),
  }));
  const notDeductedUnits = notDeducted.reduce((t, x) => t + x.qty, 0);
  type Line = { kind: 'move'; ts: string; m: NonNullable<typeof sum>['movements'][number] } | { kind: 'sale'; ts: string; x: (typeof notDeducted)[number] };
  const lines: Line[] = [
    ...(sum?.movements.filter((m) => dir === 'all' || (dir === 'in' ? m.qty > 0 : m.qty < 0)).map((m) => ({ kind: 'move' as const, ts: m.ts, m })) ?? []),
    ...(dir === 'in' ? [] : notDeducted.map((x) => ({ kind: 'sale' as const, ts: x.ts, x }))),
  ].sort((a, b) => b.ts.localeCompare(a.ts));
  const rows = lines.flatMap((l) => (l.kind === 'move' ? [l.m] : []));
  const eposUnits = sales.reduce((s, x) => s + x.qty, 0);
  const per = p.unitsPerCase;
  const before = sales.find((x) => x.status === 'BEFORE_COUNT');
  const fmt = (n: number) => `${+n.toFixed(3)} EA${per > 1 ? ` (${cases(n, per)})` : ''}`;

  const exportCsv = () => download(`StockCard-${p.upc}-${new Date().toLocaleDateString('en-CA')}.csv`, toCsv([
    ['Date', 'Type', 'Direction', 'Qty', 'Before', 'After', 'Employee', 'Reference'],
    ...lines.map((l) => l.kind === 'move'
      ? [new Date(l.m.ts).toLocaleString('en-CA'), MOVEMENT_LABEL[l.m.type], l.m.qty > 0 ? 'IN' : 'OUT', l.m.qty, l.m.before, l.m.after, l.m.user, l.m.ref ?? '']
      : [l.x.date, 'Epos Now till sale (not deducted)', 'OUT', -l.x.qty, '', '', 'Epos Now', `${l.x.reason} · ${l.x.file}`]),
  ]));

  return (
    <Modal title="Stock Card · Ins & Outs" onClose={onClose} wide>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-lg font-bold leading-tight">{p.name}</div>
          <div className="font-mono text-xs text-muted">{p.upc} · {p.sku} · {p.category} · Aisle {p.aisle || '—'} · {p.packSize} · {p.vendor}</div>
          <div className="mt-1 font-mono text-xs">Price {money(p.unitPrice)} · cost {money(unitCost(p))} · margin {marginPct(p).toFixed(1)}% · reorder {p.reorderPoint} / target {p.targetLevel}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">On hand now</div>
          <div className="font-mono text-2xl font-semibold">{p.onHand} EA</div>
          <Tag v={stockStatus(p)} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex border border-line">
          {PERIODS.map((x) => (
            <button key={x.d} onClick={() => setDays(x.d)} className={cx('px-3 py-1.5 text-xs font-bold', days === x.d ? 'bg-ink text-canvas' : 'hover:bg-canvas')}>{x.l}</button>
          ))}
        </div>
        <div className="flex border border-line">
          {(['all', 'in', 'out'] as const).map((x) => (
            <button key={x} onClick={() => setDir(x)} className={cx('px-3 py-1.5 text-xs font-bold uppercase', dir === x ? 'bg-ink text-canvas' : 'hover:bg-canvas')}>{x === 'all' ? 'All' : x === 'in' ? 'Ins' : 'Outs'}</button>
          ))}
        </div>
        <Btn className="ml-auto" disabled={!lines.length} onClick={exportCsv}>Export CSV</Btn>
      </div>

      {!sum ? <p className="py-10 text-center text-sm text-muted">Loading…</p> : (
        <>
          <div className="mt-4 grid gap-px bg-line sm:grid-cols-4">
            <div className="bg-panel p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Opening</div>
              <div className="font-mono text-lg font-semibold">{fmt(sum.opening)}</div>
            </div>
            <div className="bg-panel p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">Stock in</div>
              <div className="font-mono text-lg font-semibold text-emerald-700 dark:text-emerald-400">+{fmt(sum.totalIn)}</div>
              {TYPES.filter((t) => sum.inByType[t]).map((t) => <div key={t} className="font-mono text-[11px] text-muted">{MOVEMENT_LABEL[t]}: +{sum.inByType[t]}</div>)}
            </div>
            <div className="bg-panel p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-red-700 dark:text-red-400">Stock out</div>
              <div className="font-mono text-lg font-semibold text-red-700 dark:text-red-400">−{fmt(sum.totalOut)}</div>
              {TYPES.filter((t) => sum.outByType[t]).map((t) => <div key={t} className="font-mono text-[11px] text-muted">{MOVEMENT_LABEL[t]}: −{sum.outByType[t]}</div>)}
              {notDeductedUnits > 0 && <div className="mt-1 font-mono text-[11px] text-muted">+ till sales not deducted: {+notDeductedUnits.toFixed(3)} (see greyed lines)</div>}
            </div>
            <div className="bg-panel p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Closing</div>
              <div className="font-mono text-lg font-semibold">{fmt(sum.closing)}</div>
              <div className="font-mono text-[11px] text-muted">net {sum.totalIn - sum.totalOut >= 0 ? '+' : ''}{sum.totalIn - sum.totalOut} EA</div>
            </div>
          </div>

          <h3 className="mb-1 mt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Movements ({rows.length}){notDeducted.length > 0 && dir !== 'in' ? ` + ${notDeducted.length} till-sales day(s) not deducted` : ''}</h3>
          <div className="max-h-[360px] overflow-y-auto border border-line">
            <Table head={['Date', 'Type', 'In', 'Out', 'Balance', 'Employee', 'Reference']} empty="No stock movements or till sales in this period.">
              {lines.map((l) => {
                if (l.kind === 'sale') return (
                  <tr key={`sale-${l.x.date}`} className="text-muted">
                    <td className="whitespace-nowrap font-mono text-xs">{l.x.date}</td>
                    <td className="whitespace-nowrap"><Tag v="UNSET" label="EPOS SALE" /> <span className="text-xs">Till sale · not deducted</span></td>
                    <td />
                    <td className="font-mono tabular-nums line-through decoration-1" title="Not deducted from stock">−{l.x.qty}</td>
                    <td className="whitespace-nowrap font-mono text-xs">unchanged</td>
                    <td>Epos Now</td>
                    <td className="text-xs">{l.x.reason} · <span className="font-mono">{l.x.file}</span></td>
                  </tr>
                );
                const m = l.m;
                return (
                <tr key={m.id}>
                  <td className="whitespace-nowrap font-mono text-xs">{dateTime(m.ts)}</td>
                  <td className="whitespace-nowrap"><Tag v={m.type} /> <span className="text-xs text-muted">{MOVEMENT_LABEL[m.type]}</span></td>
                  <td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">{m.qty > 0 ? `+${m.qty}` : ''}</td>
                  <td className="font-mono tabular-nums text-red-700 dark:text-red-400">{m.qty < 0 ? `−${-m.qty}` : ''}</td>
                  <td className="whitespace-nowrap font-mono tabular-nums">{m.before} → <b>{m.after}</b></td>
                  <td>{m.user}</td>
                  <td className="font-mono text-xs text-muted">{m.ref ?? ''}</td>
                </tr>
                );
              })}
            </Table>
          </div>
          {ledger?.truncated && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Showing the most recent 5,000 movements.</p>}
          {before && dir !== 'in' && (
            <p className="mt-1 text-xs text-muted">
              "Before last count": these till sales happened before the latest shelf count, so the counted quantity already reflects them;
              deducting them again would double count. Sales imported for days after the count are deducted and appear as real EPOS SALE outs.
            </p>
          )}

          <h3 className="mb-1 mt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
            Epos Now till sales · {+eposUnits.toFixed(3)} sold in {sales.length} day(s) · {sales.reduce((t, x) => t + x.posted, 0)} deducted from stock (see EPOS SALE outs above)
          </h3>
          {sales.length ? (
            <div className="max-h-[200px] overflow-y-auto border border-line">
              <Table head={['Sales date', 'Units sold', 'Stock', 'Report file']}>
                {sales.map((s) => (
                  <tr key={s.date}>
                    <td className="font-mono text-xs">{s.date}</td><td className="font-mono tabular-nums">{+s.qty.toFixed(3)}</td>
                    <td className="whitespace-nowrap text-xs">
                      {!s.status ? <span className="text-muted">Not posted (imported without "deduct from stock")</span>
                        : s.status === 'POSTED' ? <span className="text-red-700 dark:text-red-400">−{s.posted} deducted</span>
                        : <><Tag v={s.status === 'SHORT' ? 'LOW' : 'UNSET'} label={POST_LABEL[s.status]} />{s.posted ? <span className="ml-1 text-red-700 dark:text-red-400">−{s.posted}</span> : null}</>}
                    </td>
                    <td className="font-mono text-xs text-muted">{s.fileName}</td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : <p className="border border-line p-3 text-xs text-muted">No Epos Now sales imported for this product in this period.</p>}
        </>
      )}
    </Modal>
  );
}
