const url = process.env.NOISE_WS_URL || 'ws://localhost:3000';

function createClient(label) {
  const socket = new WebSocket(url);
  const waiters = [];
  const client = {
    label,
    state: null,
    send(payload) {
      socket.send(JSON.stringify(payload));
    },
    waitFor(predicate, timeoutMs = 4000) {
      if (predicate(client.state)) return Promise.resolve(client.state);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} timed out waiting for state`));
        }, timeoutMs);

        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    close() {
      socket.close();
    }
  };

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${label} server error: ${message.message}`));
      }
      return;
    }

    if (message.type !== 'snapshot') return;
    client.state = message.state;

    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(client.state)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(client.state);
      }
    }
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(client), { once: true });
    socket.addEventListener('error', () => reject(new Error(`${label} could not connect`)), { once: true });
  });
}

const a = await createClient('A');
const b = await createClient('B');

a.send({ type: 'createRoom', sessionId: 'smoke-a', name: 'Smoke A' });
await a.waitFor((state) => state?.status === 'lobby');

b.send({ type: 'joinRoom', sessionId: 'smoke-b', name: 'Smoke B', roomCode: a.state.roomCode });
await Promise.all([
  a.waitFor((state) => state?.phase === 'number'),
  b.waitFor((state) => state?.phase === 'number')
]);

a.send({ type: 'submitNumber', number: 4 });
b.send({ type: 'submitNumber', number: 8 });

await Promise.all([
  a.waitFor((state) => state?.phase === 'noise'),
  b.waitFor((state) => state?.phase === 'noise')
]);

const firstNoise = a.state.you.noiseHand[0];
a.send({
  type: 'submitNoise',
  cardId: firstNoise.id,
  direction: firstNoise.type === 'Shift' ? 1 : null
});
b.send({ type: 'submitNoise', cardId: null });

await Promise.all([
  a.waitFor((state) => state?.phase === 'reveal'),
  b.waitFor((state) => state?.phase === 'reveal')
]);

const summary = {
  roomCode: a.state.roomCode,
  rule: a.state.currentRule.label,
  phase: a.state.phase,
  noiseUsed: firstNoise.type,
  numbers: a.state.reveal.finalNumbers,
  winner: a.state.reveal.winner,
  detail: a.state.reveal.judgement.detail
};

console.log(JSON.stringify(summary, null, 2));
a.close();
b.close();
