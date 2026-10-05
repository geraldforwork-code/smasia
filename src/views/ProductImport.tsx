import { useMemo, useState } from 'react';
import { CATEGORIES, productCodeIndex, type AppState, type Category, type Product, type ProductInput } from '../shared';
import { api, money, sound } from '../lib';
import { guessCategory, inStoreCode, parseCatalogCsv, parseEposProductList, type CatalogRow, type EposListRow } from '../catalogIO';
import { Btn, cx, Modal, Tag } from '../ui';

type Toast = (m: string, bad?: boolean) => void;
type Update = Partial<ProductInput> & { id: number };
const MAP_KEY = 'smasia.eposCategoryMap';
const loadMap = (): Record<string, Category> => { try { return JSON.parse(localStorage.getItem(MAP_KEY) ?? '{}'); } catch { return {}; } };
const saveMap = (m: Record<string, Category>) => { try { localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch { /* storage blocked */ } };

/** Import products: an Epos Now ProductList export, or this app's catalog CSV (edited in Excel). */
export default function ProductImportModal({ products, onClose, onDone, toast }: { products: Product[]; onClose: () => void; onDone: () => void; toast: Toast }) {
  const [file, setFile] = useState<{ name: string; epos?: EposListRow[]; catalog?: { rows: CatalogRow[]; errors: string[] } } | null>(null);

  const pick = async (f: File) => {
    const text = await f.text();
    const epos = parseEposProductList(text);
    if (epos) return setFile({ name: f.name, epos });
    const catalog = parseCatalogCsv(text);
    if (catalog) return setFile({ name: f.name, catalog });
    toast('Unrecognised file. Use an Epos Now ProductList export or a catalog CSV exported from this app.', true);
  };

  return (
    <Modal title="Import Products" onClose={onClose} wide>
      <label className="grid cursor-pointer place-items-center border-2 border-dashed border-line px-4 py-6 text-center hover:border-ink">
        <input type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
        <div className="text-sm font-bold uppercase tracking-wider">{file?.name ?? 'Choose product file (.csv)'}</div>
        <div className="mt-1 text-xs text-muted">Epos Now: Products → Export (ProductList.csv), or a catalog CSV exported from here and edited in Excel.</div>
      </label>
      {file?.epos && <EposListImport key={file.name} rows={file.epos} products={products} onDone={onDone} onClose={onClose} toast={toast} />}
      {file?.catalog && <CatalogImport key={file.name} data={file.catalog} products={products} onDone={onDone} onClose={onClose} toast={toast} />}
    </Modal>
  );
}

/** Create first, then update: one call each, both transactional on the server. */
async function apply(creates: Partial<ProductInput>[], updates: Update[], toast: Toast) {
  let created = 0, updated = 0;
  if (creates.length) created = (await api<{ created: number; state: AppState }>('/api/products/bulk', { products: creates })).created;
  if (updates.length) updated = (await api<{ updated: number; state: AppState }>('/api/products/bulk-update', { products: updates })).updated;
  sound.success();
  toast(`Products imported: ${created} added, ${updated} updated`);
}

function EposListImport({ rows, products, onDone, onClose, toast }: { rows: EposListRow[]; products: Product[]; onDone: () => void; onClose: () => void; toast: Toast }) {
  const [catMap, setCatMap] = useState<Record<string, Category>>(() => {
    const saved = loadMap();
    return Object.fromEntries([...new Set(rows.map((r) => r.eposCategory))].map((c) => [c, saved[c] ?? guessCategory(c)]));
  });
  const [updPrice, setUpdPrice] = useState(true);
  const [updCost, setUpdCost] = useState(false);
  const [updCat, setUpdCat] = useState(true);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => {
    const match = productCodeIndex(products);
    const seen = new Set<string>();
    let dups = 0, invalid = 0;
    const creates: (Partial<ProductInput> & { eposCategory: string })[] = [];
    const updates: (Update & { before: Product })[] = [];
    for (const r of rows) {
      const key = r.barcode || r.name.toLowerCase();
      if (seen.has(key)) { dups++; continue; }
      seen.add(key);
      if (!Number.isFinite(r.price) || r.price < 0) { invalid++; continue; }
      const category = catMap[r.eposCategory];
      const cost = Number.isFinite(r.cost) && r.cost >= 0 ? r.cost : 0;
      const existing = match(r.barcode, '', r.name);
      if (!existing) {
        const upc = r.barcode || inStoreCode(r.name);
        creates.push({ upc, sku: `SMA-${upc}`, name: r.name, category, vendor: 'Unassigned', packSize: '1 EA', unitsPerCase: 1,
          caseCost: cost, unitPrice: r.price, aisle: '', eposCategory: r.eposCategory });
        continue;
      }
      const u: Update & { before: Product } = { id: existing.id, before: existing };
      if (updPrice && Math.abs(existing.unitPrice - r.price) >= 0.005) u.unitPrice = r.price;
      // Epos cost is per each; keep the product's case size.
      if (updCost && Number.isFinite(r.cost) && Math.abs(existing.caseCost / existing.unitsPerCase - cost) >= 0.005) u.caseCost = +(cost * existing.unitsPerCase).toFixed(2);
      if (updCat && existing.category === 'Uncategorized' && category !== 'Uncategorized') u.category = category;
      if (Object.keys(u).length > 2) updates.push(u);
    }
    return { creates, updates, dups, invalid, matched: seen.size - creates.length - invalid };
  }, [rows, products, catMap, updPrice, updCost, updCat]);

  const cats = Object.keys(catMap).map((c) => ({ c, n: rows.filter((r) => r.eposCategory === c).length })).sort((a, b) => b.n - a.n);

  const run = async () => {
    setBusy(true);
    saveMap(catMap);
    try {
      await apply(plan.creates.map(({ eposCategory: _e, ...p }) => p), plan.updates.map(({ before: _b, ...u }) => u), toast);
      onDone();
    } catch (e) { sound.error(); toast((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-4 grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs"><Tag v="OK" label="Epos Now ProductList" />
        <span className="text-muted">{rows.length} rows · {plan.matched} already in catalog · {plan.creates.length} new · {plan.dups} duplicate rows ignored{plan.invalid ? ` · ${plan.invalid} without a valid price skipped` : ''}</span>
      </div>

      <div>
        <h3 className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Epos Now category → store category</h3>
        <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
          {cats.map(({ c, n }) => (
            <label key={c} className="flex items-center justify-between gap-2 bg-panel px-3 py-1.5 text-sm">
              <span className="truncate">{c} <span className="text-muted">({n})</span></span>
              <select value={catMap[c]} onChange={(e) => setCatMap({ ...catMap, [c]: e.target.value as Category })} className="h-7 border border-line bg-canvas px-1 text-xs">
                {CATEGORIES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">Remembered on this device for the next import.</p>
      </div>

      <div className="grid gap-1 border border-line p-3 text-sm">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Products already in the catalog</div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={updPrice} onChange={(e) => setUpdPrice(e.target.checked)} className="accent-[#c8102e]" /> Update shelf price from Epos Now (the till price)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={updCost} onChange={(e) => setUpdCost(e.target.checked)} className="accent-[#c8102e]" /> Update cost from Epos Now <span className="text-xs text-muted">(off: supplier invoices normally own cost)</span></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={updCat} onChange={(e) => setUpdCat(e.target.checked)} className="accent-[#c8102e]" /> Set category on products that are still Uncategorized</label>
        <p className="text-xs text-muted">Names, barcodes, aisles, pack sizes and reorder levels of existing products are never changed by this import. New products start with stock not tracked until counted.</p>
      </div>

      {plan.creates.length > 0 && (
        <details className="border border-line p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{plan.creates.length} new products</summary>
          <table className="mt-2 w-full font-mono">
            <tbody>
              {plan.creates.slice(0, 500).map((p) => (
                <tr key={p.upc} className="border-b border-line/60">
                  <td className="py-0.5 pr-2">{p.name}</td><td className="pr-2 text-muted">{p.upc}</td><td className="pr-2">{p.category}</td>
                  <td className="pr-2 text-right">{money(p.caseCost!)}</td><td className="text-right">{money(p.unitPrice!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {plan.updates.length > 0 && (
        <details className="border border-line p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{plan.updates.length} existing products will change</summary>
          <table className="mt-2 w-full font-mono">
            <tbody>
              {plan.updates.slice(0, 500).map((u) => (
                <tr key={u.id} className="border-b border-line/60">
                  <td className="py-0.5 pr-2">{u.before.name}</td>
                  <td className="pr-2">{u.unitPrice !== undefined && <>price {money(u.before.unitPrice)} → <b>{money(u.unitPrice)}</b></>}</td>
                  <td className="pr-2">{u.caseCost !== undefined && <>cost {money(u.before.caseCost)} → <b>{money(u.caseCost)}</b></>}</td>
                  <td>{u.category && <>→ {u.category}</>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <p className="text-xs text-muted">Prices are taken as Epos Now exports them (SalePriceIncTax). For zero-rated groceries that equals the shelf price; taxable items will show the tax-inclusive price.</p>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={busy || (!plan.creates.length && !plan.updates.length)} onClick={run}>
          {busy ? 'Importing…' : `Add ${plan.creates.length} · update ${plan.updates.length}`}
        </Btn>
      </div>
    </div>
  );
}

const FIELDS: (keyof ProductInput)[] = ['name', 'category', 'vendor', 'packSize', 'unitsPerCase', 'caseCost', 'unitPrice', 'aisle', 'reorderPoint', 'targetLevel'];

function CatalogImport({ data, products, onDone, onClose, toast }: { data: { rows: CatalogRow[]; errors: string[] }; products: Product[]; onDone: () => void; onClose: () => void; toast: Toast }) {
  const [busy, setBusy] = useState(false);
  const plan = useMemo(() => {
    const match = productCodeIndex(products);
    const errors = [...data.errors];
    const creates: Partial<ProductInput>[] = [];
    const updates: (Update & { before: Product; changed: string[] })[] = [];
    for (const r of data.rows) {
      const existing = match(r.upc ?? '', r.sku ?? '', ''); // SKU, then UPC; never by name for a catalog file
      if (!existing) {
        if (!r.upc || !r.name) { errors.push(`Line ${r.line}: new product needs UPC and Name.`); continue; }
        creates.push({ upc: r.upc, sku: r.sku ?? `SMA-${r.upc}`, name: r.name, category: r.category ?? 'Uncategorized', vendor: r.vendor ?? 'Unassigned',
          packSize: r.packSize ?? '', unitsPerCase: r.unitsPerCase ?? 1, caseCost: r.caseCost ?? 0, unitPrice: r.unitPrice ?? 0, aisle: r.aisle ?? '',
          reorderPoint: r.reorderPoint ?? 0, targetLevel: r.targetLevel ?? 0 });
        continue;
      }
      const u: Update = { id: existing.id };
      const changed: string[] = [];
      for (const f of FIELDS) {
        const v = r[f];
        if (v !== undefined && v !== existing[f]) { (u as Record<string, unknown>)[f] = v; changed.push(f); }
      }
      const rp = u.reorderPoint ?? existing.reorderPoint, tl = u.targetLevel ?? existing.targetLevel;
      if (tl < rp) { errors.push(`Line ${r.line}: target level ${tl} is below reorder point ${rp}.`); continue; }
      if (changed.length) updates.push({ ...u, before: existing, changed });
    }
    return { creates, updates, errors };
  }, [data, products]);

  const run = async () => {
    setBusy(true);
    try { await apply(plan.creates, plan.updates.map(({ before: _b, changed: _c, ...u }) => u), toast); onDone(); }
    catch (e) { sound.error(); toast((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-4 grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs"><Tag v="OK" label="Catalog CSV" />
        <span className="text-muted">{data.rows.length} rows · {plan.updates.length} products change · {plan.creates.length} new · {plan.errors.length} problems</span>
      </div>
      <p className="text-xs text-muted">Rows match by SKU, then UPC. Blank cells keep the current value. OnHand is ignored: stock changes only through counts, sales and deliveries.</p>
      {plan.errors.length > 0 && (
        <details open className="border border-amber-500 p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{plan.errors.length} rows skipped</summary>
          <ul className="mt-2 max-h-40 overflow-y-auto font-mono">{plan.errors.slice(0, 300).map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      )}
      {plan.updates.length > 0 && (
        <details className="border border-line p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{plan.updates.length} products will change</summary>
          <ul className="mt-2 max-h-60 overflow-y-auto font-mono">
            {plan.updates.slice(0, 500).map((u) => <li key={u.id} className={cx('border-b border-line/60 py-0.5')}>{u.before.name}: {u.changed.map((f) => `${f} ${String(u.before[f as keyof Product])} → ${String(u[f as keyof Update])}`).join(' · ')}</li>)}
          </ul>
        </details>
      )}
      {plan.creates.length > 0 && (
        <details className="border border-line p-2 text-xs">
          <summary className="cursor-pointer font-semibold">{plan.creates.length} new products</summary>
          <ul className="mt-2 max-h-40 overflow-y-auto font-mono">{plan.creates.slice(0, 500).map((p) => <li key={p.upc}>{p.upc} · {p.name}</li>)}</ul>
        </details>
      )}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={busy || (!plan.creates.length && !plan.updates.length)} onClick={run}>
          {busy ? 'Importing…' : `Add ${plan.creates.length} · update ${plan.updates.length}`}
        </Btn>
      </div>
    </div>
  );
}
