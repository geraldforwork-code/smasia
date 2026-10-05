// Types and pure business rules shared by the Express server and the React client.

export const CATEGORIES = [
  'Snacks & Confectionery',
  'Sauces & Condiments',
  'Canned & Preserved',
  'Frozen & Seafood',
  'Beverages',
  'Dry Goods',
  'Uncategorized',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Role = 'ADMIN' | 'CLERK' | 'CASHIER';
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Store Admin / General Manager',
  CLERK: 'Inventory Clerk / Warehouse Lead',
  CASHIER: 'Cashier / Floor Staff',
};

export const PERMISSIONS = {
  dashboard: { label: 'Executive dashboard & valuation reports', roles: ['ADMIN'] },
  invoices: { label: 'Receiving dock: parse & stage vendor invoices', roles: ['ADMIN', 'CLERK'] },
  invoiceApprove: { label: 'Approve invoice intake into inventory', roles: ['ADMIN'] },
  sqlHub: { label: 'T-SQL Hub, query runner & connection config', roles: ['ADMIN'] },
  users: { label: 'Employee role management', roles: ['ADMIN'] },
  pushConfig: { label: 'Push notification configuration', roles: ['ADMIN'] },
  scanSale: { label: 'POS checkout scan (deduct stock)', roles: ['ADMIN', 'CASHIER'] },
  scanIntake: { label: 'Intake / restock scan (add stock)', roles: ['ADMIN', 'CLERK'] },
  lookup: { label: 'Price check & stock availability lookup', roles: ['ADMIN', 'CLERK', 'CASHIER'] },
  adjust: { label: 'Cycle counts & shelf adjustments', roles: ['ADMIN', 'CLERK'] },
  movements: { label: 'Stock movement audit log', roles: ['ADMIN', 'CLERK'] },
  purchaseOrders: { label: 'View & receive purchase orders', roles: ['ADMIN', 'CLERK'] },
  poCreate: { label: 'Create & cancel purchase orders', roles: ['ADMIN'] },
  forecast: { label: 'Demand forecast & stockout projection', roles: ['ADMIN', 'CLERK'] },
  salesImport: { label: 'Import EPOS sales reports', roles: ['ADMIN'] },
  catalog: { label: 'Create & edit products (price, category, reorder levels)', roles: ['ADMIN'] },
  labels: { label: 'Print shelf barcode labels', roles: ['ADMIN', 'CLERK'] },
} as const satisfies Record<string, { label: string; roles: readonly Role[] }>;
export type Perm = keyof typeof PERMISSIONS;
export const can = (role: Role, perm: Perm) => (PERMISSIONS[perm].roles as readonly Role[]).includes(role);

export interface User { id: number; name: string; role: Role; title: string }

export interface Product {
  id: number;
  upc: string;
  sku: string;
  name: string;
  category: Category;
  vendor: string;
  packSize: string;
  unitsPerCase: number;
  caseCost: number; // CAD per case
  unitPrice: number; // CAD retail per each
  aisle: string;
  onHand: number; // eaches
  reorderPoint: number; // eaches
  targetLevel: number; // eaches
}

export type MovementType = 'SCAN_SALE' | 'EPOS_SALE' | 'INVOICE_INTAKE' | 'CYCLE_COUNT' | 'ADJUSTMENT';
export interface Movement {
  id: number;
  ts: string;
  productId: number;
  upc: string;
  name: string;
  type: MovementType;
  qty: number; // signed delta, eaches
  before: number;
  after: number;
  user: string;
  ref: string | null;
}

export type Severity = 'WARNING' | 'CRITICAL';
export interface Alert {
  id: number;
  ts: string;
  productId: number;
  upc: string;
  name: string;
  severity: Severity;
  onHand: number;
  reorderPoint: number;
  message: string;
  ack: boolean;
}

export interface InvoiceLine {
  upc: string;
  description: string;
  packSize: string;
  qty: number; // cases
  unitCost: number; // CAD per case
  category?: Category;
}
export interface InvoiceDoc {
  vendor: string;
  invoiceNo: string;
  date: string;
  total: number;
  pages?: number;
  lines: InvoiceLine[];
  /** Set when this receipt fulfils an open purchase order. */
  poNo?: string;
}

