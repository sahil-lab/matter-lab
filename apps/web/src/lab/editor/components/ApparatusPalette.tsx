/**
 * PROVISIONAL STUB — owned by Agent 01 ("Creative Director / UI Engineer") per
 * `Agent_01_Creative_Direction_and_UI.md` ("Build a full-screen lab shell... collapsible apparatus
 * library (left)"). That agent's branch did not exist yet when this one was written, so this is the
 * smallest apparatus browser that lets the editor's placement flow (brief item 1: "Drag equipment
 * from Agent 01 apparatus browser into Agent 02 3D scene") be exercised end to end: a plain list,
 * draggable (native HTML5 drag-and-drop) and also clickable (arms placement, so a mouse click or a
 * keyboard Enter/Space on a focused item both work without requiring a drag gesture at all — the
 * brief's "accessible keyboard alternatives"). Replace this file with Agent 01's real apparatus
 * browser; nothing elsewhere depends on its markup, only on `GestureController.armPlacement`.
 */
import { APPARATUS_CATALOG } from '../../apparatus/catalog';

export interface ApparatusPaletteProps {
  readonly onArm: (definitionId: string) => void;
}

export function ApparatusPalette({ onArm }: ApparatusPaletteProps): React.JSX.Element {
  const byCategory = new Map<string, typeof APPARATUS_CATALOG[number][]>();
  for (const definition of APPARATUS_CATALOG) {
    const list = byCategory.get(definition.category) ?? [];
    list.push(definition);
    byCategory.set(definition.category, list);
  }

  return (
    <nav aria-label="Apparatus palette" data-testid="apparatus-palette" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, width: 220, overflowY: 'auto' }}>
      {[...byCategory.entries()].map(([category, definitions]) => (
        <div key={category}>
          <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6, margin: '0 0 6px' }}>{category}</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {definitions.map((definition) => (
              <li key={definition.id}>
                <button
                  type="button"
                  draggable
                  data-testid={`palette-item-${definition.id}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-matterlab-apparatus', definition.id);
                    e.dataTransfer.effectAllowed = 'copy';
                    onArm(definition.id);
                  }}
                  onClick={() => onArm(definition.id)}
                  style={{ width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: '1px solid #2a3444', background: '#141b28', color: '#e7edf5', cursor: 'grab' }}
                >
                  {definition.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
