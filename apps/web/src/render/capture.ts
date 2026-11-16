interface CaptureRequest {
  readonly maxWidth: number | undefined;
  readonly resolve: (dataUrl: string | null) => void;
}

const queue: CaptureRequest[] = [];

/**
 * Asks for an image of the next rendered frame. The WebGL drawing buffer is only readable in the
 * same task that drew it, so the request is fulfilled from inside the frame loop (see `FrameHooks.tsx`).
 */
export function requestCapture(maxWidth?: number): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ maxWidth, resolve });
    // If no frame arrives (the canvas is gone), do not leave the caller waiting forever.
    window.setTimeout(() => {
      const index = queue.findIndex((r) => r.resolve === resolve);
      if (index >= 0) {
        queue.splice(index, 1);
        resolve(null);
      }
    }, 3000);
  });
}

export function hasPendingCapture(): boolean {
  return queue.length > 0;
}

/** Called right after a frame has been drawn, while the canvas contents are still readable. */
export function fulfilCaptures(canvas: HTMLCanvasElement): void {
  while (queue.length > 0) {
    const request = queue.shift()!;
    try {
      if (request.maxWidth && canvas.width > request.maxWidth) {
        const scale = request.maxWidth / canvas.width;
        const small = document.createElement('canvas');
        small.width = Math.round(canvas.width * scale);
        small.height = Math.round(canvas.height * scale);
        const context = small.getContext('2d');
        if (!context) {
          request.resolve(null);
          continue;
        }
        context.imageSmoothingQuality = 'high';
        context.drawImage(canvas, 0, 0, small.width, small.height);
        request.resolve(small.toDataURL('image/png'));
      } else {
        request.resolve(canvas.toDataURL('image/png'));
      }
    } catch {
      request.resolve(null);
    }
  }
}
