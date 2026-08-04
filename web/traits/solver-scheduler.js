(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SolverScheduler = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function create({ send, onStarted = () => {}, onFinished = () => {} }) {
    let inFlight = null;
    let queued = null;

    function dispatch(message) {
      inFlight = message;
      send(message);
    }

    return {
      enqueue(message) {
        if (inFlight) {
          queued = message;
          return false;
        }
        dispatch(message);
        return true;
      },
      started(id) {
        if (!inFlight || inFlight.id !== id) return false;
        onStarted(id);
        return true;
      },
      finished(id) {
        if (!inFlight || inFlight.id !== id) return false;
        inFlight = null;
        onFinished(id);
        if (queued) {
          const next = queued;
          queued = null;
          dispatch(next);
        }
        return true;
      },
      terminate() {
        inFlight = null;
        queued = null;
      },
      inFlightId() {
        return inFlight?.id ?? null;
      },
      queuedId() {
        return queued?.id ?? null;
      },
    };
  }

  return { create };
}));
