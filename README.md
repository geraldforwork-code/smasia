# SM ASIA · Store Inventory & POS (Store #104)

```
npm install
cp .env.example .env     # optional: SQL Server + Gemini settings
npm run dev              # http://localhost:3000  (Express + Vite)
npm run check            # typecheck + self-check of scan/alert/invoice rules
npm run build && npm start
```

- Without `MSSQL_*` the app runs on an in-memory store (resets on restart). The status badge says so.
- With SQL Server: T-SQL Hub → Connection → Connect, then Schema Script → Deploy (or run `StoreInventoryDB.sql` in SSMS).
  From then on every scan, count and invoice goes through `sp_ProcessBarcodeScan` / `sp_AdjustStock` / `sp_IngestInvoiceBatch`.
- This store: `.env` points at the local named instance `BLANCHARD-PC\SQLEXPRESS` / `StoreInventoryDB` with Windows authentication
  (`MSSQL_TRUSTED=true`, ODBC Driver 18 via msnodesqlv8). TCP and SQL Browser stay disabled; shared memory is used.
- Invoice OCR needs `GEMINI_API_KEY` (model from `GEMINI_MODEL`).
- Employee sessions are a 1-click switcher (header `x-user-id`), not real authentication. Keep it on the store LAN.
- Re-ordering: Purchase Orders (GM creates, `dbo.sp_CreatePurchaseOrder`, numbered `PO-104-#####`) → Invoice Intake → Receive
  (the delivery is ingested via `sp_IngestInvoiceBatch @PoNo`, which closes the PO in the same transaction).
  Upgrading an older database: T-SQL Hub → Schema Script → Deploy (idempotent; existing data is kept).
- Forecast: demand from POS `SCAN_SALE` history (last 28 days, 60/40 weighted 7-day/28-day rate) → days of cover, stockout date,
  suggested cases (horizon demand + reorder point − on hand − on order) → one-click PO per vendor. Days follow this server's clock.
- EPOS sales import (Forecast → Import EPOS sales report): Epos Now CSV, by-day or period summary. Columns are auto-detected
  and editable; rows match by barcode (leading zeros ignored), SKU, then exact name. A report replaces earlier imports for
  its dates (`sp_ImportSalesHistory`, tables `SalesImports` / `SalesHistory`). Forecast history only: stock is not changed.
- Epos Now DailySales_YYYY_MM_DD_HHMM.csv: select one or many files; each is one trading day (filename stamp is UTC →
  local sales date, editable). Weighed items use MeasuredQty. Barcode lists, leading zeros and missing check digits are matched.
- Catalog from Epos Now: the DailySales import can add missing items (SKU `EPOS-<ProductID>`, price before tax/discount,
  cost = TotCost/Qty, weighed items per lb). They start "Not tracked" (target level 0: no alerts or re-order suggestions)
  until counted and given levels via Inventory → Edit (`sp_CreateProducts`, `sp_UpdateProduct`).
- Products import/export (Inventory, GM only): import an Epos Now ProductList.csv (categories mapped once, remembered;
  adds missing items, optionally updates till price / cost / Uncategorized categories) or a catalog CSV exported from here
  and edited in Excel (matches by SKU then UPC; blank cells keep values; OnHand ignored). Export as full catalog CSV or
  Epos Now ProductList layout (`sp_CreateProducts`, `sp_BulkUpdateProducts`).
- Stock card (Inventory → click a product; GM + clerk): every IN/OUT with balance, opening/closing and totals by type for
  7/30/90 days or all time, CSV export, plus that product's imported Epos Now daily sales (not deducted from stock).
- Epos Now sales → stock: "Deduct these sales from stock on hand" (on by default) posts each imported line as an EPOS_SALE out.
  Skips sales dated before the product's latest cycle count, untracked products and weighed items; deducts to 0 and flags
  SHORT when the system has less than was sold; re-importing a day reverses its earlier postings first.
- Delete imported sales (Forecast → EPOS Sales Imports → Delete / Delete all; GM only): adds back stock those sales deducted
  (unless a shelf count was made since), then removes the lines so the day(s) can be imported again (`sp_DeleteSalesImport`).
