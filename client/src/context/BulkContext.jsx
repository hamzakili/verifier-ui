import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { analyzeColumn, detectEmailColumn, isEmailSyntax, parseCsvFile } from '../lib/csv';
import { emptyCounts } from '../lib/status';
import { useApp } from './AppContext';
import { useToast } from './ToastContext';

/**
 * Holds the bulk CSV workflow at the app root so an in-flight job keeps
 * polling while the user navigates to other pages.
 */
const BulkContext = createContext(null);

const POLL_MS = 1500;
const MAX_CONSECUTIVE_ERRORS = 6;

const initialJob = null;

export function BulkProvider({ children }) {
  const toast = useToast();
  const { applyCredits, recordBulk, refreshAccount, activeProvider } = useApp();
  const submitting = useRef(false);
  const finishedJobs = useRef(new Set());

  const [step, setStep] = useState('upload'); // upload | configure | running | results
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [column, setColumn] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [job, setJob] = useState(initialJob);
  const [results, setResults] = useState(null);

  const pollRef = useRef({ timer: null, errors: 0, cancelled: false, controller: null });

  const analysis = useMemo(() => (parsed && column ? analyzeColumn(parsed.rows, column) : null), [parsed, column]);

  const stopPolling = useCallback(() => {
    const p = pollRef.current;
    p.cancelled = true;
    clearTimeout(p.timer);
    p.controller?.abort();
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setStep('upload');
    setFile(null);
    setParsed(null);
    setColumn(null);
    setJob(initialJob);
    setResults(null);
  }, [stopPolling]);

  const loadFile = useCallback(
    async (f) => {
      setParsing(true);
      try {
        const p = await parseCsvFile(f);
        const detected = detectEmailColumn(p.fields, p.rows);
        setFile({ name: f.name, size: f.size });
        setParsed(p);
        setColumn(detected);
        setStep('configure');
        if (detected) {
          toast.success(`Found ${p.rows.length.toLocaleString()} rows. Email column detected: "${detected}".`, { title: 'CSV parsed' });
        } else {
          toast.warning('Could not auto-detect an email column. Please choose one from the dropdown.', { title: 'CSV parsed' });
        }
        if (p.warnings) toast.warning(`${p.warnings} row(s) had formatting issues and may be incomplete.`, { title: 'CSV warnings' });
      } catch (err) {
        toast.error(err.message, { title: 'Could not read CSV' });
      } finally {
        setParsing(false);
      }
    },
    [toast],
  );

  const finish = useCallback(
    async (jobId, mode) => {
      // Process each completed job exactly once (guards against overlapping polls).
      if (finishedJobs.current.has(jobId)) return;
      finishedJobs.current.add(jobId);
      let data;
      try {
        data = await api.bulkResults(jobId);
      } catch (err) {
        finishedJobs.current.delete(jobId);
        throw err;
      }
      const provider = data.provider || job?.provider;
      const byEmail = new Map(data.results.map((r) => [r.email.trim().toLowerCase(), r]));

      const uniqueCounts = emptyCounts();
      for (const r of data.results) uniqueCounts[r.result] = (uniqueCounts[r.result] || 0) + 1;

      const rowCounts = emptyCounts();
      const rows = parsed.rows.map((orig, i) => {
        const raw = String(orig[column] ?? '').trim();
        const hit = raw ? byEmail.get(raw.toLowerCase()) : null;
        let result;
        let note = '';
        let suggestion = '';
        let flags = [];
        let cached = false;
        if (hit) {
          result = hit.result;
          suggestion = hit.suggestedCorrection;
          flags = hit.flags;
          cached = Boolean(hit.cached);
          note = hit.note || '';
        } else {
          result = 'invalid';
          note = !raw ? 'Empty value' : !isEmailSyntax(raw) ? 'Bad syntax (not submitted)' : 'Not returned';
          flags = raw ? ['bad_syntax'] : [];
        }
        rowCounts[result] += 1;
        return { __i: i, __email: raw, __result: result, __suggestion: suggestion, __flags: flags, __note: note, __cached: cached, ...orig };
      });
      const reused = data.results.filter((r) => r.cached).length;

      setResults({
        jobId,
        mode,
        provider,
        rows,
        rowCounts,
        uniqueCounts,
        uniqueProcessed: data.results.length,
        reused,
        creditsUsed: data.creditsUsed,
        creditsRemaining: data.creditsRemaining,
        completedAt: new Date().toISOString(),
      });
      applyCredits(data.creditsUsed, data.creditsRemaining, provider);
      recordBulk({
        mode,
        provider,
        jobId,
        filename: file?.name || 'upload.csv',
        totalRows: parsed.rows.length,
        total: data.results.length,
        counts: uniqueCounts,
        creditsUsed: data.creditsUsed,
        reused,
      });
      setStep('results');
      toast.success(
        `${data.results.length.toLocaleString()} unique emails verified. ${data.creditsUsed.toLocaleString()} credits used` +
          (reused ? ` · ${reused.toLocaleString()} reused from the email registry.` : '.'),
        { title: 'Bulk verification complete' },
      );
    },
    [parsed, column, file, job?.provider, applyCredits, recordBulk, toast],
  );

  const poll = useCallback(
    (jobId, mode) => {
      const p = pollRef.current;
      const tick = async () => {
        if (p.cancelled) return;
        p.controller = new AbortController();
        try {
          const s = await api.bulkStatus(jobId, p.controller.signal);
          if (p.cancelled) return;
          p.errors = 0;
          setJob((j) => ({ ...j, ...s, error: null, retrying: false }));

          if (s.stage === 'failed') {
            const reason = s.failureReason || 'The verification provider reported that the job failed.';
            setJob((j) => ({ ...j, error: reason }));
            toast.error(reason, { title: 'Bulk job failed' });
            return;
          }
          if (s.stage === 'complete') {
            await finish(jobId, mode);
            return;
          }
        } catch (err) {
          if (err.name === 'AbortError' || p.cancelled) return;
          p.errors += 1;
          if (!err.retryable || p.errors >= MAX_CONSECUTIVE_ERRORS) {
            setJob((j) => ({ ...j, error: err.message, retrying: false }));
            toast.error(err.message, { title: 'Lost track of bulk job' });
            return;
          }
          setJob((j) => ({ ...j, retrying: true }));
          if (p.errors === 1) toast.warning(`${err.message} Retrying…`, { title: 'Connection hiccup' });
        }
        // Back off on errors (rate limits / transient failures).
        p.timer = setTimeout(tick, POLL_MS * Math.min(8, 2 ** p.errors));
      };
      tick();
    },
    [finish, toast],
  );

  const start = useCallback(async () => {
    if (!analysis || analysis.uniqueEmails.length === 0) {
      toast.error('There are no valid email addresses in the selected column.');
      return;
    }
    if (submitting.current) return; // ignore double clicks while a submission is in flight
    submitting.current = true;
    stopPolling();
    pollRef.current = { timer: null, errors: 0, cancelled: false, controller: null };
    setJob({
      stage: 'uploading',
      percent: 0,
      processed: 0,
      total: analysis.uniqueEmails.length,
      counts: emptyCounts(),
      startedAt: Date.now(),
      provider: activeProvider,
    });
    setStep('running');
    try {
      const created = await api.createBulkJob(analysis.uniqueEmails, file?.name);
      setJob((j) => ({ ...j, jobId: created.jobId, mode: created.mode, provider: created.provider, total: created.uniqueEmails }));
      if (created.duplicate) {
        toast.info('This list is already being verified — resuming the existing job instead of charging twice.', { title: 'Duplicate submission' });
      } else if (created.reused || created.pendingElsewhere) {
        toast.info(
          `${(created.reused || 0).toLocaleString()} already verified (free)` +
            (created.pendingElsewhere ? `, ${created.pendingElsewhere.toLocaleString()} being verified elsewhere` : '') +
            `. Sending ${(created.toVerify ?? 0).toLocaleString()} to the provider.`,
          { title: 'Email registry' },
        );
      }
      poll(created.jobId, created.mode);
    } catch (err) {
      setJob((j) => ({ ...j, error: err.message }));
      toast.error(err.message, { title: 'Could not start bulk job' });
      refreshAccount({ silent: true });
    } finally {
      submitting.current = false;
    }
  }, [analysis, file, poll, stopPolling, toast, refreshAccount, activeProvider]);

  const retryResults = useCallback(() => {
    if (!job?.jobId) return;
    pollRef.current = { timer: null, errors: 0, cancelled: false, controller: null };
    setJob((j) => ({ ...j, error: null }));
    poll(job.jobId, job.mode);
  }, [job, poll]);

  const value = {
    step,
    setStep,
    file,
    parsed,
    parsing,
    column,
    setColumn,
    analysis,
    job,
    results,
    loadFile,
    start,
    reset,
    retryResults,
    isRunning: step === 'running' && !job?.error,
  };

  return <BulkContext.Provider value={value}>{children}</BulkContext.Provider>;
}

export function useBulk() {
  const ctx = useContext(BulkContext);
  if (!ctx) throw new Error('useBulk must be used inside BulkProvider');
  return ctx;
}
