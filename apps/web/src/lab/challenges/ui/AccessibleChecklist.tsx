import { Check, Circle } from 'lucide-react';
import type { ChecklistItem } from '../hints';

/**
 * The non-3D accessible guided path: every step as a plain, keyboard-navigable, screen-reader
 * friendly list. Status is always said in words ("Done" / "Current step" / "Not yet"), never by
 * colour or icon alone.
 */
export function AccessibleChecklist({ items }: { items: readonly ChecklistItem[] }) {
  if (items.length === 0) return null;
  return (
    <ol className="lc-checklist" aria-label="Guided titration checklist">
      {items.map((item) => (
        <li key={item.stepId} className="lc-checklist__item" data-met={item.met} data-current={item.current}>
          <span className="lc-checklist__icon" aria-hidden="true">
            {item.met ? <Check /> : <Circle />}
          </span>
          <span className="lc-checklist__text">
            <strong>{item.title}</strong>
            <span>{item.instructions}</span>
            <span className="lc-checklist__detail">{item.detail}</span>
          </span>
          <span className="lc-checklist__status">{item.met ? 'Done' : item.current ? 'Current step' : 'Not yet'}</span>
        </li>
      ))}
    </ol>
  );
}