export type PoStatus = 'OPEN' | 'RECEIVED' | 'CANCELLED';
export interface PoLine { productId: number; upc: string; description: string; packSize: string; qty: number /* cases */; unitCost: number /* per case */ }
export interface PurchaseOrder {
  id: number;
  poNo: string;
  vendor: string;
  status: PoStatus;
  createdAt: string;
  createdBy: string;
  expectedDate: string | null;
  notes: string | null;
  receivedInvoiceNo: string | null;
  lines: PoLine[];
}
export const poTotal = (po: PurchaseOrder) => po.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
/** Cases already ordered on open POs. */
export const onOrderCases = (pos: PurchaseOrder[], productId: number) =>
  pos.filter((po) => po.status === 'OPEN').reduce((s, po) => s + po.lines.filter((l) => l.productId === productId).reduce((t, l) => t + l.qty, 0), 0);
/** Cases still needed to reach target after counting what's on order (0 when above reorder point). */
export const reorderCases = (p: Product, pos: PurchaseOrder[]) =>
  p.targetLevel === 0 || p.onHand > p.reorderPoint ? 0 : Math.max(0, Math.ceil((p.targetLevel - p.onHand) / p.unitsPerCase) - onOrderCases(pos, p.id));
export interface Invoice extends InvoiceDoc { id: number; receivedAt: string; receivedBy: string }
export interface PendingInvoice { id: number; doc: InvoiceDoc; stagedBy: string; stagedAt: string }

export interface SqlStatus {
  mode: 'MSSQL' | 'IN_MEMORY';
  connected: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  schemaReady: boolean;
  latencyMs: number | null;
  version: string | null;
  error: string | null;
  checkedAt: string;
}

export interface AppState {
  products: Product[];
  movements: Movement[];
  alerts: Alert[];
  invoices: Invoice[];
  pending: PendingInvoice[];
  purchaseOrders: PurchaseOrder[];
  users: User[];
  sql: SqlStatus;
}

export interface ScanResult { product: Product; before: number; after: number; alert: Alert | null }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; ms: number; mode: SqlStatus['mode'] }

// --- rules -----------------------------------------------------------------

/** "50/400g", "24x78g", "12 / 900g" -> 50, 24, 12. Anything else is a single unit. */
export const unitsFromPack = (pack: string) => {
  const m = /^\s*(\d+)\s*[\/x×]/i.exec(pack ?? '');
  return m ? Math.max(1, +m[1]) : 1;
};

/** Mirrors dbo.trg_CheckLowStock: fire only when stock crosses the threshold or hits zero. */
export const alertSeverity = (before: number, after: number, reorderPoint: number): Severity | null =>
  after === 0 && before > 0 ? 'CRITICAL' : after <= reorderPoint && before > reorderPoint ? 'WARNING' : null;

export const alertMessage = (name: string, onHand: number, reorderPoint: number) =>
  onHand === 0
    ? `${name} is depleted (0 on hand)`
    : `${name} at ${onHand} units, at/below reorder point ${reorderPoint}`;

/** Retail for a product first seen on an invoice: 40% markup, rounded up to the next .24/.49/.74/.99. */
export const defaultUnitPrice = (caseCost: number, unitsPerCase: number) =>
  +Math.max(0.99, Math.ceil((caseCost / unitsPerCase) * 1.4 * 4) / 4 - 0.01).toFixed(2);

// --- demand forecast ---------------------------------------------------------------

export const HISTORY_DAYS = 28;
/** Units sold per local day for the last HISTORY_DAYS days (index 0 = oldest, last = today). */
export interface SalesHistory { spanDays: number; series: Record<number, number[]>; imports: SalesImport[] }

