// Microsoft SQL Server integration: T-SQL script, connection pool, stored-procedure calls.
import sql from 'mssql';
import type { Alert, Invoice, Movement, PostingSummary, Product, ProductInput, ProductLedger, PurchaseOrder, QueryResult, Role, SalesImport, SalesImportBody, SqlStatus, User } from '../src/shared.ts';
import { seedProducts, USERS } from './seed.ts';

export interface SqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  /** Windows authentication (Trusted_Connection) through ODBC Driver 18 + msnodesqlv8. */
  trusted: boolean;
  connectionString?: string;
}

export const envConfig = (): SqlConfig => ({
  host: process.env.MSSQL_HOST ?? '',
  port: +(process.env.MSSQL_PORT || 1433),
  database: process.env.MSSQL_DATABASE || 'StoreInventoryDB',
  user: process.env.MSSQL_USER ?? '',
  password: process.env.MSSQL_PASSWORD ?? '',
  encrypt: process.env.MSSQL_ENCRYPT !== 'false',
  trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE !== 'false',
  trusted: process.env.MSSQL_TRUSTED === 'true',
  connectionString: process.env.MSSQL_CONNECTION_STRING || undefined,
});

let cfg = envConfig();
let pool: sql.ConnectionPool | null = null;
let status: SqlStatus = offline(null);

function offline(error: string | null): SqlStatus {
  return {
    mode: 'IN_MEMORY', connected: false, host: cfg.host || 'localhost', port: cfg.port, database: cfg.database,
    user: cfg.user, schemaReady: false, latencyMs: null, version: null, error, checkedAt: new Date().toISOString(),
  };
}

export const sqlStatus = () => status;
/** True when reads/writes should go to SQL Server instead of the in-memory store. */
export const sqlLive = () => !!pool && status.connected && status.schemaReady;

/** Named instance ("HOST\SQLEXPRESS") is addressed by name, otherwise host,port. */
export const serverAddress = (c: Pick<SqlConfig, 'host' | 'port'>) => (c.host.includes('\\') ? c.host : `${c.host},${c.port}`);

async function makePool(c: SqlConfig): Promise<sql.ConnectionPool> {
  // Windows auth needs the native ODBC driver (tedious can't do integrated auth); it also reaches
  // local named instances over shared memory, so TCP and SQL Browser can stay disabled.
  const odbc = c.trusted || /Driver\s*=/i.test(c.connectionString ?? '');
  if (odbc) {
    const v8 = (await import('mssql/msnodesqlv8.js')).default;
    const connectionString = c.connectionString ||
      `Driver={ODBC Driver 18 for SQL Server};Server=${serverAddress(c)};Database=${c.database};Trusted_Connection=yes;` +
      `Encrypt=${c.encrypt ? 'yes' : 'no'};TrustServerCertificate=${c.trustServerCertificate ? 'yes' : 'no'};`;
    return new v8.ConnectionPool({ connectionString, connectionTimeout: 5000, requestTimeout: 15000 } as unknown as sql.config) as unknown as sql.ConnectionPool;
  }
  return c.connectionString
    ? new sql.ConnectionPool(c.connectionString)
    : new sql.ConnectionPool({
        server: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
        options: { encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate },
        connectionTimeout: 5000, requestTimeout: 15000,
      });
}

async function ping(p: sql.ConnectionPool) {
  const t = performance.now();
  const r = await p.request().query(
    `SELECT @@VERSION AS v, DB_NAME() AS db, CAST(CASE WHEN OBJECT_ID(N'dbo.sp_DeleteSalesImport', N'P') IS NULL OR COL_LENGTH(N'dbo.SalesHistory', N'QtyPosted') IS NULL THEN 0 ELSE 1 END AS BIT) AS ready`,
  );
  const row = r.recordset[0];
  return { latencyMs: Math.round(performance.now() - t), version: String(row.v).split('\n')[0].trim(), db: row.db as string, ready: !!row.ready };
}

