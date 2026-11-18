import { CheckCircle2, XCircle, Flame, AlertTriangle, HelpCircle } from 'lucide-react';

/** Display metadata for each NeverBounce result code, in canonical order. */
export const STATUS_ORDER = ['valid', 'invalid', 'disposable', 'catchall', 'unknown'];

export const STATUS_META = {
  valid: {
    label: 'Valid',
    description: 'Safe to send — the mailbox exists and accepts mail.',
    icon: CheckCircle2,
    color: '#10b981',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    soft: 'bg-emerald-50 border-emerald-200',
    text: 'text-emerald-700',
  },
  invalid: {
    label: 'Invalid',
    description: 'Will bounce — the address or domain does not exist.',
    icon: XCircle,
    color: '#ef4444',
    badge: 'bg-red-50 text-red-700 ring-red-600/20',
    soft: 'bg-red-50 border-red-200',
    text: 'text-red-700',
  },
  disposable: {
    label: 'Disposable',
    description: 'Temporary inbox from a throwaway provider.',
    icon: Flame,
    color: '#f97316',
    badge: 'bg-orange-50 text-orange-700 ring-orange-600/20',
    soft: 'bg-orange-50 border-orange-200',
    text: 'text-orange-700',
  },
  catchall: {
    label: 'Catch-all',
    description: 'Domain accepts all mail; the mailbox cannot be confirmed.',
    icon: AlertTriangle,
    color: '#eab308',
    badge: 'bg-yellow-50 text-yellow-800 ring-yellow-600/25',
    soft: 'bg-yellow-50 border-yellow-200',
    text: 'text-yellow-800',
  },
  unknown: {
    label: 'Unknown',
    description: 'The mail server did not give a definitive answer.',
    icon: HelpCircle,
    color: '#94a3b8',
    badge: 'bg-slate-100 text-slate-700 ring-slate-500/20',
    soft: 'bg-slate-50 border-slate-200',
    text: 'text-slate-700',
  },
};

export const emptyCounts = () => ({ valid: 0, invalid: 0, disposable: 0, catchall: 0, unknown: 0 });

export const FLAG_LABELS = {
  has_dns: 'Has DNS',
  has_dns_mx: 'Has MX records',
  free_email_host: 'Free email host',
  role_account: 'Role account',
  smtp_connectable: 'SMTP connectable',
  bad_syntax: 'Bad syntax',
  disposable_email: 'Disposable domain',
  spelling_mistake: 'Spelling mistake',
  bad_dns: 'Bad DNS',
  connect_fails: 'Connect fails',
  accepts_all: 'Accepts all',
};