/** Stock card for one product: every movement (newest first) plus imported Epos Now daily sales. */
export interface ProductLedger {
  movements: Movement[];
  sales: { date: string; qty: number; fileName: string; posted: number; status: PostStatus | null }[];
  truncated: boolean; // more movements exist than were returned
}

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  SCAN_SALE: 'POS checkout sale',
  EPOS_SALE: 'Epos Now till sale',
  INVOICE_INTAKE: 'Received (invoice / PO / restock)',
  CYCLE_COUNT: 'Cycle count correction',
  ADJUSTMENT: 'Shelf adjustment',
};
/**
 * Totals for movements on/after `since` (all when null). Movements arrive newest first.
 * Opening = stock before the oldest movement in the period; closing = stock after the newest (or current stock if none).
 */
export function summarizeLedger(movements: Movement[], currentOnHand: number, since: string | null) {
  const inPeriod = since ? movements.filter((m) => m.ts >= since) : movements;
  const by = (sign: 1 | -1) => {
    const t: Partial<Record<MovementType, number>> = {};
    for (const m of inPeriod) if (Math.sign(m.qty) === sign) t[m.type] = (t[m.type] ?? 0) + Math.abs(m.qty);
    return t;
  };
  const totalIn = inPeriod.filter((m) => m.qty > 0).reduce((s, m) => s + m.qty, 0);
  const totalOut = inPeriod.filter((m) => m.qty < 0).reduce((s, m) => s - m.qty, 0);
  return {
    movements: inPeriod, inByType: by(1), outByType: by(-1), totalIn, totalOut,
    opening: inPeriod.length ? inPeriod[inPeriod.length - 1].before : currentOnHand,
    closing: inPeriod.length ? inPeriod[0].after : currentOnHand,
  };
}

/** One uploaded EPOS sales report. Its period replaces any earlier import for the same dates. */
export interface SalesImport { id: number; fileName: string; periodFrom: string; periodTo: string; rows: number; units: number; importedBy: string; importedAt: string }
export interface SalesImportBody {
  fileName: string; periodFrom: string; periodTo: string; rows: { productId: number; date: string; qty: number }[];
  /** Also deduct the sales from stock on hand as EPOS_SALE movements. */
  post?: boolean;
}

/**
 * What happened to each imported sales line when posting to stock:
 * POSTED deducted · SHORT deducted to 0 (sold more than on hand: count needed) · BEFORE_COUNT sale predates the
 * latest shelf count, which already reflects it · UNTRACKED levels not set · WEIGHED sold by weight, stock is in eaches.
 */
export type PostStatus = 'POSTED' | 'SHORT' | 'BEFORE_COUNT' | 'UNTRACKED' | 'WEIGHED';
export const POST_LABEL: Record<PostStatus, string> = {
  POSTED: 'Deducted', SHORT: 'Short: count needed', BEFORE_COUNT: 'Before last count', UNTRACKED: 'Not tracked', WEIGHED: 'Weighed item',
};
export interface PostingSummary { status: PostStatus; lines: number; sold: number; posted: number }

/** Decide how much of a day's till sales to deduct (shared rule; SQL Server mirrors it in sp_ImportSalesHistory). */
export function postSale(qty: number, onHand: number, targetLevel: number, countedAfterSale: boolean): { deduct: number; status: PostStatus } {
  if (targetLevel === 0) return { deduct: 0, status: 'UNTRACKED' };
  if (!Number.isInteger(qty)) return { deduct: 0, status: 'WEIGHED' };
  if (countedAfterSale) return { deduct: 0, status: 'BEFORE_COUNT' };
  if (qty < 0) return { deduct: qty, status: 'POSTED' }; // net refund puts stock back
  const deduct = Math.min(qty, onHand);
  return { deduct, status: deduct < qty ? 'SHORT' : 'POSTED' };
}

export interface Forecast {
  product: Product;
  daily: number[];
  sold7: number;
  sold28: number;
  perDay: number; // forecast eaches/day
  daysOfCover: number | null; // null = no sales, never runs out at current rate
  stockoutDate: string | null; // YYYY-MM-DD
  demand: number; // eaches over the horizon
  onOrder: number; // cases on open POs
  needCases: number;
  lowData: boolean; // fewer than 7 days of store history
}

/**
 * Weighted moving average: 60% last-7-day rate + 40% last-28-day rate, divided by the days the store has actually
 * been recording (spanDays), so a new install doesn't read as slow sales.
 * Order = horizon demand + reorder point (safety stock) − on hand − on order, rounded up to whole cases.
 * ponytail: no day-of-week or seasonal factors; add them once there is a year of history.
 */
