// Table de shadcn/ui, adaptada a los tokens de HeroUI.
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}
export const TableHeader = ({ className, ...p }: React.ComponentProps<'thead'>) => <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...p} />;
export const TableBody = ({ className, ...p }: React.ComponentProps<'tbody'>) => <tbody className={cn('[&_tr:last-child]:border-0', className)} {...p} />;
export const TableRow = ({ className, ...p }: React.ComponentProps<'tr'>) => <tr className={cn('border-b border-separator transition-colors hover:bg-surface-secondary/60', className)} {...p} />;
export const TableHead = ({ className, ...p }: React.ComponentProps<'th'>) => <th className={cn('h-9 px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted', className)} {...p} />;
export const TableCell = ({ className, ...p }: React.ComponentProps<'td'>) => <td className={cn('px-3 py-2 align-top', className)} {...p} />;

/** Tabla simple a partir de encabezados y filas (atajo para resultados de Athena). */
export function DataTable({ head, rows, className }: { head: string[]; rows: React.ReactNode[][]; className?: string }) {
  return (
    <Table className={className}>
      <TableHeader><TableRow>{head.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {rows.map((r, i) => <TableRow key={i}>{r.map((v, j) => <TableCell key={j}>{v ?? ''}</TableCell>)}</TableRow>)}
      </TableBody>
    </Table>
  );
}
