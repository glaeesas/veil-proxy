// Ring buffer of recent proxy activity, plus process facts, so the debug menu in
// the browser can explain what happened to a request. Nothing is persisted and no
// response bodies are kept — only status, timing and the target.
const MAX = 100;

const entries = [];
let sequence = 0;

export function note(entry) {
  const item = { seq: ++sequence, at: new Date().toISOString(), ...entry };
  entries.push(item);
  if (entries.length > MAX) entries.shift();
  return item;
}

/** Newest first, which is how the debug table reads. */
export function recent(limit = 30) {
  return entries.slice(-limit).reverse();
}

export function clearLog() {
  entries.length = 0;
}

export function stats() {
  return { recorded: sequence, buffered: entries.length, capacity: MAX };
}
