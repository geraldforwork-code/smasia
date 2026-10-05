import { useEffect, useState } from 'react';
import type { Ctx } from '../App';
import { can, matchLine, poTotal, unitsFromPack, type InvoiceDoc, type InvoiceLine, type PurchaseOrder } from '../shared';
import { api, cases, confetti, dateTime, money, sound } from '../lib';
import { Btn, cx, inputCls, Panel, Table, Tag } from '../ui';

type Preset = { key: string; label: string; doc: InvoiceDoc };

export default function Invoices({ state, user, refresh, toast }: Ctx) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [doc, setDoc] = useState<InvoiceDoc | null>(null);
  const [source, setSource] = useState('');
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const approver = can(user.role, 'invoiceApprove');

  useEffect(() => { api<Preset[]>('/api/invoice-presets').then(setPresets).catch((e) => toast(e.message, true)); }, [toast]);

  const load = (d: InvoiceDoc, src: string) => { setDoc(d); setSource(src); setSkip(new Set()); };
  const patch = (p: Partial<InvoiceDoc>) => setDoc((d) => d && { ...d, ...p });
  const setLine = (i: number, p: Partial<InvoiceLine>) => setDoc((d) => d && { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const openPos = state.purchaseOrders.filter((po) => po.status === 'OPEN');
  // Receiving against a PO: the PO lines become the receipt; the clerk enters the vendor's invoice # and fixes short shipments.
  const receive = (po: PurchaseOrder) => load({
    vendor: po.vendor, invoiceNo: '', date: new Date().toLocaleDateString('en-CA'), total: poTotal(po), poNo: po.poNo,
    lines: po.lines.map((l) => ({ upc: l.upc, description: l.description, packSize: l.packSize, qty: l.qty, unitCost: l.unitCost })),
  }, `Receiving against ${po.poNo} · enter the vendor invoice # and adjust any short-shipped quantities`);

  const upload = async (file: File) => {
    setBusy(`Reading ${file.name} with Gemini OCR…`);
    try {
      const isText = file.type.startsWith('text/') || /\.(txt|csv)$/i.test(file.name);
      const body = isText
        ? { text: await file.text() }
        : { mimeType: file.type, data: await new Promise<string>((ok, bad) => {
            const r = new FileReader();
            r.onload = () => ok(String(r.result).split(',')[1]);
            r.onerror = () => bad(r.error);
            r.readAsDataURL(file);
          }) };
      load(await api<InvoiceDoc>('/api/parse-invoice', body), `AI OCR · ${file.name}`);
      sound.scan();
    } catch (e) {
      sound.error();
      toast((e as Error).message, true);
    } finally { setBusy(null); }
  };

  const chosenLines = doc?.lines.filter((_, i) => !skip.has(i)) ?? [];
  const chosen = doc && { ...doc, lines: chosenLines, total: doc.poNo ? +chosenLines.reduce((s, l) => s + l.qty * l.unitCost, 0).toFixed(2) : doc.total };
  const duplicate = doc && state.invoices.some((v) => v.invoiceNo === doc.invoiceNo.trim());
  const blocked = !!busy || !!duplicate || !chosenLines.length || !doc?.invoiceNo.trim() || chosenLines.some((l) => !(l.qty > 0));

  const run = async (label: string, fn: () => Promise<unknown>, celebrate: boolean) => {
    setBusy(label);
    try {
      await fn();
      if (celebrate) { sound.success(); confetti(); }
      toast(celebrate ? `Invoice ${chosen?.invoiceNo ?? ''} ingested into SQL inventory` : 'Done');
      setDoc(null);
      await refresh();
    } catch (e) { sound.error(); toast((e as Error).message, true); }
    finally { setBusy(null); }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
      <div className="grid content-start gap-4">
        <Panel title={`Open Purchase Orders · ${openPos.length}`}>
          {!openPos.length && <p className="text-sm text-muted">No open purchase orders.</p>}
          <div className="grid gap-2">
            {openPos.map((po) => (
              <div key={po.id} className={cx('border p-3', doc?.poNo === po.poNo ? 'border-brand' : 'border-line')}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-sm font-bold">{po.poNo}</div>
                    <div className="text-xs">{po.vendor}</div>
                    <div className="font-mono text-[10px] text-muted">{po.lines.length} lines · {money(poTotal(po))}{po.expectedDate ? ` · due ${po.expectedDate}` : ''}</div>
                  </div>
                  <Btn kind="ok" onClick={() => receive(po)}>Receive</Btn>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Vendor Invoice Presets">
          <div className="grid gap-2">
            {presets.map((p) => (
              <button key={p.key} onClick={() => load(structuredClone(p.doc), `Preset · ${p.label}`)}
                className="border border-line p-3 text-left hover:border-brand">
                <div className="text-sm font-bold">{p.doc.vendor}</div>
                <div className="font-mono text-xs text-muted">#{p.doc.invoiceNo} · {p.doc.date} · {p.doc.lines.length} lines{p.doc.pages ? ` · ${p.doc.pages} pg` : ''}</div>
                <div className="mt-1 font-mono text-sm">{money(p.doc.total)}</div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Custom Document · AI OCR">
          <label
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
            className={cx('grid cursor-pointer place-items-center border-2 border-dashed px-4 py-10 text-center', drag ? 'border-brand bg-brand/5' : 'border-line hover:border-ink')}>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,application/pdf,image/*,text/plain" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            <div className="text-sm font-bold uppercase tracking-wider">Drop invoice here</div>
            <div className="mt-1 text-xs text-muted">PDF · PNG · JPG · raw text<br />Parsed server-side by Gemini (POST /api/parse-invoice)</div>
          </label>
          {busy && <div className="mt-3 font-mono text-xs text-muted">{busy}</div>}
        </Panel>

        {state.pending.length > 0 && (
          <Panel title={`Awaiting GM Approval · ${state.pending.length}`}>
            <div className="grid gap-2">
              {state.pending.map((p) => (
                <div key={p.id} className="border border-amber-500 p-3">
                  <div className="text-sm font-bold">{p.doc.vendor} · #{p.doc.invoiceNo}</div>
                  <div className="font-mono text-xs text-muted">{p.doc.lines.length} lines · {money(p.doc.total)} · staged by {p.stagedBy}</div>
                  <div className="mt-2 flex gap-2">
                    <Btn onClick={() => load(p.doc, `Pending · staged by ${p.stagedBy}`)}>Review</Btn>
                    {approver && <Btn kind="ok" onClick={() => run('Approving…', () => api(`/api/invoices/pending/${p.id}/approve`, {}), true)}>Approve & ingest</Btn>}
                    {approver && <Btn kind="danger" onClick={() => run('Rejecting…', () => api(`/api/invoices/pending/${p.id}`, undefined, 'DELETE'), false)}>Reject</Btn>}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>

      <div className="grid content-start gap-4">
        {!doc ? (
          <Panel title="Reconciliation"><p className="py-16 text-center text-sm text-muted">Load a vendor preset or drop an invoice to reconcile it against the store catalog.</p></Panel>
        ) : (
          <Panel title="Reconciliation & Ingestion" pad={false}
            actions={<>
              <Btn onClick={() => setDoc(null)}>Discard</Btn>
              {approver
                ? <Btn kind="primary" disabled={blocked} onClick={() => run('Ingesting…', () => api('/api/invoices/ingest', { doc: chosen }), true)}>Ingest into SQL Inventory</Btn>
                : <Btn kind="primary" disabled={blocked} onClick={() => run('Submitting…', () => api('/api/invoices/stage', { doc: chosen }), false)}>Submit for GM approval</Btn>}
            </>}>
            <div className="grid gap-px border-b border-line bg-line sm:grid-cols-5">
              <div className="bg-panel px-4 py-2">
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Vendor</div>
                <div className="font-mono text-sm font-semibold">{doc.vendor}</div>
                {doc.poNo && <div className="font-mono text-[10px] text-muted">for {doc.poNo}</div>}
              </div>
              <label className="bg-panel px-4 py-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Vendor invoice #</span>
                <input value={doc.invoiceNo} onChange={(e) => patch({ invoiceNo: e.target.value })} placeholder="Required"
                  className={cx(inputCls, 'h-7 font-mono', !doc.invoiceNo.trim() && 'border-amber-500')} />
              </label>
              <label className="bg-panel px-4 py-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Invoice date</span>
                <input type="date" value={doc.date} onChange={(e) => patch({ date: e.target.value })} className={cx(inputCls, 'h-7 font-mono')} />
              </label>
              <div className="bg-panel px-4 py-2">
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{doc.poNo ? 'Receipt total' : 'Invoice total'}</div>
                <div className="font-mono text-sm font-semibold">{money(chosen!.total)}</div>
              </div>
              <div className="bg-panel px-4 py-2">
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Bill to</div>
                <div className="font-mono text-sm font-semibold">SM Asia Enterprises</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-muted">
              <span>{source}</span>
              {duplicate && <span className="font-semibold text-red-600">Invoice #{doc.invoiceNo} has already been ingested. Ingesting it again is blocked.</span>}
            </div>
            <Table head={['Use', 'Match', 'UPC', 'Description', 'Pack', 'Qty', 'Case cost', 'Line total', 'Stock delta', 'Cost change']}>
              {doc.lines.map((l, i) => {
                const p = matchLine(state.products, l);
                const per = p?.unitsPerCase ?? unitsFromPack(l.packSize);
                const before = p?.onHand ?? 0;
                const after = before + l.qty * per;
                return (
                  <tr key={i} className={cx(skip.has(i) && 'opacity-40')}>
                    <td><input type="checkbox" checked={!skip.has(i)} className="accent-[#c8102e]"
                      onChange={() => setSkip((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })} /></td>
                    <td>{p ? <Tag v="MATCH" label="In catalog" /> : <Tag v="NEW" label="New product" />}</td>
                    <td className="font-mono text-xs">{l.upc || <span className="text-muted">(none: in-store code)</span>}</td>
                    <td className="font-medium">{l.description}</td>
                    <td className="font-mono text-xs">{l.packSize}</td>
                    <td><input type="number" min={1} value={l.qty || ''} aria-label={`Cases of ${l.description}`}
                      onChange={(e) => setLine(i, { qty: Math.max(0, Math.floor(+e.target.value) || 0) })} className={cx(inputCls, 'h-7 w-16 font-mono')} /></td>
                    <td className="font-mono tabular-nums">{money(l.unitCost)}</td>
                    <td className="font-mono tabular-nums">{money(l.qty * l.unitCost)}</td>
                    <td className="whitespace-nowrap font-mono text-xs tabular-nums">
                      <span className={before === 0 ? 'text-red-600 dark:text-red-400' : ''}>{cases(before, per)}</span> → <b className="text-emerald-600 dark:text-emerald-400">{cases(after, per)}</b>
                    </td>
                    <td className="font-mono text-xs tabular-nums">
                      {p && Math.abs(p.caseCost - l.unitCost) > 0.004
                        ? <span className={l.unitCost > p.caseCost ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>{money(p.caseCost)} → {money(l.unitCost)}</span>
                        : <span className="text-muted">{p ? 'unchanged' : 'new'}</span>}
                    </td>
                  </tr>
                );
              })}
            </Table>
            <div className="flex justify-end gap-6 px-4 py-3 font-mono text-sm">
              <span>{chosen!.lines.length} lines · {chosen!.lines.reduce((s, l) => s + l.qty, 0)} CS</span>
              <span>Selected total <b>{money(chosen!.lines.reduce((s, l) => s + l.qty * l.unitCost, 0))}</b></span>
            </div>
          </Panel>
        )}

        <Panel title="Received Invoices" pad={false}>
          <Table head={['Received', 'Vendor', 'Invoice #', 'Invoice date', 'Lines', 'Total', 'Received by']} empty="No invoices received yet.">
            {state.invoices.map((v) => (
              <tr key={v.id}>
                <td className="font-mono text-xs">{dateTime(v.receivedAt)}</td>
                <td>{v.vendor}</td>
                <td className="font-mono">{v.invoiceNo}</td>
                <td className="font-mono text-xs">{v.date}</td>
                <td className="font-mono">{v.lines.length}</td>
                <td className="font-mono">{money(v.total)}</td>
                <td>{v.receivedBy}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
    </div>
  );
}
