// Runs the candidate's Python in a web worker so the page stays responsive and
// a runaway loop can be stopped by terminating the worker.
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');

const ready = (async () => {
  self.pyodide = await loadPyodide();
  postMessage({ type: 'ready' });
})().catch((err) => postMessage({ type: 'load-error', text: String(err) }));

// Pyodide tracebacks start with its own internal frames; keep only the candidate's.
function cleanTraceback(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.includes('File "<exec>"'));
  if (first === -1) return text;
  return ['Traceback (most recent call last):', ...lines.slice(first)].join('\n');
}

onmessage = async (e) => {
  await ready;
  const { id, code } = e.data;
  pyodide.setStdout({ batched: (text) => postMessage({ type: 'out', id, text: text + '\n' }) });
  pyodide.setStderr({ batched: (text) => postMessage({ type: 'out', id, text: text + '\n' }) });

  const ns = pyodide.globals.get('dict')();
  ns.set('__name__', '__main__');
  try {
    await pyodide.runPythonAsync(code, { globals: ns });
    postMessage({ type: 'done', id });
  } catch (err) {
    postMessage({ type: 'out', id, text: cleanTraceback(String(err.message || err)) });
    postMessage({ type: 'done', id, failed: true });
  } finally {
    ns.destroy();
  }
};
