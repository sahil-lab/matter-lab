import { Beaker, FlaskConical, Plus, Save } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { EquipmentLibrary } from './EquipmentLibrary';
import type { EquipmentLibraryItem } from './EquipmentLibrary';
import { LabEntry } from './LabEntry';
import { LabInspector } from './LabInspector';
import { LabTransport } from './LabTransport';
import { LabTutorialCard } from './LabTutorialCard';
import { useLabMotion } from './motion';
import { LabButton, LabJobProgress, LabSection, LabStateNotice, LabTag } from './primitives';
import type { LabSurfaceStatus } from './types';
import './tokens.css';
import './lab.css';

const GALLERY_ITEMS: readonly EquipmentLibraryItem[] = [
  { definitionId: 'gallery.vessel', label: 'Receiving vessel', category: 'Glassware', description: 'UI specimen. No apparatus is placed by this gallery.', thumbnail: <FlaskConical />, capabilities: ['CONTAINER', 'FLOW_RECEIVER'], keywords: ['flask'], facts: [{ label: 'Capacity', value: 'Supplied by definition' }] },
  { definitionId: 'gallery.beaker', label: 'Mixing vessel', category: 'Glassware', description: 'A second presentation specimen for keyboard search.', thumbnail: <Beaker />, capabilities: ['CONTAINER'], keywords: ['beaker'] },
  { definitionId: 'gallery.unsupported', label: 'Unvalidated instrument', category: 'Instruments', description: 'An honest unsupported catalog entry.', unavailableReason: 'No compatible model is registered.' },
];

const STATES: readonly LabSurfaceStatus[] = ['empty', 'loading', 'warning', 'offline', 'error', 'unsupported'];
const STATE_COPY: Record<LabSurfaceStatus, string> = {
  empty: 'No observation has been recorded. There is no substitute value.',
  loading: 'The real interface waits for the authoritative worker. This is a UI state specimen.',
  warning: 'An assumption or validation warning needs attention before a result is interpreted.',
  offline: 'Remote save is unavailable. An offline draft is not a confirmed server save.',
  error: 'The operation failed. Existing history is separate from the failed operation.',
  unsupported: 'No validated model is available for these conditions. Numeric results are withheld.',
};

export interface LabComponentGalleryProps {
  /** Optional real, read-only scientific panels from the current run. No sample pH values are generated. */
  readonly scientificContent?: ReactNode;
}

