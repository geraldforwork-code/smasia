import { useMemo, useState } from 'react';
import { can, EPOS_SKU, POST_LABEL, productCodeIndex, type PostingSummary, type AppState, type Product, type Role, type SalesHistory, type SalesImportBody } from '../shared';
import {
  api, eposNewProduct, findHeaderRow, guessColumns, money, parseCsv, parseDate, parseEposDaily, parseNumber, sniffDateOrder, sound,
  type DateOrder, type EposDaily, type EposDailyRow, type SalesColumn,
} from '../lib';
import { Btn, cx, Field, inputCls, Modal, Table, Tag } from '../ui';

const LABELS: Record<SalesColumn, string> = { barcode: 'Barcode / UPC', sku: 'SKU / product code', name: 'Product name', qty: 'Quantity sold', date: 'Date (optional)' };
type Toast = (m: string, bad?: boolean) => void;

/** Upload sales reports: Epos Now DailySales files (one or many), or any other CSV via column mapping. */
export default function SalesImportModal({ products, role, onClose, onDone, toast }: {
  products: Product[]; role: Role; onClose: () => void; onDone: (h: SalesHistory) => void; toast: Toast;
}) {
  const [daily, setDaily] = useState<EposDaily[] | null>(null);
  const [generic, setGeneric] = useState<{ name: string; rows: string[][] } | null>(null);
  const match = useMemo(() => productCodeIndex(products), [products]);

  const pick = async (files: File[]) => {
    if (!files.length) return;
    const texts = await Promise.all(files.map(async (f) => ({ f, text: await f.text() })));
    const parsed = texts.map(({ f, text }) => parseEposDaily(text, f.name));
    if (parsed.every(Boolean)) { setGeneric(null); setDaily(parsed as EposDaily[]); return; }
    if (files.length > 1) return toast('Several files can be imported together only if they are all Epos Now DailySales exports.', true);
    const rows = parseCsv(texts[0].text);
    if (rows.length < 2) return toast('That file has no data rows. Export the report as CSV.', true);
    setDaily(null);
    setGeneric({ name: files[0].name, rows });
  };

  return (
    <Modal title="Import EPOS Sales Reports" onClose={onClose} wide>
      <label className="grid cursor-pointer place-items-center border-2 border-dashed border-line px-4 py-6 text-center hover:border-ink">
        <input type="file" multiple accept=".csv,text/csv,text/plain" className="hidden"
          onChange={(e) => { pick([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <div className="text-sm font-bold uppercase tracking-wider">Choose sales report(s) (.csv)</div>
        <div className="mt-1 text-xs text-muted">Epos Now DailySales_YYYY_MM_DD_HHMM.csv: select one or many days at once. Other CSV reports: one file, columns mapped below.</div>
      </label>
      {daily && <DailyImport files={daily} match={match} canCreate={can(role, 'catalog')} onDone={onDone} toast={toast} onClose={onClose} />}
      {generic && <GenericImport key={generic.name} file={generic} match={match} onDone={onDone} toast={toast} onClose={onClose} />}
    </Modal>
  );
}

type Matcher = ReturnType<typeof productCodeIndex>;
type ImportResult = SalesHistory & { posting: PostingSummary[] };

/** "Deducted 340 · Before last count: 12 lines · …" */
const describePosting = (all: PostingSummary[]) => {
  const by = new Map<string, PostingSummary>();
  for (const s of all) { const t = by.get(s.status) ?? { ...s, lines: 0, sold: 0, posted: 0 }; t.lines += s.lines; t.sold += s.sold; t.posted += s.posted; by.set(s.status, t); }
  const deducted = [...by.values()].reduce((t, s) => t + s.posted, 0);
  const notes = [...by.values()].filter((s) => s.status !== 'POSTED').map((s) => `${POST_LABEL[s.status]}: ${s.lines} line(s)`);
  return `${deducted} units deducted from stock${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
};

function PostToStock({ post, setPost }: { post: boolean; setPost: (v: boolean) => void }) {
  return (
    <label className={cx('mt-3 flex items-start gap-2 border p-3 text-sm', post ? 'border-brand' : 'border-line')}>
      <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} className="mt-0.5 accent-[#c8102e]" />
      <span>
        <b>Deduct these sales from stock on hand</b> (recorded as OUTs on each product's stock card)
        <span className="block text-xs text-muted">
          Skipped automatically: sales from before a product's latest shelf count (the count already reflects them), products not tracked yet
          (levels not set) and weighed items. Selling more than the system has deducts to 0 and flags the line "short: count needed".
          Re-importing a day first reverses that day's earlier deductions, so nothing is deducted twice.
        </span>
      </span>
    </label>
  );
}

const matchRows = (f: EposDaily, match: Matcher) => {
  const matched: { productId: number; qty: number }[] = [];
  const unmatched: EposDailyRow[] = [];
  for (const r of f.rows) {
    const p = match(r.barcodes, EPOS_SKU(r.productId), r.name);
    if (p) matched.push({ productId: p.id, qty: r.qty }); else unmatched.push(r);
  }
  return { matched, unmatched };
};

function DailyImport({ files, match, canCreate, onDone, toast, onClose }: {
  files: EposDaily[]; match: Matcher; canCreate: boolean; onDone: (h: SalesHistory) => void; toast: Toast; onClose: () => void;
}) {
  const [dates, setDates] = useState<Record<string, string>>(() => Object.fromEntries(files.map((f) => [f.fileName, f.salesDate ?? ''])));
  const [busy, setBusy] = useState<string | null>(null);
  const [create, setCreate] = useState(canCreate);
  const [post, setPost] = useState(true);

  const results = useMemo(() => files.map((f) => ({ f, ...matchRows(f, match), date: dates[f.fileName] })), [files, match, dates]);

  // Two exports of the same day: the later one is the more complete picture.
  const latest = new Map<string, (typeof results)[number]>();
  for (const r of results) {
    const cur = latest.get(r.date);
    if (r.date && (!cur || (r.f.generatedUtc ?? '') > (cur.f.generatedUtc ?? ''))) latest.set(r.date, r);
  }
  const days = [...latest.values()].sort((a, b) => a.date.localeCompare(b.date));
  const unmatched = new Map<string, { barcodes: string; qty: number }>();
  // New catalog entries: one per Epos Now item, priced from the most recent day it sold.
  const newProducts = new Map<string, NonNullable<ReturnType<typeof eposNewProduct>>>();
  for (const r of days) for (const u of r.unmatched) {
    const cur = unmatched.get(u.name) ?? { barcodes: u.barcodes, qty: 0 };
    cur.qty += u.qty;
    unmatched.set(u.name, cur);
    const np = eposNewProduct(u);
    if (np && ![...newProducts.values()].some((x) => x.upc === np.upc && x.sku !== np.sku)) newProducts.set(np.sku, np);
  }
  const toImport = create && newProducts.size ? days : days.filter((r) => r.matched.length);

  const run = async () => {
    let last: SalesHistory | null = null;
    const posting: PostingSummary[] = [];
    let rematch: Matcher | null = null;
    if (create && newProducts.size) {
      setBusy(`Adding ${newProducts.size} products…`);
      try {
        const res = await api<{ created: number; state: AppState }>('/api/products/bulk', { products: [...newProducts.values()] });
        rematch = productCodeIndex(res.state.products);
        toast(`Added ${res.created} Epos Now products to the catalog`);
      } catch (e) {
        sound.error(); setBusy(null);
        return toast((e as Error).message, true);
      }
    }
    for (const r of toImport) {
      setBusy(`Importing ${r.date}…`);
      const matched = rematch ? matchRows(r.f, rematch).matched : r.matched;
      if (!matched.length) continue;
      try {
        const body: SalesImportBody = { fileName: r.f.fileName, periodFrom: r.date, periodTo: r.date, rows: matched.map((m) => ({ ...m, date: r.date })), post };
        const res = await api<ImportResult>('/api/sales-imports', body);
        posting.push(...res.posting);
        last = res;
      } catch (e) {
        sound.error(); setBusy(null);
        return toast(`${r.f.fileName}: ${(e as Error).message}`, true);
      }
    }
    setBusy(null);
    sound.success();
    toast(`Imported ${toImport.length} day(s) of Epos Now sales${post ? `: ${describePosting(posting)}` : ''}`);
    if (last) onDone(last);
  };

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-2"><Tag v="OK" label="Epos Now DailySales" /><span className="text-xs text-muted">One file = one trading day. The filename time is UTC; the sales date below is its local date. Change it if a file covers a different day.</span></div>
      <Table head={['File', 'Exported (local)', 'Sales date', 'Lines', 'Matched', 'Units', 'Sales inc. tax', '']}>
        {results.map((r) => {
          const used = latest.get(r.date) === r;
          return (
            <tr key={r.f.fileName} className={cx(!used && 'opacity-50')}>
              <td className="font-mono text-xs">{r.f.fileName}</td>
              <td className="whitespace-nowrap font-mono text-xs">{r.f.generatedUtc ? new Date(r.f.generatedUtc).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
              <td><input type="date" value={r.date} onChange={(e) => setDates({ ...dates, [r.f.fileName]: e.target.value })} className={cx(inputCls, 'h-7 w-40 font-mono', !r.date && 'border-red-600')} /></td>
              <td className="font-mono tabular-nums">{r.f.rows.length}</td>
              <td className="font-mono tabular-nums">{r.matched.length} <span className="text-muted">({r.f.rows.length ? Math.round((r.matched.length / r.f.rows.length) * 100) : 0}%)</span></td>
              <td className="font-mono tabular-nums">{r.matched.reduce((s, m) => s + m.qty, 0).toLocaleString('en-CA', { maximumFractionDigits: 2 })} <span className="text-muted">/ {r.f.units.toLocaleString('en-CA', { maximumFractionDigits: 2 })}</span></td>
              <td className="font-mono tabular-nums">{money(r.f.revenue)}</td>
              <td>{!r.date ? <Tag v="OUT" label="Set date" /> : !used ? <Tag v="NEW" label="Superseded" /> : !r.matched.length ? <Tag v="LOW" label="Nothing matched" /> : null}</td>
            </tr>
          );
        })}
      </Table>
      <p className="mt-2 text-xs text-muted">
        Matching: Epos Now product ID, then barcode (any in the list, leading zeros and missing check digits tolerated), then exact product name.
        Weighed items use MeasuredQty. Each day replaces any earlier import for that day, so re-exporting a day later (e.g. after close) just updates it.
        The filename time is when the report was exported: if you export an earlier day, set its sales date here.
      </p>
      <PostToStock post={post} setPost={setPost} />
      {newProducts.size > 0 && (
        <label className={cx('mt-3 flex items-start gap-2 border p-3 text-sm', create ? 'border-brand' : 'border-line', !canCreate && 'opacity-50')}>
          <input type="checkbox" checked={create} disabled={!canCreate} onChange={(e) => setCreate(e.target.checked)} className="mt-0.5 accent-[#c8102e]" />
          <span>
            <b>Add {newProducts.size} missing Epos Now items to the catalog</b> before importing, so their sales count too.
            <span className="block text-xs text-muted">
              Name, barcode, shelf price (before tax/discount) and unit cost come from the report; SKU = EPOS-&lt;ProductID&gt;. They start as
              <i> Uncategorized</i> with stock not tracked (levels not set) until you count them and set reorder levels under Inventory → Edit.
              {!canCreate && ' Only the General Manager can add products.'}
            </span>
          </span>
        </label>
      )}
      {unmatched.size > 0 && (
        <details className="mt-3 border border-line p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{unmatched.size} Epos Now items aren't in this app's catalog yet ({create ? 'will be added' : 'skipped'})</summary>
          <table className="mt-2 w-full font-mono">
            <tbody>
              {[...unmatched.entries()].sort((a, b) => b[1].qty - a[1].qty).map(([name, u]) => (
                <tr key={name} className="border-b border-line/60"><td className="py-0.5 pr-3">{name}</td><td className="pr-3 text-muted">{u.barcodes || '(no barcode)'}</td><td className="text-right">{+u.qty.toFixed(3)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={!!busy || !toImport.length || results.some((r) => !r.date)} onClick={run}>
          {busy ?? `Import ${toImport.length} day(s)`}
        </Btn>
      </div>
    </div>
  );
}

function GenericImport({ file, match, onDone, toast, onClose }: { file: { name: string; rows: string[][] }; match: Matcher; onDone: (h: SalesHistory) => void; toast: Toast; onClose: () => void }) {
  const headerAt = useMemo(() => findHeaderRow(file.rows), [file]);
  const header = file.rows[headerAt] ?? [];
  const body = file.rows.slice(headerAt + 1);
  const [cols, setCols] = useState<Record<SalesColumn, number>>(() => guessColumns(header));
  const sniffed = useMemo(() => (cols.date >= 0 ? sniffDateOrder(body.map((r) => r[cols.date] ?? '')) : null), [cols.date, body]);
  const [order, setOrder] = useState<DateOrder>(sniffed ?? 'DMY');
  // A summary report usually states its period in the title rows above the header.
  const titleDates = useMemo(() => [...file.rows.slice(0, headerAt).flat().join(' ')
    .matchAll(/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{4}/g)]
    .map((m) => parseDate(m[0], sniffed ?? 'DMY')).filter(Boolean) as string[], [file, headerAt, sniffed]);
  const [from, setFrom] = useState(titleDates[0] ?? '');
  const [to, setTo] = useState(titleDates[1] ?? titleDates[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [post, setPost] = useState(true);

  const preview = useMemo(() => {
    if (cols.qty < 0) return null;
    const cell = (r: string[], c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
    const matched: { product: Product; date: string | null; qty: number }[] = [];
    const unmatched = new Map<string, number>();
    let badDates = 0, badQty = 0;
    for (const r of body) {
      const label = cell(r, cols.name) || cell(r, cols.barcode) || cell(r, cols.sku);
      if (!label || /^(grand\s+)?totals?\b/i.test(label)) continue; // report footer
      const qty = parseNumber(cell(r, cols.qty));
      if (!Number.isFinite(qty)) { badQty++; continue; }
      const product = match(cell(r, cols.barcode), cell(r, cols.sku), cell(r, cols.name));
      if (!product) { unmatched.set(label, (unmatched.get(label) ?? 0) + qty); continue; }
      const date = cols.date >= 0 ? parseDate(cell(r, cols.date), order) : null;
      if (cols.date >= 0 && !date) { badDates++; continue; }
      matched.push({ product, date, qty });
    }
    const dates = matched.map((m) => m.date).filter(Boolean).sort() as string[];
    return { matched, unmatched: [...unmatched.entries()], badDates, badQty, minDate: dates[0], maxDate: dates.at(-1) };
  }, [body, cols, order, match]);

  const periodFrom = from || preview?.minDate || '';
  const periodTo = to || preview?.maxDate || '';
  const days = periodFrom && periodTo && periodTo >= periodFrom ? Math.round((Date.parse(periodTo) - Date.parse(periodFrom)) / 86_400_000) + 1 : 0;
  const outside = cols.date >= 0 && preview ? preview.matched.filter((m) => m.date! < periodFrom || m.date! > periodTo).length : 0;

  const submit = async () => {
    if (!preview || !days) return;
    const rows = cols.date >= 0
      ? preview.matched.map((m) => ({ productId: m.product.id, date: m.date!, qty: m.qty })).filter((r) => r.date >= periodFrom && r.date <= periodTo)
      // ponytail: a summary report has no per-day detail, so its totals are spread evenly over the period.
      : preview.matched.flatMap((m) => Array.from({ length: days }, (_, i) => ({
          productId: m.product.id, date: new Date(Date.parse(periodFrom) + i * 86_400_000).toISOString().slice(0, 10), qty: m.qty / days,
        })));
    setBusy(true);
    try {
      const h = await api<ImportResult>('/api/sales-imports', { fileName: file.name, periodFrom, periodTo, rows, post } satisfies SalesImportBody);
      sound.success();
      toast(`Imported ${preview.matched.length} sales lines for ${periodFrom} → ${periodTo}${post ? `: ${describePosting(h.posting)}` : ''}`);
      onDone(h);
    } catch (e) { sound.error(); toast((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-4">
      <div className="mb-2 font-mono text-xs">{file.name}</div>
      <div className="grid gap-3 sm:grid-cols-5">
        {(Object.keys(LABELS) as SalesColumn[]).map((k) => (
          <Field key={k} label={LABELS[k]}>
            <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: +e.target.value })} className={cx(inputCls, k === 'qty' && cols.qty < 0 && 'border-red-600')}>
              <option value={-1}>— none —</option>
              {header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">Header found on row {headerAt + 1}. Rows match by barcode (leading zeros and missing check digits tolerated), then SKU, then exact product name.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {cols.date >= 0 && (
          <Field label={`Date format${sniffed ? ' (detected)' : ' (ambiguous: check!)'}`}>
            <select value={order} onChange={(e) => setOrder(e.target.value as DateOrder)} className={cx(inputCls, !sniffed && 'border-amber-500')}>
              <option value="DMY">DD/MM/YYYY</option>
              <option value="MDY">MM/DD/YYYY</option>
            </select>
          </Field>
        )}
        <Field label="Report period from"><input type="date" value={periodFrom} onChange={(e) => setFrom(e.target.value)} className={cx(inputCls, 'font-mono')} /></Field>
        <Field label="to"><input type="date" value={periodTo} onChange={(e) => setTo(e.target.value)} className={cx(inputCls, 'font-mono')} /></Field>
      </div>
      {preview && (
        <div className="mt-4 grid gap-px bg-line text-sm sm:grid-cols-4">
          {[
            ['Matched lines', `${preview.matched.length}`],
            ['Units sold', preview.matched.reduce((s, m) => s + m.qty, 0).toLocaleString('en-CA', { maximumFractionDigits: 2 })],
            ['Period', days ? `${days} day${days === 1 ? '' : 's'}` : 'set dates'],
            ['Skipped', `${preview.unmatched.length} unmatched · ${preview.badDates} bad date · ${preview.badQty} bad qty`],
          ].map(([k, v]) => (
            <div key={k} className="bg-panel p-2">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{k}</div>
              <div className="font-mono font-semibold">{v}</div>
            </div>
          ))}
        </div>
      )}
      {cols.date < 0 && days > 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">No date column: each product's total is spread evenly across the {days} days.</p>}
      {outside > 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{outside} dated lines fall outside the period and will be left out.</p>}
      <p className="mt-2 text-xs text-muted">Importing replaces any previously imported sales between these dates (for every product).</p>
      <PostToStock post={post} setPost={setPost} />
      {preview && preview.unmatched.length > 0 && (
        <details className="mt-3 border border-line p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{preview.unmatched.length} report items not in the catalog (not imported)</summary>
          <ul className="mt-2 max-h-40 overflow-y-auto font-mono">{preview.unmatched.slice(0, 200).map(([label, q]) => <li key={label}>{label} · {q}</li>)}</ul>
        </details>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={busy || !preview?.matched.length || !days || cols.qty < 0} onClick={submit}>{busy ? 'Importing…' : 'Import into forecast history'}</Btn>
      </div>
    </div>
  );
}
