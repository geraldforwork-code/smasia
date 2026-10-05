// Smallest checks that fail if the core rules break. Run: npm run check
import assert from 'node:assert/strict';
import { alertSeverity, bucketSales, forecast, onOrderCases, postSale, productCodeIndex, reorderCases, stockStatus, summarizeLedger, unitsFromPack, validGtin, type Movement } from '../src/shared.ts';
import { barcodeBars, code128, findHeaderRow, guessColumns, isUpcA, parseCsv, eposNewProduct, parseDate, parseEposDaily, parseNumber, sniffDateOrder, upcA } from '../src/lib.ts';
import { seedProducts } from './seed.ts';
import { exportCatalog, exportEposList, guessCategory, inStoreCode, parseCatalogCsv, parseEposProductList } from '../src/catalogIO.ts';
import * as store from './store.ts';
import { buildScript } from './sql.ts';
import { INVOICE_PRESETS } from './seed.ts';

// Barcodes: every Code 128 symbol is 11 modules; Code128-B of "A" = start B, 'A', check, stop.
assert.equal(code128('A').reduce((s, w) => s + w, 0), 11 * 3 + 13);
assert.ok(isUpcA('036000291452') && !isUpcA('036000291453'));
assert.equal(upcA('036000291452').length, 95);
assert.equal(barcodeBars('63516830083').symbology, 'Code 128');

assert.equal(unitsFromPack('24x78g'), 24);
assert.equal(unitsFromPack('1/25lb'), 1);
assert.equal(alertSeverity(13, 12, 12), 'WARNING');
assert.equal(alertSeverity(12, 11, 12), null); // already below: no repeat alert
assert.equal(alertSeverity(3, 0, 12), 'CRITICAL');

// In-memory flows (no MSSQL env during check)
const sarah = store.findUser(1)!;
const r = await store.scan('480002457550', 'SALE', 1, sarah); // 9 → 8, already below reorder point
assert.equal(r.after, 8);
const c2 = await store.scan('4800016052132', 'SALE', 3, sarah); // 3 → 0
assert.equal(c2.alert?.severity, 'CRITICAL');
await assert.rejects(store.scan('4800016052132', 'SALE', 1, sarah), /Insufficient/);
await assert.rejects(store.scan('999', 'SALE', 1, sarah), /Unknown/);

const doc = structuredClone(INVOICE_PRESETS[0].doc);
await store.ingest(doc, sarah);
const palm = store.getState().products.find((p) => p.upc === '63516830083')!;
assert.equal(palm.onHand, 24); // 0 → 1 CS
assert.ok(store.getState().products.some((p) => p.upc === '76189860877')); // new product added
await assert.rejects(store.ingest(doc, sarah), /already been ingested/);

const uno = structuredClone(INVOICE_PRESETS[1].doc);
await store.ingest(uno, sarah);
assert.ok(store.getState().products.some((p) => p.name === "Lily's Peanut Butter" && p.upc.startsWith('21')));

// Purchase order → receipt closes the PO and adds stock; on-order cases suppress the re-order suggestion.
const ketchup = store.getState().products.find((p) => p.upc === '200104000035')!; // 2 EA, reorder pt 12, target 48, 24/case
assert.equal(reorderCases(ketchup, store.getState().purchaseOrders), 2);
const po = await store.createPo({ vendor: ketchup.vendor, lines: [{ productId: ketchup.id, qty: 2 }] }, sarah);
assert.match(po!.poNo, /^PO-104-\d{5}$/);
assert.equal(onOrderCases(store.getState().purchaseOrders, ketchup.id), 2);
assert.equal(reorderCases(ketchup, store.getState().purchaseOrders), 0);
const receipt = { vendor: ketchup.vendor, invoiceNo: 'DI-555', date: '2026-10-05', total: 62.4, poNo: po!.poNo,
  lines: [{ upc: ketchup.upc, description: ketchup.name, packSize: ketchup.packSize, qty: 2, unitCost: ketchup.caseCost }] };
await store.ingest(receipt, sarah);
assert.equal(store.getState().purchaseOrders.find((x) => x.poNo === po!.poNo)!.status, 'RECEIVED');
assert.equal(ketchup.onHand, 50);
await assert.rejects(store.ingest({ ...receipt, invoiceNo: 'DI-556' }, sarah), /not open/);
const po2 = await store.createPo({ vendor: ketchup.vendor, lines: [{ productId: ketchup.id, qty: 1 }] }, sarah);
await store.cancelPo(po2!.id);
await assert.rejects(store.cancelPo(po2!.id), /already cancelled/);
await assert.rejects(store.createPo({ vendor: 'X', lines: [{ productId: ketchup.id, qty: 0 }] }, sarah), /positive/);

