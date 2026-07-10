/**
 * Test-only mock that fails loudly if any `fetch` call is made.
 *
 * Used by RP-04 CLI integer-validation tests to prove that invalid integer
 * options are rejected at option-parse time (before the command action runs),
 * so no HN/provider request is ever issued. If validation wrongly allowed the
 * action to run, the action would call `fetch` and this mock would throw,
 * surfacing a distinct error in stderr.
 */
globalThis.fetch = async (): Promise<Response> => {
  throw new Error("mock-fetch-throw: fetch should not be called during integer validation");
};
