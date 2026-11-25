import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combina clases de Tailwind resolviendo conflictos (helper estándar de shadcn/ui). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const fmtNum = (n: number | string | null | undefined) =>
  n == null || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('es');

export const fmtBytes = (n?: number | null) =>
  n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`;

/** 1234567 -> "1.2M" para ejes y KPIs. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Dólares con la precisión adecuada: los costos de una demo son fracciones de centavo. */
export function usd(n: number): string {
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(5)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const fmtTime = (ts: number | string) =>
  new Date(ts).toLocaleString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
