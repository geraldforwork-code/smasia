import { unitsFromPack, type Category, type InvoiceDoc, type Product, type User } from '../src/shared.ts';

export const USERS: User[] = [
  { id: 1, name: 'Sarah Chen', role: 'ADMIN', title: 'General Manager' },
  { id: 2, name: 'Marcus Vance', role: 'CLERK', title: 'Warehouse Lead' },
  { id: 3, name: 'Elena Gomez', role: 'CASHIER', title: 'Cashier' },
];

const DP = 'Dong Phuong Distributor';
const UNO = 'UNO Foods Inc.';
const DI = 'Direct Import';
const S: Category = 'Snacks & Confectionery', SC: Category = 'Sauces & Condiments', C: Category = 'Canned & Preserved',
  F: Category = 'Frozen & Seafood', B: Category = 'Beverages', D: Category = 'Dry Goods';

// [upc, name, category, vendor, pack, caseCost, unitPrice, aisle, onHand, reorderPoint, target]  (stock in eaches)
// Codes starting with 2 are in-store codes (UPC-A number system 2), not manufacturer UPCs.
type Row = [string, string, Category, string, string, number, number, string, number, number, number];
const ROWS: Row[] = [
  ['08490900040', 'Cock Brand Tapioca Pearl Small 400g', D, DP, '50/400g', 62.5, 2.49, 'A3', 64, 25, 150],
  ['480002457550', 'Del Monte Filipino Style Spaghetti Sauce 900g', SC, DP, '12/900g', 38.4, 5.49, 'A2', 9, 12, 48],
  ['63516830083', 'Palm Liver Spread 227g', C, DP, '24/227g', 52.8, 3.29, 'A4', 0, 12, 72],
  ['01622900058', 'Aroy-D Quail Eggs in Water 425g', C, DP, '24/425g', 44.16, 2.99, 'A4', 30, 12, 72],
  ['480901052461', 'Sugo Cracker Nuts BBQ/Butter/Garlic 100g', S, DP, '24/100g', 28.8, 1.99, 'A1', 41, 12, 72],
  ['74822999043', 'Nora Kitchen Tamarind Soup Base 40g', SC, DP, '24/40g', 21.6, 1.49, 'A2', 10, 12, 48],
  ['480651704004', 'Delfi Knick Knacks 60g', S, DP, '20/60g', 18.0, 1.49, 'A1', 26, 10, 60],
  ['480019417710', 'Oishi Rin-Bee Cheese Stick 24g', S, DP, '50/24g', 22.5, 0.79, 'A1', 120, 25, 150],
  ['80048900237', 'ABC Jelly Straws 300g', S, DP, '24/300g', 33.6, 2.49, 'A1', 18, 12, 48],
  ['941489702054', "Talley's Greenshell Mussels 1kg", F, DP, '12/1kg', 96.0, 11.99, 'F1', 7, 6, 36],
  ['77431', 'Golden Panda Condensada & Evaporada 300ml', C, UNO, '48/300ml', 52.8, 1.79, 'A4', 60, 24, 144],
  ['774310210007', 'Sarangani Milkfish in Oil 220g', C, UNO, '24/220g', 50.4, 3.29, 'A4', 22, 12, 72],
  ['774310300203', 'Reno Liver Spread 78g', C, UNO, '24x78g', 26.4, 1.69, 'A4', 5, 12, 72],
  ['4806515630000', 'Suka Pinakurat Spiced Vinegar 250ml', SC, UNO, '30/250ml', 54.0, 2.99, 'A2', 40, 15, 90],
  ['4800016052132', 'C2 Green Tea Apple & Lemon 455ml', B, UNO, '24/455ml', 26.4, 1.79, 'B1', 3, 24, 96],
  ['089686170795', 'IndoMie Mi Goreng Regular 85g', D, UNO, '40/85g', 22.0, 0.89, 'A3', 160, 40, 240],
  ['200104000011', 'SkyFlakes Crackers 250g', S, DI, '24/250g', 43.2, 2.99, 'A1', 30, 12, 72],
  ['200104000028', 'Datu Puti Soy Sauce 1L', SC, DI, '12/1L', 21.6, 2.79, 'A2', 15, 6, 36],
  ['200104000035', 'UFC Banana Ketchup 320g', SC, DI, '24/320g', 31.2, 2.29, 'A2', 2, 12, 48],
  ['200104000042', 'Mang Tomas All-Purpose Sauce 550g', SC, DI, '12/550g', 30.0, 3.99, 'A2', 14, 6, 36],
  ['200104000059', 'Century Tuna Flakes in Oil 180g', C, DI, '48/180g', 72.0, 2.29, 'A4', 70, 24, 144],
  ['200104000066', 'Ligo Sardines in Tomato Sauce 155g', C, DI, '50/155g', 45.0, 1.49, 'A4', 0, 25, 150],
  ['200104000073', 'CDO Pork Longganisa 454g', F, DI, '20/454g', 70.0, 5.99, 'F2', 12, 10, 40],
  ["200104000080", "Pampanga's Best Pork Tocino 450g", F, DI, '20/450g', 74.0, 6.49, 'F2', 4, 10, 40],
  ['200104000097', 'Kopiko Brown Coffee 3-in-1 10x25g', B, DI, '24/250g', 64.8, 3.99, 'B2', 30, 12, 48],
  ['200104000103', 'Calamansi Juice Drink 1L', B, DI, '12/1L', 30.0, 3.49, 'B1', 20, 6, 36],
  ['200104000110', 'Jasmine Rice 25 lb', D, DI, '1/25lb', 22.0, 32.99, 'C1', 18, 8, 40],
  ['200104000127', 'Lucky Me! Pancit Canton Original 60g', D, DI, '72/60g', 36.0, 0.79, 'A3', 200, 72, 360],
];

