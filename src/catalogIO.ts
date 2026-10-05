// Product import/export: Epos Now ProductList CSV and this app's full catalog CSV (Excel round trip).
import { CATEGORIES, type Category, type Product, type ProductInput } from './shared';
import { parseCsv, parseNumber } from './lib';

// --- writing ---------------------------------------------------------------------------------

/** Text cells that Excel would run as a formula get a leading apostrophe (CSV injection guard); numbers are left alone. */
const safe = (v: string | number) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
export function toCsv(rows: (string | number)[][], delim = ',') {
  const cell = (v: string | number) => {
    const s = String(safe(v));
    return s.includes(delim) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(delim)).join('\r\n') + '\r\n';
}
/** Strip the apostrophe our own export (or Epos Now) put in front of formula-like text. */
const unsafe = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

export function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); // BOM: Excel reads UTF-8
  Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const CATALOG_COLUMNS = ['UPC', 'SKU', 'Name', 'Category', 'Vendor', 'PackSize', 'UnitsPerCase', 'CaseCost', 'UnitPrice', 'Aisle', 'ReorderPoint', 'TargetLevel', 'OnHand'] as const;

/** Full catalog. OnHand is informational: the import ignores it (stock changes only through counts and movements). */
export const exportCatalog = (products: Product[]) => toCsv([
  [...CATALOG_COLUMNS],
  ...products.map((p) => [p.upc, p.sku, p.name, p.category, p.vendor, p.packSize, p.unitsPerCase, p.caseCost.toFixed(2),
    p.unitPrice.toFixed(2), p.aisle, p.reorderPoint, p.targetLevel, p.onHand]),
]);

/** Same layout as Epos Now's ProductList export (semicolon-separated, unit cost and price). */
export const exportEposList = (products: Product[]) => toCsv([
  ['Name', 'CategoryId', 'CostPriceIncTax', 'SalePriceIncTax', 'Barcode'],
  ...products.map((p) => [p.name, p.category, (p.caseCost / p.unitsPerCase).toFixed(2), p.unitPrice.toFixed(2), p.upc]),
], ';');

// --- reading -------------------------------------------------------------------------------------

export interface EposListRow { name: string; eposCategory: string; cost: number; price: number; barcode: string }

/** Epos Now ProductList: Name;CategoryId;CostPriceIncTax;SalePriceIncTax;Barcode. Returns null for other files. */
export function parseEposProductList(text: string): EposListRow[] | null {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (h: string) => head.indexOf(h.toLowerCase());
  if (['Name', 'CategoryId', 'SalePriceIncTax', 'Barcode'].some((h) => col(h) < 0)) return null;
  return rows.slice(1).map((r) => ({
    name: unsafe((r[col('Name')] ?? '').replace(/\s+/g, ' ').trim()),
    eposCategory: (r[col('CategoryId')] ?? '').trim() || '(none)',
    cost: col('CostPriceIncTax') >= 0 ? parseNumber(r[col('CostPriceIncTax')] ?? '') : NaN,
    price: parseNumber(r[col('SalePriceIncTax')] ?? ''),
    barcode: (r[col('Barcode')] ?? '').split(/[,;|]/).map((s) => s.trim()).find((s) => /^[0-9A-Za-z-]{4,20}$/.test(s)) ?? '',
  })).filter((r) => r.name);
}

export type CatalogRow = Partial<ProductInput> & { line: number };
/** This app's catalog export (header must include UPC, SKU and Name). Blank cells mean "keep current value". */
export function parseCatalogCsv(text: string): { rows: CatalogRow[]; errors: string[] } | null {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (h: string) => head.indexOf(h.toLowerCase());
  if (['UPC', 'SKU', 'Name'].some((h) => col(h) < 0)) return null;
  const errors: string[] = [];
  const out: CatalogRow[] = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const txt = (h: string) => (col(h) >= 0 && (r[col(h)] ?? '').trim() !== '' ? unsafe(r[col(h)].trim()) : undefined);
    const num = (h: string, int: boolean) => {
      const v = txt(h);
      if (v === undefined) return undefined;
      const n = parseNumber(v);
      if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) { errors.push(`Line ${line}: ${h} "${v}" is not a valid number.`); return null; }
      return n;
    };
    const category = txt('Category');
    if (category !== undefined && !CATEGORIES.includes(category as Category)) {
      errors.push(`Line ${line}: category "${category}" must be one of: ${CATEGORIES.join(', ')}.`);
      return;
    }
    const row: CatalogRow = {
      line, upc: txt('UPC'), sku: txt('SKU'), name: txt('Name'), category: category as Category | undefined, vendor: txt('Vendor'),
      packSize: txt('PackSize'), aisle: txt('Aisle'),
      unitsPerCase: num('UnitsPerCase', true) ?? undefined, caseCost: num('CaseCost', false) ?? undefined,
      unitPrice: num('UnitPrice', false) ?? undefined, reorderPoint: num('ReorderPoint', true) ?? undefined,
      targetLevel: num('TargetLevel', true) ?? undefined,
    };
    if (!row.upc && !row.sku) { errors.push(`Line ${line}: needs a UPC or SKU.`); return; }
    out.push(row);
  });
  return { rows: out, errors };
}

/** Best-guess mapping from an Epos Now category name to this app's categories (editable in the import screen). */
export function guessCategory(eposCategory: string): Category {
  const c = eposCategory.toLowerCase();
  if (/frozen|seafood|fish|meat/.test(c)) return 'Frozen & Seafood';
  if (/drink|beverage|juice|coffee|tea/.test(c)) return 'Beverages';
  if (/snack|candy|confection|chip|bake|bread|pastry|dessert/.test(c)) return 'Snacks & Confectionery';
  if (/sauce|condiment|spice|seasoning/.test(c)) return 'Sauces & Condiments';
  if (/can|preserv|jar/.test(c)) return 'Canned & Preserved';
  if (/grocer|dry|rice|noodle/.test(c)) return 'Dry Goods';
  return 'Uncategorized';
}

/** Stable in-store code for an item without a barcode: "22" + 10 digits from an FNV-1a hash of its name. */
export function inStoreCode(name: string) {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return `22${String(h).padStart(10, '0').slice(-10)}`;
}
