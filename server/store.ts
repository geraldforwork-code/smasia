// Inventory operations. Routes to SQL Server stored procedures when connected,
// otherwise applies the same rules to an in-memory store.
// ponytail: in-memory mode does not persist across restarts; SQL Server is the durable path.
import {
  bucketSales, HISTORY_DAYS, postSale, type PostStatus, type PostingSummary, type ProductLedger, type SalesHistory, type SalesImport, type SalesImportBody,
  alertMessage, alertSeverity, defaultUnitPrice, matchLine, unitsFromPack, CATEGORIES,
  type Alert, type AppState, type Category, type Invoice, type InvoiceDoc, type Movement, type MovementType,
  type PendingInvoice, type PresetKey, type Product, type ProductInput, type PurchaseOrder, type QueryResult, type Role, type ScanResult, type User,
} from '../src/shared.ts';
import { seedProducts, USERS } from './seed.ts';
import * as db from './sql.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const mem = {
  products: seedProducts(),
  movements: [] as Movement[],
  alerts: [] as Alert[],
  invoices: [] as Invoice[],
  purchaseOrders: [] as PurchaseOrder[],
  users: structuredClone(USERS),
  // imported EPOS daily sales; posted = units deducted from stock, status = how the line was posted (null = not posted)
  sales: [] as { productId: number; date: string; qty: number; importId: number; posted: number; status: PostStatus | null }[],
  salesImports: [] as SalesImport[],
};
let poSeq = 1;
// Mirror of SQL Server data while connected; refreshed after every write.
let live: Omit<AppState, 'pending' | 'sql'> | null = null;
// ponytail: invoices awaiting GM approval live in process memory only; move to dbo.Invoices.Status='PENDING' if they must survive restarts.
const pending: PendingInvoice[] = [];
let seq = 1;

const data = () => (db.sqlLive() && live ? live : mem);
export const reload = async () => { live = db.sqlLive() ? await db.sqlLoad() : null; };

export const getState = (): AppState => {
  const d = data();
  return { ...d, movements: d.movements.slice(0, 200), alerts: d.alerts.slice(0, 100), pending, sql: db.sqlStatus() };
};
export const findUser = (id: number) => data().users.find((u) => u.id === id);

/** Map SQL Server THROW numbers to HTTP statuses. */
async function viaSql<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    await reload();
    return r;
  } catch (e) {
    const n = (e as { number?: number }).number ?? 0;
    const msg = (e as Error).message.replace(/^(\[[^\]]*\])+\s*/, ''); // drop "[Microsoft][ODBC Driver 18…][SQL Server]"
    if (n >= 50000) throw new HttpError(n === 50404 ? 404 : n === 50409 || n === 50410 || n === 50411 ? 409 : 400, msg);
    throw e;
  }
}

function memMove(p: Product, type: MovementType, after: number, user: User, ref: string | null) {
  const before = p.onHand;
  p.onHand = after;
  mem.movements.unshift({
    id: seq++, ts: new Date().toISOString(), productId: p.id, upc: p.upc, name: p.name,
    type, qty: after - before, before, after, user: user.name, ref,
  });
  const severity = alertSeverity(before, after, p.reorderPoint);
  if (!severity) return null;
  const alert: Alert = {
    id: seq++, ts: new Date().toISOString(), productId: p.id, upc: p.upc, name: p.name, severity,
    onHand: after, reorderPoint: p.reorderPoint, message: alertMessage(p.name, after, p.reorderPoint), ack: false,
  };
  mem.alerts.unshift(alert);
  return alert;
}

const positiveInt = (n: unknown, what: string) => {
  if (!Number.isInteger(n) || (n as number) <= 0) throw new HttpError(400, `${what} must be a positive whole number.`);
  return n as number;
};

