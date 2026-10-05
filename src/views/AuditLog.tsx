import { useState } from 'react';
import type { Ctx } from '../App';
import type { MovementType } from '../shared';
import { dateTime } from '../lib';
import { cx, Panel, Table, Tag } from '../ui';

const TYPES: MovementType[] = ['SCAN_SALE', 'EPOS_SALE', 'INVOICE_INTAKE', 'CYCLE_COUNT', 'ADJUSTMENT'];

export default function AuditLog({ state }: Ctx) {
  const [type, setType] = useState<MovementType | null>(null);
  const rows = state.movements.filter((m) => !type || m.type === type);
  return (
    <Panel title={`Stock Movement Audit Log · ${rows.length} records`} pad={false}
      actions={[null, ...TYPES].map((t) => (
        <button key={t ?? 'all'} onClick={() => setType(t)}
          className={cx('border px-2 py-1 text-[10px] font-bold uppercase tracking-wider', type === t ? 'border-ink bg-ink text-canvas' : 'border-line hover:border-ink')}>
          {t?.replace('_', ' ') ?? 'All'}
        </button>
      ))}>
      <Table head={['#', 'Timestamp', 'Type', 'UPC', 'Product', 'Δ Qty', 'Before', 'After', 'Employee', 'Reference']} empty="No movements recorded.">
        {rows.map((m) => (
          <tr key={m.id}>
            <td className="font-mono text-xs text-muted">{m.id}</td>
            <td className="whitespace-nowrap font-mono text-xs">{dateTime(m.ts)}</td>
            <td><Tag v={m.type} /></td>
            <td className="font-mono text-xs">{m.upc}</td>
            <td>{m.name}</td>
            <td className={cx('font-mono tabular-nums', m.qty < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>{m.qty > 0 ? '+' : ''}{m.qty}</td>
            <td className="font-mono tabular-nums">{m.before}</td>
            <td className="font-mono tabular-nums">{m.after}</td>
            <td>{m.user}</td>
            <td className="font-mono text-xs text-muted">{m.ref ?? ''}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}