export function forecast(p: Product, daily: number[], spanDays: number, horizon: number, pos: PurchaseOrder[], today = new Date()): Forecast {
  const span = Math.min(HISTORY_DAYS, Math.max(1, spanDays));
  const sold7 = daily.slice(-7).reduce((s, n) => s + n, 0);
  const sold28 = daily.reduce((s, n) => s + n, 0);
  const avg28 = sold28 / span;
  const avg7 = sold7 / Math.min(7, span);
  const perDay = span >= 7 ? 0.6 * avg7 + 0.4 * avg28 : avg28;
  const daysOfCover = perDay > 0 && p.targetLevel > 0 ? p.onHand / perDay : null; // untracked stock has no meaningful cover
  const stockoutDate = daysOfCover === null ? null
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() + Math.floor(daysOfCover)).toLocaleDateString('en-CA');
  const onOrder = onOrderCases(pos, p.id);
  const demand = perDay * horizon;
  // Untracked stock (levels not set): on hand is unknown, so don't suggest an order from it.
  const needCases = p.targetLevel === 0 ? 0 : Math.max(0, Math.ceil((demand + p.reorderPoint - p.onHand - onOrder * p.unitsPerCase) / p.unitsPerCase));
  return { product: p, daily, sold7, sold28, perDay, daysOfCover, stockoutDate, demand, onOrder, needCases, lowData: span < 7 };
}

/** Bucket sales into local calendar days, oldest first. A bare "YYYY-MM-DD" is a local calendar date (EPOS imports). */
export function bucketSales(rows: { productId: number; ts: string | Date; units: number }[], today = new Date()) {
  const toDate = (ts: string | Date) => {
    const m = typeof ts === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(ts);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(ts);
  };
  const dayNo = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  const t = dayNo(today);
  const series: Record<number, number[]> = {};
  for (const r of rows) {
    const ago = t - dayNo(toDate(r.ts));
    if (ago < 0 || ago >= HISTORY_DAYS) continue;
    (series[r.productId] ??= Array(HISTORY_DAYS).fill(0))[HISTORY_DAYS - 1 - ago] += r.units;
  }
  return series;
}

// --- barcode matching -------------------------------------------------------------------

/** GTIN-8/12/13/14 check digit (weights 3,1 from the right). */
export const validGtin = (code: string) => {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const d = [...code].map(Number);
  const sum = d.slice(0, -1).reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[d.length - 1];
};
/**
 * Lookup keys for a barcode: digits without leading zeros (Excel strips them), plus the same without its check digit,
 * because distributor invoices often print UPCs minus the check digit (941489702054 vs 9414897020545).
 */
export const barcodeKeys = (code: string) => {
  const c = code.replace(/\s/g, '');
  const keys = [c.replace(/^0+/, '')];
  if (validGtin(c)) keys.push(c.slice(0, -1).replace(/^0+/, ''));
  return keys.filter(Boolean);
};
export function productCodeIndex(products: Product[]) {
  const byCode = new Map<string, Product>(), byName = new Map<string, Product>();
  // Exact keys first so they win over check-digit-stripped ones.
  for (const p of products) { const k = barcodeKeys(p.upc)[0]; if (k) byCode.set(k, p); byCode.set(p.sku.toLowerCase(), p); }
  for (const p of products) for (const k of barcodeKeys(p.upc).slice(1)) if (!byCode.has(k)) byCode.set(k, p);
  for (const p of products) byName.set(p.name.trim().toLowerCase(), p);
  /** SKU (e.g. EPOS-39108500, the stable Epos Now ID), then any barcode in a list ("774310693046, 853693001607"), then exact name. */
  return (barcodes: string, sku = '', name = '') => {
    const bySku = sku.trim() && byCode.get(sku.trim().toLowerCase());
    if (bySku) return bySku;
    for (const b of barcodes.split(/[,;|]/).map((s) => s.trim()).filter(Boolean))
      for (const k of barcodeKeys(b)) { const p = byCode.get(k); if (p) return p; }
    return (name && byName.get(name.trim().toLowerCase())) || undefined;
  };
}

