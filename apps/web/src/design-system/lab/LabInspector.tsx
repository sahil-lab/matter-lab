import { Crosshair, FileQuestion } from 'lucide-react';
import type { ReactNode } from 'react';
import { LabButton, LabSection, LabStateNotice, LabTag } from './primitives';
import type { LabSurfaceStatus } from './types';

export interface LabProperty {
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly description?: string;
}

export interface LabInspectorProps {
  readonly title?: string;
  readonly category?: string;
  readonly instanceId?: string;
  readonly properties?: readonly LabProperty[];
  readonly children?: ReactNode;
  /** Agent04's validated editor, not local scene mutation. */
  readonly controls?: ReactNode;
  readonly observations?: ReactNode;
  readonly explanation?: ReactNode;
  readonly onFocus?: () => void;
  readonly onExplain?: () => void;
  readonly status?: LabSurfaceStatus;
  readonly statusMessage?: string;
}

export function LabInspector({ title, category, instanceId, properties = [], children, controls, observations, explanation, onFocus, onExplain, status, statusMessage }: LabInspectorProps) {
  if (!title) return <LabSection><LabStateNotice status={status ?? 'empty'} title={status ? undefined : 'Choose an apparatus'}>{statusMessage ?? 'Select a vessel or instrument in the scene, or use the editor’s apparatus list. Its properties and observations will appear here.'}</LabStateNotice>{controls}</LabSection>;
  return (
    <div className="mlab-inspector">
      <LabSection eyebrow={category ?? 'Selected apparatus'} title={title} action={onFocus && <LabButton icon aria-label={`Focus ${title}`} onClick={onFocus}><Crosshair /></LabButton>}>
        {instanceId && <p className="mlab-caption mlab-definition-id">INSTANCE / {instanceId}</p>}
        <LabTag>Read-only properties</LabTag>
        {properties.length > 0 && <dl className="mlab-properties">{properties.map((property, index) => <div key={`${property.label}-${index}`}><dt title={property.description}>{property.label}</dt><dd>{property.value}{property.unit && <span className="mlab-unit"> {property.unit}</span>}</dd></div>)}</dl>}
        {status && <LabStateNotice status={status} compact>{statusMessage}</LabStateNotice>}
      </LabSection>
      {controls && <LabSection title="Operate" eyebrow="Validated controls">{controls}</LabSection>}
      {observations && <LabSection title="Observations" eyebrow="From the ledger">{observations}</LabSection>}
      {children}
      {(explanation || onExplain) && <LabSection title="Scientific reasoning" action={onExplain && <LabButton icon aria-label="Open scientific explanation" onClick={onExplain}><FileQuestion /></LabButton>}>{explanation ?? <p className="mlab-caption">Inspect the method, assumptions and provenance behind these observations.</p>}</LabSection>}
    </div>
  );
}
