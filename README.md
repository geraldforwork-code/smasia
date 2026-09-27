# SM Asia Inventory

Web app for SM Asia Enterprises: inventory, purchase ordering, receiving, demand forecasting, and imports from EPOS reports, spreadsheets and supplier invoice PDFs. Built with ASP.NET Core 10 (Razor Pages) and SQL Server.

## Run it

Prerequisites: .NET 10 SDK and SQL Server (Express is fine).

```bash
dotnet run --project src/SmAsia.Web --urls http://localhost:5080
```

On first start the app creates the `SmAsiaInventory` database, applies migrations, and seeds the category list plus the two suppliers (UNO Foods, Dong Phuong). The connection string is in `src/SmAsia.Web/appsettings.json`:

```
Server=.\SQLEXPRESS;Database=SmAsiaInventory;Trusted_Connection=True;TrustServerCertificate=True
```

Run the tests:

```bash
dotnet test
```

## Modules

| Area | What it does |
| --- | --- |
| **Dashboard** | Stock value, items to reorder, open POs, expiring stock, weekly sales chart |
| **Products** | Search and filter by category, location, supplier or stock status; edit; per-product movement history, sales vs forecast chart, reorder calculation; export a count sheet (.xlsx) |
| **Stock count** | Count one aisle or category at a time; differences are posted as count adjustments |
| **Movements** | Ledger of every stock change (receipt, sale, count, adjustment, wastage) |
| **Forecast & reorder** | Demand per product, days of cover, reorder point and suggested cases; one click creates draft POs grouped by supplier |
| **Purchase orders** | Draft → Sent → Part received / Received; printable PO |
| **Receiving** | Read a supplier invoice PDF (or start a manual receipt / receive against a PO), review the line matches, then post to stock |
| **Imports** | EPOS sales (CSV/XLSX, any layout), inventory workbook, history, fixing unmatched rows, reversing an import |

## How stock works

- Stock is kept in **sellable units**. Orders and invoices are in **cases**: units = cases × units per case.
- `Products.QtyOnHand` changes only through `InventoryService`, which writes a `StockMovements` row every time.
- Receiving updates the **weighted average unit cost** (case cost ÷ units per case).
- **Sales and stock counts:** sales dated before a product's last stock count are kept for forecasting but **not deducted**, because the count already includes them. A count entered before noon counts as start-of-day and one entered after noon as end-of-day. This makes it safe to back-load months of EPOS history.

## Supplier invoice PDFs

`Services/Parsing` reads PDFs with PdfPig. It rebuilds rows from word positions and assigns numbers to the nearest column header. Supported layouts:

- **UNO Foods Inc.** (`UnoFoodsInvoiceParser`): multi-page, taxable `*` marker, checked against the invoice subtotal
- **Dong Phuong Distributor** (`DongPhuongInvoiceParser`): order vs ship qty, per-line GST, checked against the invoice total

Lines are matched to products in this order: **supplier item code** (learned on every posted receipt) → **UPC/EAN** (also works when the check digit is missing) → **name**. Units per case come from the pack size in the description (`24/425g` → 24, `20x(10x33g)` → 20). Invoices that were already entered are rejected unless you allow duplicates.

**Adding a supplier:** implement `IInvoiceParser` (see the two existing parsers), register it in `Program.cs`, and add a test in `tests/SmAsia.Tests/InvoiceParserTests.cs` with a sample PDF in `samples/`. Scanned (image-only) PDFs have no text layer; enter those as manual receipts.

## EPOS sales import

Upload a CSV or XLSX, check the columns (auto-detected), and import. The mapping is remembered per report layout. It needs a quantity column plus a barcode/PLU or a description. If the report has no date column, enter the period it covers and sales are spread evenly across those days. Unmatched items can be linked to a product or created. The link is saved as an alias, so the next import matches automatically. Any sales import can be reversed.

Old `.xls` files and PDF reports aren't supported. Export as CSV or XLSX instead.

## Forecasting method (`Services/Forecasting/DemandForecaster.cs`)

- **6+ weeks of history:** Holt's damped-trend exponential smoothing on weekly totals (α 0.35, β 0.10, φ 0.90). **Less history:** the average.
- Day-of-week pattern is estimated once there are 8+ weeks.
- Safety stock = z × σ(weekly) × √((lead time + order cycle) ÷ 7), with z from the service level (default 95%).
- Reorder point = daily demand × lead time + safety stock. When stock on hand plus stock on order drops to it, the app suggests whole cases up to demand × (lead time + order cycle) + safety stock.
- Lead time and order cycle are set per supplier. A product's minimum stock always applies.
- Settings are in the `Forecast` section of `appsettings.json`.

## Project layout

```
src/SmAsia.Web
  Data/            EF Core DbContext, entities, migrations, seed data
  Services/        InventoryService, ReceivingService, PurchasingService, ProductMatcher
    Parsing/       invoice PDF parsers
    Import/        CSV/XLSX reader, EPOS sales and inventory importers
    Forecasting/   demand forecast and reorder advice
  Pages/           Razor Pages UI
tests/SmAsia.Tests parser, forecast and import tests
samples/           the sample reports (SYNTHETIC-* files are generated test data, not real sales)
```

Schema changes: `dotnet ef migrations add <Name> -p src/SmAsia.Web -o Data/Migrations`. They're applied automatically on startup.

## Before using this for real

- **No login yet.** Add ASP.NET Core Identity or Windows authentication before exposing it beyond one PC.
- Back up the `SmAsiaInventory` database. SQL Express has no Agent, so use a scheduled `sqlcmd BACKUP DATABASE` task.
- To host it for the whole store, publish to IIS on the store PC (`dotnet publish -c Release`) or run it as a Windows service.
