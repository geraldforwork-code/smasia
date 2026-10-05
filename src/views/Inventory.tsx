import { useState } from 'react';
import type { Ctx } from '../App';
import { can, CATEGORIES, marginPct, needsReorder, stockStatus, unitCost, type Category, type Product, type ProductInput } from '../shared';
import { api, cases, money, sound } from '../lib';
import { Btn, cx, Field, inputCls, Modal, Panel, Table, Tag } from '../ui';
import LabelsModal from './Labels';
import ProductImportModal from './ProductImport';
import ProductLedgerModal from './ProductLedger';
import { download, exportCatalog, exportEposList } from '../catalogIO';

export default function Inventory({ state, user, refresh, toast }: Ctx) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [show, setShow] = useState<'all' | 'reorder' | 'untracked'>('all');
  const [editing, setEditing] = useState<Product | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const canEdit = can(user.role, 'catalog');
  const [importing, setImporting] = useState(false);
  const [cardId, setCardId] = useState<number | null>(null);
  const canCard = can(user.role, 'movements');
  const card = state.products.find((x) => x.id === cardId);
  const stamp = () => new Date().toLocaleDateString('en-CA');
  const [labels, setLabels] = useState(false);
  const canAdjust = can(user.role, 'adjust');

  const rows = state.products.filter((p) =>
    (!cat || p.category === cat) && (show === 'all' || (show === 'reorder' ? needsReorder(p) : stockStatus(p) === 'UNSET')) &&
    `${p.name} ${p.upc} ${p.sku} ${p.aisle}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <Panel pad={false} title={`Catalog & Stock Availability · ${rows.length} SKUs${canCard ? ' · click a product for its stock card' : ''}`}
        actions={<>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, UPC, SKU, aisle" className={cx(inputCls, 'w-64')} />
          <select value={cat} onChange={(e) => setCat(e.target.value)} className={cx(inputCls, 'w-52')}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={show} onChange={(e) => setShow(e.target.value as typeof show)} className={cx(inputCls, 'w-48')}>
            <option value="all">All stock statuses</option>
            <option value="reorder">Low / out of stock</option>
            <option value="untracked">Not tracked (levels not set)</option>
          </select>
          {can(user.role, 'labels') && <Btn onClick={() => setLabels(true)}>Shelf labels</Btn>}
          {canEdit && <>
            <Btn kind="primary" onClick={() => setImporting(true)}>Import products</Btn>
            <Btn onClick={() => download(`SMASIA-catalog-${stamp()}.csv`, exportCatalog(state.products))} title="All fields incl. aisle and reorder levels; edit in Excel and import back">Export catalog</Btn>
            <Btn onClick={() => download(`SMASIA-ProductList-${stamp()}.csv`, exportEposList(state.products))} title="Epos Now ProductList layout">Export Epos format</Btn>
          </>}
        </>}>
        <Table head={['Status', 'UPC', 'Product', 'Category', 'Aisle', 'Pack', 'On hand', 'Reorder', 'Retail', 'Unit cost', 'Margin', ...(canAdjust || canEdit ? [''] : [])]} empty="No products match.">
          {rows.map((p) => (
            <tr key={p.id}>
              <td><Tag v={stockStatus(p)} /></td>
              <td className="font-mono text-xs">{p.upc}</td>
              <td className="font-medium">
                {canCard
                  ? <button onClick={() => setCardId(p.id)} className="text-left underline decoration-line decoration-dotted underline-offset-4 hover:text-brand" title="Stock card: all ins and outs">{p.name}</button>
                  : p.name}
              </td>
              <td className="text-xs text-muted">{p.category}</td>
              <td className="font-mono">{p.aisle}</td>
              <td className="font-mono text-xs">{p.packSize}</td>
              <td className="whitespace-nowrap font-mono tabular-nums">{p.onHand} EA <span className="text-muted">· {cases(p.onHand, p.unitsPerCase)}</span></td>
              <td className="font-mono tabular-nums text-muted">{p.reorderPoint}</td>
              <td className="font-mono tabular-nums">{money(p.unitPrice)}</td>
              <td className="font-mono tabular-nums">{money(unitCost(p))}</td>
              <td className="font-mono tabular-nums">{marginPct(p).toFixed(1)}%</td>
              {(canAdjust || canEdit) && (
                <td className="whitespace-nowrap">
                  <div className="flex gap-1">
                    {canAdjust && <Btn onClick={() => setEditing(p)}>Count / Adjust</Btn>}
                    {canEdit && <Btn onClick={() => setProduct(p)}>Edit</Btn>}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </Table>
      </Panel>
      {editing && <AdjustModal p={editing} onClose={() => setEditing(null)} done={async (msg) => { setEditing(null); toast(msg); await refresh(); }} fail={(m) => toast(m, true)} />}
      {labels && <LabelsModal products={state.products} onClose={() => setLabels(false)} />}
      {card && <ProductLedgerModal p={card} toast={toast} onClose={() => setCardId(null)} />}
      {importing && <ProductImportModal products={state.products} toast={toast} onClose={() => setImporting(false)} onDone={async () => { setImporting(false); await refresh(); }} />}
      {product && <EditProductModal p={product} vendors={[...new Set(state.products.map((x) => x.vendor))].sort()} onClose={() => setProduct(null)}
        done={async (msg) => { setProduct(null); toast(msg); await refresh(); }} fail={(m) => toast(m, true)} />}
    </>
  );
}

function AdjustModal({ p, onClose, done, fail }: { p: Product; onClose: () => void; done: (msg: string) => void; fail: (m: string) => void }) {
  const [type, setType] = useState<'CYCLE_COUNT' | 'ADJUSTMENT'>('CYCLE_COUNT');
  const [count, setCount] = useState(String(p.onHand));
  const [delta, setDelta] = useState('0');
  const [reason, setReason] = useState('');
  const newOnHand = type === 'CYCLE_COUNT' ? Number(count) : p.onHand + Number(delta);
  const valid = Number.isInteger(newOnHand) && newOnHand >= 0 && (type === 'CYCLE_COUNT' || (Number(delta) !== 0 && reason.trim()));

  const save = async () => {
    try {
      await api('/api/adjust', { productId: p.id, newOnHand, type, reason: reason.trim() || (type === 'CYCLE_COUNT' ? 'Cycle count' : '') });
      sound.scan();
      if (newOnHand <= p.reorderPoint) setTimeout(sound.lowStock, 160);
      done(`${p.name}: ${p.onHand} → ${newOnHand} EA`);
    } catch (e) { sound.error(); fail((e as Error).message); }
  };

  return (
    <Modal title="Cycle Count / Shelf Adjustment" onClose={onClose}>
      <div className="mb-4">
        <div className="font-mono text-xs text-muted">{p.upc} · Aisle {p.aisle}</div>
        <div className="text-lg font-bold">{p.name}</div>
        <div className="font-mono text-sm">System on hand: {p.onHand} EA ({cases(p.onHand, p.unitsPerCase)}) · {p.unitsPerCase} EA/CS</div>
      </div>
      <div className="mb-4 flex border border-line">
        {(['CYCLE_COUNT', 'ADJUSTMENT'] as const).map((t) => (
          <button key={t} onClick={() => setType(t)} className={cx('flex-1 py-2 text-xs font-bold uppercase tracking-wider', type === t ? 'bg-ink text-canvas' : 'hover:bg-canvas')}>
            {t === 'CYCLE_COUNT' ? 'Barcode cycle count (set)' : 'Shelf adjustment (±)'}
          </button>
        ))}
      </div>
      <div className="grid gap-3">
        {type === 'CYCLE_COUNT'
          ? <Field label="Counted on shelf (EA)"><input type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} className={cx(inputCls, 'font-mono')} autoFocus /></Field>
          : <Field label="Adjustment (EA, negative to remove)"><input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} className={cx(inputCls, 'font-mono')} autoFocus /></Field>}
        <Field label={type === 'ADJUSTMENT' ? 'Reason (required)' : 'Note'}>
          <input value={reason} maxLength={60} onChange={(e) => setReason(e.target.value)} placeholder={type === 'ADJUSTMENT' ? 'Damaged, expired, found stock…' : 'Optional'} className={inputCls} />
        </Field>
        <div className="border border-line p-2 font-mono text-sm">
          Result: {p.onHand} → <b>{Number.isFinite(newOnHand) ? newOnHand : '?'}</b> EA ({newOnHand - p.onHand >= 0 ? '+' : ''}{newOnHand - p.onHand})
          {newOnHand >= 0 && newOnHand <= p.reorderPoint && <span className="ml-2"><Tag v={newOnHand === 0 ? 'OUT' : 'LOW'} /></span>}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={!valid} onClick={save}>Post to inventory</Btn>
      </div>
    </Modal>
  );
}

function EditProductModal({ p, vendors, onClose, done, fail }: { p: Product; vendors: string[]; onClose: () => void; done: (msg: string) => void; fail: (m: string) => void }) {
  const [f, setF] = useState({
    name: p.name, category: p.category, vendor: p.vendor, aisle: p.aisle, packSize: p.packSize, unitsPerCase: String(p.unitsPerCase),
    unitPrice: String(p.unitPrice), caseCost: String(p.caseCost), reorderPoint: String(p.reorderPoint), targetLevel: String(p.targetLevel),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const n = (k: keyof typeof f) => Number(f[k]);
  const valid = f.name.trim() && Number.isInteger(n('unitsPerCase')) && n('unitsPerCase') >= 1 && n('unitPrice') >= 0 && n('caseCost') >= 0 &&
    Number.isInteger(n('reorderPoint')) && Number.isInteger(n('targetLevel')) && n('reorderPoint') >= 0 && n('targetLevel') >= n('reorderPoint');
  const untracked = n('targetLevel') === 0;

  const save = async () => {
    const body: Partial<ProductInput> = {
      name: f.name, category: f.category as Category, vendor: f.vendor, aisle: f.aisle, packSize: f.packSize, unitsPerCase: n('unitsPerCase'),
      unitPrice: n('unitPrice'), caseCost: n('caseCost'), reorderPoint: n('reorderPoint'), targetLevel: n('targetLevel'),
    };
    try { await api(`/api/products/${p.id}`, body, 'PATCH'); done(`${f.name} saved`); }
    catch (e) { fail((e as Error).message); }
  };

  return (
    <Modal title="Edit Product" onClose={onClose}>
      <div className="mb-3 font-mono text-xs text-muted">{p.upc} · {p.sku} · on hand {p.onHand} EA (change with Count / Adjust)</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><Field label="Name"><input value={f.name} onChange={set('name')} maxLength={200} className={inputCls} /></Field></div>
        <Field label="Category">
          <select value={f.category} onChange={set('category')} className={inputCls}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
        <Field label="Vendor">
          <input value={f.vendor} onChange={set('vendor')} list="vendors" maxLength={100} className={inputCls} />
          <datalist id="vendors">{vendors.map((v) => <option key={v} value={v} />)}</datalist>
        </Field>
        <Field label="Aisle"><input value={f.aisle} onChange={set('aisle')} maxLength={10} className={cx(inputCls, 'font-mono')} /></Field>
        <Field label="Pack size (e.g. 24/227g)"><input value={f.packSize} onChange={set('packSize')} maxLength={50} className={cx(inputCls, 'font-mono')} /></Field>
        <Field label="Units per case"><input type="number" min={1} value={f.unitsPerCase} onChange={set('unitsPerCase')} className={cx(inputCls, 'font-mono')} /></Field>
        <Field label="Case cost (CAD)"><input type="number" min={0} step="0.01" value={f.caseCost} onChange={set('caseCost')} className={cx(inputCls, 'font-mono')} /></Field>
        <Field label="Shelf price each (CAD, before tax)"><input type="number" min={0} step="0.01" value={f.unitPrice} onChange={set('unitPrice')} className={cx(inputCls, 'font-mono')} /></Field>
        <div className="font-mono text-xs text-muted self-end pb-2">
          Unit cost {money(n('caseCost') / Math.max(1, n('unitsPerCase')))} · margin {n('unitPrice') ? (((n('unitPrice') - n('caseCost') / Math.max(1, n('unitsPerCase'))) / n('unitPrice')) * 100).toFixed(1) : '0.0'}%
        </div>
        <Field label="Reorder point (EA)"><input type="number" min={0} value={f.reorderPoint} onChange={set('reorderPoint')} className={cx(inputCls, 'font-mono')} /></Field>
        <Field label="Target level (EA)"><input type="number" min={0} value={f.targetLevel} onChange={set('targetLevel')} className={cx(inputCls, 'font-mono')} /></Field>
      </div>
      <p className="mt-3 text-xs text-muted">
        {untracked
          ? 'Target level 0 = stock not tracked: no low-stock alerts or re-order suggestions. Count the shelf and set a target to start tracking.'
          : 'Low-stock alerts fire at the reorder point; re-order suggestions top up to the target level.'}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={!valid} onClick={save}>Save</Btn>
      </div>
    </Modal>
  );
}
