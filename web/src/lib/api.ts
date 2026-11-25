// Cliente tipado de la API. Cada llamada adjunta el JWT de Cognito.
import { currentIdToken } from './auth';

let apiUrl = '';
export const setApiUrl = (url: string) => { apiUrl = url.replace(/\/$/, ''); };

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) { super(message); }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await currentIdToken();
  if (!token) throw new ApiError('Sesión expirada. Vuelve a iniciar sesión.', 401, {});
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { message?: string }).message || `Error ${res.status}`, res.status, data);
  return data as T;
}

/* ------------------------------------------------------------------ tipos */
export type DatasetStatus = 'no_file' | 'pending' | 'bronze' | 'stale' | 'ok';
export type StageStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed';
export type PipelineMode = 'event' | 'scheduled';
export type GoldStatus = 'not_built' | 'stale' | 'ok';

export interface StageInfo {
  status: StageStatus;
  rows?: number;
  rowsIn?: number;
  duplicates?: number;
  error?: string;
  detail?: { dependency: string; status: string; reason: string }[];
  startedAt?: number;
  finishedAt?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
  note?: string;
  skipped?: boolean;
  archived?: string[];
  glueRunId?: string;
}
export interface DatasetRun {
  executionId: string;
  runStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | string;
  orchestrator: 'event' | 'stepfunctions';
  updatedAt?: number;
  queued: boolean;
  stages: Record<'bronze' | 'dependencies' | 'silver', StageInfo>;
}
export interface DatasetState {
  name: string;
  description: string;
  engine: 'pandas' | 'glue';
  dependsOn: string[];
  files: { name: string; uploaded: boolean; size?: number }[];
  status: DatasetStatus;
  rows: { bronze?: number; silver?: number };
  lastBronzeAt?: string;
  archived: string[];
  run: DatasetRun | null;
}
export interface GoldState {
  name: string;
  silverDeps: string[];
  goldDeps: string[];
  status: GoldStatus;
  run: { status: StageStatus | 'blocked'; error?: string; detail?: { dependency: string; reason: string }[]; active?: boolean;
    attempt?: number; maxAttempts?: number; executionId?: string; skipped?: boolean } | null;
}
export interface QueueDepth { visible: number; inFlight: number; delayed: number; error?: boolean }
export interface LakeState {
  datasets: DatasetState[]; gold: GoldState[]; running: boolean; ready: boolean; mode: PipelineMode;
  queues: Record<'events' | 'retry' | 'dlq', QueueDepth>;
  schedule: { everyMinutes: number; lastRun: { executionArn: string; status: string; startDate: string; stopDate?: string } | null };
  runningMachines: Record<'datasets' | 'gold' | 'scheduled', boolean>;
}
export interface FeedEvent { ts: number; level: 'info' | 'ok' | 'wait' | 'error'; kind: string; target: string; text: string; trace?: string; attempt?: number }
export interface StoragePrefix { prefix: string; depth: number; files: number; bytes: number; lastModified: string | null }
export interface StorageBucket { label: string; bucket: string; files: number; bytes: number; prefixes: StoragePrefix[] }

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  queryExecutionId: string;
  stats?: { dataScannedBytes?: number; engineMillis?: number; totalMillis?: number };
}

export interface CostService {
  id: string;
  label: string;
  cost: number;
  usage: { label: string; value: number; unit: string }[];
  details: Record<string, string | number>[];
  note?: string | null;
  error?: string | null;
}
export interface CostReport {
  range: string;
  generatedAt: string;
  windowHours: number;
  periodSeconds: number;
  total: number;
  monthlyProjection: number;
  services: CostService[];
  series: ({ t: string; total: number } & Record<string, number | string>)[];
  prices: Record<string, number>;
}

export type LogLevel = 'ERROR' | 'WARN' | 'INFO';
export interface LogEvent { ts: number; stream: string; group: string; message: string; level: LogLevel; platform: boolean }
export interface LogsResponse {
  source: string; label: string; groups: string[]; minutes: number;
  counts: Record<LogLevel, number>; total: number; truncated: boolean; events: LogEvent[];
}
export interface LogsSummary {
  minutes: number;
  sources: Record<string, { label: string; kind: string; stage: string } & Record<LogLevel, number> & { unavailable?: string }>;
}
export interface Run {
  kind: string; id: string; arn: string; status: string; startedAt: string; stoppedAt?: string; input: string[]; error?: string | null;
}

/* --------------------------------------------------------------- llamadas */
export const api = {
  state: () => call<LakeState>('GET', '/state'),
  /** 'single' = solo ese dataset · 'with_dependencies' = ese dataset y todo lo que necesita. 'all' = todos. */
  startDatasets: (dataset: string, mode: 'single' | 'with_dependencies' = 'single') =>
    call<{ executionArn: string; datasets: string[] }>('POST', '/pipeline/start', { kind: 'datasets', dataset, mode }),
  startGold: (models: string[] = []) =>
    call<{ executionArn: string; models: string[] }>('POST', '/pipeline/start', { kind: 'gold', models }),
  reset: (includeLanding: boolean) => call<Record<string, unknown>>('POST', '/reset', { includeLanding }),
  setMode: (mode: PipelineMode) => call<{ mode: PipelineMode; resentEvents: string[] }>('POST', '/mode', { mode }),
  events: () => call<{ events: FeedEvent[] }>('GET', '/events'),
  storage: () => call<{ buckets: StorageBucket[]; generatedAt: string }>('GET', '/storage'),
  restore: (dataset = 'all') => call<{ restored: { file: string; from: string }[]; missing: string[] }>('POST', '/landing/restore', { dataset }),
  simulateMissing: (filename: string) => call<{ sent: string }>('POST', '/events/simulate', { filename }),
  redriveDlq: () => call<{ messages: number }>('POST', '/dlq/redrive'),
  runSchedule: () => call<{ executionArn: string }>('POST', '/schedule/run'),
  query: (sql: string) => call<QueryResult>('POST', '/query', { sql }),
  costs: (range: '24h' | '7d' | '30d') => call<CostReport>('GET', `/costs?range=${range}`),
  logs: (p: { source: string; minutes: number; level: string; q?: string }) =>
    call<LogsResponse>('GET', `/logs?${new URLSearchParams({ ...p, minutes: String(p.minutes), limit: '400', q: p.q ?? '' })}`),
  logsSummary: (minutes: number) => call<LogsSummary>('GET', `/logs?summary=1&minutes=${minutes}`),
  runs: () => call<{ runs: Run[]; generatedAt: string }>('GET', '/runs'),

  /** Sube un CSV directo a S3 con una URL prefirmada (no pasa por la API ni por Lambda). */
  async upload(file: File) {
    const { url, contentType } = await call<{ url: string; contentType: string }>('POST', '/upload-url', { filename: file.name });
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
    if (!res.ok) throw new Error(`S3 rechazó ${file.name} (${res.status})`);
  },
};
