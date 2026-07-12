/** Serialize Dream HTTP/session work per user:profile so LetterBot and Inbox sync do not overlap. */

/** @type {Map<string, Promise<void>>} */
const tails = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withDreamGate(key, fn) {
  const gateKey = String(key || "default");
  const prev = tails.get(gateKey) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  tails.set(
    gateKey,
    prev.then(() => next).catch(() => next),
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(gateKey) === next) tails.delete(gateKey);
  }
}
