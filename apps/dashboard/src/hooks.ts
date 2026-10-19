import { useCallback, useEffect, useRef, useState } from 'react';

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function useResource<T>(fetcher: () => Promise<T>, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    async function load() {
      try {
        const result = await fetcher();
        if (active) { setData(result); setError(''); }
      } catch (err) {
        if (active) setError(errorMessage(err));
      } finally {
        if (active) {
          setLoading(false);
          if (interval) timer = setTimeout(load, interval);
        }
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [fetcher, interval, revision]);
  return { data, error, loading, reload };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try { await task(); } catch (err) { setError(errorMessage(err)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return { busy, error, run };
}