/** Ping a config without adopting it. */
export async function testConfig(c: SqlConfig) {
  let p: sql.ConnectionPool | null = null;
  try {
    p = await makePool(c);
    await p.connect();
    return { ok: true as const, ...(await ping(p)) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  } finally {
    await p?.close().catch(() => {});
  }
}

/** Connect and adopt a config. Pass null to drop back to the in-memory store. */
export async function connect(c: SqlConfig | null): Promise<SqlStatus> {
  await pool?.close().catch(() => {});
  pool = null;
  if (!c) return (status = offline(null));
  cfg = c;
  if (!c.connectionString && !c.host) return (status = offline(null));
  try {
    const p = await makePool(c);
    await p.connect();
    pool = p;
    return refreshStatus();
  } catch (e) {
    return (status = offline((e as Error).message));
  }
}

export async function refreshStatus(): Promise<SqlStatus> {
  if (!pool) return (status = { ...status, checkedAt: new Date().toISOString() });
  try {
    const r = await ping(pool);
    status = {
      mode: r.ready ? 'MSSQL' : 'IN_MEMORY', connected: true, host: cfg.connectionString ? 'connection string' : cfg.host, port: cfg.port,
      database: r.db, user: cfg.trusted ? 'Windows authentication' : cfg.user, schemaReady: r.ready, latencyMs: r.latencyMs, version: r.version,
      error: r.ready ? null : 'Connected, but the schema is missing or out of date. Use T-SQL Hub → Schema Script → Deploy.',
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    status = { ...offline((e as Error).message), host: status.host };
  }
  return status;
}

const need = () => {
  if (!pool) throw Object.assign(new Error('SQL Server is not connected.'), { status: 503 });
  return pool;
};

// --- writes (each is one stored-procedure call) -----------------------------

export async function sqlScan(code: string, mode: 'SALE' | 'INTAKE', qty: number, userId: number) {
  const r = await need().request()
    .input('Code', sql.VarChar(32), code).input('Mode', sql.VarChar(10), mode)
    .input('Qty', sql.Int, qty).input('UserId', sql.Int, userId)
    .execute('dbo.sp_ProcessBarcodeScan');
  const row = r.recordset[0];
  return { ProductId: +row.ProductId, QtyBefore: +row.QtyBefore, QtyAfter: +row.QtyAfter, AlertId: row.AlertId == null ? null : +row.AlertId };
}

/** The ODBC driver can return INT/DECIMAL columns as strings; coerce the numeric ones back. */
const nums = <T extends Record<string, any>>(rows: T[], keys: string[]) =>
  rows.map((r) => { const o: Record<string, any> = { ...r }; for (const k of keys) if (o[k] != null) o[k] = Number(o[k]); return o; });

export async function sqlAdjust(productId: number, newOnHand: number, type: string, userId: number, ref: string | null) {
  await need().request()
    .input('ProductId', sql.Int, productId).input('NewOnHand', sql.Int, newOnHand)
    .input('MovementType', sql.VarChar(20), type).input('UserId', sql.Int, userId)
    .input('Reference', sql.NVarChar(60), ref).execute('dbo.sp_AdjustStock');
}

export interface IngestLine {
  upc: string; sku: string; description: string; packSize: string; unitsPerCase: number;
  qtyCases: number; caseCost: number; unitPrice: number; category: string;
}
export async function sqlIngest(
  inv: { vendor: string; invoiceNo: string; date: string; total: number; pages?: number; poNo?: string },
  lines: IngestLine[], userId: number,
) {
  await need().request()
    .input('Vendor', sql.NVarChar(100), inv.vendor).input('InvoiceNo', sql.VarChar(40), inv.invoiceNo)
    .input('InvoiceDate', sql.Date, inv.date ? new Date(inv.date) : null).input('Total', sql.Decimal(12, 2), inv.total)
    .input('Pages', sql.Int, inv.pages ?? null).input('UserId', sql.Int, userId)
    .input('ItemsJson', sql.NVarChar(sql.MAX), JSON.stringify(lines)).input('PoNo', sql.VarChar(20), inv.poNo ?? null)
    .execute('dbo.sp_IngestInvoiceBatch');
}

export async function sqlCreatePo(
  po: { vendor: string; expectedDate: string | null; notes: string | null }, lines: { productId: number; qty: number }[], userId: number,
) {
  const r = await need().request()
    .input('Vendor', sql.NVarChar(100), po.vendor).input('ExpectedDate', sql.Date, po.expectedDate ? new Date(po.expectedDate) : null)
    .input('Notes', sql.NVarChar(300), po.notes).input('UserId', sql.Int, userId)
    .input('ItemsJson', sql.NVarChar(sql.MAX), JSON.stringify(lines))
    .execute('dbo.sp_CreatePurchaseOrder');
  return { id: +r.recordset[0].PurchaseOrderId, poNo: String(r.recordset[0].PoNo) };
}

export async function sqlCancelPo(id: number) {
  const r = await need().request().input('Id', sql.Int, id)
    .query("UPDATE dbo.PurchaseOrders SET Status = 'CANCELLED' WHERE PurchaseOrderId = @Id AND Status = 'OPEN'; SELECT @@ROWCOUNT AS n;");
  return +r.recordset[0].n;
}

export async function sqlAck(alertId: number | null) {
  await need().request().input('Id', sql.Int, alertId)
    .query('UPDATE dbo.AlertNotifications SET IsAcknowledged = 1 WHERE IsAcknowledged = 0 AND (@Id IS NULL OR AlertId = @Id);');
}

export async function sqlSetRole(userId: number, role: Role) {
  await need().request().input('Id', sql.Int, userId).input('Role', sql.VarChar(20), role)
    .query('UPDATE dbo.AppUsers SET Role = @Role WHERE UserId = @Id;');
}

// --- reads ------------------------------------------------------------------

export async function sqlLoad() {
  const r = await need().request().query(`
SELECT p.ProductId AS id, p.UPC AS upc, p.SKU AS sku, p.Name AS name, p.Category AS category, p.Vendor AS vendor,
       p.PackSize AS packSize, p.UnitsPerCase AS unitsPerCase, CAST(p.CaseCost AS FLOAT) AS caseCost,
       CAST(p.UnitPrice AS FLOAT) AS unitPrice, p.Aisle AS aisle, i.OnHand AS onHand,
       i.ReorderPoint AS reorderPoint, i.TargetLevel AS targetLevel
FROM dbo.Products p JOIN dbo.Inventory i ON i.ProductId = p.ProductId WHERE p.IsActive = 1 ORDER BY p.ProductId;

SELECT TOP (200) m.MovementId AS id, m.CreatedAt AS ts, m.ProductId AS productId, p.UPC AS upc, p.Name AS name,
       m.MovementType AS type, m.QtyDelta AS qty, m.QtyBefore AS before, m.QtyAfter AS after,
       ISNULL(u.FullName, N'system') AS [user], m.Reference AS ref
FROM dbo.StockMovements m JOIN dbo.Products p ON p.ProductId = m.ProductId
LEFT JOIN dbo.AppUsers u ON u.UserId = m.UserId ORDER BY m.MovementId DESC;

SELECT TOP (100) a.AlertId AS id, a.CreatedAt AS ts, a.ProductId AS productId, p.UPC AS upc, p.Name AS name,
       a.Severity AS severity, a.OnHand AS onHand, a.ReorderPoint AS reorderPoint, a.Message AS message,
       a.IsAcknowledged AS ack
FROM dbo.AlertNotifications a JOIN dbo.Products p ON p.ProductId = a.ProductId ORDER BY a.AlertId DESC;

SELECT TOP (50) v.InvoiceId AS id, v.Vendor AS vendor, v.InvoiceNo AS invoiceNo,
       CONVERT(VARCHAR(10), v.InvoiceDate, 23) AS date, CAST(v.Total AS FLOAT) AS total, v.Pages AS pages,
       v.ReceivedAt AS receivedAt, ISNULL(u.FullName, N'system') AS receivedBy,
       (SELECT ii.UPC AS upc, ii.Description AS description, ii.PackSize AS packSize, ii.QtyCases AS qty,
               CAST(ii.CaseCost AS FLOAT) AS unitCost
        FROM dbo.InvoiceItems ii WHERE ii.InvoiceId = v.InvoiceId FOR JSON PATH) AS linesJson
FROM dbo.Invoices v LEFT JOIN dbo.AppUsers u ON u.UserId = v.ReceivedBy ORDER BY v.InvoiceId DESC;

SELECT UserId AS id, FullName AS name, Role AS role, Title AS title FROM dbo.AppUsers WHERE IsActive = 1 ORDER BY UserId;

SELECT TOP (100) po.PurchaseOrderId AS id, po.PoNo AS poNo, po.Vendor AS vendor, po.Status AS status, po.CreatedAt AS createdAt,
       ISNULL(u.FullName, N'system') AS createdBy, CONVERT(VARCHAR(10), po.ExpectedDate, 23) AS expectedDate, po.Notes AS notes,
       po.ReceivedInvoiceNo AS receivedInvoiceNo,
       (SELECT pi.ProductId AS productId, p.UPC AS upc, p.Name AS description, p.PackSize AS packSize, pi.QtyCases AS qty,
               CAST(pi.CaseCost AS FLOAT) AS unitCost
        FROM dbo.PurchaseOrderItems pi JOIN dbo.Products p ON p.ProductId = pi.ProductId
        WHERE pi.PurchaseOrderId = po.PurchaseOrderId FOR JSON PATH) AS linesJson
FROM dbo.PurchaseOrders po LEFT JOIN dbo.AppUsers u ON u.UserId = po.CreatedBy ORDER BY po.PurchaseOrderId DESC;`);
  const [products, movements, alerts, invoices, users, purchaseOrders] = r.recordsets as unknown as Record<string, any>[][];
  const iso = (d: Date) => new Date(d).toISOString();
  return {
    products: nums(products, ['id', 'unitsPerCase', 'caseCost', 'unitPrice', 'onHand', 'reorderPoint', 'targetLevel']) as Product[],
    movements: nums(movements, ['id', 'productId', 'qty', 'before', 'after']).map((m) => ({ ...m, ts: iso(m.ts) })) as Movement[],
    alerts: nums(alerts, ['id', 'productId', 'onHand', 'reorderPoint'])
      .map((a) => ({ ...a, ts: iso(a.ts), ack: [true, 1, '1', 'true'].includes(a.ack) })) as Alert[],
    invoices: nums(invoices, ['id', 'total', 'pages'])
      .map(({ linesJson, ...v }) => ({ ...v, receivedAt: iso(v.receivedAt), lines: JSON.parse(linesJson ?? '[]') })) as Invoice[],
    users: nums(users, ['id']) as User[],
    purchaseOrders: nums(purchaseOrders, ['id'])
      .map(({ linesJson, ...po }) => ({ ...po, createdAt: iso(po.createdAt), lines: JSON.parse(linesJson ?? '[]') })) as PurchaseOrder[],
  };
}

/** POS sales for the forecast window, pre-summed per product per UTC hour (local-day bucketing happens in Node). */
export async function sqlSalesHistory() {
  const r = await need().request().query(`
SELECT ProductId AS productId, DATEADD(HOUR, DATEDIFF(HOUR, 0, CreatedAt), 0) AS ts, SUM(-QtyDelta) AS units
FROM dbo.StockMovements
WHERE MovementType = 'SCAN_SALE' AND CreatedAt >= DATEADD(DAY, -29, SYSUTCDATETIME())
GROUP BY ProductId, DATEADD(HOUR, DATEDIFF(HOUR, 0, CreatedAt), 0);

SELECT MIN(CreatedAt) AS firstAt FROM dbo.StockMovements;

SELECT ProductId AS productId, CONVERT(VARCHAR(10), SaleDate, 23) AS ts, CAST(QtySold AS FLOAT) AS units
FROM dbo.SalesHistory WHERE SaleDate >= DATEADD(DAY, -29, CAST(SYSDATETIME() AS DATE));

SELECT CONVERT(VARCHAR(10), MIN(SaleDate), 23) AS firstDate FROM dbo.SalesHistory;

SELECT TOP (25) s.SalesImportId AS id, s.FileName AS fileName, CONVERT(VARCHAR(10), s.PeriodFrom, 23) AS periodFrom,
       CONVERT(VARCHAR(10), s.PeriodTo, 23) AS periodTo, s.RowsImported AS [rows], CAST(s.UnitsImported AS FLOAT) AS units,
       ISNULL(u.FullName, N'system') AS importedBy, s.ImportedAt AS importedAt
FROM dbo.SalesImports s LEFT JOIN dbo.AppUsers u ON u.UserId = s.ImportedBy ORDER BY s.SalesImportId DESC;`);
  const [moves, first, sales, firstSale, imports] = r.recordsets as unknown as Record<string, any>[][];
  return {
    rows: [
      ...moves.map((x) => ({ productId: +x.productId, ts: new Date(x.ts) as Date | string, units: +x.units })),
      ...sales.map((x) => ({ productId: +x.productId, ts: String(x.ts), units: +x.units })),
    ],
    firstAt: first[0]?.firstAt ? new Date(first[0].firstAt) : null,
    firstSaleDate: (firstSale[0]?.firstDate as string | null) ?? null,
    imports: nums(imports, ['id', 'rows', 'units']).map((i) => ({ ...i, importedAt: new Date(i.importedAt).toISOString() })) as SalesImport[],
  };
}

export async function sqlBulkUpdateProducts(items: (Omit<ProductInput, 'upc' | 'sku'> & { id: number })[]) {
  const r = await need().request().input('ItemsJson', sql.NVarChar(sql.MAX), JSON.stringify(items)).execute('dbo.sp_BulkUpdateProducts');
  return +r.recordset[0].Updated;
}

export async function sqlCreateProducts(items: ProductInput[]) {
  const r = await need().request().input('ItemsJson', sql.NVarChar(sql.MAX), JSON.stringify(items)).execute('dbo.sp_CreateProducts');
  return +r.recordset[0].Created;
}

export async function sqlUpdateProduct(id: number, p: Omit<ProductInput, 'upc' | 'sku'>) {
  await need().request()
    .input('ProductId', sql.Int, id).input('Name', sql.NVarChar(200), p.name).input('Category', sql.NVarChar(50), p.category)
    .input('Vendor', sql.NVarChar(100), p.vendor).input('PackSize', sql.NVarChar(50), p.packSize).input('UnitsPerCase', sql.Int, p.unitsPerCase)
    .input('CaseCost', sql.Decimal(12, 2), p.caseCost).input('UnitPrice', sql.Decimal(12, 2), p.unitPrice).input('Aisle', sql.VarChar(10), p.aisle)
    .input('ReorderPoint', sql.Int, p.reorderPoint).input('TargetLevel', sql.Int, p.targetLevel)
    .execute('dbo.sp_UpdateProduct');
}

export const LEDGER_LIMIT = 5000;
export async function sqlProductLedger(productId: number) {
  const r = await need().request().input('Id', sql.Int, productId).input('Limit', sql.Int, LEDGER_LIMIT + 1).query(`
SELECT TOP (@Limit) m.MovementId AS id, m.CreatedAt AS ts, m.ProductId AS productId, p.UPC AS upc, p.Name AS name,
       m.MovementType AS type, m.QtyDelta AS qty, m.QtyBefore AS before, m.QtyAfter AS after,
       ISNULL(u.FullName, N'system') AS [user], m.Reference AS ref
FROM dbo.StockMovements m JOIN dbo.Products p ON p.ProductId = m.ProductId
LEFT JOIN dbo.AppUsers u ON u.UserId = m.UserId
WHERE m.ProductId = @Id ORDER BY m.MovementId DESC;

SELECT CONVERT(VARCHAR(10), h.SaleDate, 23) AS date, CAST(h.QtySold AS FLOAT) AS qty, s.FileName AS fileName,
       h.QtyPosted AS posted, h.PostStatus AS status
FROM dbo.SalesHistory h JOIN dbo.SalesImports s ON s.SalesImportId = h.SalesImportId
WHERE h.ProductId = @Id ORDER BY h.SaleDate DESC;`);
  const [moves, sales] = r.recordsets as unknown as Record<string, any>[][];
  return {
    movements: nums(moves, ['id', 'productId', 'qty', 'before', 'after']).map((m) => ({ ...m, ts: new Date(m.ts).toISOString() })) as Movement[],
    sales: nums(sales, ['qty', 'posted']) as ProductLedger['sales'],
  };
}

export async function sqlDeleteSalesImport(id: number | null, userId: number) {
  const r = await need().request().input('SalesImportId', sql.Int, id).input('UserId', sql.Int, userId).execute('dbo.sp_DeleteSalesImport');
  return { linesDeleted: +r.recordset[0].LinesDeleted, unitsRestored: +r.recordset[0].UnitsRestored };
}

export async function sqlImportSales(b: SalesImportBody & { rows: { dayEndUtc: string }[] }, userId: number) {
  const r = await need().request()
    .input('FileName', sql.NVarChar(260), b.fileName).input('PeriodFrom', sql.VarChar(10), b.periodFrom)
    .input('PeriodTo', sql.VarChar(10), b.periodTo).input('UserId', sql.Int, userId)
    .input('RowsJson', sql.NVarChar(sql.MAX), JSON.stringify(b.rows)).input('Post', sql.Bit, !!b.post)
    .execute('dbo.sp_ImportSalesHistory');
  const summary = (r.recordsets as unknown as Record<string, any>[][])[1] ?? [];
  return nums(summary, ['lines', 'sold', 'posted']) as PostingSummary[];
}

/** Ad-hoc query console. Runs inside a transaction that is always rolled back, so it can never change data. */
export async function sqlQuery(text: string): Promise<QueryResult> {
  const tx = need().transaction();
  await tx.begin();
  const t = performance.now();
  try {
    const r = await tx.request().query(text);
    const rows = (r.recordset ?? []) as Record<string, unknown>[];
    const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : Object.keys(rows[0] ?? {});
    return { columns, rows: rows.slice(0, 1000), ms: Math.round(performance.now() - t), mode: 'MSSQL' };
  } finally {
    await tx.rollback().catch(() => {});
  }
}

/** Runs the deployable part of the script (no CREATE DATABASE / USE) batch by batch. */
export async function sqlDeploy() {
  const p = need();
  const batches = buildScript(false).split(/^\s*GO\s*$/im).map((b) => b.trim()).filter(Boolean);
  for (const b of batches) await p.request().batch(b);
  return refreshStatus();
}

// --- T-SQL script -----------------------------------------------------------

const q = (s: string) => `N'${s.replace(/'/g, "''")}'`;

export function buildScript(createDb = true) {
  const products = seedProducts();
  const head = createDb
    ? `IF DB_ID(N'StoreInventoryDB') IS NULL CREATE DATABASE StoreInventoryDB;
GO
USE StoreInventoryDB;
GO
`
    : '';
  return `/* =====================================================================
   SM ASIA · Store #104 · SM Asia Enterprises Inc. · Lloydminster, SK
   StoreInventoryDB · Microsoft SQL Server 2022 (T-SQL)
   Idempotent: safe to run more than once.
   ===================================================================== */
${head}SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ---------- Tables ---------- */
IF OBJECT_ID(N'dbo.AppUsers', N'U') IS NULL
CREATE TABLE dbo.AppUsers (
    UserId      INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUsers PRIMARY KEY,
    FullName    NVARCHAR(100)     NOT NULL,
    Role        VARCHAR(20)       NOT NULL CONSTRAINT CK_AppUsers_Role CHECK (Role IN ('ADMIN','CLERK','CASHIER')),
    Title       NVARCHAR(100)     NULL,
    IsActive    BIT               NOT NULL CONSTRAINT DF_AppUsers_IsActive DEFAULT (1),
    CreatedAt   DATETIME2(3)      NOT NULL CONSTRAINT DF_AppUsers_CreatedAt DEFAULT (SYSUTCDATETIME())
);
GO

IF OBJECT_ID(N'dbo.Products', N'U') IS NULL
CREATE TABLE dbo.Products (
    ProductId    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Products PRIMARY KEY,
    UPC          VARCHAR(20)       NOT NULL,
    SKU          VARCHAR(32)       NOT NULL,
    Name         NVARCHAR(200)     NOT NULL,
    Category     NVARCHAR(50)      NOT NULL,
    Vendor       NVARCHAR(100)     NULL,
    PackSize     NVARCHAR(50)      NULL,
    UnitsPerCase INT               NOT NULL CONSTRAINT CK_Products_UnitsPerCase CHECK (UnitsPerCase > 0),
    CaseCost     DECIMAL(12,2)     NOT NULL CONSTRAINT CK_Products_CaseCost CHECK (CaseCost >= 0),
    UnitPrice    DECIMAL(12,2)     NOT NULL CONSTRAINT CK_Products_UnitPrice CHECK (UnitPrice >= 0),
    Aisle        VARCHAR(10)       NULL,
    IsActive     BIT               NOT NULL CONSTRAINT DF_Products_IsActive DEFAULT (1),
    CreatedAt    DATETIME2(3)      NOT NULL CONSTRAINT DF_Products_CreatedAt DEFAULT (SYSUTCDATETIME())
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_Products_UPC')
    CREATE UNIQUE NONCLUSTERED INDEX UX_Products_UPC ON dbo.Products (UPC) INCLUDE (Name, UnitPrice, UnitsPerCase);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_Products_SKU')
    CREATE UNIQUE NONCLUSTERED INDEX UX_Products_SKU ON dbo.Products (SKU);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Products_Category')
    CREATE NONCLUSTERED INDEX IX_Products_Category ON dbo.Products (Category);
GO

IF OBJECT_ID(N'dbo.Inventory', N'U') IS NULL
CREATE TABLE dbo.Inventory (
    ProductId    INT          NOT NULL CONSTRAINT PK_Inventory PRIMARY KEY
                              CONSTRAINT FK_Inventory_Products REFERENCES dbo.Products (ProductId),
    OnHand       INT          NOT NULL CONSTRAINT DF_Inventory_OnHand DEFAULT (0)
                              CONSTRAINT CK_Inventory_OnHand CHECK (OnHand >= 0),
    ReorderPoint INT          NOT NULL,
    TargetLevel  INT          NOT NULL,
    UpdatedAt    DATETIME2(3) NOT NULL CONSTRAINT DF_Inventory_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    RowVer       ROWVERSION
);
GO

IF OBJECT_ID(N'dbo.Invoices', N'U') IS NULL
CREATE TABLE dbo.Invoices (
    InvoiceId   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Invoices PRIMARY KEY,
    Vendor      NVARCHAR(100)     NOT NULL,
    InvoiceNo   VARCHAR(40)       NOT NULL CONSTRAINT UQ_Invoices_InvoiceNo UNIQUE,
    InvoiceDate DATE              NULL,
    Total       DECIMAL(12,2)     NULL,
    Pages       INT               NULL,
    Status      VARCHAR(12)       NOT NULL CONSTRAINT DF_Invoices_Status DEFAULT ('RECEIVED'),
    ReceivedBy  INT               NULL CONSTRAINT FK_Invoices_AppUsers REFERENCES dbo.AppUsers (UserId),
    ReceivedAt  DATETIME2(3)      NOT NULL CONSTRAINT DF_Invoices_ReceivedAt DEFAULT (SYSUTCDATETIME())
);
GO

IF OBJECT_ID(N'dbo.InvoiceItems', N'U') IS NULL
CREATE TABLE dbo.InvoiceItems (
    InvoiceItemId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_InvoiceItems PRIMARY KEY,
    InvoiceId     INT               NOT NULL CONSTRAINT FK_InvoiceItems_Invoices REFERENCES dbo.Invoices (InvoiceId),
    ProductId     INT               NOT NULL CONSTRAINT FK_InvoiceItems_Products REFERENCES dbo.Products (ProductId),
    UPC           VARCHAR(20)       NOT NULL,
    Description   NVARCHAR(200)     NOT NULL,
    PackSize      NVARCHAR(50)      NULL,
    QtyCases      INT               NOT NULL CONSTRAINT CK_InvoiceItems_Qty CHECK (QtyCases > 0),
    CaseCost      DECIMAL(12,2)     NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_InvoiceItems_UPC')
    CREATE NONCLUSTERED INDEX IX_InvoiceItems_UPC ON dbo.InvoiceItems (UPC);
GO

IF OBJECT_ID(N'dbo.StockMovements', N'U') IS NULL
CREATE TABLE dbo.StockMovements (
    MovementId   BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_StockMovements PRIMARY KEY,
    ProductId    INT                  NOT NULL CONSTRAINT FK_StockMovements_Products REFERENCES dbo.Products (ProductId),
    MovementType VARCHAR(20)          NOT NULL CONSTRAINT CK_StockMovements_Type
                                      CHECK (MovementType IN ('SCAN_SALE','EPOS_SALE','INVOICE_INTAKE','CYCLE_COUNT','ADJUSTMENT')),
    QtyDelta     INT                  NOT NULL,
    QtyBefore    INT                  NOT NULL,
    QtyAfter     INT                  NOT NULL,
    UserId       INT                  NULL CONSTRAINT FK_StockMovements_AppUsers REFERENCES dbo.AppUsers (UserId),
    Reference    NVARCHAR(60)         NULL,
    CreatedAt    DATETIME2(3)         NOT NULL CONSTRAINT DF_StockMovements_CreatedAt DEFAULT (SYSUTCDATETIME())
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_StockMovements_Product_Created')
    CREATE NONCLUSTERED INDEX IX_StockMovements_Product_Created ON dbo.StockMovements (ProductId, CreatedAt DESC);
GO

IF OBJECT_ID(N'dbo.AlertNotifications', N'U') IS NULL
CREATE TABLE dbo.AlertNotifications (
    AlertId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AlertNotifications PRIMARY KEY,
    ProductId      INT               NOT NULL CONSTRAINT FK_AlertNotifications_Products REFERENCES dbo.Products (ProductId),
    Severity       VARCHAR(10)       NOT NULL CONSTRAINT CK_AlertNotifications_Severity CHECK (Severity IN ('WARNING','CRITICAL')),
    OnHand         INT               NOT NULL,
    ReorderPoint   INT               NOT NULL,
    Message        NVARCHAR(300)     NOT NULL,
    IsAcknowledged BIT               NOT NULL CONSTRAINT DF_AlertNotifications_Ack DEFAULT (0),
    CreatedAt      DATETIME2(3)      NOT NULL CONSTRAINT DF_AlertNotifications_CreatedAt DEFAULT (SYSUTCDATETIME())
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AlertNotifications_Open')
    CREATE NONCLUSTERED INDEX IX_AlertNotifications_Open ON dbo.AlertNotifications (IsAcknowledged, AlertId DESC);
GO

IF OBJECT_ID(N'dbo.PurchaseOrderNo', N'SO') IS NULL
    CREATE SEQUENCE dbo.PurchaseOrderNo AS INT START WITH 1 INCREMENT BY 1;
GO

IF OBJECT_ID(N'dbo.PurchaseOrders', N'U') IS NULL
CREATE TABLE dbo.PurchaseOrders (
    PurchaseOrderId   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PurchaseOrders PRIMARY KEY,
    PoNo              VARCHAR(20)       NOT NULL CONSTRAINT UQ_PurchaseOrders_PoNo UNIQUE,
    Vendor            NVARCHAR(100)     NOT NULL,
    Status            VARCHAR(12)       NOT NULL CONSTRAINT DF_PurchaseOrders_Status DEFAULT ('OPEN')
                                        CONSTRAINT CK_PurchaseOrders_Status CHECK (Status IN ('OPEN','RECEIVED','CANCELLED')),
    ExpectedDate      DATE              NULL,
    Notes             NVARCHAR(300)     NULL,
    CreatedBy         INT               NULL CONSTRAINT FK_PurchaseOrders_AppUsers REFERENCES dbo.AppUsers (UserId),
    CreatedAt         DATETIME2(3)      NOT NULL CONSTRAINT DF_PurchaseOrders_CreatedAt DEFAULT (SYSUTCDATETIME()),
    ReceivedInvoiceNo VARCHAR(40)       NULL,
    ReceivedAt        DATETIME2(3)      NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PurchaseOrders_Status')
    CREATE NONCLUSTERED INDEX IX_PurchaseOrders_Status ON dbo.PurchaseOrders (Status, Vendor);
GO

IF OBJECT_ID(N'dbo.PurchaseOrderItems', N'U') IS NULL
CREATE TABLE dbo.PurchaseOrderItems (
    PurchaseOrderItemId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PurchaseOrderItems PRIMARY KEY,
    PurchaseOrderId     INT               NOT NULL CONSTRAINT FK_PurchaseOrderItems_PurchaseOrders REFERENCES dbo.PurchaseOrders (PurchaseOrderId),
    ProductId           INT               NOT NULL CONSTRAINT FK_PurchaseOrderItems_Products REFERENCES dbo.Products (ProductId),
    QtyCases            INT               NOT NULL CONSTRAINT CK_PurchaseOrderItems_Qty CHECK (QtyCases > 0),
    CaseCost            DECIMAL(12,2)     NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PurchaseOrderItems_Product')
    CREATE NONCLUSTERED INDEX IX_PurchaseOrderItems_Product ON dbo.PurchaseOrderItems (ProductId) INCLUDE (QtyCases);
GO

IF OBJECT_ID(N'dbo.SalesImports', N'U') IS NULL
CREATE TABLE dbo.SalesImports (
    SalesImportId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SalesImports PRIMARY KEY,
    FileName      NVARCHAR(260)     NOT NULL,
    Source        VARCHAR(20)       NOT NULL CONSTRAINT DF_SalesImports_Source DEFAULT ('EPOSNOW'),
    PeriodFrom    DATE              NOT NULL,
    PeriodTo      DATE              NOT NULL,
    RowsImported  INT               NOT NULL,
    UnitsImported DECIMAL(14,3)     NOT NULL,
    ImportedBy    INT               NULL CONSTRAINT FK_SalesImports_AppUsers REFERENCES dbo.AppUsers (UserId),
    ImportedAt    DATETIME2(3)      NOT NULL CONSTRAINT DF_SalesImports_ImportedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_SalesImports_Period CHECK (PeriodTo >= PeriodFrom)
);
GO

IF OBJECT_ID(N'dbo.SalesHistory', N'U') IS NULL
CREATE TABLE dbo.SalesHistory (
    SalesHistoryId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SalesHistory PRIMARY KEY,
    ProductId      INT                  NOT NULL CONSTRAINT FK_SalesHistory_Products REFERENCES dbo.Products (ProductId),
    SaleDate       DATE                 NOT NULL,
    QtySold        DECIMAL(12,3)        NOT NULL,
    SalesImportId  INT                  NOT NULL CONSTRAINT FK_SalesHistory_SalesImports REFERENCES dbo.SalesImports (SalesImportId),
    CONSTRAINT UQ_SalesHistory_Product_Date UNIQUE (ProductId, SaleDate)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SalesHistory_Date')
    CREATE NONCLUSTERED INDEX IX_SalesHistory_Date ON dbo.SalesHistory (SaleDate) INCLUDE (ProductId, QtySold);
GO

/* ---------- Upgrades for databases created by earlier versions ---------- */
IF COL_LENGTH(N'dbo.SalesHistory', N'QtyPosted') IS NULL
    ALTER TABLE dbo.SalesHistory ADD
        QtyPosted  INT         NOT NULL CONSTRAINT DF_SalesHistory_QtyPosted DEFAULT (0),  -- units deducted from stock
        PostStatus VARCHAR(12) NULL;                                                        -- NULL = not posted to stock
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_StockMovements_Type' AND definition NOT LIKE N'%EPOS_SALE%')
    ALTER TABLE dbo.StockMovements DROP CONSTRAINT CK_StockMovements_Type;
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_StockMovements_Type')
    ALTER TABLE dbo.StockMovements ADD CONSTRAINT CK_StockMovements_Type
        CHECK (MovementType IN ('SCAN_SALE','EPOS_SALE','INVOICE_INTAKE','CYCLE_COUNT','ADJUSTMENT'));
GO

/* ---------- Trigger: low-stock / depletion alerts ---------- */
CREATE OR ALTER TRIGGER dbo.trg_CheckLowStock ON dbo.Inventory
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT UPDATE(OnHand) RETURN;

    INSERT dbo.AlertNotifications (ProductId, Severity, OnHand, ReorderPoint, Message)
    SELECT i.ProductId,
           CASE WHEN i.OnHand = 0 THEN 'CRITICAL' ELSE 'WARNING' END,
           i.OnHand, i.ReorderPoint,
           CASE WHEN i.OnHand = 0
                THEN CONCAT(p.Name, N' is depleted (0 on hand)')
                ELSE CONCAT(p.Name, N' at ', i.OnHand, N' units, at/below reorder point ', i.ReorderPoint) END
    FROM inserted i
    JOIN deleted d  ON d.ProductId = i.ProductId
    JOIN dbo.Products p ON p.ProductId = i.ProductId
    WHERE (i.OnHand = 0 AND d.OnHand > 0)
       OR (i.OnHand <= i.ReorderPoint AND d.OnHand > i.ReorderPoint);
END;
GO

/* ---------- Procedure: single barcode scan (POS sale or dock intake) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_ProcessBarcodeScan
    @Code      VARCHAR(32),          -- UPC or SKU
    @Mode      VARCHAR(10),          -- 'SALE' (-Qty eaches) | 'INTAKE' (+Qty cases)
    @Qty       INT,
    @UserId    INT,
    @Reference NVARCHAR(60) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @Qty IS NULL OR @Qty <= 0 THROW 50001, 'Quantity must be a positive whole number.', 1;
    IF @Mode NOT IN ('SALE', 'INTAKE') THROW 50002, 'Mode must be SALE or INTAKE.', 1;

    DECLARE @ProductId INT, @UnitsPerCase INT, @Before INT, @Delta INT, @LastAlert INT;
    SELECT @LastAlert = ISNULL(MAX(AlertId), 0) FROM dbo.AlertNotifications;

    BEGIN TRAN;
        SELECT @ProductId = p.ProductId, @UnitsPerCase = p.UnitsPerCase, @Before = i.OnHand
        FROM dbo.Products p
        JOIN dbo.Inventory i WITH (UPDLOCK, ROWLOCK) ON i.ProductId = p.ProductId
        WHERE (p.UPC = @Code OR p.SKU = @Code) AND p.IsActive = 1;

        IF @ProductId IS NULL THROW 50404, 'Unknown barcode.', 1;

        SET @Delta = CASE WHEN @Mode = 'SALE' THEN -@Qty ELSE @Qty * @UnitsPerCase END;
        IF @Before + @Delta < 0 THROW 50409, 'Insufficient stock on hand. Run a cycle count.', 1;

        UPDATE dbo.Inventory                         -- fires trg_CheckLowStock
        SET OnHand = @Before + @Delta, UpdatedAt = SYSUTCDATETIME()
        WHERE ProductId = @ProductId;

        INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
        VALUES (@ProductId, CASE WHEN @Mode = 'SALE' THEN 'SCAN_SALE' ELSE 'INVOICE_INTAKE' END,
                @Delta, @Before, @Before + @Delta, @UserId, @Reference);
    COMMIT;

    SELECT @ProductId AS ProductId, @Before AS QtyBefore, @Before + @Delta AS QtyAfter,
           (SELECT MAX(AlertId) FROM dbo.AlertNotifications WHERE ProductId = @ProductId AND AlertId > @LastAlert) AS AlertId;
END;
GO

/* ---------- Procedure: cycle count / shelf adjustment ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_AdjustStock
    @ProductId    INT,
    @NewOnHand    INT,
    @MovementType VARCHAR(20),       -- 'CYCLE_COUNT' | 'ADJUSTMENT'
    @UserId       INT,
    @Reference    NVARCHAR(60) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @NewOnHand IS NULL OR @NewOnHand < 0 THROW 50001, 'On-hand count cannot be negative.', 1;
    IF @MovementType NOT IN ('CYCLE_COUNT', 'ADJUSTMENT') THROW 50002, 'Invalid adjustment type.', 1;

    DECLARE @Before INT;
    BEGIN TRAN;
        SELECT @Before = OnHand FROM dbo.Inventory WITH (UPDLOCK, ROWLOCK) WHERE ProductId = @ProductId;
        IF @Before IS NULL THROW 50404, 'Unknown product.', 1;

        UPDATE dbo.Inventory SET OnHand = @NewOnHand, UpdatedAt = SYSUTCDATETIME() WHERE ProductId = @ProductId;
        INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
        VALUES (@ProductId, @MovementType, @NewOnHand - @Before, @Before, @NewOnHand, @UserId, @Reference);
    COMMIT;
END;
GO

/* ---------- Procedure: bulk invoice receipt ----------
   @ItemsJson: [{"upc","sku","description","packSize","unitsPerCase","qtyCases","caseCost","unitPrice","category"}] */
CREATE OR ALTER PROCEDURE dbo.sp_IngestInvoiceBatch
    @Vendor      NVARCHAR(100),
    @InvoiceNo   VARCHAR(40),
    @InvoiceDate DATE,
    @Total       DECIMAL(12,2),
    @Pages       INT = NULL,
    @UserId      INT,
    @ItemsJson   NVARCHAR(MAX),
    @PoNo        VARCHAR(20) = NULL  -- open purchase order this delivery fulfils
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF ISJSON(@ItemsJson) <> 1 THROW 50003, 'ItemsJson is not valid JSON.', 1;

    DECLARE @Lines TABLE (
        UPC VARCHAR(20) NOT NULL, SKU VARCHAR(32) NOT NULL, Description NVARCHAR(200) NOT NULL,
        PackSize NVARCHAR(50) NULL, UnitsPerCase INT NOT NULL, QtyCases INT NOT NULL,
        CaseCost DECIMAL(12,2) NOT NULL, UnitPrice DECIMAL(12,2) NOT NULL, Category NVARCHAR(50) NOT NULL);
    INSERT @Lines
    SELECT upc, sku, description, packSize, unitsPerCase, qtyCases, caseCost, unitPrice, category
    FROM OPENJSON(@ItemsJson) WITH (
        upc VARCHAR(20), sku VARCHAR(32), description NVARCHAR(200), packSize NVARCHAR(50),
        unitsPerCase INT, qtyCases INT, caseCost DECIMAL(12,2), unitPrice DECIMAL(12,2), category NVARCHAR(50));
    IF NOT EXISTS (SELECT 1 FROM @Lines) THROW 50004, 'Invoice has no line items.', 1;
    IF EXISTS (SELECT 1 FROM @Lines WHERE QtyCases <= 0) THROW 50005, 'Line quantities must be positive.', 1;

    DECLARE @InvoiceId INT;
    DECLARE @Moves TABLE (ProductId INT, Delta INT, QtyBefore INT, QtyAfter INT);

    BEGIN TRAN;
        IF EXISTS (SELECT 1 FROM dbo.Invoices WITH (UPDLOCK, HOLDLOCK) WHERE InvoiceNo = @InvoiceNo)
            THROW 50410, 'This invoice number has already been ingested.', 1;
        IF @PoNo IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM dbo.PurchaseOrders WITH (UPDLOCK, HOLDLOCK) WHERE PoNo = @PoNo AND Status = 'OPEN')
            THROW 50411, 'That purchase order is not open (already received or cancelled).', 1;

        -- New products enter the catalog with a 1-case reorder point and 3-case target.
        INSERT dbo.Products (UPC, SKU, Name, Category, Vendor, PackSize, UnitsPerCase, CaseCost, UnitPrice, Aisle)
        SELECT DISTINCT l.UPC, l.SKU, l.Description, l.Category, @Vendor, l.PackSize, l.UnitsPerCase, l.CaseCost, l.UnitPrice, 'RCV'
        FROM @Lines l
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.UPC = l.UPC);

        INSERT dbo.Inventory (ProductId, OnHand, ReorderPoint, TargetLevel)
        SELECT p.ProductId, 0, p.UnitsPerCase, p.UnitsPerCase * 3
        FROM dbo.Products p
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Inventory i WHERE i.ProductId = p.ProductId);

        -- Latest invoice cost wins.
        UPDATE p SET p.CaseCost = l.CaseCost
        FROM dbo.Products p JOIN @Lines l ON l.UPC = p.UPC;

        INSERT dbo.Invoices (Vendor, InvoiceNo, InvoiceDate, Total, Pages, ReceivedBy)
        VALUES (@Vendor, @InvoiceNo, @InvoiceDate, @Total, @Pages, @UserId);
        SET @InvoiceId = SCOPE_IDENTITY();

        INSERT dbo.InvoiceItems (InvoiceId, ProductId, UPC, Description, PackSize, QtyCases, CaseCost)
        SELECT @InvoiceId, p.ProductId, l.UPC, l.Description, l.PackSize, l.QtyCases, l.CaseCost
        FROM @Lines l JOIN dbo.Products p ON p.UPC = l.UPC;

        UPDATE i
        SET i.OnHand = i.OnHand + x.Delta, i.UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.ProductId, x.Delta, deleted.OnHand, inserted.OnHand INTO @Moves (ProductId, Delta, QtyBefore, QtyAfter)
        FROM dbo.Inventory i WITH (UPDLOCK, ROWLOCK)
        JOIN (SELECT p.ProductId, SUM(l.QtyCases * p.UnitsPerCase) AS Delta
              FROM @Lines l JOIN dbo.Products p ON p.UPC = l.UPC
              GROUP BY p.ProductId) x ON x.ProductId = i.ProductId;

        INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
        SELECT ProductId, 'INVOICE_INTAKE', Delta, QtyBefore, QtyAfter, @UserId,
               CONCAT(N'INV ', @InvoiceNo, CASE WHEN @PoNo IS NULL THEN N'' ELSE CONCAT(N' / ', @PoNo) END)
        FROM @Moves;

        -- ponytail: a short shipment still closes the PO; add backorder lines if vendors split deliveries often.
        UPDATE dbo.PurchaseOrders
        SET Status = 'RECEIVED', ReceivedInvoiceNo = @InvoiceNo, ReceivedAt = SYSUTCDATETIME()
        WHERE PoNo = @PoNo;
    COMMIT;

    SELECT @InvoiceId AS InvoiceId, (SELECT COUNT(*) FROM @Moves) AS ProductsUpdated;
END;
GO

/* ---------- Procedure: purchase order for re-ordering ----------
   @ItemsJson: [{"productId":1,"qty":2}]  (qty in cases; cost is taken from the current catalog case cost) */
CREATE OR ALTER PROCEDURE dbo.sp_CreatePurchaseOrder
    @Vendor       NVARCHAR(100),
    @ExpectedDate DATE = NULL,
    @Notes        NVARCHAR(300) = NULL,
    @UserId       INT,
    @ItemsJson    NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF ISJSON(@ItemsJson) <> 1 THROW 50003, 'ItemsJson is not valid JSON.', 1;

    DECLARE @Lines TABLE (ProductId INT NULL, Qty INT NULL);
    INSERT @Lines SELECT productId, qty FROM OPENJSON(@ItemsJson) WITH (productId INT, qty INT);
    IF NOT EXISTS (SELECT 1 FROM @Lines) THROW 50004, 'Purchase order has no lines.', 1;
    IF EXISTS (SELECT 1 FROM @Lines WHERE Qty IS NULL OR Qty <= 0) THROW 50005, 'Line quantities must be positive.', 1;
    IF EXISTS (SELECT 1 FROM @Lines l WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ProductId = l.ProductId))
        THROW 50404, 'Unknown product on purchase order.', 1;

    DECLARE @Seq INT, @PoNo VARCHAR(20), @Id INT;
    SET @Seq = NEXT VALUE FOR dbo.PurchaseOrderNo;
    SET @PoNo = CONCAT('PO-104-', RIGHT(CONCAT('00000', @Seq), 5));

    BEGIN TRAN;
        INSERT dbo.PurchaseOrders (PoNo, Vendor, ExpectedDate, Notes, CreatedBy)
        VALUES (@PoNo, @Vendor, @ExpectedDate, @Notes, @UserId);
        SET @Id = SCOPE_IDENTITY();

        INSERT dbo.PurchaseOrderItems (PurchaseOrderId, ProductId, QtyCases, CaseCost)
        SELECT @Id, l.ProductId, SUM(l.Qty), p.CaseCost
        FROM @Lines l JOIN dbo.Products p ON p.ProductId = l.ProductId
        GROUP BY l.ProductId, p.CaseCost;
    COMMIT;

    SELECT @Id AS PurchaseOrderId, @PoNo AS PoNo;
END;
GO

/* ---------- Procedure: EPOS sales report import (forecast history, optionally posted to stock) ----------
   @RowsJson: [{"productId":1,"date":"2026-10-04","qty":3.0,"dayEndUtc":"2026-10-05T04:00:00Z"}]
   @Post = 1 deducts each line as an EPOS_SALE movement, except: levels not set (UNTRACKED), fractional qty (WEIGHED),
   or a shelf count recorded after the sales day ended (BEFORE_COUNT: the count already reflects it).
   Selling more than on hand deducts to 0 (SHORT). Re-importing a day first reverses that day's earlier postings. */
CREATE OR ALTER PROCEDURE dbo.sp_ImportSalesHistory
    @FileName   NVARCHAR(260),
    @PeriodFrom DATE,
    @PeriodTo   DATE,
    @UserId     INT,
    @RowsJson   NVARCHAR(MAX),
    @Post       BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF ISJSON(@RowsJson) <> 1 THROW 50003, 'RowsJson is not valid JSON.', 1;
    IF @PeriodFrom IS NULL OR @PeriodTo IS NULL OR @PeriodTo < @PeriodFrom THROW 50006, 'The report period is invalid.', 1;

    DECLARE @Rows TABLE (
        Seq INT IDENTITY(1,1) NOT NULL, ProductId INT NOT NULL, SaleDate DATE NOT NULL, Qty DECIMAL(12,3) NOT NULL,
        DayEndUtc DATETIME2(3) NULL, QtyPosted INT NOT NULL DEFAULT (0), PostStatus VARCHAR(12) NULL,
        PRIMARY KEY (ProductId, SaleDate));
    INSERT @Rows (ProductId, SaleDate, Qty, DayEndUtc)
    SELECT productId, saleDate, SUM(qty), MAX(dayEndUtc)
    FROM OPENJSON(@RowsJson) WITH (productId INT '$.productId', saleDate DATE '$.date', qty DECIMAL(12,3) '$.qty', dayEndUtc DATETIME2(3) '$.dayEndUtc')
    GROUP BY productId, saleDate
    ORDER BY saleDate, productId;  -- posting order: oldest day first
    IF EXISTS (SELECT 1 FROM @Rows WHERE SaleDate < @PeriodFrom OR SaleDate > @PeriodTo)
        THROW 50007, 'A sales row is dated outside the report period.', 1;
    IF EXISTS (SELECT 1 FROM @Rows r WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ProductId = r.ProductId))
        THROW 50404, 'Unknown product in sales rows.', 1;

    DECLARE @Id INT;
    DECLARE @Rev TABLE (ProductId INT PRIMARY KEY, Qty INT NOT NULL);
    DECLARE @Moves TABLE (ProductId INT, QtyBefore INT, QtyAfter INT);
    BEGIN TRAN;
        -- 1. Undo stock postings of the sales this report replaces (re-import never double deducts).
        INSERT @Rev
        -- A shelf count made after the posting already reset stock to reality, so that posting is not added back.
        SELECT h.ProductId, SUM(h.QtyPosted)
        FROM dbo.SalesHistory h WITH (UPDLOCK, HOLDLOCK) JOIN dbo.SalesImports s ON s.SalesImportId = h.SalesImportId
        WHERE h.SaleDate BETWEEN @PeriodFrom AND @PeriodTo AND h.QtyPosted <> 0
          AND NOT EXISTS (SELECT 1 FROM dbo.StockMovements c WHERE c.ProductId = h.ProductId AND c.MovementType = 'CYCLE_COUNT' AND c.CreatedAt >= s.ImportedAt)
        GROUP BY h.ProductId;
        UPDATE i SET i.OnHand = IIF(i.OnHand + r.Qty < 0, 0, i.OnHand + r.Qty), i.UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.ProductId, deleted.OnHand, inserted.OnHand INTO @Moves
        FROM dbo.Inventory i WITH (UPDLOCK, ROWLOCK) JOIN @Rev r ON r.ProductId = i.ProductId;
        INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
        SELECT ProductId, 'EPOS_SALE', QtyAfter - QtyBefore, QtyBefore, QtyAfter, @UserId, N'EPOS re-import: earlier posting reversed'
        FROM @Moves WHERE QtyAfter <> QtyBefore;

        -- A report replaces earlier imported sales for the same dates.
        -- ponytail: assumes each report covers all products for its period; a category-filtered export would blank the rest.
        DELETE dbo.SalesHistory WHERE SaleDate BETWEEN @PeriodFrom AND @PeriodTo;

        INSERT dbo.SalesImports (FileName, PeriodFrom, PeriodTo, RowsImported, UnitsImported, ImportedBy)
        SELECT @FileName, @PeriodFrom, @PeriodTo, COUNT(*), ISNULL(SUM(Qty), 0), @UserId FROM @Rows;
        SET @Id = SCOPE_IDENTITY();

        -- 2. Post to stock, one line at a time so several days of one product deduct cumulatively.
        -- ponytail: row-by-row loop; fine for daily reports (hundreds of lines), set-based if imports reach tens of thousands.
        IF @Post = 1
        BEGIN
            DECLARE @n INT = 1, @last INT = (SELECT MAX(Seq) FROM @Rows),
                    @pid INT, @qty DECIMAL(12,3), @end DATETIME2(3), @day DATE, @on INT, @tl INT, @d INT, @st VARCHAR(12);
            WHILE @n <= @last
            BEGIN
                SELECT @pid = ProductId, @qty = Qty, @end = DayEndUtc, @day = SaleDate FROM @Rows WHERE Seq = @n;
                SELECT @on = OnHand, @tl = TargetLevel FROM dbo.Inventory WITH (UPDLOCK, ROWLOCK) WHERE ProductId = @pid;
                SET @d = 0;
                IF @tl = 0 SET @st = 'UNTRACKED';
                ELSE IF @qty <> FLOOR(@qty) SET @st = 'WEIGHED';
                ELSE IF EXISTS (SELECT 1 FROM dbo.StockMovements WHERE ProductId = @pid AND MovementType = 'CYCLE_COUNT' AND CreatedAt >= @end)
                    SET @st = 'BEFORE_COUNT';
                ELSE
                BEGIN
                    SET @d = CASE WHEN @qty < 0 THEN CAST(@qty AS INT) WHEN @qty > @on THEN @on ELSE CAST(@qty AS INT) END;
                    SET @st = IIF(@d < @qty, 'SHORT', 'POSTED');
                    IF @d <> 0
                    BEGIN
                        UPDATE dbo.Inventory SET OnHand = @on - @d, UpdatedAt = SYSUTCDATETIME() WHERE ProductId = @pid;  -- fires trg_CheckLowStock
                        INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
                        VALUES (@pid, 'EPOS_SALE', -@d, @on, @on - @d, @UserId,
                                CONCAT(N'EPOS ', CONVERT(CHAR(10), @day, 23), IIF(@st = 'SHORT', CONCAT(N' · short ', CAST(@qty AS INT) - @d), N'')));
                    END
                END
                UPDATE @Rows SET QtyPosted = @d, PostStatus = @st WHERE Seq = @n;
                SET @n += 1;
            END
        END

        INSERT dbo.SalesHistory (ProductId, SaleDate, QtySold, SalesImportId, QtyPosted, PostStatus)
        SELECT ProductId, SaleDate, Qty, @Id, QtyPosted, PostStatus FROM @Rows;
    COMMIT;

    SELECT @Id AS SalesImportId;
    SELECT PostStatus AS status, COUNT(*) AS lines, CAST(SUM(Qty) AS FLOAT) AS sold, SUM(QtyPosted) AS posted
    FROM @Rows WHERE PostStatus IS NOT NULL GROUP BY PostStatus;
END;
GO

/* ---------- Procedure: delete imported sales (one import, or all when @SalesImportId IS NULL) ----------
   Stock deducted by those sales is added back first (EPOS_SALE reversal movements), then the sales lines and import
   records are removed, so the day(s) can be imported again cleanly. */
CREATE OR ALTER PROCEDURE dbo.sp_DeleteSalesImport
    @SalesImportId INT = NULL,
    @UserId        INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @SalesImportId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.SalesImports WHERE SalesImportId = @SalesImportId)
        THROW 50404, 'Sales import not found.', 1;

    DECLARE @Rev TABLE (ProductId INT PRIMARY KEY, Qty INT NOT NULL);
    DECLARE @Moves TABLE (ProductId INT, QtyBefore INT, QtyAfter INT);
    DECLARE @Lines INT;
    BEGIN TRAN;
        INSERT @Rev
        -- A shelf count made after the posting already reset stock to reality, so that posting is not added back.
        SELECT h.ProductId, SUM(h.QtyPosted)
        FROM dbo.SalesHistory h WITH (UPDLOCK, HOLDLOCK) JOIN dbo.SalesImports s ON s.SalesImportId = h.SalesImportId
        WHERE (@SalesImportId IS NULL OR h.SalesImportId = @SalesImportId) AND h.QtyPosted <> 0
          AND NOT EXISTS (SELECT 1 FROM dbo.StockMovements c WHERE c.ProductId = h.ProductId AND c.MovementType = 'CYCLE_COUNT' AND c.CreatedAt >= s.ImportedAt)
        GROUP BY h.ProductId;

        UPDATE i SET i.OnHand = IIF(i.OnHand + r.Qty < 0, 0, i.OnHand + r.Qty), i.UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.ProductId, deleted.OnHand, inserted.OnHand INTO @Moves
        FROM dbo.Inventory i WITH (UPDLOCK, ROWLOCK) JOIN @Rev r ON r.ProductId = i.ProductId;

        INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
        SELECT ProductId, 'EPOS_SALE', QtyAfter - QtyBefore, QtyBefore, QtyAfter, @UserId,
               IIF(@SalesImportId IS NULL, N'EPOS imports deleted: posting reversed', CONCAT(N'EPOS import #', @SalesImportId, N' deleted: posting reversed'))
        FROM @Moves WHERE QtyAfter <> QtyBefore;

        DELETE dbo.SalesHistory WHERE @SalesImportId IS NULL OR SalesImportId = @SalesImportId;
        SET @Lines = @@ROWCOUNT;
        DELETE dbo.SalesImports WHERE @SalesImportId IS NULL OR SalesImportId = @SalesImportId;
    COMMIT;

    SELECT @Lines AS LinesDeleted, (SELECT ISNULL(SUM(Qty), 0) FROM @Rev) AS UnitsRestored;
END;
GO

/* ---------- Procedure: bulk-create catalog products (Epos Now reports, product lists, catalog CSV) ----------
   Existing UPCs/SKUs are skipped, never overwritten. Stock starts at 0; reorder levels default to 0 (= not tracked).
   @ItemsJson: [{"upc","sku","name","category","vendor","packSize","unitsPerCase","caseCost","unitPrice","aisle","reorderPoint","targetLevel"}] */
CREATE OR ALTER PROCEDURE dbo.sp_CreateProducts
    @ItemsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF ISJSON(@ItemsJson) <> 1 THROW 50003, 'ItemsJson is not valid JSON.', 1;

    DECLARE @Items TABLE (
        UPC VARCHAR(20) NOT NULL, SKU VARCHAR(32) NOT NULL, Name NVARCHAR(200) NOT NULL, Category NVARCHAR(50) NOT NULL,
        Vendor NVARCHAR(100) NULL, PackSize NVARCHAR(50) NULL, UnitsPerCase INT NOT NULL, CaseCost DECIMAL(12,2) NOT NULL,
        UnitPrice DECIMAL(12,2) NOT NULL, Aisle VARCHAR(10) NULL, ReorderPoint INT NOT NULL, TargetLevel INT NOT NULL);
    INSERT @Items
    SELECT upc, sku, name, category, vendor, packSize, unitsPerCase, caseCost, unitPrice, aisle, ISNULL(reorderPoint, 0), ISNULL(targetLevel, 0)
    FROM OPENJSON(@ItemsJson) WITH (
        upc VARCHAR(20), sku VARCHAR(32), name NVARCHAR(200), category NVARCHAR(50), vendor NVARCHAR(100), packSize NVARCHAR(50),
        unitsPerCase INT, caseCost DECIMAL(12,2), unitPrice DECIMAL(12,2), aisle VARCHAR(10), reorderPoint INT, targetLevel INT);
    IF EXISTS (SELECT 1 FROM @Items WHERE ReorderPoint < 0 OR TargetLevel < ReorderPoint)
        THROW 50008, 'Target level must be at least the reorder point.', 1;

    DECLARE @New TABLE (ProductId INT, UPC VARCHAR(20));
    BEGIN TRAN;
        INSERT dbo.Products (UPC, SKU, Name, Category, Vendor, PackSize, UnitsPerCase, CaseCost, UnitPrice, Aisle)
        OUTPUT inserted.ProductId, inserted.UPC INTO @New
        SELECT i.UPC, i.SKU, i.Name, i.Category, i.Vendor, i.PackSize, i.UnitsPerCase, i.CaseCost, i.UnitPrice, i.Aisle
        FROM @Items i
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WITH (UPDLOCK, HOLDLOCK) WHERE p.UPC = i.UPC OR p.SKU = i.SKU);

        INSERT dbo.Inventory (ProductId, OnHand, ReorderPoint, TargetLevel)
        SELECT n.ProductId, 0, i.ReorderPoint, i.TargetLevel FROM @New n JOIN @Items i ON i.UPC = n.UPC;
    COMMIT;

    SELECT COUNT(*) AS Created FROM @New;
END;
GO

/* ---------- Procedure: bulk edit (product list re-import, catalog CSV round trip) ----------
   Every row carries the full, already-validated editable field set. Stock on hand is never touched.
   @ItemsJson: [{"id","name","category","vendor","packSize","unitsPerCase","caseCost","unitPrice","aisle","reorderPoint","targetLevel"}] */
CREATE OR ALTER PROCEDURE dbo.sp_BulkUpdateProducts
    @ItemsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF ISJSON(@ItemsJson) <> 1 THROW 50003, 'ItemsJson is not valid JSON.', 1;

    DECLARE @I TABLE (
        ProductId INT PRIMARY KEY, Name NVARCHAR(200) NOT NULL, Category NVARCHAR(50) NOT NULL, Vendor NVARCHAR(100) NULL,
        PackSize NVARCHAR(50) NULL, UnitsPerCase INT NOT NULL, CaseCost DECIMAL(12,2) NOT NULL, UnitPrice DECIMAL(12,2) NOT NULL,
        Aisle VARCHAR(10) NULL, ReorderPoint INT NOT NULL, TargetLevel INT NOT NULL);
    INSERT @I
    SELECT id, name, category, vendor, packSize, unitsPerCase, caseCost, unitPrice, aisle, reorderPoint, targetLevel
    FROM OPENJSON(@ItemsJson) WITH (
        id INT, name NVARCHAR(200), category NVARCHAR(50), vendor NVARCHAR(100), packSize NVARCHAR(50), unitsPerCase INT,
        caseCost DECIMAL(12,2), unitPrice DECIMAL(12,2), aisle VARCHAR(10), reorderPoint INT, targetLevel INT);
    IF EXISTS (SELECT 1 FROM @I i WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ProductId = i.ProductId))
        THROW 50404, 'Unknown product in update.', 1;
    IF EXISTS (SELECT 1 FROM @I WHERE ReorderPoint < 0 OR TargetLevel < ReorderPoint OR UnitsPerCase < 1)
        THROW 50008, 'Target level must be at least the reorder point.', 1;

    BEGIN TRAN;
        UPDATE p
        SET p.Name = i.Name, p.Category = i.Category, p.Vendor = i.Vendor, p.PackSize = i.PackSize, p.UnitsPerCase = i.UnitsPerCase,
            p.CaseCost = i.CaseCost, p.UnitPrice = i.UnitPrice, p.Aisle = i.Aisle
        FROM dbo.Products p JOIN @I i ON i.ProductId = p.ProductId;

        UPDATE inv SET inv.ReorderPoint = i.ReorderPoint, inv.TargetLevel = i.TargetLevel
        FROM dbo.Inventory inv JOIN @I i ON i.ProductId = inv.ProductId;
    COMMIT;

    SELECT COUNT(*) AS Updated FROM @I;
END;
GO

/* ---------- Procedure: edit catalog fields and reorder levels (stock on hand is not touched) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_UpdateProduct
    @ProductId    INT,
    @Name         NVARCHAR(200),
    @Category     NVARCHAR(50),
    @Vendor       NVARCHAR(100),
    @PackSize     NVARCHAR(50),
    @UnitsPerCase INT,
    @CaseCost     DECIMAL(12,2),
    @UnitPrice    DECIMAL(12,2),
    @Aisle        VARCHAR(10),
    @ReorderPoint INT,
    @TargetLevel  INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @ReorderPoint < 0 OR @TargetLevel < @ReorderPoint THROW 50008, 'Target level must be at least the reorder point.', 1;
    BEGIN TRAN;
        UPDATE dbo.Products
        SET Name = @Name, Category = @Category, Vendor = @Vendor, PackSize = @PackSize, UnitsPerCase = @UnitsPerCase,
            CaseCost = @CaseCost, UnitPrice = @UnitPrice, Aisle = @Aisle
        WHERE ProductId = @ProductId;
        IF @@ROWCOUNT = 0 THROW 50404, 'Unknown product.', 1;
        UPDATE dbo.Inventory SET ReorderPoint = @ReorderPoint, TargetLevel = @TargetLevel WHERE ProductId = @ProductId;
    COMMIT;
END;
GO

/* ---------- Seed data ---------- */
IF NOT EXISTS (SELECT 1 FROM dbo.AppUsers)
BEGIN
    SET IDENTITY_INSERT dbo.AppUsers ON;
    INSERT dbo.AppUsers (UserId, FullName, Role, Title) VALUES
${USERS.map((u) => `        (${u.id}, ${q(u.name)}, '${u.role}', ${q(u.title)})`).join(',\n')};
    SET IDENTITY_INSERT dbo.AppUsers OFF;
END;

IF NOT EXISTS (SELECT 1 FROM dbo.Products)
BEGIN
    INSERT dbo.Products (UPC, SKU, Name, Category, Vendor, PackSize, UnitsPerCase, CaseCost, UnitPrice, Aisle) VALUES
${products.map((p) => `        ('${p.upc}', '${p.sku}', ${q(p.name)}, ${q(p.category)}, ${q(p.vendor)}, ${q(p.packSize)}, ${p.unitsPerCase}, ${p.caseCost.toFixed(2)}, ${p.unitPrice.toFixed(2)}, '${p.aisle}')`).join(',\n')};

    INSERT dbo.Inventory (ProductId, OnHand, ReorderPoint, TargetLevel)
    SELECT p.ProductId, v.OnHand, v.ReorderPoint, v.TargetLevel
    FROM (VALUES
${products.map((p) => `        ('${p.upc}', ${p.onHand}, ${p.reorderPoint}, ${p.targetLevel})`).join(',\n')}
    ) v (UPC, OnHand, ReorderPoint, TargetLevel)
    JOIN dbo.Products p ON p.UPC = v.UPC;
END;
GO
`;
}
