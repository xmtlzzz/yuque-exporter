// Export progress events, consumed by the local web UI.
//
// The CLI keeps working exactly as before: with no listener every emit is a
// cheap no-op. A listener that throws can never break an export, so the UI is
// strictly an observer.

export type ProgressEvent =
  | { type: 'phase'; phase: 'crawl' | 'build' | 'done'; message?: string }
  | { type: 'repo'; namespace: string; total: number }
  | { type: 'doc'; namespace: string; slug?: string; title?: string; status: string };

export type ProgressListener = (event: ProgressEvent) => void;

const listeners = new Set<ProgressListener>();

export function onProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitProgress(event: ProgressEvent): void {
  for (const listener of [ ...listeners ]) {
    try {
      listener(event);
    } catch {
      // An observer must never break the export it observes.
    }
  }
}

export function clearProgressListeners(): void {
  listeners.clear();
}
