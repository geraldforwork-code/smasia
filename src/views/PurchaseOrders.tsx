import { useMemo, useState } from 'react';
import type { Ctx } from '../App';
import { can, onOrderCases, poTotal, reorderCases, type PoStatus, type Product, type PurchaseOrder } from '../shared';
import { api, cases, dateTime, money, sound } from '../lib';
import { Btn, cx, inputCls, Modal, Panel, Table, Tag } from '../ui';

const STATUS_TAG: Record<PoStatus, string> = { OPEN: 'LOW', RECEIVED: 'OK', CANCELLED: 'CANCELLED' };

export default function PurchaseOrders({ state, user, refresh, toast, go }: Ctx) {
  const canCreate = can(user.role, 'poCreate');
  const [filter, setFilter] = useState<PoStatus | null>('OPEN');
  const [viewing, setViewing] = useState<PurchaseOrder | null>(null);
  const pos = state.purchaseOrders.filter((po) => !filter || po.status === filter);

  const cancel = async (po: PurchaseOrder) => {
    if (!confirm(`Cancel ${po.poNo} to ${po.vendor}?`)) return;
    try { await api(`/api/purchase-orders/${po.id}/cancel`, {}); toast(`${po.poNo} cancelled`); await refresh(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {canCreate ? <Builder {...{ state, user, refresh, toast, go }} onCreated={(po) => setViewing(po)} /> : (
        <Panel title="Re-order Suggestions">
          <p className="text-sm text-muted">Purchase orders are created by the General Manager. Open orders appear on the right; receive them at the dock from Invoice Intake.</p>
        </Panel>
      )}

      <Panel title={`Purchase Orders · ${pos.length}`} pad={false}
        actions={([null, 'OPEN', 'RECEIVED', 'CANCELLED'] as const).map((s) => (
          <button key={s ?? 'all'} onClick={() => setFilter(s)}
            className={cx('border px-2 py-1 text-[10px] font-bold uppercase tracking-wider', filter === s ? 'border-ink bg-ink text-canvas' : 'border-line hover:border-ink')}>
            {s ?? 'All'}
          </button>
        ))}>
        <Table head={['PO #', 'Vendor', 'Created', 'Expected', 'Lines', 'Total', 'Status', '']} empty="No purchase orders.">
          {pos.map((po) => (
            <tr key={po.id}>
              <td className="font-mono font-semibold">{po.poNo}</td>
              <td>{po.vendor}</td>
              <td className="whitespace-nowrap font-mono text-xs">{dateTime(po.createdAt)}<div className="text-muted">{po.createdBy}</div></td>
              <td className="font-mono text-xs">{po.expectedDate ?? '—'}</td>
              <td className="font-mono">{po.lines.length}</td>
              <td className="font-mono tabular-nums">{money(poTotal(po))}</td>
              <td>
                <Tag v={STATUS_TAG[po.status]} label={po.status} />
                {po.receivedInvoiceNo && <div className="mt-0.5 font-mono text-[10px] text-muted">INV {po.receivedInvoiceNo}</div>}
              </td>
              <td className="whitespace-nowrap">
                <div className="flex gap-1">
                  <Btn onClick={() => setViewing(po)}>View / Print</Btn>
                  {po.status === 'OPEN' && can(user.role, 'invoices') && <Btn kind="ok" onClick={() => go('invoices')}>Receive</Btn>}
                  {po.status === 'OPEN' && canCreate && <Btn kind="danger" onClick={() => cancel(po)}>Cancel</Btn>}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      {viewing && <PoDocument po={state.purchaseOrders.find((p) => p.id === viewing.id) ?? viewing} products={state.products} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Suggests below-reorder items per vendor (net of what's already on order); the GM edits quantities and creates the PO. */
function Builder({ state, refresh, toast, onCreated }: Pick<Ctx, 'state' | 'user' | 'refresh' | 'toast' | 'go'> & { onCreated: (po: PurchaseOrder) => void }) {
  const vendors = useMemo(() => [...new Set(state.products.map((p) => p.vendor))].sort(), [state.products]);
  const suggested = (v: string) => state.products.filter((p) => p.vendor === v && reorderCases(p, state.purchaseOrders) > 0);
  const firstWithNeeds = vendors.find((v) => suggested(v).length) ?? vendors[0];
  const [vendor, setVendor] = useState(firstWithNeeds);
  const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(suggested(firstWithNeeds).map((p) => [p.id, reorderCases(p, state.purchaseOrders)])));
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = (v: string) => {
    setVendor(v);
    setQty(Object.fromEntries(suggested(v).map((p) => [p.id, reorderCases(p, state.purchaseOrders)])));
  };
  const catalog = state.products.filter((p) => p.vendor === vendor);
  const lines = catalog.filter((p) => (qty[p.id] ?? 0) > 0);
  const total = lines.reduce((s, p) => s + qty[p.id] * p.caseCost, 0);
  const needCount = (v: string) => suggested(v).length;

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: number; poNo: string }>('/api/purchase-orders', {
        vendor, expectedDate: expected || null, notes, lines: lines.map((p) => ({ productId: p.id, qty: qty[p.id] })),
      });
      sound.success();
      toast(`${r.poNo} created for ${vendor}`);
      await refresh();
      setQty({}); setNotes(''); setExpected('');
      onCreated({ id: r.id } as PurchaseOrder);
    } catch (e) { sound.error(); toast((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <Panel title="Re-order · New Purchase Order" pad={false}
      actions={<Btn kind="primary" disabled={!lines.length || busy} onClick={create}>{busy ? 'Creating…' : `Create PO · ${money(total)}`}</Btn>}>
      <div className="flex flex-wrap gap-px border-b border-line bg-line">
        {vendors.map((v) => (
          <button key={v} onClick={() => pick(v)} className={cx('flex-1 px-3 py-2 text-left text-xs', v === vendor ? 'bg-ink text-canvas' : 'bg-panel hover:bg-canvas')}>
            <div className="font-bold">{v}</div>
            <div className="opacity-70">{needCount(v) ? `${needCount(v)} item(s) need re-order` : 'stock OK'}</div>
          </button>
        ))}
      </div>
      <div className="grid gap-3 border-b border-line p-3 sm:grid-cols-[180px_1fr]">
        <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Expected delivery
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={cx(inputCls, 'mt-1 font-mono')} />
        </label>
        <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Notes to vendor
          <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery window, dock instructions…" className={cx(inputCls, 'mt-1')} />
        </label>
      </div>
      <Table head={['Product', 'Aisle', 'On hand', 'Reorder pt', 'On order', 'Suggest', 'Order (CS)', 'Case cost', 'Line total']} empty="No products from this vendor.">
        {[...catalog].sort((a, b) => reorderCases(b, state.purchaseOrders) - reorderCases(a, state.purchaseOrders) || a.name.localeCompare(b.name)).map((p) => {
          const need = reorderCases(p, state.purchaseOrders);
          const onOrder = onOrderCases(state.purchaseOrders, p.id);
          const q = qty[p.id] ?? 0;
          return (
            <tr key={p.id} className={cx(!q && 'text-muted')}>
              <td className="font-medium">{p.name}<div className="font-mono text-[10px] text-muted">{p.upc} · {p.packSize}</div></td>
              <td className="font-mono">{p.aisle}</td>
              <td className={cx('whitespace-nowrap font-mono tabular-nums', p.onHand === 0 && 'text-red-600 dark:text-red-400')}>{p.onHand} EA · {cases(p.onHand, p.unitsPerCase)}</td>
              <td className="font-mono tabular-nums">{p.reorderPoint}</td>
              <td className="font-mono tabular-nums">{onOrder ? `${onOrder} CS` : '—'}</td>
              <td>{need ? <Tag v={p.onHand === 0 ? 'OUT' : 'LOW'} label={`${need} CS`} /> : <span className="text-xs">—</span>}</td>
              <td><input type="number" min={0} value={q || ''} placeholder="0" aria-label={`Cases of ${p.name}`}
                onChange={(e) => setQty({ ...qty, [p.id]: Math.max(0, Math.floor(+e.target.value) || 0) })} className={cx(inputCls, 'w-20 font-mono')} /></td>
              <td className="font-mono tabular-nums">{money(p.caseCost)}</td>
              <td className="font-mono tabular-nums">{q ? money(q * p.caseCost) : ''}</td>
            </tr>
          );
        })}
      </Table>
    </Panel>
  );
}

function PoDocument({ po, products, onClose }: { po: PurchaseOrder; products: Product[]; onClose: () => void }) {
  if (!po.poNo) return null; // just created; waits for the refreshed list
  return (
    <Modal title={`Purchase Order ${po.poNo}`} onClose={onClose} wide>
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Btn kind="primary" onClick={() => window.print()}>Print / Save as PDF</Btn>
      </div>
      <div className="print-area bg-white p-8 text-black">
        <div className="flex items-start justify-between border-b-4 border-black pb-4">
          <div>
            <div className="text-3xl font-black tracking-[0.2em] text-[#c8102e]">SM ASIA</div>
            <div className="text-sm">SM Asia Enterprises Inc. · Store #104<br />Lloydminster, SK</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-black tracking-widest">PURCHASE ORDER</div>
            <div className="font-mono text-lg">{po.poNo}</div>
            <div className="mt-1 inline-block border-2 border-black px-2 font-mono text-xs font-bold">{po.status}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 py-4 text-sm">
          <div><div className="text-[10px] font-bold tracking-widest text-zinc-500">VENDOR</div><div className="font-semibold">{po.vendor}</div></div>
          <div><div className="text-[10px] font-bold tracking-widest text-zinc-500">SHIP TO / BILL TO</div>SM Asia Enterprises Inc.<br />Store #104, Lloydminster, SK</div>
          <div className="font-mono text-xs">
            <div>Issued: {dateTime(po.createdAt)}</div>
            <div>Expected: {po.expectedDate ?? 'ASAP'}</div>
            <div>Buyer: {po.createdBy}</div>
            {po.receivedInvoiceNo && <div>Received on INV {po.receivedInvoiceNo}</div>}
          </div>
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y-2 border-black text-left text-[10px] tracking-widest">
              <th className="py-1.5">#</th><th>UPC</th><th>DESCRIPTION</th><th>PACK</th><th className="text-right">QTY (CS)</th><th className="text-right">CASE COST</th><th className="text-right">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l, i) => (
              <tr key={i} className="border-b border-zinc-300">
                <td className="py-1.5 font-mono">{i + 1}</td>
                <td className="font-mono text-xs">{l.upc}</td>
                <td>{l.description}</td>
                <td className="font-mono text-xs">{l.packSize || products.find((p) => p.id === l.productId)?.packSize}</td>
                <td className="text-right font-mono">{l.qty}</td>
                <td className="text-right font-mono">{money(l.unitCost)}</td>
                <td className="text-right font-mono">{money(l.qty * l.unitCost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-black font-bold">
              <td colSpan={4} className="py-2">{po.lines.reduce((s, l) => s + l.qty, 0)} cases</td>
              <td colSpan={2} className="text-right">TOTAL (CAD, before tax)</td>
              <td className="text-right font-mono">{money(poTotal(po))}</td>
            </tr>
          </tfoot>
        </table>
        {po.notes && <div className="mt-4 border border-black p-2 text-sm"><b>Notes:</b> {po.notes}</div>}
        <div className="mt-12 grid grid-cols-2 gap-12 text-xs">
          <div className="border-t border-black pt-1">Authorized by ({po.createdBy})</div>
          <div className="border-t border-black pt-1">Received by / date</div>
        </div>
      </div>
    </Modal>
  );
}
