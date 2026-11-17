import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './cx';

export interface AstraTabItem<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly badge?: ReactNode;
}

/**
 * An accessible tab list following the WAI-ARIA tabs pattern (roving tabindex, arrow-key
 * navigation, Home/End), used by the scientific explanation panel and inspector sections.
 */
export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  idPrefix,
}: {
  label: string;
  items: ReadonlyArray<AstraTabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
}) {
  const list = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = items.findIndex((item) => item.value === value);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = items[next]!;
    onChange(target.value);
    list.current?.querySelector<HTMLButtonElement>(`#${idPrefix}-tab-${target.value}`)?.focus();
  };

  return (
    <div ref={list} className="astra-tabs" role="tablist" aria-label={label}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            id={`${idPrefix}-tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            className={cx('astra-tabs__tab', selected && 'is-selected')}
            onClick={() => onChange(item.value)}
            onKeyDown={onKeyDown}
          >
            {item.label}
            {item.badge && <span className="astra-tabs__badge">{item.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, tabId, active, children }: { id: string; tabId: string; active: boolean; children: ReactNode }) {
  if (!active) return null;
  return (
    <div id={id} role="tabpanel" aria-labelledby={tabId} tabIndex={0} className="astra-tabs__panel">
      {children}
    </div>
  );
}
