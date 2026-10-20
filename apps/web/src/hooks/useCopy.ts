import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'failed';

export function useCopy(resetMs = 2000) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setStatus('copied');
      } catch {
        setStatus('failed');
      }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus('idle'), resetMs);
    },
    [resetMs],
  );
  return { status, copy };
}