// Forecast: 28 days of history, 2/day for 3 weeks then 6/day last week → 0.6*6 + 0.4*(14*2... see below)
{
  const daily = [...Array(21).fill(2), ...Array(7).fill(6)]; // 42 + 42 = 84 sold
  const p = { ...ketchup, onHand: 30, reorderPoint: 12, unitsPerCase: 24 };
  const f = forecast(p, daily, 28, 14, [], new Date(2026, 9, 5));
  assert.equal(+f.perDay.toFixed(2), +(0.6 * 6 + 0.4 * 3).toFixed(2)); // 4.8/day
  assert.equal(+f.daysOfCover!.toFixed(2), 6.25);
  assert.equal(f.stockoutDate, '2026-10-11');
  assert.equal(f.needCases, Math.ceil((4.8 * 14 + 12 - 30) / 24)); // 2
  const fresh = forecast(p, [...Array(27).fill(0), 10], 1, 7, []); // brand-new store: one day of data counts as one day
  assert.ok(fresh.lowData && fresh.perDay === 10);
  const series = bucketSales([{ productId: 1, ts: new Date(2026, 9, 5, 9), units: 3 }, { productId: 1, ts: new Date(2026, 9, 4, 23), units: 2 }], new Date(2026, 9, 5, 12));
  assert.deepEqual(series[1].slice(-2), [2, 3]);
}
assert.equal((await store.salesHistory()).series[2]?.at(-1), 1); // the Del Monte sale scanned above, bucketed into today

// EPOS sales report: title rows skipped, quoted commas, column guess, DD/MM sniffing, footer ignored.
{
  const csv = '﻿Product Sales Report\r\nDate range: 01/10/2026 - 04/10/2026\r\n\r\n' +
    'Date,Barcode,Product Name,Quantity Sold,Stock On Hand,Net Sales\r\n' +
    '13/10/2026,8490900040,"Cock Brand Tapioca, Small",3,10,"$7.47"\r\nTotal,,,3,,\r\n';
  const rows = parseCsv(csv);
  const h = findHeaderRow(rows);
  assert.equal(h, 2);
  const g = guessColumns(rows[h]);
  assert.deepEqual([g.date, g.barcode, g.name, g.qty], [0, 1, 2, 3]); // qty skips "Stock On Hand"
  assert.equal(rows[h + 1][2], 'Cock Brand Tapioca, Small');
  assert.equal(sniffDateOrder(['13/10/2026']), 'DMY');
  assert.equal(sniffDateOrder(['10/04/2026']), null);
  assert.equal(parseDate('04/10/2026 13:45', 'DMY'), '2026-10-04');
  assert.equal(parseDate('04/10/2026', 'MDY'), '2026-04-10');
  assert.equal(parseDate('Oct 4, 2026', 'DMY'), '2026-10-04');
  assert.equal(parseDate('4-Oct-2026', 'DMY'), '2026-10-04');
  assert.equal(parseDate('31/02/2026', 'DMY'), null);
  assert.equal(parseNumber('(1,234.50)'), -1234.5);
}
{
  const d = (n: number) => { const t = new Date(); t.setDate(t.getDate() - n); return t.toLocaleDateString('en-CA'); };
  const body = { fileName: 'r.csv', periodFrom: d(2), periodTo: d(1), rows: [{ productId: 1, date: d(2), qty: 5 }, { productId: 1, date: d(2), qty: 1 }] };
  await store.importSales(body, sarah);
  await store.importSales({ ...body, rows: [{ productId: 1, date: d(1), qty: 4 }] }, sarah); // same period → replaces, no double count
  const hist = await store.salesHistory();
  assert.deepEqual(hist.series[1].slice(-3, -1), [0, 4]);
  assert.equal(hist.imports.length, 2);
  await assert.rejects(store.importSales({ ...body, rows: [{ productId: 1, date: d(5), qty: 1 }] }, sarah), /outside/);
  await assert.rejects(store.importSales({ ...body, rows: [{ productId: 9999, date: d(2), qty: 1 }] }, sarah), /unknown product/);
}

