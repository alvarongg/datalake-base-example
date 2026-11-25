// Visor de código: un panel lateral que muestra el archivo real del repositorio
// (embebido en la web al compilar) con resaltado de sintaxis. Cualquier parte de
// la app puede abrirlo con useCode().open({ files, title, highlight }).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { Button } from '@heroui/react';
import { Code2, Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { GITHUB_BASE, SOURCES, languageOf, lineOf } from '@/lib/sources';
import { cn } from '@/lib/utils';

export interface CodeRequest {
  title: string;
  description?: string;
  files: string[];
  /** Texto a buscar en el primer archivo para resaltar y desplazarse hasta esa línea. */
  highlight?: string;
}

const Ctx = createContext<{ open: (r: CodeRequest) => void }>({ open: () => {} });
export const useCode = () => useContext(Ctx);

export function CodeViewerProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<CodeRequest | null>(null);
  const [active, setActive] = useState(0);
  const open = useCallback((r: CodeRequest) => { setReq(r); setActive(0); }, []);
  const value = useMemo(() => ({ open }), [open]);
  const files = (req?.files ?? []).filter((f) => f in SOURCES);
  const file = files[active];

  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet open={!!req} onOpenChange={(o) => !o && setReq(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Code2 className="size-5 text-accent" />{req?.title}</SheetTitle>
            <SheetDescription>{req?.description ?? 'Código real del repositorio, tal como se despliega.'}</SheetDescription>
          </SheetHeader>
          {files.length > 1 && (
            <div className="flex flex-wrap gap-1 border-b border-border px-4 py-2">
              {files.map((f, i) => (
                <button key={f} onClick={() => setActive(i)}
                  className={cn('rounded-md px-2.5 py-1 font-mono text-xs', i === active ? 'bg-accent text-accent-foreground' : 'text-muted hover:bg-surface-secondary')}>
                  {f.split('/').slice(-2).join('/')}
                </button>
              ))}
            </div>
          )}
          {file ? <CodeBlock path={file} highlight={active === 0 ? req?.highlight : undefined} /> : (
            <p className="p-6 text-sm text-muted">No se encontró el archivo en el bundle.</p>
          )}
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  );
}

function CodeBlock({ path, highlight }: { path: string; highlight?: string }) {
  const code = SOURCES[path].replace(/\n$/, '');
  const target = lineOf(path, highlight);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[data-target="true"]');
    el?.scrollIntoView({ block: 'center' });
  }, [path, target]);

  return (
    <>
      <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted">
        <span className="font-mono">{path}</span>
        <span>· {code.split('\n').length} líneas</span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onPress={() => navigator.clipboard.writeText(code).then(() => toast.success('Código copiado'))}>
            <Copy className="size-3.5" /> Copiar
          </Button>
          {GITHUB_BASE && (
            <a className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-surface-secondary" href={`${GITHUB_BASE}${path}`} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" /> GitHub
            </a>
          )}
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-2 pb-6">
        <Highlight theme={themes.vsDark} code={code} language={languageOf(path)}>
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre className="min-w-max rounded-lg bg-[#1e1e1e] py-3 font-mono text-[12.5px] leading-5">
              {tokens.map((line, i) => {
                const isTarget = target === i + 1;
                const { key: _k, ...lineProps } = getLineProps({ line, key: i }) as Record<string, unknown> & { key?: unknown };
                return (
                  <div key={i} {...lineProps} data-target={isTarget} className={cn('flex pr-6', isTarget && 'bg-accent/25')}>
                    <span className="w-12 shrink-0 select-none pr-4 text-right text-white/30">{i + 1}</span>
                    <span>{line.map((token, k) => {
                      const { key: _tk, ...tp } = getTokenProps({ token, key: k }) as Record<string, unknown> & { key?: unknown };
                      return <span key={k} {...tp} />;
                    })}</span>
                  </div>
                );
              })}
            </pre>
          )}
        </Highlight>
      </div>
    </>
  );
}

/** Botón estándar "Ver código" que abre el visor. */
export function CodeButton({ request, label = 'Ver código', size = 'sm' }: { request: CodeRequest; label?: string; size?: 'sm' | 'md' }) {
  const { open } = useCode();
  return (
    <Button size={size} variant="secondary" onPress={() => open(request)}>
      <Code2 className="size-4" /> {label}
    </Button>
  );
}
