(() => {
  'use strict';

  const MONACO = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min';
  const DEFAULT_MODEL = 'google/gemma-4-12b';
  const RUN_TIMEOUT_MS = 10000;
  const MAX_OUTPUT_CHARS = 20000;
  const MAX_CODE_CHARS_FOR_MODEL = 16000;
  const MAX_DIFF_LINES = 40;
  const MAX_OUTPUT_CHARS_FOR_MODEL = 2000;
  const MAX_HISTORY_CHARS = 8000;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('ip.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('ip.' + key, JSON.stringify(value));
      } catch {}
    },
  };

  // ---------------------------------------------------------------- problems

  const problems = window.PROBLEMS;
  let problem = problems.find((p) => p.id === store.get('problem')) || problems[0];

  function problemPrompt() {
    return problem.custom ? $('customPrompt').value.trim() : problem.prompt;
  }

  function loadProblem() {
    $('promptText').textContent = problem.prompt;
    $('promptText').hidden = !!problem.custom;
    $('customPrompt').hidden = !problem.custom;
    $('runBar').hidden = $('output').hidden = !!problem.design;
    editor.setLanguage(problem.design ? 'markdown' : 'python');
    editor.setValue(store.get('code.' + problem.id, problem.starter));
    setOutput('');
    lastRun = null;
  }

  // ------------------------------------------------------------------ editor

  // Starts as a plain textarea and is swapped for Monaco once that has loaded.
  const fallback = $('editorFallback');
  let editor = {
    getValue: () => fallback.value,
    setValue: (v) => { fallback.value = v; },
    setLanguage: () => {},
  };
  let saveTimer = null;

  function onEdit() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('code.' + problem.id, editor.getValue()), 400);
  }

  function useFallbackEditor() {
    $('editor').hidden = true;
    fallback.hidden = false;
    fallback.addEventListener('input', onEdit);
    fallback.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      fallback.setRangeText('    ', fallback.selectionStart, fallback.selectionEnd, 'end');
      onEdit();
    });
  }

  function loadMonaco() {
    const script = document.createElement('script');
    script.src = MONACO + '/vs/loader.js';
    script.onerror = useFallbackEditor;
    script.onload = () => {
      // Monaco's worker has to be same-origin, so wrap the CDN script in a blob.
      window.MonacoEnvironment = {
        getWorkerUrl: () => URL.createObjectURL(new Blob(
          [`self.MonacoEnvironment = { baseUrl: '${MONACO}/' }; importScripts('${MONACO}/vs/base/worker/workerMain.js');`],
          { type: 'text/javascript' },
        )),
      };
      window.require.config({ paths: { vs: MONACO + '/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        const current = editor.getValue();
        const instance = window.monaco.editor.create($('editor'), {
          value: current,
          language: problem.design ? 'markdown' : 'python',
          theme: 'vs-dark',
          fontSize: 14,
          minimap: { enabled: false },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          tabSize: 4,
        });
        instance.onDidChangeModelContent(onEdit);
        editor = {
          getValue: () => instance.getValue(),
          setValue: (v) => instance.setValue(v),
          setLanguage: (lang) => window.monaco.editor.setModelLanguage(instance.getModel(), lang),
        };
      }, useFallbackEditor);
    };
    document.head.appendChild(script);
  }

  // ------------------------------------------------------------ python runner

  let worker = null;
  let workerReady = false;
  let runId = 0;
  let running = false;
  let runTimer = null;
  let lastRun = null; // { code, output, status }

  function setOutput(text) {
    $('output').textContent = text;
  }

  function appendOutput(text) {
    const el = $('output');
    if (el.textContent.length > MAX_OUTPUT_CHARS) return;
    el.textContent += text;
    if (el.textContent.length > MAX_OUTPUT_CHARS) el.textContent += '\n… output truncated …\n';
    el.scrollTop = el.scrollHeight;
  }

  function setPyStatus(text, cls) {
    $('pyStatus').textContent = text;
    $('pyStatus').className = 'status ' + (cls || '');
  }

  function updateRunButtons() {
    $('run').disabled = !workerReady || running;
    $('stop').disabled = !running;
  }

  function startWorker() {
    workerReady = false;
    setPyStatus('Loading Python…');
    worker = new Worker('py-worker.js');
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        workerReady = true;
        setPyStatus('Python ready', 'ok');
      } else if (msg.type === 'load-error') {
        setPyStatus('Python failed to load (needs internet the first time)', 'bad');
      } else if (msg.id !== runId) {
        return;
      } else if (msg.type === 'out') {
        appendOutput(msg.text);
      } else if (msg.type === 'done') {
        finishRun(msg.failed ? 'raised an error' : 'finished');
      }
      updateRunButtons();
    };
    worker.onerror = () => {
      setPyStatus('Python failed to load (needs internet the first time)', 'bad');
    };
    updateRunButtons();
  }

  function finishRun(status) {
    clearTimeout(runTimer);
    running = false;
    lastRun.output = $('output').textContent;
    lastRun.status = status;
    updateRunButtons();
  }

  // A worker stuck in a loop can't be interrupted, so replace it.
  function killRun(reason) {
    if (!running) return;
    worker.terminate();
    appendOutput('\n' + reason + '\n');
    finishRun(reason);
    startWorker();
  }

  function run() {
    if (!workerReady || running || problem.design) return;
    const code = editor.getValue();
    runId += 1;
    running = true;
    lastRun = { code, output: '', status: 'running' };
    setOutput('');
    updateRunButtons();
    runTimer = setTimeout(
      () => killRun(`Stopped: ran longer than ${RUN_TIMEOUT_MS / 1000} seconds (infinite loop?)`),
      RUN_TIMEOUT_MS,
    );
    worker.postMessage({ id: runId, code });
  }

  // -------------------------------------------------------------------- chat

  let history = []; // { role, content }
  let codeSeenByModel = null; // editor contents the model last replied to
  let abortCtl = null;
  let startedAt = null;

  function addBubble(kind, text) {
    const chat = $('chat');
    const hint = chat.querySelector('.hint');
    if (hint) hint.remove();
    const el = document.createElement('div');
    el.className = 'bubble ' + kind;
    el.textContent = text;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  // Shows a reply with any fenced code set apart as a code block.
  function renderReply(el, text) {
    el.textContent = '';
    const parts = text.split(/```[a-zA-Z]*\n?([\s\S]*?)(?:```|$)/);
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part.trim()) el.appendChild(document.createTextNode(i ? part.trim() : part.trimEnd()));
      } else if (part.trim()) {
        const pre = document.createElement('pre');
        pre.textContent = part.replace(/\s+$/, '');
        el.appendChild(pre);
      }
    });
  }

  function systemPrompt() {
    const kind = problem.design ? 'system design discussion' : 'coding problem';
    return [
      'You are a senior software engineer on an ads engineering team at a large streaming company. You are running a technical phone screen with a candidate for a senior role. The session is a ' + kind + '.',
      '',
      'This is a spoken conversation. Everything you write is read aloud by a speech synthesizer, and the candidate\'s words reach you through speech recognition, which makes mistakes. Interpret odd wording charitably.',
      '',
      'Rules:',
      '- Keep every reply to one to three short sentences unless you are giving final feedback.',
      '- Use plain spoken English. No markdown, no lists, no emoji. Never dictate code; refer to a line, a variable or a method by name instead.',
      '- When you ask something, ask one question at a time. Not every reply needs a question.',
      '- Do not volunteer the solution. If the candidate is stuck or asks for a hint, give the smallest hint that moves them forward, and escalate only if they stay stuck.',
      '- Exception: this is a practice session, so if the candidate directly asks for the answer, the solution, or an explanation, give it plainly and completely. Do not respond with a question or a hint, and do not ask them to try first. That reply may run up to six sentences, and it must end with a statement, not a question.',
      '- If the candidate asks to see the code, explain the approach in a sentence or two and then write the code in a fenced code block. Code blocks are shown on screen and are not read aloud. This is the only situation in which you write code.',
      '- You can see the candidate\'s editor and the output of their last code run. They are attached to the end of the candidate\'s latest message inside square-bracket sections. Use them to judge progress and point out real bugs, but never mention the sections themselves or read them back.',
      '- The editor section is refreshed with every message and is the only source of truth for the code. Read it again each time. If it disagrees with something said earlier, including your own earlier remarks, the editor is right.',
      '- If the code has a bug, ask a question that leads the candidate to it before telling them, unless they asked you to just tell them.',
      '- Once the solution works, move on to follow-up questions from your notes, one at a time.',
      '- Be professional and direct, like a real interviewer. Do not praise every answer.',
      '',
      'The problem, as shown to the candidate:',
      problemPrompt() || '(the candidate has not described the problem yet; ask what they want to practise)',
      '',
      'Your private notes (never reveal them directly):',
      problem.notes,
    ].join('\n');
  }

  // Lines present in one version but not the other, ignoring blank lines and order.
  function changedLines(before, after) {
    const remaining = new Map();
    for (const line of before.split('\n')) remaining.set(line, (remaining.get(line) || 0) + 1);
    const added = [];
    for (const line of after.split('\n')) {
      const n = remaining.get(line) || 0;
      if (n) remaining.set(line, n - 1);
      else if (line.trim()) added.push(line);
    }
    const removed = [...remaining].filter(([line, n]) => n > 0 && line.trim()).map(([line]) => line);
    return { added, removed };
  }

  function editorContext() {
    const code = editor.getValue();
    const what = problem.design ? 'notes' : 'code';
    let text = `\n\n[EDITOR: the candidate's complete current ${what}. This is the newest version and replaces any earlier one.]\n`;
    text += code.trim() ? code.slice(0, MAX_CODE_CHARS_FOR_MODEL) : '(empty)';

    // Earlier versions are not kept in the conversation, so spell out what moved.
    if (codeSeenByModel !== null) {
      text += '\n\n[CHANGES SINCE YOUR LAST REPLY]\n';
      if (codeSeenByModel === code) {
        text += `(none: the ${what} is unchanged)`;
      } else {
        const { added, removed } = changedLines(codeSeenByModel, code);
        text += `The candidate edited the ${what}.`;
        if (added.length) text += '\nLines added or rewritten:\n' + added.slice(0, MAX_DIFF_LINES).map((l) => '+ ' + l).join('\n');
        if (removed.length) text += '\nLines removed or replaced:\n' + removed.slice(0, MAX_DIFF_LINES).map((l) => '- ' + l).join('\n');
      }
    }
    if (problem.design) return text;

    if (!lastRun) {
      text += '\n\n[LAST RUN OUTPUT]\n(the code has not been run yet)';
    } else {
      const stale = lastRun.code !== code;
      const output = lastRun.output.trim() ? lastRun.output.slice(-MAX_OUTPUT_CHARS_FOR_MODEL) : '(no output)';
      text += stale
        ? '\n\n[OUTPUT OF AN OLDER RUN: the code has been edited since, so this may no longer apply]\n'
        : '\n\n[LAST RUN OUTPUT: from the code exactly as shown above]\n';
      text += output + '\n(run ' + lastRun.status + ')';
    }
    return text;
  }

  // Newest messages that fit the budget, merged so roles strictly alternate
  // (some local chat templates reject anything else), starting with a user turn.
  function recentHistory() {
    const merged = [];
    for (const m of history) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += '\n' + m.content;
      else merged.push({ role: m.role, content: m.content });
    }
    let total = 0;
    let start = merged.length;
    while (start > 0 && total + merged[start - 1].content.length <= MAX_HISTORY_CHARS) {
      start -= 1;
      total += merged[start].content.length;
    }
    start = Math.min(start, merged.length - 1);
    if (merged[start].role !== 'user' && start + 1 < merged.length) start += 1;
    return merged.slice(start);
  }

  function buildMessages(foldSystem) {
    const msgs = recentHistory();
    const last = msgs[msgs.length - 1];
    last.content += editorContext();
    if (foldSystem) {
      msgs[0].content = systemPrompt() + '\n\n---\n\n' + msgs[0].content;
      return msgs;
    }
    return [{ role: 'system', content: systemPrompt() }, ...msgs];
  }

  // Resolves to { finish, reasoned }: why the model stopped, and whether it sent any reasoning.
  async function streamChat(messages, { maxTokens, skipReasoning }, signal, onDelta) {
    const payload = { model: $('model').value, messages, stream: true, temperature: 0.6, max_tokens: maxTokens };
    // Reasoning models think before answering, which delays speech and counts against max_tokens.
    if (skipReasoning) payload.reasoning_effort = 'none';
    const result = { finish: null, reasoned: false };
    const res = await fetch('/lm/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const err = new Error(await describeFailure(res));
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return result;
        let choice;
        try {
          choice = JSON.parse(data).choices?.[0];
        } catch {
          continue;
        }
        if (!choice) continue;
        if (choice.finish_reason) result.finish = choice.finish_reason;
        if (choice.delta?.reasoning_content) result.reasoned = true;
        if (choice.delta?.content) onDelta(choice.delta.content);
      }
    }
  }

  function emptyReplyMessage(result) {
    if (result && (result.reasoned || result.finish === 'length')) {
      return 'The model used its whole reply budget on reasoning and never answered. Turn off "Think first" in the header if it is on, then send your message again.';
    }
    return 'The model returned an empty reply. Send your message again.';
  }

  async function describeFailure(res) {
    let detail = '';
    try {
      const body = await res.text();
      const json = JSON.parse(body);
      detail = (json.error && (json.error.message || json.error)) || body;
    } catch {}
    if (res.status === 401) {
      return 'LM Studio rejected the request (401). It is asking for an API key: put your key in lmstudio_key.txt next to server.py and restart the server, or turn off the API key requirement in LM Studio\'s server settings.';
    }
    if (res.status === 502) return 'LM Studio is not reachable. Start its local server (Developer tab) and try again.';
    return `LM Studio returned ${res.status}. ${String(detail).slice(0, 300)}`;
  }

  // Hides reasoning blocks some local models emit. While streaming, also hides a
  // half-arrived tag so it never flashes on screen or gets spoken.
  function visibleText(raw, streaming) {
    let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
    if (streaming) text = text.replace(/<\/?[a-z]{0,5}$/i, '');
    return text.trimStart();
  }

  function stopResponding() {
    if (abortCtl) abortCtl.abort();
    abortCtl = null;
    window.speechSynthesis.cancel();
  }

  // The budget is generous because any reasoning the model does is counted against it;
  // reply length is controlled by the system prompt.
  async function respond(maxTokens = 1200) {
    stopResponding();
    const ctl = new AbortController();
    abortCtl = ctl;
    const bubble = addBubble('assistant pending', '');
    let raw = '';
    let spoken = 0;
    let result = null;
    let failed = false;
    const codeSent = editor.getValue();

    // Fallbacks for a 400 from LM Studio: a model that rejects the reasoning option,
    // then a chat template with no system role (fold it into the first user turn).
    const attempts = [{ skipReasoning: false, fold: false }, { skipReasoning: false, fold: true }];
    if (!$('think').checked) attempts.unshift({ skipReasoning: true, fold: false });

    const onDelta = (delta) => {
      raw += delta;
      const text = visibleText(raw, true);
      renderReply(bubble, text);
      spoken = speakReady(text, spoken, false);
      $('chat').scrollTop = $('chat').scrollHeight;
    };

    try {
      for (let i = 0; !result; i += 1) {
        const { skipReasoning, fold } = attempts[i];
        try {
          result = await streamChat(buildMessages(fold), { maxTokens, skipReasoning }, ctl.signal, onDelta);
        } catch (err) {
          if (err.status !== 400 || raw || i === attempts.length - 1) throw err;
        }
      }
    } catch (err) {
      failed = true;
      if (err.name !== 'AbortError') {
        addBubble('error', err.status ? err.message : 'Could not reach the local server. Is server.py still running?');
      }
    } finally {
      const text = visibleText(raw, false);
      bubble.classList.remove('pending');
      if (text.trim()) {
        renderReply(bubble, text);
        history.push({ role: 'assistant', content: text.trim() });
        codeSeenByModel = codeSent;
        if (!ctl.signal.aborted) speakReady(text, spoken, true);
      } else {
        bubble.remove();
        if (!failed && !ctl.signal.aborted) addBubble('error', emptyReplyMessage(result));
      }
      if (abortCtl === ctl) abortCtl = null;
    }
  }

  // Shown under each of the candidate's messages, so it is clear what the model was given.
  function attachmentNote() {
    const code = editor.getValue();
    const lines = code.trim() ? code.split('\n').length : 0;
    let note = `Sent with your ${problem.design ? 'notes' : 'code'}: ${lines} lines`;
    if (codeSeenByModel !== null) note += codeSeenByModel === code ? ', unchanged' : ', edited since the last reply';
    if (problem.design) return note;
    if (!lastRun) return note + '; no run output yet';
    return note + (lastRun.code === code ? '; output of your last run' : '; output of an older run (run again to update it)');
  }

  function sendUser(text, shown, maxTokens) {
    if (shown) {
      const bubble = addBubble(shown.kind, shown.text);
      if (shown.kind === 'user') {
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = attachmentNote();
        bubble.appendChild(meta);
      }
    }
    history.push({ role: 'user', content: text });
    respond(maxTokens);
  }

  function sendFromInput() {
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = '';
    sendUser(text, { kind: 'user', text });
  }

  function startInterview() {
    stopResponding();
    history = [];
    codeSeenByModel = null;
    $('chat').textContent = '';
    startedAt = Date.now();
    sendUser(
      '[The candidate has just joined the call. Greet them in one sentence, then present the problem in your own words and invite questions.]',
      { kind: 'system', text: 'Interview started: ' + problem.title },
    );
  }

  function askFeedback() {
    startedAt = null;
    sendUser(
      '[The candidate has ended the interview. Give candid spoken feedback in under 150 words: what went well, what was missing or wrong, and whether you would lean hire or no hire for a senior role. Then stop.]',
      { kind: 'system', text: 'Interview ended. Asking for feedback…' },
      2500,
    );
  }

  setInterval(() => {
    if (!startedAt) return;
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  }, 1000);

  // ------------------------------------------------------------------ models

  async function loadModels() {
    const status = $('lmStatus');
    try {
      const res = await fetch('/lm/v1/models');
      if (!res.ok) throw new Error(await describeFailure(res));
      const ids = (await res.json()).data.map((m) => m.id).filter((id) => !/embed/i.test(id));
      const select = $('model');
      select.textContent = '';
      for (const id of ids) select.add(new Option(id, id));
      const wanted = store.get('model', DEFAULT_MODEL);
      if (ids.includes(wanted)) select.value = wanted;
      status.textContent = 'LM Studio connected';
      status.className = 'status ok';
      status.title = '';
    } catch (err) {
      $('model').textContent = '';
      $('model').add(new Option(store.get('model', DEFAULT_MODEL)));
      status.textContent = 'LM Studio not connected (click to retry)';
      status.className = 'status bad';
      status.title = err.message;
    }
  }

  // ------------------------------------------------------------ text to speech

  const utterances = []; // keeps references alive; Chrome can drop queued utterances otherwise

  function loadVoices() {
    const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    if (!voices.length) return;
    const select = $('voice');
    select.textContent = '';
    for (const v of voices) select.add(new Option(v.name, v.name));
    const preferred = store.get('voice')
      || (voices.find((v) => /natural/i.test(v.name)) || voices.find((v) => /google us english/i.test(v.name)) || voices[0]).name;
    if (voices.some((v) => v.name === preferred)) select.value = preferred;
  }

  // The part of a reply that should be read aloud: everything except fenced code.
  // An unfinished block is held back until its closing fence arrives.
  function speakable(text, streaming) {
    let s = text.replace(/```[\s\S]*?```/g, ' ');
    const open = s.indexOf('```');
    if (open >= 0) s = s.slice(0, open);
    if (streaming) s = s.replace(/`{1,2}$/, '');
    return s;
  }

  function speak(text) {
    const clean = text
      .replace(/[`*_#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    const voice = window.speechSynthesis.getVoices().find((v) => v.name === $('voice').value);
    if (voice) u.voice = voice;
    u.rate = Number($('rate').value);
    utterances.push(u);
    u.onend = u.onerror = () => utterances.splice(utterances.indexOf(u), 1);
    window.speechSynthesis.speak(u);
  }

  // Speaks whole sentences as they arrive. Returns how much of the speakable text has been handed to speech.
  function speakReady(fullText, from, flush) {
    const text = speakable(fullText, !flush);
    if (!$('ttsOn').checked) return text.length;
    const rest = text.slice(from);
    if (flush) {
      speak(rest);
      return text.length;
    }
    let cut = 0;
    for (const m of rest.matchAll(/[.!?\n]+\s/g)) cut = m.index + m[0].length;
    if (!cut) return from;
    speak(rest.slice(0, cut));
    return from + cut;
  }

  // ---------------------------------------------------------- speech to text

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;
  let typedPrefix = '';
  let finalText = '';

  function micNote(text) {
    $('micNote').textContent = text;
    $('micNote').hidden = !text;
  }

  function updateMic() {
    $('mic').classList.toggle('recording', listening);
    $('mic').textContent = listening ? '■ Stop & send' : '🎤 Talk';
  }

  function startListening() {
    stopResponding(); // barge-in: talking over the interviewer cuts it off
    micNote('');
    typedPrefix = $('input').value.trim() ? $('input').value.trim() + ' ' : '';
    finalText = '';
    listening = true;
    rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
        else interim += e.results[i][0].transcript;
      }
      $('input').value = typedPrefix + finalText + interim;
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      listening = false;
      const reasons = {
        'not-allowed': 'Microphone access was blocked. Allow it for this page in the browser\'s site settings.',
        'service-not-allowed': 'Speech recognition is not available in this browser. Use Chrome or Edge.',
        network: 'Speech recognition could not reach its service. Check your internet connection, or use Chrome or Edge.',
        'audio-capture': 'No microphone was found.',
      };
      micNote(reasons[e.error] || 'Speech recognition error: ' + e.error);
    };
    rec.onend = () => {
      if (listening) {
        // the browser ends a session after a pause; keep going until the candidate stops it
        try { rec.start(); return; } catch {}
        listening = false;
      }
      updateMic();
      sendFromInput();
    };
    try {
      rec.start();
    } catch {
      listening = false;
    }
    updateMic();
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    rec.stop(); // onend then sends what was heard
  }

  function toggleMic() {
    if (!SR) return;
    if (listening) stopListening();
    else startListening();
  }

  // ------------------------------------------------------------ push to talk

  let pttKey = store.get('pttKey', 'v');
  let pttHeld = false;
  let rebinding = false;

  function keyLabel(key) {
    if (key === ' ') return 'Space';
    return key.length === 1 ? key.toUpperCase() : key;
  }

  function updatePttUI() {
    $('pttKey').textContent = rebinding ? 'Press a key…' : keyLabel(pttKey);
    $('mic').title = `Hold ${keyLabel(pttKey)} to talk, or click to toggle (Ctrl+M)`;
  }

  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('.monaco-editor')) return true;
    return el.tagName === 'INPUT' && !['checkbox', 'range', 'button'].includes(el.type);
  }

  function isPttKey(e) {
    return normalizeKey(e.key) === pttKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  }

  // letters match regardless of Shift or Caps Lock; named keys such as F9 keep their name
  function normalizeKey(key) {
    return key.length === 1 ? key.toLowerCase() : key;
  }

  function onPttDown(e) {
    if (rebinding) {
      e.preventDefault();
      e.stopPropagation();
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key !== 'Escape') {
        pttKey = normalizeKey(e.key);
        store.set('pttKey', pttKey);
      }
      rebinding = false;
      updatePttUI();
      return;
    }
    if (!SR || !isPttKey(e)) return;
    // a key that types a character must stay usable in the editor and the message box
    if (!pttHeld && pttKey.length === 1 && isTyping()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || pttHeld) return;
    pttHeld = true;
    if (!listening) startListening();
  }

  function onPttUp(e) {
    if (!pttHeld || normalizeKey(e.key) !== pttKey) return;
    pttHeld = false;
    stopListening();
  }

  // ------------------------------------------------------------------ wiring

  function init() {
    for (const p of problems) $('problem').add(new Option(p.title, p.id));
    $('problem').value = problem.id;
    $('customPrompt').value = store.get('customPrompt', '');
    $('rate').value = store.get('rate', 1.1);
    $('ttsOn').checked = store.get('ttsOn', true);
    $('think').checked = store.get('think', false);
    $('think').addEventListener('change', () => store.set('think', $('think').checked));

    // the hidden textarea holds the code until Monaco is ready
    loadProblem();
    loadMonaco();
    startWorker();
    loadModels();
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    if (!SR) {
      $('mic').disabled = true;
      micNote('Voice input needs Chrome or Edge. You can still type, and replies are still spoken.');
    }

    $('problem').addEventListener('change', () => {
      store.set('code.' + problem.id, editor.getValue());
      problem = problems.find((p) => p.id === $('problem').value);
      store.set('problem', problem.id);
      stopResponding();
      history = [];
      codeSeenByModel = null;
      startedAt = null;
      $('timer').textContent = '00:00';
      loadProblem();
    });
    $('customPrompt').addEventListener('input', () => store.set('customPrompt', $('customPrompt').value));
    $('model').addEventListener('change', () => store.set('model', $('model').value));
    $('voice').addEventListener('change', () => store.set('voice', $('voice').value));
    $('rate').addEventListener('change', () => store.set('rate', Number($('rate').value)));
    $('ttsOn').addEventListener('change', () => {
      store.set('ttsOn', $('ttsOn').checked);
      if (!$('ttsOn').checked) window.speechSynthesis.cancel();
    });
    $('lmStatus').addEventListener('click', loadModels);

    $('start').addEventListener('click', startInterview);
    $('feedback').addEventListener('click', askFeedback);
    $('run').addEventListener('click', run);
    $('stop').addEventListener('click', () => killRun('Stopped by you'));
    $('reset').addEventListener('click', () => {
      if (window.confirm('Replace your code with the starter code for this problem?')) editor.setValue(problem.starter);
    });
    $('mic').addEventListener('click', toggleMic);
    $('send').addEventListener('click', sendFromInput);
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendFromInput();
      }
    });

    updatePttUI();
    $('pttKey').addEventListener('click', () => {
      rebinding = !rebinding;
      updatePttUI();
      $('pttKey').blur();
    });
    window.addEventListener('keydown', onPttDown, true);
    window.addEventListener('keyup', onPttUp, true);
    window.addEventListener('blur', () => {
      // releasing the key in another window would never reach us
      if (pttHeld) {
        pttHeld = false;
        stopListening();
      }
    });

    // capture phase, so these win over the editor's own bindings
    window.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        run();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        e.stopPropagation();
        toggleMic();
      }
    }, true);
  }

  init();
})();
