import type { ReactNode } from 'react';
import { EmptyState } from './empty-state.js';

export interface DataTableColumn<Row> {
  key: string;
  label: string;
  width?: string;
  className?: string;
  render(row: Row): ReactNode;
}

interface DataTableProps<Row> {
  ariaLabel: string;
  columns: Array<DataTableColumn<Row>>;
  rows: Row[];
  rowKey(row: Row): string;
  emptyTitle: string;
}

export function DataTable<Row>({
  ariaLabel,
  columns,
  rows,
  rowKey,
  emptyTitle,
}: DataTableProps<Row>) {
  return (
    <div className="data-table-wrap">
      <table className="data-table" aria-label={ariaLabel}>
        <colgroup>
          {columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}><EmptyState title={emptyTitle} /></td>
            </tr>
          ) : rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.className}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
