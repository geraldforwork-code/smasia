// Client utilities: API, audio cues, barcode geometry, formatting, confetti, browser notifications.
import { EPOS_SKU, type ProductInput } from './shared';

let userId = 1;
export const setApiUser = (id: number) => { userId = id; };

export async function api<T = unknown>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-id': String(userId) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') ?? '';
  const out = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((out as { error?: string })?.error ?? res.statusText);
  return out as T;
}

// --- Web Audio cues ---------------------------------------------------------------

let ctx: AudioContext | null = null;
function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.18) {
  ctx ??= new AudioContext();
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}
export const sound = {
  scan: () => tone(1850, 0, 0.08, 'square', 0.12),
  lowStock: () => [1046.5, 880, 698.5, 523.3].forEach((f, i) => tone(f, i * 0.14, 0.22, 'triangle', 0.2)),
  error: () => { tone(110, 0, 0.35, 'sawtooth', 0.2); tone(116, 0, 0.35, 'square', 0.08); },
  success: () => [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(f, i * 0.11, i === 3 ? 0.45 : 0.18, 'triangle', 0.2)),
};

// --- Barcodes ------------------------------------------------------------------------

// Code 128 symbol widths (bar, space, bar, space, bar, space), values 0..106.
const C128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 ' +
  '232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 ' +
  '313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 ' +
  '111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 ' +
  '114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

/** Code 128-B as alternating bar/space module widths (starting with a bar). */
export function code128(text: string): number[] {
  const vals = [...text].map((ch) => {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) throw new Error(`Unsupported character in barcode: ${ch}`);
    return v;
  });
  const check = vals.reduce((s, v, i) => s + v * (i + 1), 104) % 103;
  return [104, ...vals, check, 106].flatMap((v) => [...C128[v]].map(Number));
}

const UPC_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
export const isUpcA = (code: string) => {
  if (!/^\d{12}$/.test(code)) return false;
  const d = [...code].map(Number);
  const sum = d.slice(0, 11).reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[11];
};
/** UPC-A as a 95-module bit string (1 = bar). */
export function upcA(code: string): string {
  const d = [...code].map(Number);
  const right = (n: number) => [...UPC_L[n]].map((b) => (b === '1' ? '0' : '1')).join('');
  return '101' + d.slice(0, 6).map((n) => UPC_L[n]).join('') + '01010' + d.slice(6).map(right).join('') + '101';
}

/** Bars as [x, width] in module units plus total width, choosing UPC-A when the code is a valid UPC-A. */
export function barcodeBars(code: string): { bars: [number, number][]; width: number; symbology: 'UPC-A' | 'Code 128' } {
  const bars: [number, number][] = [];
  if (isUpcA(code)) {
    const bits = upcA(code);
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') bars.push([i, 1]);
    return { bars, width: bits.length, symbology: 'UPC-A' };
  }
  let x = 0;
  code128(code).forEach((w, i) => { if (i % 2 === 0) bars.push([x, w]); x += w; });
  return { bars, width: x, symbology: 'Code 128' };
}

// --- Formatting -------------------------------------------------------------------------

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const cad0 = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
export const money = (n: number) => cad.format(n);
export const money0 = (n: number) => cad0.format(n);
export const cases = (units: number, perCase: number) => {
  const c = units / perCase;
  return `${Number.isInteger(c) ? c : c.toFixed(1)} CS`;
};
export const time = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dateTime = (iso: string) => new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });

// --- Confetti (Web Animations API) ---------------------------------------------------

