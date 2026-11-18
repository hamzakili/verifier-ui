import { STATUS_META } from '../lib/status';

export default function StatusBadge({ status, size = 'sm' }) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  const Icon = meta.icon;
  const sizes = size === 'lg' ? 'px-3 py-1 text-sm gap-1.5' : 'px-2 py-0.5 text-xs gap-1';
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full font-medium ring-1 ring-inset ${meta.badge} ${sizes}`}>
      <Icon className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
