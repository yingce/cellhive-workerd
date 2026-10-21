// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';

// These must match the limits hard-coded in worker-loader.c++.
const MAX_CODE_SIZE = 64 * 1024 * 1024; // 64 MiB
const MAX_ENV_SIZE = 1 * 1024 * 1024; // 1 MiB

const MAIN_MODULE = `
  import {WorkerEntrypoint} from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    ping() { return "pong"; }
    async delayedPing() {
      await new Promise(resolve => setTimeout(resolve, 150));
      return "pong-after-delay";
    }
    busy() { while (true) {} }
    envBigLength() { return this.env.big ? this.env.big.length : 0; }
  }
`;

const SUBREQUEST_MODULE = `
  import {WorkerEntrypoint} from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async fetchThrice() {
      await fetch("https://example.com/one");
      await fetch("https://example.com/two");
      await fetch("https://example.com/three");
      return "done";
    }
  }
`;

// Used as the dynamic worker's global outbound so that each fetch is a real subrequest.
export let outbound = {
  async fetch(req) {
    return new Response('ok');
  },
};

const CPU_YIELD_MODULE = `
  import {WorkerEntrypoint} from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async burnWithYields() {
      for (let i = 0; i < 100; i++) {
        const end = Date.now() + 5;
        while (Date.now() < end) {}
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return "finished";
    }
  }
`;

const DEADLINE_MODULE = `
  import {WorkerEntrypoint} from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async waitForever() {
      await new Promise((resolve) => setTimeout(resolve, 60000));
      return "finished";
    }
  }
`;

const MEMORY_MODULE = `
  import {WorkerEntrypoint} from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    allocate() {
      const chunks = [];
      while (true) {
        chunks.push(new Array(1_000_000).fill(1.5));
      }
    }
  }
`;

function makeCode(overrides) {
  return {
    compatibilityDate: '2025-01-01',
    mainModule: 'main.js',
    modules: { 'main.js': MAIN_MODULE },
    globalOutbound: null,
    ...overrides,
  };
}

// A worker whose total module size is comfortably under the limit loads and runs fine.
export let codeSizeWithinLimit = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('codeSizeWithinLimit', () =>
      makeCode({
        modules: {
          'main.js': MAIN_MODULE,
          // ~1 MiB of additional (uncompiled) module content, well under the limit.
          'pad.js': '// ' + 'x'.repeat(1 * 1024 * 1024),
        },
      })
    );

    assert.strictEqual(await worker.getEntrypoint().ping(), 'pong');
  },
};

// A worker whose total module size exceeds the limit fails to load with a clear error.
export let codeSizeExceedsLimit = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('codeSizeExceedsLimit', () =>
      makeCode({
        modules: {
          'main.js': MAIN_MODULE,
          // Push the total just over the limit. This module is never compiled because the size
          // check throws first.
          'big.js': '// ' + 'x'.repeat(MAX_CODE_SIZE),
        },
      })
    );

    await assert.rejects(worker.getEntrypoint().ping(), (e) => {
      assert.strictEqual(e.name, 'Error');
      assert.match(
        e.message,
        /^Dynamic Worker code size \(\d+ bytes\) exceeds the maximum allowed size of 67108864 bytes\.$/
      );
      return true;
    });
  },
};

// An env value under the limit is passed through to the dynamic worker.
export let envSizeWithinLimit = {
  async test(ctrl, env, ctx) {
    const big = 'x'.repeat(512 * 1024); // 512 KiB, under the 1 MiB limit.
    let worker = env.loader.get('envSizeWithinLimit', () =>
      makeCode({ env: { big } })
    );

    assert.strictEqual(await worker.getEntrypoint().envBigLength(), big.length);
  },
};

// An env value over the limit fails to load with a clear error.
export let envSizeExceedsLimit = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('envSizeExceedsLimit', () =>
      makeCode({ env: { big: 'x'.repeat(2 * MAX_ENV_SIZE) } })
    );

    await assert.rejects(worker.getEntrypoint().ping(), (e) => {
      assert.strictEqual(e.name, 'Error');
      assert.match(
        e.message,
        /^Dynamic Worker env size \(\d+ bytes\) exceeds the maximum allowed size of 1048576 bytes\.$/
      );
      return true;
    });
  },
};

