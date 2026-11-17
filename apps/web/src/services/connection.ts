import { create } from 'zustand';
import type { ScienceClient } from './science-client';

/** Connection credentials live only inside this in-memory client, never in a saved document. */
export const useScienceConnection = create<{ readonly client: ScienceClient | null }>(() => ({ client: null }));

export function setScienceConnection(client: ScienceClient | null): void {
  useScienceConnection.setState({ client });
}