/** SALE deducts eaches; INTAKE adds cases. */
export async function scan(code: string, mode: 'SALE' | 'INTAKE', qty: number, user: User): Promise<ScanResult> {
  code = String(code ?? '').trim();
  positiveInt(qty, 'Quantity');
  if (db.sqlLive()) {
    const r = await viaSql(() => db.sqlScan(code, mode, qty, user.id));
    const d = data();
    return {
      product: d.products.find((p) => p.id === r.ProductId)!, before: r.QtyBefore, after: r.QtyAfter,
      alert: r.AlertId ? d.alerts.find((a) => a.id === r.AlertId) ?? null : null,
    };
  }
  const p = mem.products.find((x) => x.upc === code || x.sku === code);
  if (!p) throw new HttpError(404, 'Unknown barcode.');
  const delta = mode === 'SALE' ? -qty : qty * p.unitsPerCase;
  if (p.onHand + delta < 0) throw new HttpError(409, 'Insufficient stock on hand. Run a cycle count.');
  const before = p.onHand;
  const alert = memMove(p, mode === 'SALE' ? 'SCAN_SALE' : 'INVOICE_INTAKE', before + delta, user, null);
  return { product: p, before, after: p.onHand, alert };
}

export async function adjust(productId: number, newOnHand: number, type: 'CYCLE_COUNT' | 'ADJUSTMENT', reason: string, user: User) {
  if (!Number.isInteger(newOnHand) || newOnHand < 0) throw new HttpError(400, 'On-hand count must be a whole number ≥ 0.');
  if (type !== 'CYCLE_COUNT' && type !== 'ADJUSTMENT') throw new HttpError(400, 'Invalid adjustment type.');
  const ref = String(reason ?? '').slice(0, 60) || null;
  if (db.sqlLive()) return viaSql(() => db.sqlAdjust(productId, newOnHand, type, user.id, ref));
  const p = mem.products.find((x) => x.id === productId);
  if (!p) throw new HttpError(404, 'Unknown product.');
  memMove(p, type, newOnHand, user, ref);
}

function validateDoc(doc: InvoiceDoc) {
  if (!doc?.invoiceNo?.trim()) throw new HttpError(400, 'Invoice number is required.');
  if (!doc.vendor?.trim()) throw new HttpError(400, 'Vendor is required.');
  if (!Array.isArray(doc.lines) || !doc.lines.length) throw new HttpError(400, 'Invoice has no line items.');
  doc.lines.forEach((l, i) => {
    positiveInt(l.qty, `Line ${i + 1} quantity`);
    if (!(l.unitCost >= 0)) throw new HttpError(400, `Line ${i + 1} cost is invalid.`);
    if (!l.description?.trim()) throw new HttpError(400, `Line ${i + 1} description is missing.`);
  });
  if (data().invoices.some((v) => v.invoiceNo === doc.invoiceNo.trim()))
    throw new HttpError(409, `Invoice ${doc.invoiceNo} has already been ingested.`);
  if (doc.poNo && !data().purchaseOrders.some((po) => po.poNo === doc.poNo && po.status === 'OPEN'))
    throw new HttpError(409, `Purchase order ${doc.poNo} is not open (already received or cancelled).`);
}

/** Normalize invoice lines into catalog terms: existing UPC, or a new in-store code for UPC-less lines. */
function resolveLines(doc: InvoiceDoc): db.IngestLine[] {
  const stamp = Date.now() % 1e9;
  return doc.lines.map((l, i) => {
    const existing = matchLine(data().products, l);
    const upc = existing?.upc ?? (l.upc.trim() || `21${String(stamp + i).padStart(10, '0')}`);
    const unitsPerCase = existing?.unitsPerCase ?? unitsFromPack(l.packSize);
    const category: Category = existing?.category ?? (CATEGORIES.includes(l.category!) ? l.category! : 'Dry Goods');
    return {
      upc, sku: existing?.sku ?? `SMA-${upc}`, description: l.description.trim(), packSize: l.packSize,
      unitsPerCase, qtyCases: l.qty, caseCost: l.unitCost,
      unitPrice: existing?.unitPrice ?? defaultUnitPrice(l.unitCost, unitsPerCase), category,
    };
  });
}