// A configured CPU budget interrupts a synchronous loop in the loaded isolate.
export let cpuLimitInterruptsLoop = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('cpuLimitInterruptsLoop', () =>
      makeCode({ limits: { cpuMs: 10, memoryBytes: 128 * 1024 * 1024 } })
    );

    await assert.rejects(worker.getEntrypoint().busy(), (e) => {
      assert.strictEqual(e.name, 'Error');
      assert.match(e.message, /CPU time limit exceeded/i);
      return true;
    });
  },
};

// A terminated busy invocation must not leave JavaScript running in the
// background or keep the isolate/event loop occupied. A second dynamic Worker
// must remain callable immediately after the rejection.
export let cpuLimitDoesNotLeaveBackgroundLoop = {
  async test(ctrl, env, ctx) {
    let busy = env.loader.get('cpuLimitDoesNotLeaveBackgroundLoop-busy', () =>
      makeCode({ limits: { cpuMs: 10 } })
    );
    await assert.rejects(busy.getEntrypoint().busy(), /CPU time limit exceeded/i);

    let healthy = env.loader.get('cpuLimitDoesNotLeaveBackgroundLoop-healthy', () =>
      makeCode()
    );
    assert.strictEqual(await healthy.getEntrypoint().ping(), 'pong');
  },
};

// Waiting longer than the CPU budget must not consume the budget while JavaScript
// is suspended awaiting the timer.
export let cpuLimitExcludesAsyncWait = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('cpuLimitExcludesAsyncWait', () =>
      makeCode({ limits: { cpuMs: 100 } })
    );
    assert.strictEqual(await worker.getEntrypoint().delayedPing(), 'pong-after-delay');
  },
};

// A fast invocation must not be delayed by the CPU budget. The budget bounds how long the
// isolate may run; finishing early must return early rather than waiting out the budget.
export let cpuLimitDoesNotDelayFastPath = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('cpuLimitDoesNotDelayFastPath', () =>
      makeCode({ limits: { cpuMs: 5000 } })
    );

    let start = Date.now();
    assert.strictEqual(await worker.getEntrypoint().ping(), 'pong');
    let elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `fast invocation took ${elapsed}ms with cpuMs=5000`);
  },
};

// The subrequest limit applies to the whole invocation, not to one JavaScript execution segment:
// sequential fetches separated by awaits must still exhaust the same budget.
export let subrequestLimitCountsAcrossAwaits = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('subrequestLimitCountsAcrossAwaits', () =>
      makeCode({
        limits: { subRequests: 2 },
        modules: { 'main.js': SUBREQUEST_MODULE },
        globalOutbound: ctx.exports.outbound,
      })
    );

    await assert.rejects(worker.getEntrypoint().fetchThrice(), (e) => {
      assert.strictEqual(e.name, 'Error');
      assert.match(e.message, /Subrequest limit exceeded/i);
      return true;
    });
  },
};

// The CPU budget is per invocation, not per JavaScript execution segment: yielding between short
// busy segments must not reset the budget.
export let cpuLimitAccumulatesAcrossSegments = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('cpuLimitAccumulatesAcrossSegments', () =>
      makeCode({
        limits: { cpuMs: 30 },
        modules: { 'main.js': CPU_YIELD_MODULE },
      })
    );

    await assert.rejects(worker.getEntrypoint().burnWithYields(), (e) => {
      assert.strictEqual(e.name, 'Error');
      assert.match(e.message, /CPU time limit exceeded/i);
      return true;
    });
  },
};

// A configured deadline aborts an invocation that is stuck awaiting I/O. CPU limits do not cover
// async waiting, so the deadline is the backstop for a hung worker.
export let deadlineAbortsPendingInvocation = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('deadlineAbortsPendingInvocation', () =>
      makeCode({
        limits: { deadlineMs: 100 },
        modules: { 'main.js': DEADLINE_MODULE },
      })
    );

    let start = Date.now();
    await assert.rejects(worker.getEntrypoint().waitForever(), (e) => {
      assert.match(String(e && e.message), /deadline/i);
      return true;
    });
    let elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `deadline took ${elapsed}ms to fire`);
  },
};

