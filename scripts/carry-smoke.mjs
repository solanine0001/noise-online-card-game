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

async function submitRound(a, b, aNumber, bNumber) {
  a.send({ type: 'submitNumber', number: aNumber });
  b.send({ type: 'submitNumber', number: bNumber });
  await Promise.all([
    a.waitFor((state) => state?.phase === 'noise'),
    b.waitFor((state) => state?.phase === 'noise')
  ]);

  a.send({ type: 'submitNoise', cardId: null });
  b.send({ type: 'submitNoise', cardId: null });
  await Promise.all([
    a.waitFor((state) => state?.phase === 'reveal'),
    b.waitFor((state) => state?.phase === 'reveal')
  ]);
}

const a = await createClient('Carry A');
const b = await createClient('Carry B');

a.send({ type: 'createRoom', sessionId: 'carry-a', name: 'Carry A' });
await a.waitFor((state) => state?.status === 'lobby');

b.send({ type: 'joinRoom', sessionId: 'carry-b', name: 'Carry B', roomCode: a.state.roomCode });
await Promise.all([
  a.waitFor((state) => state?.phase === 'number'),
  b.waitFor((state) => state?.phase === 'number')
]);

await submitRound(a, b, 4, 4);

if (a.state.reveal.winner !== null) {
  throw new Error('First round should draw and create carry');
}
if (!a.state.reveal.carryOut || !a.state.carryRule) {
  throw new Error('Carry card was not created after draw');
}

const carryPoints = a.state.reveal.carryOut.points;
a.send({ type: 'readyNext' });
b.send({ type: 'readyNext' });
await Promise.all([
  a.waitFor((state) => state?.round === 2 && state?.phase === 'number'),
  b.waitFor((state) => state?.round === 2 && state?.phase === 'number')
]);

await submitRound(a, b, 1, 6);

if (!a.state.reveal.winner) {
  throw new Error('Second round should have a winner');
}
if (!a.state.reveal.carryIn || a.state.reveal.pointsAwarded !== carryPoints + a.state.reveal.currentRule.points) {
  throw new Error('Carry points were not awarded with current rule points');
}

console.log(JSON.stringify({
  roomCode: a.state.roomCode,
  carryPoints,
  roundTwoRule: `${a.state.reveal.currentRule.label} ${a.state.reveal.currentRule.points}PT`,
  winner: a.state.reveal.winner,
  pointsAwarded: a.state.reveal.pointsAwarded,
  scoreDetail: a.state.reveal.scoreDetail
}, null, 2));

a.close();
b.close();
