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

const client = await createClient('CPU smoke');

client.send({ type: 'createCpuRoom', sessionId: 'cpu-smoke-a', name: 'CPU Smoke' });
await client.waitFor((state) => state?.phase === 'number' && state.opponent?.isCpu);

client.send({ type: 'submitNumber', number: 4 });
await client.waitFor((state) => state?.phase === 'noise');

client.send({ type: 'submitNoise', cardId: null });
await client.waitFor((state) => state?.phase === 'reveal');

client.send({ type: 'readyNext' });
await client.waitFor((state) => state?.round === 2 && state?.phase === 'number');

console.log(JSON.stringify({
  roomCode: client.state.roomCode,
  opponent: client.state.opponent.name,
  isCpu: client.state.opponent.isCpu,
  round: client.state.round,
  phase: client.state.phase,
  score: `${client.state.you.score}-${client.state.opponent.score}`
}, null, 2));

client.close();