/** Invoice line -> catalog product: by UPC, or by name when the vendor printed no UPC. */
export const matchLine = (products: Product[], line: InvoiceLine) =>
  line.upc
    ? products.find((p) => p.upc === line.upc)
    : products.find((p) => p.name.toLowerCase().startsWith(line.description.trim().toLowerCase()));

export const costValue =(p: Product) => (p.onHand / p.unitsPerCase) * p.caseCost;
export const retailValue = (p: Product) => p.onHand * p.unitPrice;
export const unitCost = (p: Product) => p.caseCost / p.unitsPerCase;
export const marginPct = (p: Product) => (p.unitPrice ? ((p.unitPrice - unitCost(p)) / p.unitPrice) * 100 : 0);
/** Reorder levels never set (e.g. created from an Epos Now report): stock isn't tracked yet, so it's not "out". */
export const levelsUnset = (p: Product) => p.targetLevel === 0;
export const stockStatus = (p: Product) =>
  levelsUnset(p) ? 'UNSET' : p.onHand === 0 ? 'OUT' : p.onHand <= p.reorderPoint ? 'LOW' : 'OK';
export const needsReorder = (p: Product) => stockStatus(p) === 'OUT' || stockStatus(p) === 'LOW';

/** Catalog fields a manager edits; stock on hand changes only through counts and movements. */
export interface ProductInput {
  upc: string; sku: string; name: string; category: Category; vendor: string; packSize: string;
  unitsPerCase: number; caseCost: number; unitPrice: number; aisle: string; reorderPoint: number; targetLevel: number;
}
export const EPOS_SKU = (eposProductId: string) => `EPOS-${eposProductId}`;

export const QUERY_PRESETS = [
  {
    key: 'low_stock',
    label: 'Low Stock Items',
    sql: `SELECT p.UPC, p.Name, p.Aisle, i.OnHand, i.ReorderPoint, i.TargetLevel,
       i.TargetLevel - i.OnHand AS Deficit
FROM dbo.Products p
JOIN dbo.Inventory i ON i.ProductId = p.ProductId
WHERE i.OnHand <= i.ReorderPoint AND i.TargetLevel > 0  -- TargetLevel 0 = not tracked yet
ORDER BY CAST(i.OnHand AS FLOAT) / NULLIF(i.ReorderPoint, 0), p.Name;`,
  },
  {
    key: 'category_valuation',
    label: 'Category Valuation',
    sql: `SELECT p.Category,
       COUNT(*) AS SKUs,
       SUM(i.OnHand) AS UnitsOnHand,
       CAST(SUM(i.OnHand * p.CaseCost / p.UnitsPerCase) AS DECIMAL(12,2)) AS CostValueCAD,
       CAST(SUM(i.OnHand * p.UnitPrice) AS DECIMAL(12,2)) AS RetailValueCAD
FROM dbo.Products p
JOIN dbo.Inventory i ON i.ProductId = p.ProductId
GROUP BY p.Category
ORDER BY CostValueCAD DESC;`,
  },
  {
    key: 'recent_movements',
    label: 'Recent Movements',
    sql: `SELECT TOP (25) m.CreatedAt, m.MovementType, p.UPC, p.Name,
       m.QtyDelta, m.QtyBefore, m.QtyAfter, u.FullName AS Employee, m.Reference
FROM dbo.StockMovements m
JOIN dbo.Products p ON p.ProductId = m.ProductId
LEFT JOIN dbo.AppUsers u ON u.UserId = m.UserId
ORDER BY m.MovementId DESC;`,
  },
  {
    key: 'active_alerts',
    label: 'Active Alerts',
    sql: `SELECT a.AlertId, a.CreatedAt, a.Severity, p.UPC, p.Name, a.OnHand, a.ReorderPoint, a.Message
FROM dbo.AlertNotifications a
JOIN dbo.Products p ON p.ProductId = a.ProductId
WHERE a.IsAcknowledged = 0
ORDER BY a.AlertId DESC;`,
  },
] as const;
export type PresetKey = (typeof QUERY_PRESETS)[number]['key'];