export async function ingest(doc: InvoiceDoc, user: User) {
  validateDoc(doc);
  const lines = resolveLines(doc);
  const head = { vendor: doc.vendor.trim(), invoiceNo: doc.invoiceNo.trim(), date: doc.date, total: +doc.total || 0, pages: doc.pages, poNo: doc.poNo || undefined };
  if (db.sqlLive()) return viaSql(() => db.sqlIngest(head, lines, user.id));

  // Validation is done; apply all lines (single-threaded, so this is atomic).
  for (const l of lines) {
    let p = mem.products.find((x) => x.upc === l.upc);
    if (!p) {
      p = {
        id: Math.max(...mem.products.map((x) => x.id)) + 1, upc: l.upc, sku: l.sku, name: l.description,
        category: l.category as Category, vendor: head.vendor, packSize: l.packSize, unitsPerCase: l.unitsPerCase,
        caseCost: l.caseCost, unitPrice: l.unitPrice, aisle: 'RCV', onHand: 0,
        reorderPoint: l.unitsPerCase, targetLevel: l.unitsPerCase * 3,
      };
      mem.products.push(p);
    }
    p.caseCost = l.caseCost;
    memMove(p, 'INVOICE_INTAKE', p.onHand + l.qtyCases * p.unitsPerCase, user, `INV ${head.invoiceNo}${head.poNo ? ` / ${head.poNo}` : ''}`);
  }
  const po = mem.purchaseOrders.find((x) => x.poNo === head.poNo);
  if (po) Object.assign(po, { status: 'RECEIVED', receivedInvoiceNo: head.invoiceNo });
  mem.invoices.unshift({ ...doc, ...head, id: seq++, receivedAt: new Date().toISOString(), receivedBy: user.name });
}

// --- catalog ----------------------------------------------------------------------------

