import express, { type NextFunction, type Request, type Response } from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { can, CATEGORIES, type InvoiceDoc, type Perm, type User } from '../src/shared.ts';
import { INVOICE_PRESETS } from './seed.ts';
import * as sql from './sql.ts';
import * as store from './store.ts';

try { process.loadEnvFile(); } catch { /* .env is optional */ }

const app = express();
app.use(express.json({ limit: '25mb' })); // invoice uploads arrive base64-encoded

type Req = Request & { user: User };
// ponytail: identity is the 1-click session switcher's x-user-id header (no passwords). Put real auth (Entra ID / SSO) in front before exposing beyond the store LAN.
const route = (perm: Perm | null, fn: (req: Req, res: Response) => unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const user = store.findUser(Number(req.header('x-user-id')));
    if (!user) return res.status(401).json({ error: 'Select an employee session.' });
    if (perm && !can(user.role, perm)) return res.status(403).json({ error: `${user.name} (${user.role}) is not permitted to do this.` });
    try {
      const out = await fn(Object.assign(req, { user }), res);
      if (!res.headersSent) res.json(out ?? store.getState());
    } catch (e) {
      next(e);
    }
  };

app.get('/api/state', route(null, () => store.getState()));
app.get('/api/invoice-presets', route('invoices', () => INVOICE_PRESETS));

app.post('/api/scan', route(null, (req) => {
  const { code, mode, qty } = req.body;
  if (mode !== 'SALE' && mode !== 'INTAKE') throw new store.HttpError(400, 'Mode must be SALE or INTAKE.');
  if (!can(req.user.role, mode === 'SALE' ? 'scanSale' : 'scanIntake')) throw new store.HttpError(403, `${req.user.name} cannot run ${mode} scans.`);
  return store.scan(code, mode, Number(qty), req.user);
}));

app.post('/api/adjust', route('adjust', async (req) => {
  const { productId, newOnHand, type, reason } = req.body;
  await store.adjust(Number(productId), Number(newOnHand), type, reason, req.user);
}));

app.post('/api/invoices/ingest', route('invoiceApprove', async (req) => { await store.ingest(req.body.doc, req.user); }));
app.post('/api/invoices/stage', route('invoices', (req) => { store.stage(req.body.doc, req.user); }));
app.post('/api/invoices/pending/:id/approve', route('invoiceApprove', async (req) => { await store.approve(Number(req.params.id), req.user); }));
app.delete('/api/invoices/pending/:id', route('invoiceApprove', (req) => { store.reject(Number(req.params.id)); }));

app.post('/api/purchase-orders', route('poCreate', (req) => store.createPo(req.body, req.user)));
app.post('/api/purchase-orders/:id/cancel', route('poCreate', async (req) => { await store.cancelPo(Number(req.params.id)); }));

app.post('/api/products/bulk', route('catalog', async (req) => ({ ...(await store.createProducts(req.body.products)), state: store.getState() })));
app.get('/api/products/:id/ledger', route('movements', (req) => store.productLedger(Number(req.params.id))));
app.post('/api/products/bulk-update', route('catalog', async (req) => ({ ...(await store.bulkUpdateProducts(req.body.products)), state: store.getState() })));
app.patch('/api/products/:id', route('catalog', async (req) => { await store.updateProduct(Number(req.params.id), req.body); }));
app.delete('/api/sales-imports/:id', route('salesImport', async (req) => ({ ...(await store.deleteSalesImport(Number(req.params.id), req.user)), history: await store.salesHistory() })));
app.delete('/api/sales-imports', route('salesImport', async (req) => ({ ...(await store.deleteSalesImport(null, req.user)), history: await store.salesHistory() })));
app.get('/api/forecast', route('forecast', () => store.salesHistory()));
app.post('/api/sales-imports', route('salesImport', async (req) => {
  const posting = await store.importSales(req.body, req.user);
  return { ...(await store.salesHistory()), posting };
}));

app.post('/api/alerts/ack', route(null, async (req) => { await store.ack(req.body.id ?? null); }));
app.patch('/api/users/:id', route('users', async (req) => { await store.setRole(Number(req.params.id), req.body.role); }));

// --- Invoice OCR ---------------------------------------------------------------

