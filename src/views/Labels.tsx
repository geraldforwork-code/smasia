import { useState } from 'react';
import { needsReorder, type Product } from '../shared';
import { money } from '../lib';
import { Barcode, Btn, Modal } from '../ui';

/** 2 × 4 shelf-edge labels per letter sheet (8 per page), printed with window.print(). */
export default function LabelsModal({ products, onClose }: { products: Product[]; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(products.filter(needsReorder).map((p) => p.id)));
  const chosen = products.filter((p) => picked.has(p.id));
  const sheets: Product[][] = [];
  for (let i = 0; i < chosen.length; i += 8) sheets.push(chosen.slice(i, i + 8));
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Modal title="Printable Shelf Barcode Labels" onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Btn onClick={() => setPicked(new Set(products.map((p) => p.id)))}>Select all</Btn>
        <Btn onClick={() => setPicked(new Set())}>Clear</Btn>
        <span className="text-xs text-muted">{chosen.length} labels · {sheets.length} sheet(s) · 2 × 4 per letter sheet</span>
        <Btn kind="primary" className="ml-auto" disabled={!chosen.length} onClick={() => window.print()}>Print labels</Btn>
      </div>
      <div className="mb-4 grid max-h-48 grid-cols-1 gap-x-4 overflow-y-auto border border-line p-2 text-sm sm:grid-cols-2 lg:grid-cols-3 print:hidden">
        {products.map((p) => (
          <label key={p.id} className="flex items-center gap-2 py-0.5">
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} className="accent-[#c8102e]" />
            <span className="truncate">{p.name}</span>
          </label>
        ))}
      </div>
      <div className="print-area">
        {sheets.map((sheet, i) => (
          <div key={i} className="sheet mb-6 grid grid-cols-2 gap-[0.1in] bg-white p-2 text-black print:mb-0 print:p-0">
            {sheet.map((p) => (
              <div key={p.id} className="flex h-[2.4in] flex-col justify-between border border-dashed border-zinc-400 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[9px] font-black tracking-[0.2em] text-[#c8102e]">SM ASIA · #104</div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] font-bold leading-tight">{p.name}</div>
                    <div className="font-mono text-[9px] text-zinc-600">{p.packSize} · {p.sku}</div>
                  </div>
                  <div className="border-2 border-black px-1.5 text-center">
                    <div className="text-[8px] font-bold tracking-widest">AISLE</div>
                    <div className="font-mono text-base font-bold leading-5">{p.aisle}</div>
                  </div>
                </div>
                <div className="flex items-end justify-between gap-3">
                  <Barcode value={p.upc} height={46} className="h-[0.8in] w-[2in]" />
                  <div className="text-right font-mono text-3xl font-bold leading-none tracking-tight">
                    {money(p.unitPrice)}<div className="text-[9px] font-normal tracking-widest">EACH</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
