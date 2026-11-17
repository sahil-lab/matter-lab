import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Collapse } from '../MotionViews';
import { cx } from './cx';

/** A labeled, keyboard-operable disclosure section: inspector groups, library categories. */
export function CollapsibleSection({
  title,
  open,
  onToggle,
  right,
  children,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="astra-collapsible" data-open={open}>
      <button type="button" className="astra-collapsible__head" aria-expanded={open} onClick={onToggle}>
        <ChevronDown className={cx('astra-collapsible__chevron', open && 'is-open')} aria-hidden />
        <span className="astra-collapsible__title">{title}</span>
        {right && (
          <span className="astra-collapsible__right" onClick={(e) => e.stopPropagation()}>
            {right}
          </span>
        )}
      </button>
      <Collapse open={open}>
        <div className="astra-collapsible__body">{children}</div>
      </Collapse>
    </div>
  );
}
