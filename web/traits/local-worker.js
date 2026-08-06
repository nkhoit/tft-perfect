importScripts(
  'search-utils.js?v=milp-hybrid-v9',
  'board-score.js?v=milp-hybrid-v9',
  'local-search.js?v=milp-hybrid-v9');

let DB = null;

onmessage = event => {
  const message = event.data;
  if (message.type === 'init') {
    DB = message.db;
    postMessage({ type: 'ready' });
    return;
  }
  if (message.type !== 'search') return;
  const started = performance.now();
  let result;
  try {
    result = LocalSearch.search(DB, {
      ...message.opts,
      onProgress: message.opts && message.opts.progress === false ? null : snapshot => {
        postMessage({
          type: 'result',
          id: message.id,
          partial: true,
          ms: Math.round(performance.now() - started),
          rows: snapshot.rows,
          total: snapshot.total,
          nodes: snapshot.nodes,
          truncated: true,
          sampled: true,
          experimental: true,
          stopReason: 'time',
        });
      },
    });
  } catch (error) {
    result = { error: String(error) };
  }
  postMessage({
    type: 'result',
    id: message.id,
    ms: Math.round(performance.now() - started),
    ...result,
  });
};
