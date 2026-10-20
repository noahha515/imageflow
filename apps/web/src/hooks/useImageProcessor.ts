import { useCallback, useEffect, useRef, useState } from 'react';
import { ProcessError, requestProcessedImage } from '../services/api';
import type { ProcessState } from '../types';

export function useImageProcessor() {
  const [state, setState] = useState<ProcessState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseObjectUrl();
    },
    [],
  );

  const process = useCallback(async (requestUrl: string, sourceUrl: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'loading', requestUrl });

    try {
      const { blob, ...rest } = await requestProcessedImage(
        requestUrl,
        sourceUrl,
        controller.signal,
      );
      releaseObjectUrl();
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      setState({ status: 'success', result: { ...rest, objectUrl } });
    } catch (err) {
      if (controller.signal.aborted) return;
      const error =
        err instanceof ProcessError
          ? err.info
          : {
              kind: 'server' as const,
              title: 'Unexpected error',
              message: 'Something went wrong while processing the image.',
              details: [],
            };
      setState({ status: 'error', error, requestUrl });
    }
  }, []);

  const fail = useCallback((messages: string[]) => {
    setState({
      status: 'error',
      error: {
        kind: 'validation',
        title: 'Check your input',
        message: messages[0] ?? '',
        details: messages.slice(1),
      },
    });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    releaseObjectUrl();
    setState({ status: 'idle' });
  }, []);

  const setProcessedDimensions = useCallback((width: number, height: number) => {
    setState((s) =>
      s.status === 'success'
        ? { ...s, result: { ...s.result, processed: { ...s.result.processed, width, height } } }
        : s,
    );
  }, []);

  return { state, process, fail, reset, setProcessedDimensions };
}