// A dynamic Worker that exhausts its heap limit fails cleanly, and the runtime keeps serving
// other workers afterwards.
export let memoryLimitStopsAllocation = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('memoryLimitStopsAllocation', () =>
      makeCode({
        limits: { memoryBytes: 32 * 1024 * 1024 },
        modules: { 'main.js': MEMORY_MODULE },
      })
    );

    await assert.rejects(worker.getEntrypoint().allocate(), (e) => {
      assert.match(String(e && e.message), /memory limit exceeded/i);
      return true;
    });

    let healthy = env.loader.get('memoryLimitStopsAllocation-healthy', () => makeCode());
    assert.strictEqual(await healthy.getEntrypoint().ping(), 'pong');
  },
};

// A reusable RPC stub keeps one JSRPC session for multiple method calls, instead of opening a
// new session per call as a Fetcher does.
export let rpcStubReusesSession = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('rpcStubReusesSession', () =>
      makeCode({
        modules: {
          'main.js': `
            import {WorkerEntrypoint} from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              ping() { return "pong"; }
              add(a, b) { return a + b; }
            }
          `,
        },
      })
    );

    const rpc = worker.getEntrypointRpcStub();
    assert.strictEqual(await rpc.ping(), 'pong');
    assert.strictEqual(await rpc.add(2, 3), 5);
    assert.strictEqual(await rpc.ping(), 'pong');
  },
};

// V8's heap limit does not cover ArrayBuffer backing stores, so memoryBytes must also bound
// external memory. Without the per-isolate ArrayBuffer quota this request would succeed.
export let externalMemoryLimitStopsAllocation = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('externalMemoryLimitStopsAllocation', () =>
      makeCode({
        limits: { memoryBytes: 32 * 1024 * 1024 },
        modules: {
          'main.js': `
            import {WorkerEntrypoint} from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              allocate() {
                const chunks = [];
                for (let i = 0; i < 8; i++) {
                  chunks.push(new Uint8Array(16 * 1024 * 1024).fill(1));
                }
                return chunks.length;
              }
            }
          `,
        },
      })
    );

    await assert.rejects(worker.getEntrypoint().allocate(), (e) => {
      assert.match(String(e && e.message), /memory limit exceeded/i);
      return true;
    });
  },
};

// A condemned isolate must be dropped from the loader's cache so a later load starts fresh rather
// than repeatedly failing against the exhausted isolate.
export let memoryLimitEvictsCondemnedIsolate = {
  async test(ctrl, env, ctx) {
    let loads = 0;
    const name = 'memoryLimitEvictsCondemnedIsolate';

    let worker = env.loader.get(name, () => {
      loads++;
      return makeCode({
        limits: { memoryBytes: 32 * 1024 * 1024 },
        modules: { 'main.js': MEMORY_MODULE },
      });
    });
    await assert.rejects(worker.getEntrypoint().allocate(), (e) => {
      assert.match(String(e && e.message), /memory limit exceeded/i);
      return true;
    });

    let healthy = env.loader.get(name, () => {
      loads++;
      return makeCode();
    });
    assert.strictEqual(await healthy.getEntrypoint().ping(), 'pong');
    assert.strictEqual(loads, 2);
  },
};

// External memory is reclaimed between requests so a worker that once used most of its budget does
// not fail later allocations solely because V8 has not run a GC yet.
export let externalMemoryReclaimedBetweenRequests = {
  async test(ctrl, env, ctx) {
    let worker = env.loader.get('externalMemoryReclaimedBetweenRequests', () =>
      makeCode({
        limits: { memoryBytes: 16 * 1024 * 1024 },
        modules: {
          'main.js': `
            export default {
              async fetch() {
                const chunks = [];
                for (let i = 0; i < 1; i++) {
                  chunks.push(new Uint8Array(12 * 1024 * 1024).fill(1));
                }
                return new Response('ok:' + chunks.length);
              }
            };
          `,
        },
      })
    );

    let first = await worker.getEntrypoint().fetch(new Request('https://example.com/'));
    assert.strictEqual(await first.text(), 'ok:1');

    let second = await worker.getEntrypoint().fetch(new Request('https://example.com/'));
    assert.strictEqual(await second.text(), 'ok:1');
  },
};
