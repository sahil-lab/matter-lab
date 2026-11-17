import { cx } from '../../design-system';
import type { ApparatusSummary } from './contracts';
import { apparatusGlyph } from './apparatusIcons';

export function ApparatusCard({ item, selected, onSelect, dense }: { item: ApparatusSummary; selected?: boolean; onSelect: () => void; dense?: boolean }) {
  const Glyph = apparatusGlyph(item.thumbnailGlyph);
  return (
    <button type="button" className={cx('astra-apparatus-card', selected && 'is-selected', dense && 'is-dense')} onClick={onSelect} aria-pressed={selected} data-testid="astra-apparatus-card">
      <span className="astra-apparatus-card__glyph">
        <Glyph aria-hidden />
      </span>
      <span className="astra-apparatus-card__text">
        <span className="astra-apparatus-card__label">{item.label}</span>
        {!dense && <span className="astra-apparatus-card__desc">{item.shortDescription}</span>}
      </span>
      {item.vertical_slice && (
        <span className="astra-apparatus-card__tag" data-astra-tip="Part of the first shared vertical slice" data-astra-tip-pos="left">
          P0
        </span>
      )}
    </button>
  );
}