function cleanProduct(raw: Partial<ProductInput>, i: number): ProductInput {
  const at = i >= 0 ? `Item ${i + 1}: ` : '';
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  const money = (v: unknown, what: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new HttpError(400, `${at}${what} is invalid.`);
    return Math.round(n * 100) / 100;
  };
  const int = (v: unknown, what: string, min: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${at}${what} must be a whole number ≥ ${min}.`);
    return n;
  };
  const p: ProductInput = {
    upc: str(raw.upc, 20), sku: str(raw.sku, 32), name: str(raw.name, 200), vendor: str(raw.vendor, 100) || 'Unassigned',
    packSize: str(raw.packSize, 50), aisle: str(raw.aisle, 10), category: raw.category as Category,
    unitsPerCase: int(raw.unitsPerCase, 'Units per case', 1), caseCost: money(raw.caseCost, 'Case cost'),
    unitPrice: money(raw.unitPrice, 'Price'), reorderPoint: int(raw.reorderPoint ?? 0, 'Reorder point', 0),
    targetLevel: int(raw.targetLevel ?? 0, 'Target level', 0),
  };
  if (!p.name) throw new HttpError(400, `${at}Name is required.`);
  if (!CATEGORIES.includes(p.category)) throw new HttpError(400, `${at}Unknown category.`);
  if (p.targetLevel < p.reorderPoint) throw new HttpError(400, `${at}Target level must be at least the reorder point.`);
  return p;
}

/** Create products that don't exist yet (by UPC or SKU). Stock starts at 0; levels default to 0 = not tracked. */
export async function createProducts(items: Partial<ProductInput>[]) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'No products to create.');
  if (items.length > 20_000) throw new HttpError(413, 'Create at most 20,000 products at a time.');
  const seen = new Set<string>();
  const clean = items.map((raw, i) => {
    const p = cleanProduct({ reorderPoint: 0, targetLevel: 0, ...raw }, i);
    if (!/^[0-9A-Za-z-]{4,20}$/.test(p.upc)) throw new HttpError(400, `Item ${i + 1}: barcode "${p.upc}" is invalid.`);
    if (!p.sku) throw new HttpError(400, `Item ${i + 1}: SKU is required.`);
    return p;
  }).filter((p) => {
    const dup = seen.has(p.upc) || seen.has(p.sku);
    seen.add(p.upc); seen.add(p.sku);
    return !dup;
  });
  if (db.sqlLive()) return { created: await viaSql(() => db.sqlCreateProducts(clean)) };
  let created = 0;
  for (const p of clean) {
    if (mem.products.some((x) => x.upc === p.upc || x.sku === p.sku)) continue;
    mem.products.push({ ...p, id: Math.max(0, ...mem.products.map((x) => x.id)) + 1, onHand: 0 });
    created++;
  }
  return { created };
}

/** Bulk edit: each item is {id, ...fields to change}; unspecified fields keep their current values. Stock is untouched. */
export async function bulkUpdateProducts(items: (Partial<ProductInput> & { id: number })[]) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'No products to update.');
  if (items.length > 20_000) throw new HttpError(413, 'Update at most 20,000 products at a time.');
  const byId = new Map(data().products.map((p) => [p.id, p]));
  const merged = new Map<number, ProductInput & { id: number }>();
  items.forEach((raw, i) => {
    const existing = byId.get(Number(raw.id));
    if (!existing) throw new HttpError(404, `Item ${i + 1}: unknown product.`);
    const { upc: _u, sku: _s, ...changes } = raw;
    merged.set(existing.id, { id: existing.id, ...cleanProduct({ ...existing, ...(merged.get(existing.id) ?? {}), ...changes }, i) });
  });
  const rows = [...merged.values()];
  if (db.sqlLive()) return { updated: await viaSql(() => db.sqlBulkUpdateProducts(rows.map(({ upc: _u, sku: _s, ...r }) => r))) };
  for (const r of rows) { const { upc: _u, sku: _s, id, ...fields } = r; Object.assign(byId.get(id)!, fields); }
  return { updated: rows.length };
}

export async function updateProduct(id: number, raw: Partial<ProductInput>) {
  const existing = data().products.find((p) => p.id === id);
  if (!existing) throw new HttpError(404, 'Unknown product.');
  const p = cleanProduct({ ...existing, ...raw, upc: existing.upc, sku: existing.sku }, -1);
  if (db.sqlLive()) return viaSql(() => db.sqlUpdateProduct(id, p));
  Object.assign(existing, p);
}

// --- purchase orders ----------------------------------------------------------------

export async function createPo(
  body: { vendor?: string; expectedDate?: string | null; notes?: string | null; lines?: { productId: number; qty: number }[] }, user: User,
) {
  const vendor = String(body.vendor ?? '').trim();
  if (!vendor) throw new HttpError(400, 'Vendor is required.');
  if (!Array.isArray(body.lines) || !body.lines.length) throw new HttpError(400, 'Purchase order has no lines.');
  const lines = body.lines.map((l, i) => {
    const product = data().products.find((p) => p.id === Number(l.productId));
    if (!product) throw new HttpError(404, `Line ${i + 1}: unknown product.`);
    return { product, qty: positiveInt(Number(l.qty), `Line ${i + 1} quantity`) };
  });
  const head = {
    vendor, expectedDate: /^\d{4}-\d{2}-\d{2}$/.test(body.expectedDate ?? '') ? body.expectedDate! : null,
    notes: String(body.notes ?? '').trim().slice(0, 300) || null,
  };
  if (db.sqlLive()) return viaSql(() => db.sqlCreatePo(head, lines.map((l) => ({ productId: l.product.id, qty: l.qty })), user.id));

  const po: PurchaseOrder = {
    id: poSeq, poNo: `PO-104-${String(poSeq++).padStart(5, '0')}`, status: 'OPEN', createdAt: new Date().toISOString(),
    createdBy: user.name, receivedInvoiceNo: null, ...head,
    lines: lines.map(({ product: p, qty }) => ({ productId: p.id, upc: p.upc, description: p.name, packSize: p.packSize, qty, unitCost: p.caseCost })),
  };
  mem.purchaseOrders.unshift(po);
  return { id: po.id, poNo: po.poNo };
}

export async function cancelPo(id: number) {
  const po = data().purchaseOrders.find((x) => x.id === id);
  if (!po) throw new HttpError(404, 'Purchase order not found.');
  if (po.status !== 'OPEN') throw new HttpError(409, `${po.poNo} is already ${po.status.toLowerCase()}.`);
  if (db.sqlLive()) return viaSql(() => db.sqlCancelPo(id));
  po.status = 'CANCELLED';
}

export function stage(doc: InvoiceDoc, user: User) {
  validateDoc(doc);
  if (pending.some((p) => p.doc.invoiceNo === doc.invoiceNo)) throw new HttpError(409, 'Invoice is already awaiting approval.');
  pending.unshift({ id: seq++, doc, stagedBy: user.name, stagedAt: new Date().toISOString() });
}

export async function approve(id: number, user: User) {
  const i = pending.findIndex((p) => p.id === id);
  if (i < 0) throw new HttpError(404, 'Pending invoice not found.');
  await ingest(pending[i].doc, user);
  pending.splice(i, 1);
}

export function reject(id: number) {
  const i = pending.findIndex((p) => p.id === id);
  if (i < 0) throw new HttpError(404, 'Pending invoice not found.');
  pending.splice(i, 1);
}

export async function ack(id: number | null) {
  if (db.sqlLive()) return viaSql(() => db.sqlAck(id));
  mem.alerts.forEach((a) => { if (id === null || a.id === id) a.ack = true; });
}

export async function setRole(id: number, role: Role) {
  if (!['ADMIN', 'CLERK', 'CASHIER'].includes(role)) throw new HttpError(400, 'Invalid role.');
  const users = data().users;
  if (!users.some((u) => u.id === id)) throw new HttpError(404, 'Unknown employee.');
  if (role !== 'ADMIN' && users.filter((u) => u.role === 'ADMIN' && u.id !== id).length === 0)
    throw new HttpError(409, 'At least one Store Admin is required.');
  if (db.sqlLive()) return viaSql(() => db.sqlSetRole(id, role));
  mem.users.find((u) => u.id === id)!.role = role;
}

// --- forecast ------------------------------------------------------------------------

/** Stock card: all movements for one product (newest first) and its imported Epos Now daily sales. */
export async function productLedger(productId: number): Promise<ProductLedger> {
  if (!data().products.some((p) => p.id === productId)) throw new HttpError(404, 'Unknown product.');
  let movements: Movement[], sales: ProductLedger['sales'];
  if (db.sqlLive()) ({ movements, sales } = await db.sqlProductLedger(productId));
  else {
    movements = mem.movements.filter((m) => m.productId === productId);
    const files = new Map(mem.salesImports.map((i) => [i.id, i.fileName]));
    sales = mem.sales.filter((s) => s.productId === productId).sort((a, b) => b.date.localeCompare(a.date))
      .map((s) => ({ date: s.date, qty: s.qty, fileName: files.get(s.importId) ?? 'import', posted: s.posted, status: s.status }));
  }
  return { movements: movements.slice(0, db.LEDGER_LIMIT), sales, truncated: movements.length > db.LEDGER_LIMIT };
}

/** Forecast demand = in-app POS scans + imported EPOS sales reports. */
export async function salesHistory(): Promise<SalesHistory> {
  let rows: { productId: number; ts: string | Date; units: number }[], firstAt: Date | null, firstSaleDate: string | null, imports: SalesImport[];
  if (db.sqlLive()) ({ rows, firstAt, firstSaleDate, imports } = await db.sqlSalesHistory());
  else {
    rows = [
      ...mem.movements.filter((m) => m.type === 'SCAN_SALE').map((m) => ({ productId: m.productId, ts: m.ts, units: -m.qty })),
      ...mem.sales.map((s) => ({ productId: s.productId, ts: s.date, units: s.qty })),
    ];
    firstAt = mem.movements.length ? new Date(mem.movements[mem.movements.length - 1].ts) : null;
    firstSaleDate = mem.sales.reduce<string | null>((min, s) => (!min || s.date < min ? s.date : min), null);
    imports = mem.salesImports;
  }
  const today = new Date();
  const fromSales = firstSaleDate ? new Date(+firstSaleDate.slice(0, 4), +firstSaleDate.slice(5, 7) - 1, +firstSaleDate.slice(8, 10)) : null;
  const start = [firstAt, fromSales].filter((d): d is Date => !!d).sort((a, b) => +a - +b)[0] ?? today;
  const spanDays = Math.min(HISTORY_DAYS,
    Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86_400_000) + 1);
  return { spanDays, series: bucketSales(rows, today), imports };
}

const isoDate = (s: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null;
};

/** Import an EPOS sales report (already matched to products client-side). Replaces earlier imports for the same dates. */
export async function importSales(b: SalesImportBody, user: User) {
  const from = isoDate(b?.periodFrom), to = isoDate(b?.periodTo);
  if (!from || !to || to < from) throw new HttpError(400, 'Enter a valid report period (from ≤ to).');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw new HttpError(400, 'Import at most ~13 months per report.');
  if (!Array.isArray(b.rows) || !b.rows.length) throw new HttpError(400, 'No matched sales rows to import.');
  if (b.rows.length > 250_000) throw new HttpError(413, 'Report is too large; split it by month.');
  const ids = new Set(data().products.map((p) => p.id));
  const totals = new Map<string, { productId: number; date: string; qty: number }>();
  b.rows.forEach((r, i) => {
    const date = isoDate(r.date);
    if (!ids.has(Number(r.productId))) throw new HttpError(400, `Row ${i + 1}: unknown product.`);
    if (!date || date < from || date > to) throw new HttpError(400, `Row ${i + 1}: date ${r.date} is outside ${from} → ${to}.`);
    if (!Number.isFinite(r.qty) || Math.abs(r.qty) > 1e6) throw new HttpError(400, `Row ${i + 1}: quantity is invalid.`);
    const k = `${r.productId}|${date}`;
    const t = totals.get(k) ?? { productId: Number(r.productId), date, qty: 0 };
    t.qty = Math.round((t.qty + r.qty) * 1000) / 1000;
    totals.set(k, t);
  });
  // Oldest day first so several days of one product deduct cumulatively; dayEndUtc = local midnight after the sales day.
  const rows = [...totals.values()].sort((a, b) => a.date.localeCompare(b.date) || a.productId - b.productId)
    .map((r) => ({ ...r, dayEndUtc: new Date(+r.date.slice(0, 4), +r.date.slice(5, 7) - 1, +r.date.slice(8, 10) + 1).toISOString() }));
  const clean = { fileName: String(b.fileName ?? 'sales.csv').slice(0, 260), periodFrom: from, periodTo: to, rows, post: b.post === true };
  if (db.sqlLive()) return viaSql(() => db.sqlImportSales(clean, user.id));

  // Undo earlier postings for the replaced dates, then post (mirrors sp_ImportSalesHistory).
  reversePostings(mem.sales.filter((s) => s.date >= from && s.date <= to), user, 'EPOS re-import: earlier posting reversed');
  const posted = rows.map((r) => {
    if (!clean.post) return { ...r, posted: 0, status: null };
    const p = mem.products.find((x) => x.id === r.productId)!;
    const counted = mem.movements.some((m) => m.productId === p.id && m.type === 'CYCLE_COUNT' && m.ts >= r.dayEndUtc);
    const { deduct, status } = postSale(r.qty, p.onHand, p.targetLevel, counted);
    if (deduct) memMove(p, 'EPOS_SALE', p.onHand - deduct, user, `EPOS ${r.date}${status === 'SHORT' ? ` · short ${r.qty - deduct}` : ''}`);
    return { ...r, posted: deduct, status };
  });
  const importId = seq++;
  mem.sales = mem.sales.filter((s) => s.date < from || s.date > to)
    .concat(posted.map(({ productId, date, qty, posted: q, status }) => ({ productId, date, qty, importId, posted: q, status })));
  mem.salesImports.unshift({
    id: importId, fileName: clean.fileName, periodFrom: from, periodTo: to, rows: rows.length,
    units: rows.reduce((s, r) => s + r.qty, 0), importedBy: user.name, importedAt: new Date().toISOString(),
  });
  const summary = new Map<PostStatus, PostingSummary>();
  for (const r of posted) if (r.status) {
    const t = summary.get(r.status) ?? { status: r.status, lines: 0, sold: 0, posted: 0 };
    t.lines++; t.sold += r.qty; t.posted += r.posted;
    summary.set(r.status, t);
  }
  return [...summary.values()];
}

/** Delete one sales import (or all when id is null): add back the stock it deducted, then remove its lines. */
export async function deleteSalesImport(id: number | null, user: User) {
  if (id !== null && !Number.isInteger(id)) throw new HttpError(400, 'Invalid import id.');
  if (db.sqlLive()) return viaSql(() => db.sqlDeleteSalesImport(id, user.id));
  if (id !== null && !mem.salesImports.some((i) => i.id === id)) throw new HttpError(404, 'Sales import not found.');
  const gone = mem.sales.filter((s) => id === null || s.importId === id);
  const unitsRestored = reversePostings(gone, user, id === null ? 'EPOS imports deleted: posting reversed' : `EPOS import #${id} deleted: posting reversed`);
  mem.sales = mem.sales.filter((s) => !(id === null || s.importId === id));
  mem.salesImports = mem.salesImports.filter((i) => !(id === null || i.id === id));
  return { linesDeleted: gone.length, unitsRestored };
}

/** Add back stock that sales lines deducted, unless a shelf count since that import already reset the product. */
function reversePostings(lines: typeof mem.sales, user: User, ref: string) {
  const importedAt = new Map(mem.salesImports.map((i) => [i.id, i.importedAt]));
  const countedSince = (pid: number, at = '') => mem.movements.some((m) => m.productId === pid && m.type === 'CYCLE_COUNT' && m.ts >= at);
  const back = new Map<number, number>();
  for (const s of lines) if (s.posted !== 0 && !countedSince(s.productId, importedAt.get(s.importId))) back.set(s.productId, (back.get(s.productId) ?? 0) + s.posted);
  let restored = 0;
  for (const [pid, qty] of back) {
    const p = mem.products.find((x) => x.id === pid)!;
    restored += qty;
    const after = Math.max(0, p.onHand + qty);
    if (after !== p.onHand) memMove(p, 'EPOS_SALE', after, user, ref);
  }
  return restored;
}

// --- query console ------------------------------------------------------------

const memPresets: Record<PresetKey, () => Record<string, unknown>[]> = {
  low_stock: () =>
    mem.products.filter((p) => p.targetLevel > 0 && p.onHand <= p.reorderPoint)
      .sort((a, b) => a.onHand / a.reorderPoint - b.onHand / b.reorderPoint || a.name.localeCompare(b.name))
      .map((p) => ({ UPC: p.upc, Name: p.name, Aisle: p.aisle, OnHand: p.onHand, ReorderPoint: p.reorderPoint, TargetLevel: p.targetLevel, Deficit: p.targetLevel - p.onHand })),
  category_valuation: () =>
    CATEGORIES.map((c) => {
      const ps = mem.products.filter((p) => p.category === c);
      return {
        Category: c, SKUs: ps.length, UnitsOnHand: ps.reduce((s, p) => s + p.onHand, 0),
        CostValueCAD: +ps.reduce((s, p) => s + (p.onHand * p.caseCost) / p.unitsPerCase, 0).toFixed(2),
        RetailValueCAD: +ps.reduce((s, p) => s + p.onHand * p.unitPrice, 0).toFixed(2),
      };
    }).filter((r) => r.SKUs).sort((a, b) => b.CostValueCAD - a.CostValueCAD),
  recent_movements: () =>
    mem.movements.slice(0, 25).map((m) => ({
      CreatedAt: m.ts, MovementType: m.type, UPC: m.upc, Name: m.name, QtyDelta: m.qty,
      QtyBefore: m.before, QtyAfter: m.after, Employee: m.user, Reference: m.ref,
    })),
  active_alerts: () =>
    mem.alerts.filter((a) => !a.ack).map((a) => ({
      AlertId: a.id, CreatedAt: a.ts, Severity: a.severity, UPC: a.upc, Name: a.name,
      OnHand: a.onHand, ReorderPoint: a.reorderPoint, Message: a.message,
    })),
};

export async function runQuery(text: string, preset?: string): Promise<QueryResult> {
  if (db.sqlStatus().connected) {
    try { return await db.sqlQuery(text); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  const fn = memPresets[preset as PresetKey];
  if (!fn) throw new HttpError(503, 'SQL Server is not connected. Only the preset queries run against the in-memory store; connect under T-SQL Hub → Connection to run ad-hoc T-SQL.');
  const t = performance.now();
  const rows = fn();
  return { columns: Object.keys(rows[0] ?? {}), rows, ms: +(performance.now() - t).toFixed(2), mode: 'IN_MEMORY' };
}