export const seedProducts = (): Product[] =>
  ROWS.map(([upc, name, category, vendor, packSize, caseCost, unitPrice, aisle, onHand, reorderPoint, targetLevel], i) => ({
    id: i + 1, upc, sku: `SMA-${upc}`, name, category, vendor, packSize, unitsPerCase: unitsFromPack(packSize),
    caseCost, unitPrice, aisle, onHand, reorderPoint, targetLevel,
  }));

// Line quantities and costs below are representative; edit them to match the paper invoices exactly.
const doc = (d: Omit<InvoiceDoc, 'total'>): InvoiceDoc => ({
  ...d,
  total: +d.lines.reduce((s, l) => s + l.qty * l.unitCost, 0).toFixed(2),
});

export const INVOICE_PRESETS: { key: string; label: string; doc: InvoiceDoc }[] = [
  {
    key: 'dong-phuong',
    label: 'Dong Phuong Distributor · #IN10073256',
    doc: doc({
      vendor: DP, invoiceNo: 'IN10073256', date: '2026-09-17', pages: 1,
      lines: [
        { upc: '08490900040', description: 'Cock Brand Tapioca Pearl Small', packSize: '50/400g', qty: 2, unitCost: 62.5, category: D },
        { upc: '480002457550', description: 'Del Monte Filipino Style Spaghetti Sauce', packSize: '12/900g', qty: 3, unitCost: 38.4, category: SC },
        { upc: '63516830083', description: 'Palm Liver Spread', packSize: '24/227g', qty: 1, unitCost: 52.8, category: C },
        { upc: '01622900058', description: 'Aroy-D Quail Eggs in Water', packSize: '24/425g', qty: 2, unitCost: 44.16, category: C },
        { upc: '480901052461', description: 'Sugo Cracker Nuts BBQ/Butter/Garlic', packSize: '24/100g', qty: 3, unitCost: 28.8, category: S },
        { upc: '74822999043', description: 'Nora Kitchen Tamarind Soup Base', packSize: '24/40g', qty: 2, unitCost: 21.6, category: SC },
        { upc: '480651704004', description: 'Delfi Knick Knacks', packSize: '20/60g', qty: 2, unitCost: 18.0, category: S },
        { upc: '480019417710', description: 'Oishi Rin-Bee Cheese Stick', packSize: '50/24g', qty: 2, unitCost: 22.5, category: S },
        { upc: '80048900237', description: 'ABC Jelly Straws', packSize: '24/300g', qty: 2, unitCost: 33.6, category: S },
        { upc: '76189860877', description: 'Choripdong Fried Fish Ball', packSize: '20/400g', qty: 2, unitCost: 54.0, category: F },
        { upc: '941489702054', description: "Talley's Greenshell Mussels", packSize: '12/1kg', qty: 1, unitCost: 96.0, category: F },
        { upc: '79356291122', description: 'Lucky Pinoy Bilo Bilo', packSize: '24/454g', qty: 1, unitCost: 57.6, category: F },
      ],
    }),
  },
  {
    key: 'uno-foods',
    label: 'UNO Foods Inc. · #IN00089529',
    doc: doc({
      vendor: UNO, invoiceNo: 'IN00089529', date: '2026-08-04', pages: 4,
      lines: [
        { upc: '77431', description: 'Golden Panda Condensada & Evaporada', packSize: '48/300ml', qty: 3, unitCost: 52.8, category: C },
        { upc: '774310210007', description: 'Sarangani Milkfish in Oil', packSize: '24/220g', qty: 2, unitCost: 50.4, category: C },
        { upc: '774310300203', description: 'Reno Liver Spread', packSize: '24x78g', qty: 3, unitCost: 26.4, category: C },
        { upc: '4806515630000', description: 'Suka Pinakurat', packSize: '30/250ml', qty: 2, unitCost: 54.0, category: SC },
        { upc: '4800016052132', description: 'C2 Green Tea Apple & Lemon', packSize: '24/455ml', qty: 4, unitCost: 26.4, category: B },
        { upc: '089686170795', description: 'IndoMie Mi Goreng Regular', packSize: '40/85g', qty: 5, unitCost: 22.0, category: D },
        // No UPC printed on the invoice: ingestion assigns an in-store code.
        { upc: '', description: "Lily's Peanut Butter", packSize: '12/340g', qty: 2, unitCost: 46.8, category: SC },
        { upc: '', description: "Mama Sita's Mixes", packSize: '24/50g', qty: 2, unitCost: 28.8, category: SC },
        { upc: '', description: 'Knorr Bouillon', packSize: '24/60g', qty: 2, unitCost: 31.2, category: D },
      ],
    }),
  },
];
