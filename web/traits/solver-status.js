(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SolverStatus = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function classify(status) {
    if (status === 'Optimal') return 'optimal';
    if (status === 'Infeasible') return 'infeasible';
    return 'unresolved';
  }

  function proof(branches, rowCount) {
    const resolved = branches.length > 0
      && branches.every(branch => branch === 'optimal' || branch === 'infeasible');
    return {
      proved: resolved && rowCount > 0,
      infeasible: resolved && rowCount === 0,
    };
  }

  return { classify, proof };
}));