export function confetti() {
  const colors = ['#dc2626', '#f59e0b', '#16a34a', '#2563eb', '#fafafa'];
  for (let i = 0; i < 140; i++) {
    const el = document.createElement('div');
    const size = 6 + Math.random() * 6;
    Object.assign(el.style, {
      position: 'fixed', left: `${50 + (Math.random() - 0.5) * 20}vw`, top: '40vh', width: `${size}px`, height: `${size * 0.6}px`,
      background: colors[i % colors.length], zIndex: '9999', pointerEvents: 'none',
    });
    document.body.appendChild(el);
    const dx = (Math.random() - 0.5) * 900, dy = -200 - Math.random() * 400;
    el.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy}px) rotate(${Math.random() * 360}deg)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${dx}px, ${window.innerHeight * 0.7}px) rotate(${Math.random() * 1080}deg)`, opacity: 0 },
      ],
      { duration: 1800 + Math.random() * 1200, easing: 'cubic-bezier(.2,.7,.4,1)' },
    ).onfinish = () => el.remove();
  }
}

// --- Browser notifications -----------------------------------------------------------

export interface PushSettings { enabled: boolean; criticalOnly: boolean; sound: boolean }
const KEY = 'smasia.push';
export function loadPush(): PushSettings {
  try { return { enabled: false, criticalOnly: false, sound: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return { enabled: false, criticalOnly: false, sound: true }; }
}
export function savePush(s: PushSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ } }

export function pushNotify(title: string, body: string, tag?: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  new Notification(title, { body, tag, icon: '/favicon.svg' });
  return true;
}

// --- EPOS sales report CSV ---------------------------------------------------------------

/** RFC 4180-style CSV (quotes, doubled quotes, CRLF, BOM). Delimiter sniffed from the first line: , ; or tab. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export type SalesColumn = 'barcode' | 'sku' | 'name' | 'qty' | 'date';
const COLUMN_HINTS: Record<SalesColumn, RegExp> = {
  barcode: /barcode|upc|ean|gtin|plu/i,
  sku: /\bsku\b|product code|item code|^code$/i,
  name: /product|item|description|name/i,
  qty: /qty|quantity|units|sold|volume|count/i,
  date: /date|day/i,
};
/** Guess which header is which; quantity ignores stock/on-hand columns. */
export function guessColumns(header: string[]): Record<SalesColumn, number> {
  const find = (k: SalesColumn, skip: (h: string) => boolean = () => false) =>
    header.findIndex((h) => COLUMN_HINTS[k].test(h) && !skip(h));
  const barcode = find('barcode');
  return {
    barcode,
    sku: find('sku', (h) => COLUMN_HINTS.barcode.test(h)),
    name: find('name', (h) => COLUMN_HINTS.barcode.test(h) || /code|id$/i.test(h)),
    qty: find('qty', (h) => /stock|on ?hand|price|cost|value|amount/i.test(h)),
    date: find('date', (h) => /update|expir/i.test(h)),
  };
}
/** Header = first of the top 20 rows that names both a quantity and a product (barcode/name) column. Report titles above it are skipped. */
export function findHeaderRow(rows: string[][]) {
  const i = rows.slice(0, 20).findIndex((r) => {
    const g = guessColumns(r);
    return g.qty >= 0 && (g.barcode >= 0 || g.name >= 0);
  });
  return Math.max(0, i);
}

export type DateOrder = 'DMY' | 'MDY';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
/** "2026-10-04", "04/10/2026 13:45", "10/04/26", "4-Oct-2026", "Oct 4, 2026", "4 October 2026" → YYYY-MM-DD (time ignored). */
export function parseDate(s: string, order: DateOrder): string | null {
  s = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) return order === 'MDY' ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-\s]([a-z]{3})[a-z]*\.?[-\s,]+(\d{2,4})/i.exec(s);
  if (m && MONTHS.includes(m[2].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})/i.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return null;
}
/** For slash dates: a first part > 12 proves DMY, a second part > 12 proves MDY; otherwise ambiguous (null). */
export function sniffDateOrder(values: string[]): DateOrder | null {
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(v.trim());
    if (m && +m[1] > 12) return 'DMY';
    if (m && +m[2] > 12) return 'MDY';
  }
  return null;
}
// --- Epos Now "DailySales" export ---------------------------------------------------------

export interface EposDailyRow {
  productId: string; name: string; barcodes: string; qty: number; revenue: number;
  weighed: boolean; value: number; valueIncVat: number; valueExcVat: number; totCost: number;
}

/**
 * Catalog entry for an Epos Now item that isn't in this app yet. Shelf price is before tax and before discount:
 * Value (gross, inc tax) scaled by ExcVAT/IncVAT, e.g. GOLDILOCKS 10.49 × 8.56/8.99 = 9.99. Cost = TotCost per unit.
 * Weighed items are priced per lb. No barcode → in-store code from the Epos Now ID. Levels stay unset until counted.
 */
export function eposNewProduct(r: EposDailyRow): Omit<ProductInput, 'reorderPoint' | 'targetLevel'> | null {
  if (!(r.qty > 0) || !r.name.trim()) return null; // refunds-only lines can't give a price
  const firstBarcode = r.barcodes.split(/[,;|]/).map((s) => s.trim()).find((s) => /^[0-9A-Za-z-]{4,20}$/.test(s));
  const taxFactor = r.valueIncVat > 0 && r.valueExcVat > 0 ? r.valueExcVat / r.valueIncVat : 1;
  return {
    upc: firstBarcode ?? `21${r.productId.replace(/\D/g, '').padStart(10, '0').slice(-10)}`,
    sku: EPOS_SKU(r.productId), name: r.name.replace(/\s+/g, ' ').trim(), category: 'Uncategorized', vendor: 'Unassigned',
    packSize: r.weighed ? 'per lb' : '1 EA', unitsPerCase: 1, aisle: '',
    unitPrice: Math.round(((r.value || r.valueIncVat) * taxFactor / r.qty) * 100) / 100,
    caseCost: Math.round((Math.max(0, r.totCost) / r.qty) * 100) / 100,
  };
}
export interface EposDaily { fileName: string; generatedUtc: string | null; salesDate: string | null; rows: EposDailyRow[]; units: number; revenue: number }
const EPOS_DAILY_HEADER = ['ProductID', 'Name', 'Barcode', 'Qty', 'MeasuredQty', 'ValueIncVAT'];

/**
 * DailySales_YYYY_MM_DD_HHMM.csv: one row per Epos Now product, no date column.
 * The filename stamp is UTC, so the sales date is that instant's local calendar date (01:50 UTC 5 Oct = evening of 4 Oct).
 * Weighed items use MeasuredQty ("17.24800lb") as the quantity, others Qty. Returns null if the header doesn't match.
 */
export function parseEposDaily(text: string, fileName: string): EposDaily | null {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim());
  if (!EPOS_DAILY_HEADER.every((h) => head.includes(h))) return null;
  const col = (h: string) => head.indexOf(h);
  const m = /(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})/.exec(fileName);
  const stamp = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
  const out: EposDailyRow[] = [];
  for (const r of rows.slice(1)) {
    const name = (r[col('Name')] ?? '').trim();
    if (!r[col('ProductID')]?.trim() && /^totals?:?$/i.test(name)) continue; // footer
    const measured = parseNumber(r[col('MeasuredQty')] ?? '');
    const qty = Number.isFinite(measured) ? measured : parseNumber(r[col('Qty')] ?? '');
    if (!Number.isFinite(qty)) continue;
    const num = (h: string) => (col(h) >= 0 ? parseNumber(r[col(h)] ?? '') || 0 : 0);
    out.push({
      productId: r[col('ProductID')].trim(), name: name || (r[col('Description')] ?? '').trim(),
      barcodes: r[col('Barcode')] ?? '', qty, revenue: num('ValueIncVAT'), weighed: Number.isFinite(measured),
      value: num('Value'), valueIncVat: num('ValueIncVAT'), valueExcVat: num('ValueExcVAT'), totCost: num('TotCost'),
    });
  }
  return {
    fileName, generatedUtc: stamp?.toISOString() ?? null, salesDate: stamp?.toLocaleDateString('en-CA') ?? null, rows: out,
    units: out.reduce((s, r) => s + r.qty, 0), revenue: out.reduce((s, r) => s + r.revenue, 0),
  };
}

/** "1,234.50", "$12", "(3)" → number. */
export const parseNumber = (s: string) => {
  const neg = /^\(.*\)$/.test(s.trim()) || /^-/.test(s.trim());
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
};
