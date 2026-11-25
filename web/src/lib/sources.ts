// Código fuente del repositorio embebido en la web (en tiempo de build), para que
// cada parte del pipeline pueda abrir y mostrar el archivo al que hace referencia.
// Vite lee estos archivos como texto con `?raw`; no se ejecuta nada.

const backend = import.meta.glob('../../../backend/**/*.{py,sql}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const infra = import.meta.glob('../../../infra/{app.py,stacks/*.py}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const root = import.meta.glob('../../../deplo.sh', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Ruta relativa al repo ("backend/lambdas/bronze/handler.py") -> contenido. */
export const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries({ ...backend, ...infra, ...root })
    .filter(([p]) => !p.includes('__pycache__'))
    .map(([p, src]) => [p.replace(/^(\.\.\/)+/, ''), src]),
);

export const languageOf = (path: string) =>
  path.endsWith('.py') ? 'python' : path.endsWith('.sql') ? 'sql' : path.endsWith('.sh') ? 'bash' : 'text';

/** Número de línea (1-based) donde aparece un texto; sirve para resaltar la parte relevante. */
export function lineOf(path: string, needle?: string): number | undefined {
  if (!needle) return undefined;
  const idx = (SOURCES[path] ?? '').split('\n').findIndex((l) => l.includes(needle));
  return idx >= 0 ? idx + 1 : undefined;
}

// Se define al compilar (deplo.sh la deduce del remote); vacía = sin enlace a GitHub.
export const GITHUB_BASE: string = import.meta.env.VITE_GITHUB_BASE ?? '';
