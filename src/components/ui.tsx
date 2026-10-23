import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { IconClose } from './icons';
import { useUpdateBlocker, DIRTY_MESSAGE } from '../pwa/updateSafety';

export function Button({
  variant = 'default',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}) {
  const cls = ['btn', variant === 'primary' ? 'btn-primary' : '', variant === 'ghost' ? 'btn-ghost' : '', variant === 'danger' ? 'btn-danger' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} {...props}>
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      {!error && hint ? <span className="muted">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input ${className}`} {...props}>
      {children}
    </select>
  );
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input py-2 ${className}`} rows={3} {...props} />;
}

export function Card({
  children,
  className = '',
  padded = true,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: 'section' | 'div' | 'li' | 'article';
}) {
  return <Tag className={`paper ${padded ? 'p-4' : 'p-0'} ${className}`}>{children}</Tag>;
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'warn' | 'danger';
}) {
  return (
    <span
      className={`badge ${tone === 'warn' ? 'badge-warn' : ''} ${tone === 'danger' ? 'badge-danger' : ''}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-cream/60 px-5 py-7 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {description ? <p className="muted max-w-sm">{description}</p> : null}
      {action}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
  guardUpdates,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** 创建/编辑表单弹窗：打开期间登记「未保存编辑」，阻止应用更新刷新。 */
  guardUpdates?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useUpdateBlocker(open && Boolean(guardUpdates), 'dirty', DIRTY_MESSAGE);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const focusable = node?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/30 p-0 sm:items-center sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`paper max-h-[92vh] w-full overflow-y-auto rounded-b-none sm:rounded-3xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-cream px-5 py-3.5">
          <h2 id={titleId} className="text-[15px] font-bold tracking-wide">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="关闭"
            style={{ minHeight: 40, padding: '0 8px' }}
          >
            <IconClose size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-line bg-cream px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type ToastTone = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto max-w-md rounded-xl border px-4 py-2 text-sm shadow-lg ${
              item.tone === 'error'
                ? 'border-danger/40 bg-[#fbe4dc] text-danger'
                : item.tone === 'success'
                  ? 'border-sage-deep/40 bg-[#eaf3e6] text-ink'
                  : 'border-line bg-cream text-ink'
            }`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-xl border border-danger/30 bg-[#fbe4dc] px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
