// Vitest setup file (vitest.config.ts `setupFiles`): every test runs git against no global and no
// system config, so a fixture `git commit` or `git tag` never signs. The user's global config signs
// commits, and its gpg agent fails under the gate's parallel load (ENG-TEST-GIT-NO-SIGN-GUARD). A test
// that needs an identity sets it itself, as on CI (scripts/check-ci.sh runs with no global config).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
