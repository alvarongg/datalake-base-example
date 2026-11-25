// Piezas pequeñas reutilizadas por todas las vistas.
import { Chip, Spinner } from '@heroui/react';
import { Cpu, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import lambda from '@/assets/aws/lambda.svg';
import cognito from '@/assets/aws/cognito.svg';
import s3 from '@/assets/aws/s3.svg';
import stepFunctions from '@/assets/aws/step-functions.svg';
import glue from '@/assets/aws/glue.svg';
import athena from '@/assets/aws/athena.svg';
import apiGateway from '@/assets/aws/api-gateway.svg';
import cloudfront from '@/assets/aws/cloudfront.svg';
import { cn } from '@/lib/utils';

/** Iconos OFICIALES de AWS (AWS Architecture Icons, ver assets/aws/NOTICE.md). */
export const AWS_ICONS = { lambda, cognito, s3, stepFunctions, glue, athena, apiGateway, cloudfront } as const;
export type AwsService = keyof typeof AWS_ICONS;
export const AWS_LABELS: Record<AwsService, string> = {
  lambda: 'AWS Lambda', cognito: 'Amazon Cognito', s3: 'Amazon S3', stepFunctions: 'AWS Step Functions',
  glue: 'AWS Glue', athena: 'Amazon Athena', apiGateway: 'Amazon API Gateway', cloudfront: 'Amazon CloudFront',
};

export function AwsIcon({ name, size = 32, className }: { name: AwsService; size?: number; className?: string }) {
  return <img src={AWS_ICONS[name]} width={size} height={size} alt={AWS_LABELS[name]} title={AWS_LABELS[name]} className={cn('shrink-0 rounded-md', className)} draggable={false} />;
}

/** Encabezado de cada pestaña: título, explicación breve y acciones. */
export function PageHeader({ title, subtitle, children }: { title: string; subtitle: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-4xl">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

const STATUS: Record<string, { label: string; color: 'success' | 'warning' | 'danger' | 'accent' | 'default' }> = {
  ok: { label: 'Al día', color: 'success' },
  succeeded: { label: 'OK', color: 'success' },
  SUCCEEDED: { label: 'OK', color: 'success' },
  stale: { label: 'Desactualizada', color: 'warning' },
  bronze: { label: 'Solo Bronze', color: 'warning' },
  pending: { label: 'Sin procesar', color: 'default' },
  not_built: { label: 'Sin construir', color: 'default' },
  no_file: { label: 'Sin archivo', color: 'default' },
  running: { label: 'En ejecución', color: 'accent' },
  RUNNING: { label: 'En ejecución', color: 'accent' },
  queued: { label: 'En cola', color: 'accent' },
  failed: { label: 'Falló', color: 'danger' },
  FAILED: { label: 'Falló', color: 'danger' },
  TIMED_OUT: { label: 'Timeout', color: 'danger' },
  ABORTED: { label: 'Abortada', color: 'danger' },
  blocked: { label: 'Bloqueado', color: 'danger' },
  STOPPED: { label: 'Detenido', color: 'warning' },
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { label: status, color: 'default' as const };
  const busy = status === 'running' || status === 'RUNNING' || status === 'queued';
  return (
    <Chip size="sm" variant="soft" color={s.color}>
      {busy && <Spinner size="sm" color="current" className="size-3" />}
      <Chip.Label>{label ?? s.label}</Chip.Label>
    </Chip>
  );
}

/** Explica por qué se usa Lambda o Glue: la regla del millón de registros. */
export function EngineNote({ engine, compact = false }: { engine: 'lambda' | 'glue'; compact?: boolean }) {
  const isGlue = engine === 'glue';
  return (
    <div className={cn('flex gap-3 rounded-xl border p-3 text-sm',
      isGlue ? 'border-glue/40 bg-glue/10' : 'border-pandas/40 bg-pandas/10')}>
      {isGlue ? <Cpu className="mt-0.5 size-5 shrink-0 text-glue" /> : <Zap className="mt-0.5 size-5 shrink-0 text-pandas" />}
      <div>
        <p className="font-medium">{isGlue ? 'AWS Glue Job (Spark): procesamiento paralelo' : 'AWS Lambda: elegida por el tamaño del dataset'}</p>
        {!compact && (
          <p className="mt-0.5 text-muted">
            {isGlue
              ? 'Spark reparte los datos entre varios workers y los procesa en paralelo. Es el estándar cuando una tabla supera el millón de registros: escala horizontalmente sin cambiar el código. Su costo es el arranque (1-2 min) y que factura por segundo de DPU.'
              : 'Adventure Works es chico (la tabla más grande tiene 56 mil filas), así que una Lambda con pandas lo procesa en segundos y casi sin costo. Con datasets de más de un millón de registros se suele pasar a un Glue Job con Spark, por su capacidad de procesamiento paralelo y porque no tiene el límite de 15 minutos ni de 10 GB de memoria de Lambda.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>;
}

export function Kpi({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-secondary/60 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', accent)}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
