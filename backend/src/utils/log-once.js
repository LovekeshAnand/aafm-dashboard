// E24 (docs/edge-case-audit.md): background loops (simulator, webhook worker, housekeeping)
// fail on every tick while the database is down. Log the first failure and the recovery,
// not the same error every few seconds.
const failing = new Map();

/** Call with an error on failure, with no error on success. */
const logOnce = (task, err) => {
  if (err) {
    if (!failing.has(task)) console.error(`${task} failing: ${err.message}`);
    failing.set(task, (failing.get(task) ?? 0) + 1);
  } else if (failing.has(task)) {
    console.error(`${task} recovered after ${failing.get(task)} failed run(s)`);
    failing.delete(task);
  }
};

export { logOnce };
