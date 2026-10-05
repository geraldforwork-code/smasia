import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { barcodeBars } from './lib';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Panel({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('border border-line bg-panel', className)}>
      {title && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

type BtnKind = 'primary' | 'ghost' | 'danger' | 'ok';
export function Btn({ kind = 'ghost', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex h-9 items-center justify-center gap-2 border px-3 text-xs font-semibold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        kind === 'primary' && 'border-brand bg-brand text-white hover:bg-brand-dark',
        kind === 'ghost' && 'border-line bg-panel text-ink hover:border-ink',
        kind === 'danger' && 'border-red-700 bg-red-700 text-white hover:bg-red-800',
        kind === 'ok' && 'border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800',
        className,
      )}
    />
  );
}

const TAG: Record<string, string> = {
  OK: 'border-emerald-600 text-emerald-700 dark:text-emerald-400',
  LOW: 'border-amber-500 text-amber-700 dark:text-amber-400',
  OUT: 'border-red-600 bg-red-600 text-white',
  UNSET: 'border-dashed border-line text-muted',
  WARNING: 'border-amber-500 text-amber-700 dark:text-amber-400',
  CRITICAL: 'border-red-600 bg-red-600 text-white',
  NEW: 'border-sky-600 bg-sky-600 text-white',
  MATCH: 'border-emerald-600 text-emerald-700 dark:text-emerald-400',
  SCAN_SALE: 'border-ink text-ink',
  EPOS_SALE: 'border-violet-600 text-violet-700 dark:text-violet-400',
  INVOICE_INTAKE: 'border-emerald-600 text-emerald-700 dark:text-emerald-400',
  CYCLE_COUNT: 'border-sky-600 text-sky-700 dark:text-sky-400',
  ADJUSTMENT: 'border-amber-500 text-amber-700 dark:text-amber-400',
  MSSQL: 'border-emerald-600 text-emerald-700 dark:text-emerald-400',
  IN_MEMORY: 'border-amber-500 text-amber-700 dark:text-amber-400',
};
export const Tag = ({ v, label }: { v: string; label?: string }) => (
  <span className={cx('inline-block border px-1.5 py-px font-mono text-[10px] font-semibold uppercase leading-4 tracking-wider whitespace-nowrap', TAG[v] ?? 'border-line text-muted')}>
    {label ?? (v === 'UNSET' ? 'NOT TRACKED' : v.replace('_', ' '))}
  </span>
);

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 print:static print:block print:bg-white print:p-0" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('mt-8 w-full border border-line bg-panel shadow-2xl print:m-0 print:border-0 print:shadow-none', wide ? 'max-w-5xl' : 'max-w-xl')}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3 print:hidden">
          <h2 className="text-sm font-bold uppercase tracking-[0.12em]">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="h-8 w-8 border border-line text-lg leading-none hover:border-ink">×</button>
        </header>
        <div className="p-4 print:p-0">{children}</div>
      </div>
    </div>
  );
}

export function Barcode({ value, height = 48, className, showText = true }: { value: string; height?: number; className?: string; showText?: boolean }) {
  let geo;
  try { geo = barcodeBars(value); } catch { return <span className="font-mono text-xs text-red-600">{value}</span>; }
  const quiet = 10;
  const w = geo.width + quiet * 2;
  return (
    <svg viewBox={`0 0 ${w} ${height + (showText ? 12 : 0)}`} className={cx('block bg-white', className)} role="img" aria-label={`${geo.symbology} barcode ${value}`} preserveAspectRatio="none">
      {geo.bars.map(([x, bw]) => <rect key={x} x={x + quiet} y={2} width={bw} height={height - 2} fill="#000" />)}
      {showText && <text x={w / 2} y={height + 10} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="9" fill="#000">{value}</text>}
    </svg>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'bad' | 'good' }) {
  return (
    <div className="border border-line bg-panel p-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className={cx('mt-2 font-mono text-2xl font-semibold tabular-nums',
        tone === 'warn' && 'text-amber-600 dark:text-amber-400', tone === 'bad' && 'text-red-600 dark:text-red-500', tone === 'good' && 'text-emerald-600 dark:text-emerald-400')}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{label}</span>
    {children}
  </label>
);
export const inputCls = 'h-9 w-full border border-line bg-canvas px-2 text-sm text-ink outline-none focus:border-brand';

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line/60 [&>tr:hover]:bg-canvas [&_td]:px-3 [&_td]:py-2">
          {rows.length ? children : <tr><td colSpan={head.length} className="py-8 text-center text-muted">{empty ?? 'Nothing here.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
