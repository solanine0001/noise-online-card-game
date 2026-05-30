import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const code = `${fs.readFileSync('server.js', 'utf8')}
globalThis.__noiseTest = { resolveRound, createPlayer, cloneRuleCard, matchResult, dealNoiseHands };`;

const httpStub = {
  createServer() {
    return {
      on() {},
      listen(_port, _host, callback) {
        if (callback) callback();
      },
      close(callback) {
        if (callback) callback();
      }
    };
  }
};

const sandbox = {
  require(name) {
    if (name === 'http') return httpStub;
    return require(name);
  },
  Buffer,
  console: { log() {} },
  process: { env: {}, on() {}, exit() {} },
  setInterval() {
    return { unref() {} };
  },
  clearInterval() {},
  setTimeout,
  clearTimeout,
  __dirname: process.cwd(),
  globalThis: null
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'server.js' });

const { resolveRound, createPlayer, cloneRuleCard, matchResult, dealNoiseHands } = sandbox.__noiseTest;

function makeRoom({ ruleType = 'BIG', points = 1, round = 1, aNumber, bNumber, aNoise = null, bNoise = null, carryRule = null }) {
  const playerA = createPlayer('A', 'test-a', 'A');
  const playerB = createPlayer('B', 'test-b', 'B');
  if (aNoise) playerA.noiseHand = [{ id: `a_${aNoise}`, type: aNoise }];
  if (bNoise) playerB.noiseHand = [{ id: `b_${bNoise}`, type: bNoise }];

  return {
    code: 'TEST',
    status: 'active',
    phase: 'noise',
    round,
    currentRule: cloneRuleCard({ id: `rule_${ruleType}_${points}`, type: ruleType, points }),
    carryRule,
    players: { A: playerA, B: playerB },
    choices: {
      A: {
        number: aNumber,
        noise: aNoise ? { cardId: `a_${aNoise}`, type: aNoise, direction: aNoise === 'Shift' ? 1 : null } : null,
        noiseSubmitted: true
      },
      B: {
        number: bNumber,
        noise: bNoise ? { cardId: `b_${bNoise}`, type: bNoise, direction: bNoise === 'Shift' ? 1 : null } : null,
        noiseSubmitted: true
      }
    },
    ready: { A: false, B: false },
    reveal: null,
    updatedAt: Date.now()
  };
}

