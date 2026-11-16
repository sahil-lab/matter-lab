import type { EditIntent, EditorGroup } from './types';

export interface EditorMetadata {
  readonly selectedIds: readonly string[];
  readonly lockedIds: readonly string[];
  readonly groups: readonly EditorGroup[];
}
export interface PreparationCommand {
  readonly label: string;
  readonly forward: readonly EditIntent[];
  readonly inverse: readonly EditIntent[];
  readonly before: EditorMetadata;
  readonly after: EditorMetadata;
  readonly epochs: Readonly<Record<string, number>>;
}
export class PreparationHistory {
  private past: PreparationCommand[] = [];
  private future: PreparationCommand[] = [];
  constructor(private readonly limit = 100) {}
  get undoCommand(): PreparationCommand | undefined { return this.past.at(-1); }
  get redoCommand(): PreparationCommand | undefined { return this.future.at(-1); }
  clear(): void { this.past = []; this.future = []; }
  record(command: PreparationCommand): void {
    this.past.push(command);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  didUndo(): void {
    const command = this.past.pop();
    if (command) this.future.push(command);
  }
  didRedo(): void {
    const command = this.future.pop();
    if (command) this.past.push(command);
  }
}
