import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Button, Spinner } from '@heroui/react';
import { Activity, BarChart3, Database, DollarSign, Layers, LogOut, Play, Workflow } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { CodeViewerProvider } from './components/CodeViewer';
import { Login } from './views/Login';
import { currentEmail, currentIdToken, logout } from './lib/auth';
import { useLake } from './lib/hooks';
import { StatusChip } from './components/common';

// Cada pestaña se carga bajo demanda (code splitting): la primera carga es más liviana.
const Overview = lazy(() => import('./views/Overview'));
const DataModel = lazy(() => import('./views/DataModel'));
const Pipelines = lazy(() => import('./views/Pipelines'));
const Operate = lazy(() => import('./views/Operate'));
const Consult = lazy(() => import('./views/Consult'));
const Costs = lazy(() => import('./views/Costs'));
const Observability = lazy(() => import('./views/Observability'));

/** Orden de las pestañas = orden en que se enseña a construir el data lake. */
const TABS: { id: string; label: string; icon: ReactNode; view: ReactNode }[] = [
  { id: 'resumen', label: 'Resumen', icon: <Layers className="size-4" />, view: <Overview /> },
  { id: 'modelo', label: 'Modelo de datos', icon: <Database className="size-4" />, view: <DataModel /> },
  { id: 'pipelines', label: 'Pipelines', icon: <Workflow className="size-4" />, view: <Pipelines /> },
  { id: 'operar', label: 'Operar', icon: <Play className="size-4" />, view: <Operate /> },
  { id: 'consultar', label: 'Consultar', icon: <BarChart3 className="size-4" />, view: <Consult /> },
  { id: 'costos', label: 'Costos', icon: <DollarSign className="size-4" />, view: <Costs /> },
  { id: 'observabilidad', label: 'Observabilidad', icon: <Activity className="size-4" />, view: <Observability /> },
];

const initialTab = () => {
  const h = location.hash.slice(1);
  return TABS.some((t) => t.id === h) ? h : 'resumen';
};

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => { currentIdToken().then((t) => setAuthed(!!t)); }, []);

  if (authed === null) return <div className="grid h-full place-items-center"><Spinner size="lg" /></div>;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <CodeViewerProvider><Shell onLogout={() => { logout(); setAuthed(false); }} /></CodeViewerProvider>;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState(initialTab);
  const { data: lake } = useLake();
  useEffect(() => { history.replaceState(null, '', `#${tab}`); }, [tab]);

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-full flex-col">
      {/* Barra superior: ocupa todo el ancho, pensada para monitores 16:9. */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="flex items-center gap-6 px-6 py-3 2xl:px-10">
          <div className="flex shrink-0 items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-bronze via-silver to-gold text-sm font-bold text-black">DL</div>
            <div className="leading-tight">
              <p className="font-semibold">Data Lake Medallion</p>
              <p className="text-xs text-muted">Adventure Works · paso a paso</p>
            </div>
          </div>
          <TabsList className="min-w-0 flex-1 overflow-x-auto">
            {TABS.map((t, i) => (
              <TabsTrigger key={t.id} value={t.id}>
                <span className="text-xs text-muted">{i + 1}</span>{t.icon}{t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex shrink-0 items-center gap-3">
            {lake?.running && <StatusChip status="running" label="Pipeline en ejecución" />}
            <span className="hidden text-sm text-muted xl:inline">{currentEmail()}</span>
            <Button size="sm" variant="ghost" onPress={onLogout}><LogOut className="size-4" /> Salir</Button>
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-6 2xl:px-10">
        {TABS.map((t) => (
          <TabsContent key={t.id} value={t.id} forceMount={undefined}>
            <AnimatePresence mode="wait">
              {tab === t.id && (
                <motion.div key={t.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
                  <Suspense fallback={<div className="grid h-64 place-items-center"><Spinner /></div>}>{t.view}</Suspense>
                </motion.div>
              )}
            </AnimatePresence>
          </TabsContent>
        ))}
      </main>
    </Tabs>
  );
}