function assert(condition, message, detail = undefined) {
  if (!condition) {
    throw new Error(`${message}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

function runCase(name, config, check) {
  const room = makeRoom(config);
  resolveRound(room);
  check(room);
  return {
    name,
    winner: room.reveal.winner,
    pointsAwarded: room.reveal.pointsAwarded,
    raiseBonus: room.reveal.raiseBonus,
    carry: room.carryRule ? `${room.carryRule.label} ${room.carryRule.points}` : null,
    usedA: room.players.A.usedNumbers,
    usedB: room.players.B.usedNumbers
  };
}

const results = [];

const dealtHands = dealNoiseHands();
const dealtTypes = [...dealtHands.A, ...dealtHands.B].map((card) => card.type);
assert(dealtHands.A.length === 3, 'Player A should receive 3 noise cards', dealtHands);
assert(dealtHands.B.length === 3, 'Player B should receive 3 noise cards', dealtHands);
assert(new Set(dealtTypes).size === 6, 'The shared 6-card noise deck should be split without duplicates', dealtHands);
assert(dealtTypes.every((type) => ['Reverse', 'Mute', 'Shift', 'Raise', 'Sync', 'Hold'].includes(type)), 'Dealt deck should only contain current noise cards', dealtTypes);

results.push({
  name: 'Shared noise deck deal',
  playerA: dealtHands.A.map((card) => card.type),
  playerB: dealtHands.B.map((card) => card.type)
});

results.push(runCase('Raise adds points on win', {
  ruleType: 'BIG',
  points: 1,
  aNumber: 7,
  bNumber: 1,
  aNoise: 'Raise'
}, (room) => {
  assert(room.reveal.winner === 'A', 'Raise win case should be won by A', room.reveal);
  assert(room.reveal.pointsAwarded === 3, 'Raise should add 2 points to a 1 point rule', room.reveal);
  assert(room.players.A.score === 3, 'A should receive raised points', room.players.A);
}));

results.push(runCase('Raise is not carried on draw', {
  ruleType: 'EVEN',
  points: 3,
  aNumber: 4,
  bNumber: 4,
  aNoise: 'Raise'
}, (room) => {
  assert(room.reveal.winner === null, 'Draw should remain draw with only Raise', room.reveal);
  assert(room.reveal.raiseBonus === 2, 'Raise bonus should be recorded', room.reveal);
  assert(room.carryRule?.points === 3, 'Only original rule points should carry', room.carryRule);
}));

results.push(runCase('Sync wins a draw', {
  ruleType: 'BIG',
  points: 2,
  aNumber: 4,
  bNumber: 4,
  aNoise: 'Sync'
}, (room) => {
  assert(room.reveal.winner === 'A', 'Single Sync should convert draw to A win', room.reveal);
  assert(room.players.A.score === 2, 'Sync winner should receive rule points', room.players.A);
  assert(room.carryRule === null, 'Sync win should not create carry', room.carryRule);
}));

results.push(runCase('Both Sync keeps draw', {
  ruleType: 'BIG',
  points: 2,
  aNumber: 4,
  bNumber: 4,
  aNoise: 'Sync',
  bNoise: 'Sync'
}, (room) => {
  assert(room.reveal.winner === null, 'Both Sync should remain draw', room.reveal);
  assert(room.carryRule?.points === 2, 'Both Sync draw should carry original rule', room.carryRule);
}));

results.push(runCase('Hold preserves number', {
  ruleType: 'BIG',
  points: 1,
  aNumber: 7,
  bNumber: 1,
  aNoise: 'Hold'
}, (room) => {
  assert(room.reveal.winner === 'A', 'Hold win should still resolve normally', room.reveal);
  assert(!room.players.A.usedNumbers.includes(7), 'Held number should not become used', room.players.A.usedNumbers);
  assert(room.players.B.usedNumbers.includes(1), 'Non-held number should become used', room.players.B.usedNumbers);
}));

results.push(runCase('Mute cancels Hold', {
  ruleType: 'BIG',
  points: 1,
  aNumber: 7,
  bNumber: 1,
  aNoise: 'Hold',
  bNoise: 'Mute'
}, (room) => {
  assert(room.reveal.winner === 'A', 'Mute should not change BIG judgement here', room.reveal);
  assert(room.players.A.usedNumbers.includes(7), 'Mute should cancel Hold and mark number used', room.players.A.usedNumbers);
  assert(room.reveal.raiseBonus === 0, 'Mute case should have no raise bonus', room.reveal);
}));

const tiebreakRoom = {
  players: {
    A: { name: 'A', score: 5, maxStreak: 2 },
    B: { name: 'B', score: 5, maxStreak: 1 }
  },
  reveal: {
    round: 7,
    winner: 'B'
  }
};
const tiebreakResult = matchResult(tiebreakRoom);
assert(tiebreakResult.winner === 'B', 'Final round winner should win tied match', tiebreakResult);

const finalDrawRoom = {
  players: {
    A: { name: 'A', score: 5, maxStreak: 2 },
    B: { name: 'B', score: 5, maxStreak: 1 }
  },
  reveal: {
    round: 7,
    winner: null
  }
};
const finalDrawResult = matchResult(finalDrawRoom);
assert(finalDrawResult.winner === null && finalDrawResult.title === 'DRAW', 'Final round draw should keep tied match as draw', finalDrawResult);

results.push({
  name: 'Final score tiebreaker',
  winner: tiebreakResult.winner,
  finalDraw: finalDrawResult.title
});

console.log(JSON.stringify({ ok: true, results }, null, 2));
