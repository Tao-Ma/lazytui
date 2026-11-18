/**
 * A seeded random source for fuzz tests: the same seed gives the same inputs on
 * every run and every machine, so a failure reproduces. An LCG stepped in 32-bit
 * integer math (Math.imul) — a plain `seed * 1103515245` passes 2^53 and loses
 * low bits — with the high bits used (an LCG's low bits cycle quickly).
 *
 *   const rnd = require('./_helpers/rng').seeded(7);
 *   rnd(n)        // an integer in [0, n)
 *   rnd.float()   // a number in [0, 1)
 */
'use strict';

function seeded(seed) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 16; };   // 16 high bits
  const rnd = (n) => next() % n;
  rnd.float = () => next() / 0x10000;
  return rnd;
}

module.exports = { seeded };
