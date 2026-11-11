'use strict';

const { spawnSync } = require('child_process');

const PLATFORMS = ['win32', 'darwin', 'mas'];

function signPlan(platform, appOutDir, env) {
  if (!PLATFORMS.includes(platform) || env.QUANTM_SKIP_VMP === '1') return null;
  const python = env.QUANTM_PYTHON || (platform === 'win32' ? 'python' : 'python3');
  return {
    python,
    steps: ['sign-pkg', 'verify-pkg'].map(step => ['-m', 'castlabs_evs.vmp', step, appOutDir])
  };
}

module.exports = async function vmpSign(context, { env = process.env, spawn = spawnSync, log = console.log } = {}) {
  const { electronPlatformName: platform, appOutDir } = context;
  const plan = signPlan(platform, appOutDir, env);
  if (!plan) {
    log(PLATFORMS.includes(platform)
      ? 'WARNING: This build is unsigned; label (copy-protected) songs will not play in it (QUANTM_SKIP_VMP=1).'
      : `No VMP signature is needed for ${platform}.`);
    return;
  }

  // Windows signs in afterSign because electron-builder stamps the exe's resources after afterPack, which would
  // invalidate the signature. macOS signs in afterPack because the VMP signature has to exist before Apple code signing.
  // castlabs switches to a non-playable intermediate signature when EVS_INTERMEDIATE exists at all, even as "0"
  const { EVS_INTERMEDIATE: _skipped, ...childEnv } = env;
  for (const args of plan.steps) {
    try {
      const result = spawn(plan.python, args, { stdio: 'inherit', env: childEnv });
      if (result.error) throw result.error;
      if (result.signal) throw new Error(`Process was killed by signal ${result.signal}`);
      if (result.status !== 0) throw new Error(`Process exited with status ${result.status}`);
    } catch (error) {
      throw new Error(`VMP ${args[2]} failed: ${error.message}. A build without this signature will not play label songs. Install the tool with: pip install --upgrade castlabs-evs; sign in again with: python -m castlabs_evs.account reauth; or set QUANTM_SKIP_VMP=1 to build without the signature on purpose.`, { cause: error });
    }
  }
  log('VMP: the build is signed.');
};

module.exports.signPlan = signPlan;

module.exports.onlyFor = platforms => (context, options) => (
  platforms.includes(context.electronPlatformName) ? module.exports(context, options) : Promise.resolve()
);