// Epos Now DailySales export (rows taken from DailySales_2026_10_05_0150.csv).
{
  const csv = 'ProductID,Name,Description,Barcode,OrderCode,Brand,Qty,MeasuredQty,Value,Discount,ValueIncVAT,ValueExcVAT,TotCost,Margin,MarginPerc\n' +
    '39108500," apple 500ml ",C2 apple 500ml,4800016052132,,,1,,2.49000,0.00000,2.49000,2.49000,1.39000,1.10000,0.44177\n' +
    '39034891,Mussels,,9414897020545,,,1,,11.99000,0.00000,11.99000,11.99000,8.99000,3.00000,0.25021\n' +
    '13566535,ASSORTED FRIED FISH BALL,ASSORTED FRIED FISH BALL,761898608777,,,2,,17.98000,0.00000,17.98000,17.98000,10.40000,7.58000,0.42158\n' +
    '39217016,Bulacan bittermelon leaves,Bulacan bittermelon leaves,"774310693046, 853693001607",,,3,,11.97000,0.00000,11.97000,11.97000,4.44000,7.53000,0.62907\n' +
    '39219159,Banana saba /lb,Banana saba /lb,,,,6,17.24800lb,51.57000,5.16000,46.41000,46.41000,17.07552,29.33000,0.63207\n' +
    ',Total:,,,,,430,,3542.13000,45.16000,3496.97000,3481.00000,2042.71834,1438.26000,77.02672\n';
  const d = parseEposDaily(csv, 'DailySales_2026_10_05_0150.csv')!;
  assert.equal(d.generatedUtc, '2026-10-05T01:50:00.000Z');
  assert.equal(d.salesDate, new Date(Date.UTC(2026, 9, 5, 1, 50)).toLocaleDateString('en-CA')); // 2026-10-04 in Canada
  assert.equal(d.rows.length, 5); // footer dropped
  assert.equal(d.rows[1 + 3].qty, 17.248); // weighed: MeasuredQty, not the 6 transactions
  assert.equal(d.rows[3].barcodes, '774310693046, 853693001607');
  assert.equal(parseEposDaily('Name,Qty\nx,1\n', 'other.csv'), null);

  assert.ok(validGtin('9414897020545') && !validGtin('941489702054'));
  const products = seedProducts();
  const match = productCodeIndex([...products, { ...products[0], id: 99, upc: '76189860877', sku: 'SMA-76189860877', name: 'Choripdong Fried Fish Ball' }]);
  assert.equal(match('4800016052132')?.upc, '4800016052132'); // exact
  assert.equal(match('9414897020545')?.upc, '941489702054'); // invoice UPC lacks check digit
  assert.equal(match('761898608777')?.id, 99); // leading zero + check digit
  assert.equal(match('8490900040')?.upc, '08490900040'); // Excel dropped the leading zero
  assert.equal(match('', '', 'IndoMie Mi Goreng Regular 85g')?.upc, '089686170795'); // by name
  assert.equal(match('123, 774310300203')?.upc, '774310300203'); // second barcode in a list
}

