import { Component } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../ui/kit';
import { LabStateNotice } from './primitives';

interface LabModuleBoundaryProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onBack: () => void;
  readonly backLabel?: string;
  readonly fullPage?: boolean;
}

export class LabModuleBoundary extends Component<LabModuleBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={cx('ml-lab', this.props.fullPage && 'mlab-module-page')}>
        <LabStateNotice status="error" title={`${this.props.title} is unavailable`}
          action={{ label: this.props.backLabel ?? 'Return to molecular workspace', onPress: this.props.onBack }}>
          This screen could not be loaded or displayed. Your molecular document has not been replaced. Return and save your work before reloading the application.
        </LabStateNotice>
      </div>
    );
  }
}

export function LabModuleLoading({ onBack }: { onBack: () => void }) {
  return <div className="ml-lab mlab-module-page"><LabStateNotice status="loading" title="Opening the instrument room" action={{ label: 'Return to molecular workspace', onPress: onBack }}>Loading the separate meter-scale laboratory. Your molecular document remains in angstroms.</LabStateNotice></div>;
}
