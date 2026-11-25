import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type LakeState } from './api';

/** Estado del lake (GET /state). Mientras algo se ejecuta se refresca cada 2,5 s; si no, cada 30 s. */
export function useLake() {
  return useQuery<LakeState>({
    queryKey: ['state'],
    queryFn: api.state,
    refetchInterval: (q) => (q.state.data?.running ? 2500 : 30_000),
  });
}

export function useRefreshLake() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['state'] });
}

/** Estado visual de cada capa del medallion a partir de /state. */
export type LayerState = 'running' | 'failed' | 'succeeded' | undefined;
export function layerStates(state?: LakeState): Record<'landing' | 'bronze' | 'silver' | 'gold' | 'athena', LayerState> {
  if (!state) return { landing: undefined, bronze: undefined, silver: undefined, gold: undefined, athena: undefined };
  const ds = state.datasets;
  const stage = (k: 'bronze' | 'dependencies' | 'silver') => ds.map((d) => {
    const st = d.run?.runStatus === 'SUCCEEDED' ? 'succeeded' : d.run?.stages?.[k]?.status;
    return st === 'waiting' ? 'running' : st;  // esperar dependencias también es "en curso"
  });
  const pick = (list: (string | undefined)[], done: boolean): LayerState =>
    list.includes('failed') || list.includes('blocked') ? 'failed' : list.includes('running') ? 'running' : done ? 'succeeded' : undefined;
  const goldOk = state.gold.every((g) => g.status === 'ok');
  return {
    landing: state.ready ? 'succeeded' : undefined,
    bronze: pick(stage('bronze'), ds.every((d) => ['bronze', 'stale', 'ok'].includes(d.status))),
    silver: pick([...stage('dependencies'), ...stage('silver')], ds.every((d) => d.status === 'ok')),
    gold: pick(state.gold.map((g) => (g.run?.status === 'waiting' ? 'running' : g.run?.status)), goldOk),
    athena: goldOk ? 'succeeded' : undefined,
  };
}
