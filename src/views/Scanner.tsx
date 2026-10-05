import { useEffect, useRef, useState } from 'react';
import type { Ctx } from '../App';
import { can, marginPct, needsReorder, stockStatus, unitCost, type Product, type ScanResult } from '../shared';
import { api, cases, money, sound, time } from '../lib';
import { Barcode, Btn, cx, inputCls, Panel, Tag } from '../ui';

type Method = 'camera' | 'hardware' | 'manual' | 'palette';
type Action = 'SALE' | 'INTAKE' | 'LOOKUP';
type Result =
  | { kind: 'move'; action: 'SALE' | 'INTAKE'; product: Product; before: number; after: number; alert: string | null }
  | { kind: 'lookup'; product: Product }
  | { kind: 'error'; code: string; msg: string };

const METHODS: { id: Method; label: string }[] = [
  { id: 'camera', label: 'Camera Scanner' },
  { id: 'hardware', label: 'Hardware Scanner' },
  { id: 'manual', label: 'Manual Keypad' },
  { id: 'palette', label: 'Quick-Scan Palette' },
];

export default function Scanner({ state, user, refresh }: Ctx) {
  const actions = ([
    { id: 'SALE', label: 'Sale / Deduct (−Qty EA)', ok: can(user.role, 'scanSale') },
    { id: 'INTAKE', label: 'Intake / Restock (+Qty CS)', ok: can(user.role, 'scanIntake') },
    { id: 'LOOKUP', label: 'Price & Stock Lookup', ok: true },
  ] as const).filter((a) => a.ok);
  const [method, setMethod] = useState<Method>('palette');
  const [action, setAction] = useState<Action>(actions[0].id);
  const [qty, setQty] = useState(1);
  const [result, setResult] = useState<Result | null>(null);
  const [log, setLog] = useState<{ ts: string; code: string; text: string; bad?: boolean }[]>([]);

  if (!actions.some((a) => a.id === action)) setAction(actions[0].id);

  const process = async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const push = (text: string, bad?: boolean) => setLog((l) => [{ ts: new Date().toISOString(), code, text, bad }, ...l].slice(0, 30));
    if (action === 'LOOKUP') {
      const product = state.products.find((p) => p.upc === code || p.sku === code);
      if (!product) { sound.error(); setResult({ kind: 'error', code, msg: 'Unknown barcode. Not in the SM ASIA catalog.' }); return push('UNKNOWN', true); }
      sound.scan();
      setResult({ kind: 'lookup', product });
      return push(`LOOKUP ${product.name}`);
    }
    try {
      const r = await api<ScanResult>('/api/scan', { code, mode: action, qty });
      sound.scan();
      if (needsReorder({ ...r.product, onHand: r.after })) setTimeout(sound.lowStock, 160);
      setResult({ kind: 'move', action, product: r.product, before: r.before, after: r.after, alert: r.alert?.message ?? null });
      push(`${action === 'SALE' ? `−${qty} EA` : `+${qty} CS`} ${r.product.name}`);
      refresh();
    } catch (e) {
      sound.error();
      setResult({ kind: 'error', code, msg: (e as Error).message });
      push((e as Error).message, true);
    }
  };
  const processRef = useRef(process);
  processRef.current = process;

  // Hardware wedge scanners type fast and end with Enter. Human typing is slower, so keys more than 60ms apart reset the buffer.
  const [wedge, setWedge] = useState('');
  useEffect(() => {
    let buf = '', last = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      const now = performance.now();
      if (now - last > 60) buf = '';
      last = now;
      if (e.key === 'Enter') {
        if (buf.length >= 4) { processRef.current(buf); setWedge(buf); }
        buf = '';
      } else if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const qtyLabel = action === 'INTAKE' ? 'CS' : 'EA';

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <div className="grid content-start gap-4">
        <Panel title="Scan Action Mode">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-wrap border border-line">
              {actions.map((a) => (
                <button key={a.id} onClick={() => setAction(a.id)}
                  className={cx('px-4 py-2 text-xs font-bold uppercase tracking-wider', action === a.id ? (a.id === 'SALE' ? 'bg-brand text-white' : a.id === 'INTAKE' ? 'bg-emerald-700 text-white' : 'bg-ink text-canvas') : 'hover:bg-canvas')}>
                  {a.label}
                </button>
              ))}
            </div>
            {action !== 'LOOKUP' && (
              <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted">
                Qty
                <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(+e.target.value) || 1))} className={cx(inputCls, 'w-20 font-mono')} />
                {qtyLabel}
              </label>
            )}
          </div>
        </Panel>

        <Panel title="Input Method" actions={
          <span className="flex items-center gap-2 font-mono text-[10px] text-muted">
            <span className="h-2 w-2 bg-emerald-500" /> USB/BT wedge listener armed{wedge && ` · last: ${wedge}`}
          </span>
        }>
          <div className="mb-4 flex flex-wrap gap-0 border-b border-line">
            {METHODS.map((m) => (
              <button key={m.id} onClick={() => setMethod(m.id)}
                className={cx('-mb-px border-b-2 px-4 py-2 text-xs font-bold uppercase tracking-wider', method === m.id ? 'border-brand' : 'border-transparent text-muted hover:text-ink')}>
                {m.label}
              </button>
            ))}
          </div>
          {method === 'camera' && <Camera onCode={(c) => processRef.current(c)} />}
          {method === 'hardware' && <Hardware wedge={wedge} />}
          {method === 'manual' && <Keypad onSubmit={process} />}
          {method === 'palette' && <Palette products={state.products} onPick={process} />}
        </Panel>
      </div>

      <div className="grid content-start gap-4">
        <ResultCard result={result} />
        <Panel title="Session Scan Log" pad={false}>
          <ul className="max-h-[420px] overflow-y-auto font-mono text-xs">
            {log.length === 0 && <li className="p-4 text-center text-muted">No scans this session.</li>}
            {log.map((l, i) => (
              <li key={i} className={cx('flex gap-3 border-b border-line/60 px-4 py-2', l.bad && 'text-red-600 dark:text-red-400')}>
                <span className="text-muted">{time(l.ts)}</span><span className="w-28 truncate">{l.code}</span><span className="flex-1 truncate">{l.text}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: Result | null }) {
  if (!result) return <Panel title="Scan Result"><p className="py-10 text-center text-sm text-muted">Waiting for a barcode…</p></Panel>;
  if (result.kind === 'error')
    return (
      <Panel title="Scan Result" className="border-red-600">
        <div className="font-mono text-xs text-muted">{result.code}</div>
        <div className="mt-1 text-lg font-bold text-red-600 dark:text-red-400">{result.msg}</div>
      </Panel>
    );
  const p = result.product;
  const onHand = result.kind === 'move' ? result.after : p.onHand;
  const status = stockStatus({ ...p, onHand });
  return (
    <Panel title="Scan Result" className={status === 'OUT' ? 'border-red-600' : status === 'LOW' ? 'border-amber-500' : ''}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-xs text-muted">{p.upc} · {p.sku}</div>
          <div className="mt-0.5 text-lg font-bold leading-tight">{p.name}</div>
          <div className="text-xs text-muted">{p.category} · {p.packSize}</div>
        </div>
        <Tag v={status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-px bg-line text-sm">
        {[
          ['Retail', money(p.unitPrice)],
          ['Unit cost', money(unitCost(p))],
          ['Margin', `${marginPct(p).toFixed(1)}%`],
          ['Aisle', p.aisle],
          ['On hand', `${onHand} EA · ${cases(onHand, p.unitsPerCase)}`],
          ['Reorder pt', `${p.reorderPoint} EA`],
        ].map(([k, v]) => (
          <div key={k} className="bg-panel p-2">
            <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{k}</dt>
            <dd className="font-mono font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {result.kind === 'move' && (
        <div className="mt-3 border border-line p-2 font-mono text-sm">
          <Tag v={result.action === 'SALE' ? 'SCAN_SALE' : 'INVOICE_INTAKE'} />{' '}
          {result.before} → <b>{result.after}</b> EA ({cases(result.before, p.unitsPerCase)} → {cases(result.after, p.unitsPerCase)})
        </div>
      )}
      {result.kind === 'move' && result.alert && <div className="mt-2 border border-red-600 bg-red-600/10 p-2 text-sm font-semibold text-red-700 dark:text-red-400">⚠ {result.alert}</div>}
      <Barcode value={p.upc} height={40} className="mt-3 h-14 w-full" />
    </Panel>
  );
}

function Camera({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const detectorOk = 'BarcodeDetector' in window;
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null, timer = 0, stopped = false, lastCode = '', lastAt = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        video.current!.srcObject = stream;
        await video.current!.play();
        if (!detectorOk) return;
        // Native BarcodeDetector (Chrome on Android / macOS / ChromeOS).
        const Detector = (window as unknown as { BarcodeDetector: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        const det = new Detector({ formats: ['code_128', 'upc_a', 'upc_e', 'ean_13', 'ean_8'] });
        timer = window.setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          const [hit] = await det.detect(video.current).catch(() => []);
          if (!hit) return;
          const now = Date.now();
          if (hit.rawValue === lastCode && now - lastAt < 2000) return;
          lastCode = hit.rawValue; lastAt = now;
          setHint(hit.rawValue);
          cb.current(hit.rawValue);
        }, 250);
      } catch (e) {
        setErr((e as Error).message || 'Camera unavailable');
      }
    })();
    return () => { stopped = true; clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [detectorOk]);

  return (
    <div>
      <div className="relative mx-auto aspect-video max-w-2xl overflow-hidden bg-black">
        <video ref={video} muted playsInline className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-[12%_18%]">
          {['left-0 top-0 border-l-4 border-t-4', 'right-0 top-0 border-r-4 border-t-4', 'left-0 bottom-0 border-l-4 border-b-4', 'right-0 bottom-0 border-r-4 border-b-4'].map((c) => (
            <span key={c} className={`absolute h-8 w-8 border-brand ${c}`} />
          ))}
          <span className="laser absolute left-0 right-0 h-0.5 bg-red-500 shadow-[0_0_12px_3px_rgba(239,68,68,0.8)]" />
        </div>
        {err && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white">{err}</div>}
      </div>
      <p className="mt-2 text-center text-xs text-muted">
        {detectorOk ? `Hold the barcode inside the brackets.${hint ? ` Last read: ${hint}` : ''}` : 'This browser has no native BarcodeDetector (e.g. desktop Chrome on Windows). The camera preview works; use the hardware scanner, keypad or palette to scan.'}
      </p>
    </div>
  );
}

function Hardware({ wedge }: { wedge: string }) {
  return (
    <div className="grid place-items-center gap-3 border border-dashed border-line py-12 text-center">
      <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted">Global keyboard-wedge listener</div>
      <div className="font-mono text-4xl font-semibold tracking-widest">{wedge || '— — — —'}</div>
      <p className="max-w-md text-sm text-muted">Pull the trigger on any USB or Bluetooth laser scanner. Rapid keystrokes ending in Enter are captured from anywhere on this page (except while a text field has focus).</p>
    </div>
  );
}

function Keypad({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [v, setV] = useState('');
  const submit = () => { onSubmit(v); setV(''); };
  return (
    <div className="mx-auto max-w-sm">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="UPC or SKU" className={cx(inputCls, 'h-12 text-center font-mono text-xl tracking-widest')} />
      <div className="mt-2 grid grid-cols-3 gap-px bg-line">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', '⌫'].map((k) => (
          <button key={k} onClick={() => setV((s) => (k === 'CLR' ? '' : k === '⌫' ? s.slice(0, -1) : s + k))}
            className="h-14 bg-panel font-mono text-xl font-semibold hover:bg-canvas">{k}</button>
        ))}
      </div>
      <Btn kind="primary" className="mt-2 h-12 w-full text-sm" onClick={submit} disabled={!v.trim()}>Enter · Look up</Btn>
    </div>
  );
}

function Palette({ products, onPick }: { products: Product[]; onPick: (code: string) => void }) {
  const [q, setQ] = useState('');
  const shown = products.filter((p) => `${p.name} ${p.upc} ${p.category}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter products…" className={cx(inputCls, 'mb-3')} />
      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-3 2xl:grid-cols-4">
        {shown.map((p) => (
          <button key={p.id} onClick={() => onPick(p.upc)} className="group bg-panel p-3 text-left hover:bg-canvas">
            <div className="flex items-start justify-between gap-2">
              <span className="line-clamp-2 text-xs font-semibold leading-tight">{p.name}</span>
              <Tag v={stockStatus(p)} />
            </div>
            <Barcode value={p.upc} height={36} className="mt-2 h-12 w-full" />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
              <span>{money(p.unitPrice)}</span><span>{p.onHand} EA</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
