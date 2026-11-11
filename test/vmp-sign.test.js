import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vmpSign = require('../scripts/vmp-sign.js');
const { signPlan } = vmpSign;
const folder = 'C:\\Users\\Some User\\Quantm\\dist\\win-unpacked';
const context = { electronPlatformName: 'win32', appOutDir: folder };
const steps = [
  ['-m', 'castlabs_evs.vmp', 'sign-pkg', folder],
  ['-m', 'castlabs_evs.vmp', 'verify-pkg', folder]
];

function fakeOptions(results = [], env = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    env,
    spawn(python, args, options) {
      calls.push({ python, args, options });
      return results[calls.length - 1] ?? { status: 0, signal: null };
    },
    log(message) { logs.push(message); }
  };
}

async function rejectsVmp(promise, step) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`${step} failed`));
    assert.match(error.message, /will not play label songs/);
    assert.match(error.message, /pip install --upgrade castlabs-evs/);
    assert.match(error.message, /python -m castlabs_evs\.account reauth/);
    assert.match(error.message, /QUANTM_SKIP_VMP=1/);
    return true;
  });
}

for (const platform of ['win32', 'darwin', 'mas']) {
  test(`signPlan prepares signing and verification with the default Python on ${platform}`, () => {
    assert.deepEqual(signPlan(platform, folder, {}), {
      python: platform === 'win32' ? 'python' : 'python3',
      steps
    });
  });

  test(`signPlan respects Python overrides and ignores an empty override on ${platform}`, () => {
    const python = 'C:\\Users\\Some User\\Python\\python.exe';
    assert.deepEqual(signPlan(platform, folder, { QUANTM_PYTHON: python }), { python, steps });
    assert.deepEqual(signPlan(platform, folder, { QUANTM_PYTHON: '' }), signPlan(platform, folder, {}));
  });

  test(`the skip flag disables signing on ${platform} and warns about label songs`, async () => {
    const options = fakeOptions([], { QUANTM_SKIP_VMP: '1' });
    assert.equal(signPlan(platform, folder, options.env), null);
    await vmpSign({ electronPlatformName: platform, appOutDir: folder }, options);
    assert.deepEqual(options.calls, []);
    assert.equal(options.logs.length, 1);
    assert.match(options.logs[0], /WARNING.*unsigned.*label \(copy-protected\) songs will not play/);
  });
}

for (const platform of ['linux', 'unknown']) {
  test(`${platform} needs no signature and never spawns, even with the skip flag`, async () => {
    for (const env of [{}, { QUANTM_SKIP_VMP: '1' }]) {
      const options = fakeOptions([], env);
      assert.equal(signPlan(platform, folder, env), null);
      await vmpSign({ electronPlatformName: platform, appOutDir: folder }, options);
      assert.deepEqual(options.calls, []);
      assert.equal(options.logs.length, 1);
      assert.match(options.logs[0], /No VMP signature is needed/);
    }
  });
}

test('signing precedes verification and paths with spaces stay single arguments', async () => {
  const python = 'C:\\Users\\Some User\\Python\\python.exe';
  const options = fakeOptions([], { QUANTM_PYTHON: python });
  await vmpSign(context, options);
  assert.deepEqual(options.calls, steps.map(args => ({ python, args, options: { stdio: 'inherit', env: { QUANTM_PYTHON: python } } })));
  assert.deepEqual(options.logs, ['VMP: the build is signed.']);
});

test('EVS_INTERMEDIATE never reaches the signer, whatever its value, and other variables pass through', async () => {
  for (const value of ['1', '0', '']) {
    const env = { EVS_INTERMEDIATE: value, QUANTM_PYTHON: 'py', PATH: 'a;b', OTHER: 'x' };
    const options = fakeOptions([], env);
    await vmpSign(context, options);
    assert.equal(options.calls.length, 2);
    for (const call of options.calls) {
      assert.ok(!('EVS_INTERMEDIATE' in call.options.env));
      assert.deepEqual(call.options.env, { QUANTM_PYTHON: 'py', PATH: 'a;b', OTHER: 'x' });
      assert.equal(call.options.stdio, 'inherit');
    }
  }
});