// Catalog from Epos Now: pricing, in-store codes, untracked stock, create/edit.
{
  const csv = 'ProductID,Name,Description,Barcode,OrderCode,Brand,Qty,MeasuredQty,Value,Discount,ValueIncVAT,ValueExcVAT,TotCost,Margin,MarginPerc\n' +
    '14444173,GOLDILOCKS PINIPIG,GOLDILOCKS PINIPIG,4800111008065,,,1,,10.49000,1.50000,8.99000,8.56000,6.16000,2.40000,0.28037\n' +
    '39107954,"BESUTO PRAWN CRACKER ","BESUTO PRAWN CRACKER ",4800174032502,,,1,,7.34000,0.00000,7.34000,6.99000,3.00000,3.99000,0.57082\n' +
    '39219159,Banana saba /lb,Banana saba /lb,,,,6,17.24800lb,51.57000,5.16000,46.41000,46.41000,17.07552,29.33000,0.63207\n' +
    '41397497,Banana Que 2pcs,Banana Que 2pcs,,,,14,,69.86000,3.96860,65.89140,65.89140,28.00000,37.89000,0.57506\n';
  const [gold, besuto, saba, que] = parseEposDaily(csv, 'DailySales_2026_10_05_0150.csv')!.rows.map(eposNewProduct);
  assert.equal(gold!.unitPrice, 9.99); // before the $1.50 discount, before tax
  assert.equal(besuto!.unitPrice, 6.99); // tax removed
  assert.equal(besuto!.name, 'BESUTO PRAWN CRACKER');
  assert.equal(besuto!.sku, 'EPOS-39107954');
  assert.equal(saba!.unitPrice, 2.99); // per lb: 51.57 / 17.248
  assert.equal(saba!.caseCost, 0.99);
  assert.equal(saba!.packSize, 'per lb');
  assert.equal(que!.upc, '210041397497'); // no barcode: in-store code from the Epos Now ID
  assert.equal(que!.unitPrice, 4.99);

  const before = store.getState().products.length;
  const r = await store.createProducts([gold!, besuto!, saba!, que!, { ...gold!, sku: 'EPOS-dup' }, { ...products0(), upc: '774310300203', sku: 'EPOS-1' }]);
  assert.equal(r.created, 4); // duplicate barcode in the batch + existing Reno UPC skipped
  assert.equal(store.getState().products.length, before + 4);
  const created = store.getState().products.find((p) => p.sku === 'EPOS-39107954')!;
  assert.equal(stockStatus(created), 'UNSET');
  assert.equal(reorderCases(created, []), 0);
  assert.equal(forecast(created, Array(28).fill(1), 28, 14, []).needCases, 0);
  assert.equal(productCodeIndex(store.getState().products)('999', 'EPOS-39107954')?.id, created.id); // Epos ID wins
  await assert.rejects(store.updateProduct(created.id, { reorderPoint: 10, targetLevel: 5 }), /Target level/);
  await store.updateProduct(created.id, { category: 'Snacks & Confectionery', aisle: 'A1', reorderPoint: 6, targetLevel: 24 });
  assert.equal(stockStatus(store.getState().products.find((p) => p.id === created.id)!), 'OUT'); // tracked now, 0 counted
  await assert.rejects(store.createProducts([{ ...gold!, category: 'Nope' as never }]), /Unknown category/);
}
// Product import/export: Epos Now ProductList, catalog CSV round trip, bulk update.
{
  const list = parseEposProductList('Name;CategoryId;CostPriceIncTax;SalePriceIncTax;Barcode\r\n' +
    'Oishi  prawn cracker;GROCERIES;0.79;1.69;4891208040136\r\nPears;fruits;0.75;1.50;\r\n' +
    'Cock brand tapioca pearl small;GROCERIES;2.20;3.99;084909007087\r\nZEST.O APPLE BOX ;DRINKS PRODUCTS;6.99;10.99;4804888889742\r\n')!;
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { name: 'Oishi prawn cracker', eposCategory: 'GROCERIES', cost: 0.79, price: 1.69, barcode: '4891208040136' });
  assert.equal(list[1].barcode, '');
  assert.equal(list[2].barcode, '084909007087'); // leading zero kept
  assert.equal(list[3].name, 'ZEST.O APPLE BOX');
  assert.equal(parseEposProductList('UPC,SKU,Name\n1,2,3\n'), null);
  assert.deepEqual(['GROCERIES', 'Frozen Product', 'DRINKS PRODUCTS', 'FROZEN SEAFOODS', 'GRANDPA BAKESHOP', 'CONSIGNED ITEMS', 'Beauty Products ', 'fruits'].map(guessCategory),
    ['Dry Goods', 'Frozen & Seafood', 'Beverages', 'Frozen & Seafood', 'Snacks & Confectionery', 'Uncategorized', 'Uncategorized', 'Uncategorized']);
  assert.match(inStoreCode('Pears'), /^22\d{10}$/);
  assert.equal(inStoreCode(' pears '), inStoreCode('Pears'));

  const tricky = { ...seedProducts()[0], name: '=SUM(A1) "Big", Pack', aisle: 'A3' };
  const csv = exportCatalog([tricky]);
  assert.ok(csv.includes(`"'=SUM(A1) ""Big"", Pack"`)); // quoted + formula-guarded
  const back = parseCatalogCsv(csv)!;
  assert.equal(back.errors.length, 0);
  assert.equal(back.rows[0].name, tricky.name); // guard removed on the way back in
  assert.equal(back.rows[0].caseCost, tricky.caseCost);
  assert.equal(back.rows[0].targetLevel, tricky.targetLevel);
  assert.ok(exportEposList([tricky]).startsWith('Name;CategoryId;CostPriceIncTax;SalePriceIncTax;Barcode'));
  const bad = parseCatalogCsv('UPC,SKU,Name,Category,UnitPrice\n1,,x,Toys,1\n2,,y,Beverages,abc\n,,z,,\n')!;
  assert.equal(bad.errors.length, 3);

  const target = store.getState().products.find((p) => p.upc === '774310300203')!;
  await store.bulkUpdateProducts([{ id: target.id, aisle: 'B7' }, { id: target.id, unitPrice: 1.99 }]); // two rows, same product, merged
  const after = store.getState().products.find((p) => p.id === target.id)!;
  assert.deepEqual([after.aisle, after.unitPrice, after.onHand], ['B7', 1.99, target.onHand]);
  await assert.rejects(store.bulkUpdateProducts([{ id: target.id, reorderPoint: 50, targetLevel: 10 }]), /Target level/);
  await assert.rejects(store.bulkUpdateProducts([{ id: 424242, aisle: 'x' }]), /unknown product/);
  const made = await store.createProducts([{ upc: '2200000001', sku: 'SMA-2200000001', name: 'Pears', category: 'Uncategorized', unitsPerCase: 1, caseCost: 0.75, unitPrice: 1.5, reorderPoint: 5, targetLevel: 20 }]);
  assert.equal(made.created, 1);
  assert.equal(stockStatus(store.getState().products.find((p) => p.sku === 'SMA-2200000001')!), 'OUT'); // levels given → tracked
}
// Stock card: opening/closing, ins and outs by type, period filter.
{
  const mv = (id: number, ts: string, type: Movement['type'], qty: number, before: number) =>
    ({ id, ts, productId: 1, upc: '', name: '', type, qty, before, after: before + qty, user: 'x', ref: null });
  const moves = [ // newest first, like the API
    mv(4, '2026-10-04T10:00:00.000Z', 'SCAN_SALE', -3, 50),
    mv(3, '2026-10-03T10:00:00.000Z', 'CYCLE_COUNT', -2, 52),
    mv(2, '2026-10-02T10:00:00.000Z', 'INVOICE_INTAKE', 48, 4),
    mv(1, '2026-09-01T10:00:00.000Z', 'SCAN_SALE', -1, 5),
  ];
  const all = summarizeLedger(moves, 47, null);
  assert.deepEqual([all.opening, all.totalIn, all.totalOut, all.closing], [5, 48, 6, 47]);
  assert.deepEqual(all.outByType, { SCAN_SALE: 4, CYCLE_COUNT: 2 });
  const recent = summarizeLedger(moves, 47, '2026-10-01T00:00:00.000Z');
  assert.deepEqual([recent.opening, recent.totalIn, recent.totalOut, recent.closing, recent.movements.length], [4, 48, 5, 47, 3]);
  assert.equal(recent.opening + recent.totalIn - recent.totalOut, recent.closing);
  const none = summarizeLedger(moves, 47, '2026-11-01T00:00:00.000Z');
  assert.deepEqual([none.opening, none.closing], [47, 47]);

  const ledger = await store.productLedger(1); // Tapioca: received on the Dong Phuong invoice, sales imported above
  assert.ok(ledger.movements.every((m) => m.productId === 1) && ledger.movements.some((m) => m.type === 'INVOICE_INTAKE'));
  assert.ok((await store.productLedger(2)).movements.some((m) => m.type === 'SCAN_SALE')); // Del Monte: POS sale scanned above
  assert.ok(ledger.sales.length > 0 && ledger.sales[0].fileName); // imported Epos Now sales with their file
  await assert.rejects(store.productLedger(999999), /Unknown product/);
}
// Epos Now sales posted to stock as EPOS_SALE outs.
{
  assert.deepEqual(postSale(3, 10, 20, false), { deduct: 3, status: 'POSTED' });
  assert.deepEqual(postSale(12, 10, 20, false), { deduct: 10, status: 'SHORT' });
  assert.deepEqual(postSale(3, 10, 0, false), { deduct: 0, status: 'UNTRACKED' });
  assert.deepEqual(postSale(17.248, 10, 20, false), { deduct: 0, status: 'WEIGHED' });
  assert.deepEqual(postSale(3, 10, 20, true), { deduct: 0, status: 'BEFORE_COUNT' });
  assert.deepEqual(postSale(-2, 10, 20, false), { deduct: -2, status: 'POSTED' }); // refund back to stock

  const day = (n: number) => { const t = new Date(); t.setDate(t.getDate() + n); return t.toLocaleDateString('en-CA'); };
  const p = store.getState().products.find((x) => x.upc === '089686170795')!; // IndoMie, tracked
  const start = p.onHand;
  const r1 = await store.importSales({ fileName: 'd.csv', periodFrom: day(1), periodTo: day(1), rows: [{ productId: p.id, date: day(1), qty: 7 }], post: true }, sarah);
  assert.deepEqual(r1, [{ status: 'POSTED', lines: 1, sold: 7, posted: 7 }]);
  assert.equal(p.onHand, start - 7);
  const out = (await store.productLedger(p.id)).movements[0];
  assert.deepEqual([out.type, out.qty, out.ref], ['EPOS_SALE', -7, `EPOS ${day(1)}`]);
  // Re-import the same day with a corrected qty: earlier 7 reversed, 4 deducted → net 4, not 11.
  await store.importSales({ fileName: 'd2.csv', periodFrom: day(1), periodTo: day(1), rows: [{ productId: p.id, date: day(1), qty: 4 }], post: true }, sarah);
  assert.equal(p.onHand, start - 4);
  // A shelf count made after the sales day already reflects the sale: not deducted again.
  await store.adjust(p.id, 100, 'CYCLE_COUNT', 'count', sarah);
  const r3 = await store.importSales({ fileName: 'old.csv', periodFrom: day(-3), periodTo: day(-3), rows: [{ productId: p.id, date: day(-3), qty: 5 }], post: true }, sarah);
  assert.equal(r3[0].status, 'BEFORE_COUNT');
  assert.equal(p.onHand, 100);
  // Without "post", stock is untouched and the line has no status.
  const r4 = await store.importSales({ fileName: 'n.csv', periodFrom: day(2), periodTo: day(2), rows: [{ productId: p.id, date: day(2), qty: 5 }] }, sarah);
  assert.deepEqual([r4.length, p.onHand], [0, 100]);
  assert.equal((await store.productLedger(p.id)).sales.find((s) => s.date === day(1))?.posted, 4);
}
// Deleting a sales import adds back what it deducted and frees the day for re-import.
{
  const day = (n: number) => { const t = new Date(); t.setDate(t.getDate() + n); return t.toLocaleDateString('en-CA'); };
  const p = store.getState().products.find((x) => x.upc === '089686170795')!;
  const start = p.onHand;
  await store.importSales({ fileName: 'del.csv', periodFrom: day(5), periodTo: day(5), rows: [{ productId: p.id, date: day(5), qty: 6 }], post: true }, sarah);
  assert.equal(p.onHand, start - 6);
  const imp = (await store.salesHistory()).imports.find((i) => i.fileName === 'del.csv')!;
  const r = await store.deleteSalesImport(imp.id, sarah);
  assert.deepEqual(r, { linesDeleted: 1, unitsRestored: 6 });
  assert.equal(p.onHand, start);
  assert.ok(!(await store.salesHistory()).imports.some((i) => i.id === imp.id));
  assert.ok(!(await store.productLedger(p.id)).sales.some((s) => s.date === day(5)));
  await assert.rejects(store.deleteSalesImport(imp.id, sarah), /not found/);
  await store.importSales({ fileName: 'del.csv', periodFrom: day(5), periodTo: day(5), rows: [{ productId: p.id, date: day(5), qty: 6 }], post: true }, sarah);
  assert.equal(p.onHand, start - 6); // re-import works after delete
  const all = await store.deleteSalesImport(null, sarah);
  assert.ok(all.linesDeleted > 0);
  assert.equal(p.onHand, start); // the earlier test's 4 is NOT added back: a shelf count (100) came after that import
  assert.equal((await store.salesHistory()).imports.length, 0);
}
function products0() { return { ...seedProducts()[0] }; }

const q = await store.runQuery('SELECT 1', 'low_stock');
assert.ok(q.rows.length > 0 && q.columns.includes('Deficit'));

const sql = buildScript();
for (const name of ['dbo.Products', 'dbo.Inventory', 'dbo.StockMovements', 'dbo.Invoices', 'dbo.InvoiceItems', 'dbo.AppUsers', 'dbo.AlertNotifications', 'dbo.sp_ProcessBarcodeScan', 'dbo.sp_IngestInvoiceBatch', 'dbo.trg_CheckLowStock', 'dbo.PurchaseOrders', 'dbo.PurchaseOrderItems', 'dbo.sp_CreatePurchaseOrder'])
  assert.ok(sql.includes(name), name);

console.log('selfcheck ok');
