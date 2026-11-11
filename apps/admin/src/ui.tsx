import { useEffect, useMemo, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type ButtonHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { formatCents, type Cents } from '@asm/shared';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Button({
  variant = 'primary', size = 'md', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  const styles = {
    primary: 'bg-ink text-white hover:bg-ink-2 disabled:bg-slate-400',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        styles,
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, error, hint, children, className }: {
  label: string; error?: string; hint?: string; children: ReactNode; className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span>
        : hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
    </label>
  );
}

const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/15 disabled:bg-slate-100';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}

export function Select({ options, placeholder, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  options: { value: string; label: string }[]; placeholder?: string;
}) {
  return (
    <select {...props} className={cx(inputCls, props.className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={cx(inputCls, props.className)} />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'gold' }) {
  return (
    <div className={cx('rounded-lg border bg-white p-4 shadow-sm', tone === 'gold' ? 'border-gold/40' : 'border-slate-200')}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="num mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'blue' | 'red' }) {
  const t = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-800',
    blue: 'bg-sky-50 text-sky-700',
    red: 'bg-red-50 text-red-700',
  }[tone];
  return <span className={cx('inline-flex rounded px-1.5 py-0.5 text-xs font-medium', t)}>{children}</span>;
}

export function Money({ cents, className }: { cents: Cents | null | undefined; className?: string }) {
  if (cents === null || cents === undefined) return <span className="text-slate-400">—</span>;
  return <span className={cx('num', cents < 0 && 'text-red-700', className)}>{formatCents(cents, { accounting: true })}</span>;
}

export function Modal({ open, title, onClose, children, width = 'max-w-2xl' }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" onMouseDown={onClose}>
      <div className={cx('w-full rounded-lg bg-white shadow-xl', width)} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">✕</button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message?: string | null }) {
  if (!message) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>;
}

// ---------------- Data table: sortable, filterable, paginated ----------------

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  align?: 'right' | 'left';
  className?: string;
}

export function DataTable<T extends { id: string }>({
  rows, columns, onRowClick, searchText, matches, searchPlaceholder = 'Filter…', onFilterChange, pageSize = 25, empty = 'Nothing here yet.', initialSort, selectable, selected, onSelectedChange,
}: {
  rows: T[];
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  /** When provided, a filter box appears and rows are filtered by this text. */
  searchText?: (row: T) => string;
  /** Custom filter (instead of searchText): gets the trimmed, lower-cased query. */
  matches?: (row: T, query: string) => boolean;
  searchPlaceholder?: string;
  onFilterChange?: (query: string) => void;
  pageSize?: number;
  empty?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const base = !f ? rows : matches ? rows.filter((r) => matches(r, f)) : searchText ? rows.filter((r) => searchText(r).toLowerCase().includes(f)) : rows;
    if (!sort) return base;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return base;
    const get = col.sort;
    return [...base].sort((a, b) => {
      const x = get(a), y = get(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, filter, sort, columns, searchText, matches]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize);
  const allVisibleSelected = selectable && visible.length > 0 && visible.every((r) => selected?.has(r.id));

  function toggle(id: string) {
    if (!selected || !onSelectedChange) return;
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    onSelectedChange(s);
  }

  return (
    <div>
      {(searchText || matches) && (
        <div className="mb-3">
          <TextInput placeholder={searchPlaceholder} aria-label={searchPlaceholder} value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); onFilterChange?.(e.target.value.trim().toLowerCase()); }} className="max-w-sm" />
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {selectable && (
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" checked={!!allVisibleSelected} aria-label="Select all on page"
                    onChange={() => {
                      if (!selected || !onSelectedChange) return;
                      const s = new Set(selected);
                      visible.forEach((r) => (allVisibleSelected ? s.delete(r.id) : s.add(r.id)));
                      onSelectedChange(s);
                    }} />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} scope="col"
                  className={cx('whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500', c.align === 'right' ? 'text-right' : 'text-left', c.sort && 'cursor-pointer select-none hover:text-ink')}
                  onClick={() => c.sort && setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }))}>
                  {c.header}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {visible.length === 0 ? (
              <tr><td colSpan={columns.length + (selectable ? 1 : 0)} className="px-3 py-8 text-center text-slate-500">{empty}</td></tr>
            ) : visible.map((r) => (
              <tr key={r.id} className={cx(onRowClick && 'cursor-pointer hover:bg-slate-50')} onClick={() => onRowClick?.(r)}>
                {selectable && (
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={!!selected?.has(r.id)} onChange={() => toggle(r.id)} aria-label="Select row" />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={cx('whitespace-nowrap px-3 py-2', c.align === 'right' && 'num text-right', c.className)}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>{filtered.length.toLocaleString()} {filtered.length === 1 ? 'row' : 'rows'}</span>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
            <span>Page {current + 1} of {pages}</span>
            <Button size="sm" variant="secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Small horizontal bar list for breakdowns (carrier mix, broker comparison). */
export function BarList({ items }: { items: { id: string; label: string; cents: Cents; hint?: string }[] }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.cents)));
  if (items.length === 0) return <p className="text-sm text-slate-500">No posted commissions yet.</p>;
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.id}>
          <div className="flex justify-between text-sm">
            <span className="truncate pr-2 text-slate-700">{i.label}{i.hint && <span className="ml-1 text-xs text-slate-400">{i.hint}</span>}</span>
            <Money cents={i.cents} />
          </div>
          <div className="mt-1 h-1.5 rounded bg-slate-100">
            <div className={cx('h-1.5 rounded', i.cents < 0 ? 'bg-red-400' : 'bg-ink')} style={{ width: `${(Math.abs(i.cents) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