test('the hook does not modify the env it was given', async () => {
  const env = { EVS_INTERMEDIATE: '0', KEEP: '1' };
  const options = fakeOptions([], env);
  await vmpSign(context, options);
  assert.deepEqual(env, { EVS_INTERMEDIATE: '0', KEEP: '1' });
  assert.notEqual(options.calls[0].options.env, env);
});

test('only the exact skip value 1 disables signing', async () => {
  for (const value of ['', '0', 'true']) {
    const options = fakeOptions([], { QUANTM_SKIP_VMP: value });
    assert.ok(signPlan('win32', folder, options.env));
    await vmpSign(context, options);
    assert.equal(options.calls.length, 2);
  }
});

test('a non-zero signing exit rejects and never runs verification', async () => {
  const options = fakeOptions([{ status: 1, signal: null }]);
  await rejectsVmp(vmpSign(context, options), 'sign-pkg');
  assert.equal(options.calls.length, 1);
  assert.deepEqual(options.logs, []);
});

test('a non-zero verification exit rejects', async () => {
  const options = fakeOptions([{ status: 0 }, { status: 2 }]);
  await rejectsVmp(vmpSign(context, options), 'verify-pkg');
  assert.equal(options.calls.length, 2);
  assert.deepEqual(options.logs, []);
});

test('an ENOENT spawn error rejects with installation, reauth and skip hints', async () => {
  const error = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
  const options = fakeOptions([{ error, status: null, signal: null }]);
  await rejectsVmp(vmpSign(context, options), 'sign-pkg');
  assert.equal(options.calls.length, 1);
  assert.deepEqual(options.logs, []);
});

test('a signal kill rejects even if a zero exit status is reported', async () => {
  const options = fakeOptions([{ status: 0, signal: 'SIGTERM' }]);
  await rejectsVmp(vmpSign(context, options), 'sign-pkg');
  assert.equal(options.calls.length, 1);
  assert.deepEqual(options.logs, []);
});

const afterPack = require('../scripts/vmp-after-pack.js');
const afterSign = require('../scripts/vmp-after-sign.js');
const ctxFor = platform => ({ electronPlatformName: platform, appOutDir: folder });

for (const platform of ['darwin', 'mas']) {
  test(`the after-pack hook signs on ${platform}`, async () => {
    const options = fakeOptions();
    await afterPack(ctxFor(platform), options);
    assert.deepEqual(options.calls.map(call => call.args), steps);
  });
  test(`the after-sign hook never spawns on ${platform}`, async () => {
    const options = fakeOptions();
    await afterSign(ctxFor(platform), options);
    assert.equal(options.calls.length, 0);
  });
}

for (const platform of ['win32', 'linux']) {
  test(`the after-pack hook never spawns on ${platform}`, async () => {
    const options = fakeOptions();
    await afterPack(ctxFor(platform), options);
    assert.equal(options.calls.length, 0);
  });
}

test('the after-sign hook signs on win32', async () => {
  const options = fakeOptions();
  await afterSign(ctxFor('win32'), options);
  assert.deepEqual(options.calls.map(call => call.args), steps);
});

test('the after-sign hook never spawns on linux', async () => {
  const options = fakeOptions();
  await afterSign(ctxFor('linux'), options);
  assert.equal(options.calls.length, 0);
});

test('a hook made by onlyFor logs nothing when it skips', async () => {
  for (const platform of ['win32', 'darwin', 'mas', 'linux']) {
    const options = fakeOptions();
    await vmpSign.onlyFor([])(ctxFor(platform), options);
    await afterPack(ctxFor('linux'), options);
    await afterSign(ctxFor('darwin'), options);
    assert.deepEqual(options.logs, []);
    assert.equal(options.calls.length, 0);
  }
});

test('package.json registers existing afterPack and afterSign hook functions', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const root = resolve(import.meta.dirname, '..');
  const { build } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const key of ['afterPack', 'afterSign']) {
    assert.ok(build[key], `${key} is set`);
    const file = resolve(root, build[key]);
    assert.ok(existsSync(file), `${key} file exists`);
    assert.equal(typeof require(file), 'function');
  }
  assert.notEqual(build.afterPack, build.afterSign);
});