const invoiceSchema = {
  type: Type.OBJECT,
  properties: {
    vendor: { type: Type.STRING },
    invoiceNo: { type: Type.STRING },
    date: { type: Type.STRING, description: 'ISO date YYYY-MM-DD' },
    total: { type: Type.NUMBER },
    pages: { type: Type.INTEGER },
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          upc: { type: Type.STRING, description: 'UPC/EAN/item barcode digits exactly as printed; empty string if none' },
          description: { type: Type.STRING },
          packSize: { type: Type.STRING, description: 'e.g. 24/227g or 12x900g' },
          qty: { type: Type.INTEGER, description: 'cases shipped' },
          unitCost: { type: Type.NUMBER, description: 'price per case in CAD' },
          category: { type: Type.STRING, enum: [...CATEGORIES] },
        },
        required: ['upc', 'description', 'packSize', 'qty', 'unitCost'],
      },
    },
  },
  required: ['vendor', 'invoiceNo', 'date', 'total', 'lines'],
};

app.post('/api/parse-invoice', route('invoices', async (req) => {
  if (!process.env.GEMINI_API_KEY) throw new store.HttpError(503, 'GEMINI_API_KEY is not set on the server. Add it to .env to enable invoice OCR.');
  const { mimeType, data, text } = req.body as { mimeType?: string; data?: string; text?: string };
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (!text && !(data && mimeType && allowed.includes(mimeType))) throw new store.HttpError(400, 'Upload a PDF, PNG, JPG or text invoice.');

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    contents: [{
      role: 'user',
      parts: [
        text ? { text: `INVOICE TEXT:\n${text}` } : { inlineData: { mimeType: mimeType!, data: data! } },
        { text: 'Extract this vendor invoice delivered to SM Asia Enterprises (Lloydminster, SK). Return every product line. Quantities are cases shipped, costs are CAD per case. Do not invent UPCs.' },
      ],
    }],
    config: { responseMimeType: 'application/json', responseSchema: invoiceSchema, temperature: 0 },
  });
  return JSON.parse(res.text ?? '{}') as InvoiceDoc;
}));

// --- SQL Server ------------------------------------------------------------------

const bodyConfig = (b: Partial<sql.SqlConfig>): sql.SqlConfig => ({
  host: String(b.host ?? ''), port: Number(b.port) || 1433, database: String(b.database || 'StoreInventoryDB'),
  user: String(b.user ?? ''), password: String(b.password ?? ''), encrypt: b.encrypt !== false,
  trustServerCertificate: b.trustServerCertificate !== false, trusted: b.trusted === true, connectionString: b.connectionString || undefined,
});

app.get('/api/sql-health', route(null, () => sql.refreshStatus()));
app.post('/api/sql-health', route('sqlHub', (req) => sql.testConfig(bodyConfig(req.body))));
app.post('/api/sql-config', route('sqlHub', async (req) => {
  const status = await sql.connect(req.body.disconnect ? null : bodyConfig(req.body));
  await store.reload();
  return status;
}));
app.post('/api/sql-deploy', route('sqlHub', async () => {
  const status = await sql.sqlDeploy();
  await store.reload();
  return status;
}));
app.get('/api/sql-script', route('sqlHub', (_req, res) => {
  res.type('text/plain').send(sql.buildScript(true));
}));
app.post('/api/sql-query', route('sqlHub', (req) => {
  const text = String(req.body.sql ?? '').trim();
  if (!text) throw new store.HttpError(400, 'Enter a T-SQL statement.');
  return store.runQuery(text, req.body.preset);
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

// --- boot ---------------------------------------------------------------------------

const prod = process.argv.includes('--prod');
if (prod) {
  app.use(express.static('dist'));
  app.get('/{*any}', (_req, res) => res.sendFile('index.html', { root: 'dist' }));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const status = await sql.connect(sql.envConfig());
if (status.connected) await store.reload();
console.log(`SQL Server: ${status.connected ? `connected (${status.database}${status.schemaReady ? '' : ', schema not deployed'})` : `not connected, using in-memory store${status.error ? ` — ${status.error}` : ''}`}`);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`SM ASIA inventory → http://localhost:${port}`));
