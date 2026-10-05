import { useState } from 'react';
import type { Ctx } from '../App';
import { CATEGORIES, costValue, onOrderCases, retailValue, stockStatus } from '../shared';
import { api, cases, money, money0, sound, time } from '../lib';
import { Btn, Panel, Stat, Table, Tag } from '../ui';
import LabelsModal from './Labels';

export default function Dashboard({ state, refresh, toast, go }: Ctx) {
  const [labels, setLabels] = useState(false);
  const ps = state.products;
  const cost = ps.reduce((s, p) => s + costValue(p), 0);
  const retail = ps.reduce((s, p) => s + retailValue(p), 0);
  const volume = ps.reduce((s, p) => s + p.onHand / p.unitsPerCase, 0);
  const low = ps.filter((p) => stockStatus(p) === 'LOW');
  const out = ps.filter((p) => stockStatus(p) === 'OUT');
  const radar = [...out, ...low].sort((a, b) => a.onHand / a.reorderPoint - b.onHand / b.reorderPoint);
  const cats = CATEGORIES.map((c) => ({ c, v: ps.filter((p) => p.category === c).reduce((s, p) => s + costValue(p), 0) }));
  const maxCat = Math.max(1, ...cats.map((x) => x.v));

  const restock = async (code: string, qty: number) => {
    try {
      await api('/api/scan', { code, mode: 'INTAKE', qty });
      sound.scan();
      toast(`Restocked ${qty} CS`);
      refresh();
    } catch (e) { sound.error(); toast((e as Error).message, true); }
  };

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Inventory Cost Valuation" value={money0(cost)} sub="CAD at landed case cost" />
        <Stat label="Retail Value" value={money0(retail)} sub="CAD at shelf price" />
        <Stat label="Gross Profit Margin" value={`${retail ? (((retail - cost) / retail) * 100).toFixed(1) : '0.0'}%`} sub={`${money0(retail - cost)} potential GP`} tone="good" />
        <Stat label="Volume on Hand" value={`${volume.toFixed(1)} CS`} sub={`${ps.filter((p) => p.onHand > 0).length} of ${ps.length} active SKUs stocked`} />
        <Stat label="Low-Stock Warnings" value={low.length} sub="at/below reorder point" tone={low.length ? 'warn' : undefined} />
        <Stat label="Out-of-Stock Depletions" value={out.length} sub="0 on hand" tone={out.length ? 'bad' : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Stock Reorder Radar" className="xl:col-span-2" pad={false}
          actions={<><Btn kind="primary" onClick={() => go('purchasing')}>Create purchase order</Btn><Btn onClick={() => setLabels(true)}>Print shelf labels</Btn></>}>
          <Table head={['Status', 'UPC', 'Product', 'Aisle', 'On hand', 'Reorder pt', 'Target', 'Deficit', 'On order', 'Est. cost', '']} empty="Every SKU is above its reorder point.">
            {radar.map((p) => {
              const deficitCs = Math.max(1, Math.ceil((p.targetLevel - p.onHand) / p.unitsPerCase));
              return (
                <tr key={p.id}>
                  <td><Tag v={stockStatus(p)} /></td>
                  <td className="font-mono text-xs">{p.upc}</td>
                  <td className="font-medium">{p.name}</td>
                  <td className="font-mono">{p.aisle}</td>
                  <td className="font-mono tabular-nums">{p.onHand} EA</td>
                  <td className="font-mono tabular-nums text-muted">{p.reorderPoint}</td>
                  <td className="font-mono tabular-nums text-muted">{p.targetLevel}</td>
                  <td className="font-mono tabular-nums">{p.targetLevel - p.onHand} EA · {deficitCs} CS</td>
                  <td className="font-mono tabular-nums">{onOrderCases(state.purchaseOrders, p.id) ? <Tag v="OK" label={`${onOrderCases(state.purchaseOrders, p.id)} CS on PO`} /> : <span className="text-muted">—</span>}</td>
                  <td className="font-mono tabular-nums">{money(deficitCs * p.caseCost)}</td>
                  <td><Btn kind="primary" onClick={() => restock(p.upc, deficitCs)}>Restock {deficitCs} CS</Btn></td>
                </tr>
              );
            })}
          </Table>
        </Panel>

        <Panel title="Category Valuation Distribution">
          <div className="grid gap-3">
            {cats.map(({ c, v }) => (
              <div key={c}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="font-semibold">{c}</span>
                  <span className="font-mono tabular-nums">{money0(v)} · {cost ? ((v / cost) * 100).toFixed(1) : 0}%</span>
                </div>
                <div className="h-3 bg-canvas">
                  <div className="h-3 bg-brand" style={{ width: `${(v / maxCat) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Live Stock Activity Stream" pad={false}>
        <Table head={['Time', 'Type', 'Product', 'Change', 'Before → After', 'Employee', 'Ref']} empty="No stock movements yet. Scan or receive an invoice to see live activity.">
          {state.movements.slice(0, 15).map((m) => {
            const p = ps.find((x) => x.id === m.productId);
            return (
              <tr key={m.id}>
                <td className="font-mono text-xs">{time(m.ts)}</td>
                <td><Tag v={m.type} /></td>
                <td>{m.name}</td>
                <td className={`font-mono tabular-nums ${m.qty < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{m.qty > 0 ? '+' : ''}{m.qty} EA</td>
                <td className="font-mono text-xs tabular-nums">{p ? `${cases(m.before, p.unitsPerCase)} → ${cases(m.after, p.unitsPerCase)}` : `${m.before} → ${m.after}`}</td>
                <td>{m.user}</td>
                <td className="font-mono text-xs text-muted">{m.ref ?? ''}</td>
              </tr>
            );
          })}
        </Table>
      </Panel>

      {labels && <LabelsModal products={ps} onClose={() => setLabels(false)} />}
    </div>
  );
}
