// Nodos personalizados de React Flow compartidos por los diagramas.
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { motion } from 'motion/react';
import { AwsIcon, type AwsService } from './common';
import { cn } from '@/lib/utils';

export type ServiceNodeData = {
  icon?: AwsService;
  title: string;
  subtitle?: string;
  tone?: 'landing' | 'bronze' | 'silver' | 'gold' | 'athena' | 'neutral';
  state?: 'running' | 'failed' | 'succeeded';
  onClick?: () => void;
  dashed?: boolean;
  badge?: string;
};

const TONE: Record<NonNullable<ServiceNodeData['tone']>, string> = {
  landing: 'border-landing/70', bronze: 'border-bronze/80', silver: 'border-silver/70', gold: 'border-gold/80',
  athena: 'border-[#a855f7]/70', neutral: 'border-border',
};

/** Caja con el icono oficial del servicio de AWS. Los 4 lados tienen conectores. */
export function ServiceNode({ data }: NodeProps & { data: ServiceNodeData }) {
  const st = data.state;
  return (
    <motion.div
      layout
      onClick={data.onClick}
      className={cn(
        'flex w-[230px] items-center gap-3 rounded-xl border-2 bg-surface px-3 py-2.5 shadow-sm',
        TONE[data.tone ?? 'neutral'],
        data.dashed && 'border-dashed opacity-80',
        st === 'running' && 'pulse-ring border-accent bg-accent/10',
        st === 'succeeded' && 'border-success bg-success/10',
        st === 'failed' && 'border-danger bg-danger/10',
        data.onClick && 'cursor-pointer hover:bg-surface-secondary',
      )}
    >
      {data.icon && <AwsIcon name={data.icon} size={36} />}
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-tight">{data.title}</p>
        {data.subtitle && <p className="text-[11px] leading-snug text-muted">{data.subtitle}</p>}
        {data.badge && <span className="mt-1 inline-block rounded-full border border-warning/60 px-1.5 text-[10px] text-warning">{data.badge}</span>}
      </div>
      {(['Left', 'Right', 'Top', 'Bottom'] as const).map((p) => (
        <span key={p}>
          <Handle type="target" position={Position[p]} id={`t-${p}`} className="!opacity-0" />
          <Handle type="source" position={Position[p]} id={`s-${p}`} className="!opacity-0" />
        </span>
      ))}
    </motion.div>
  );
}

/** Etiqueta grande para agrupar zonas del diagrama (ej. "Front-end", "Data lake"). */
export function GroupNode({ data }: NodeProps & { data: { title: string; w: number; h: number; tint?: string } }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface-secondary/30" style={{ width: data.w, height: data.h, background: data.tint }}>
      <p className="px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted">{data.title}</p>
    </div>
  );
}

export const flowNodeTypes = { service: ServiceNode, zone: GroupNode };