export function LabComponentGallery({ scientificContent }: LabComponentGalleryProps) {
  const [state, setState] = useState<LabSurfaceStatus>('unsupported');
  const [events, setEvents] = useState<string[]>([]);
  const [entry, setEntry] = useState(false);
  const [entryStorage] = useState(() => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  });
  const motion = useLabMotion();
  const record = (message: string) => setEvents((current) => [message, ...current].slice(0, 4));
  return (
    <div className="ml-lab mlab-gallery" data-reduced-motion={motion.reduced}>
      <header className="mlab-gallery__intro">
        <div><div className="mlab-eyebrow">Design language / component reference</div><h2>Built around the observation.</h2><p className="mlab-prose">Interactive UI specimens, not a simulation. Buttons below only record local gallery events; chemistry is never generated here.</p></div>
        <LabTag tone="warm">UI EXAMPLES ONLY</LabTag>
      </header>
      <div className="mlab-gallery-grid">
        <section className="mlab-gallery-cell mlab-gallery-cell--wide">
          <LabSection title="Material & type" eyebrow="01 / Tokens">
            <div className="mlab-swatches">{['void', 'bed', 'surface', 'raised', 'cool', 'warm', 'danger', 'ink'].map((name) => <div key={name}><span style={{ background: `var(--mlab-${name})` }} /><code>--mlab-{name}</code></div>)}</div>
            <div className="mlab-type-specimen"><strong>Measure what the model supports.</strong><p>Inter / interface and long-form reasoning</p><code>JetBrains Mono / value · unit · source</code></div>
            <div className="mlab-row"><LabButton variant="primary" onClick={() => record('Primary action requested')}><Plus />Primary action</LabButton><LabButton variant="outline" onClick={() => record('Notebook action requested; no save performed')}><Save />Secondary action</LabButton><LabButton disabled>Unavailable</LabButton></div>
          </LabSection>
        </section>
        <section className="mlab-gallery-cell">
          <LabSection title="Honest states" eyebrow="02 / Availability">
            <label className="mlab-field"><span>Preview state</span><select value={state} onChange={(event) => setState(event.target.value as LabSurfaceStatus)}>{STATES.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            <LabStateNotice status={state} action={state === 'error' || state === 'offline' ? { label: 'Retry example', onPress: () => record('Retry requested; gallery only') } : undefined}>{STATE_COPY[state]}</LabStateNotice>
          </LabSection>
        </section>
        <section className="mlab-gallery-cell">
          <LabSection title="Catalog" eyebrow="03 / Search, inspect, place"><p className="mlab-caption">Search labels and capabilities. These specimens have no chemical inventory.</p></LabSection>
          <EquipmentLibrary items={GALLERY_ITEMS} onPlace={(id) => record(`Place requested: ${id}; gallery only`)} />
        </section>
        <section className="mlab-gallery-cell">
          <LabInspector title="Selected instrument" category="Read-only specimen" instanceId="gallery.instrument"
            properties={[{ label: 'Coordinates', value: 'Received from runtime', unit: 'm' }, { label: 'Capacity', value: 'Received from catalog' }, { label: 'Evidence', value: 'Shown with each observation' }]}
            onFocus={() => record('Focus selected instrument requested')}
            controls={<LabTransport state="unsupported" disabledReason="This gallery does not run experiments." />}
            observations={<LabStateNotice status="empty" compact>No observation supplied.</LabStateNotice>}
            onExplain={() => record('Explain requested')} />
        </section>
        <section className="mlab-gallery-cell">
          <LabSection title="Guide surface" eyebrow="04 / Progress from Agent08">
            <LabTutorialCard title="Inspect the apparatus" stepLabel="Guide specimen" goals={[{ id: 'choose', label: 'Choose an apparatus', state: 'complete' }, { id: 'inspect', label: 'Read its capabilities', state: 'current' }, { id: 'observe', label: 'Wait for a real observation', state: 'pending' }]}
              onContinue={() => record('Guide continue requested')} onDismiss={() => record('Guide dismiss requested')}>
              This card displays progression supplied by the challenge engine. It does not evaluate completion.
            </LabTutorialCard>
          </LabSection>
        </section>
        <section className="mlab-gallery-cell mlab-gallery-cell--wide">
          <LabSection title="Motion & work" eyebrow="05 / Shared timing">
            <LabJobProgress title="Worker progress specimen" status="running" progress={null} detail="Intentionally indeterminate: there is no running calculation in this gallery." onCancel={() => record('Cancel requested; gallery only')} />
            <p className="mlab-caption mlab-gallery-motion">Motion is {motion.reduced ? 'reduced' : 'enabled'}. UI transitions: {motion.durationMs} ms. Camera transitions: {motion.cameraDurationS} s. A system accessibility preference always wins.</p>
            <LabButton variant="outline" onClick={() => setEntry(true)}>Replay skippable introduction</LabButton>
          </LabSection>
        </section>
      </div>
      <LabSection title="Scientific content" eyebrow="06 / Authoritative observations only">
        {scientificContent ?? <LabStateNotice status="empty" title="No scientific fixture supplied">Pass the current run’s read-only HUD, explanation or ledger through scientificContent to review populated science panels. The gallery never makes up a titration curve.</LabStateNotice>}
      </LabSection>
      <LabSection title="Event monitor" eyebrow="UI callbacks / no domain changes">
        <ol className="mlab-gallery-events" aria-live="polite">{events.length === 0 ? <li>Interact with a component to inspect its callback.</li> : events.map((event, index) => <li key={`${event}-${index}`}>{event}</li>)}</ol>
      </LabSection>
      {entry && <LabEntry replay storage={entryStorage} onEnter={(choice) => { setEntry(false); record(`Entry choice: ${choice}; gallery preference only`); }} />}
    </div>
  );
}
