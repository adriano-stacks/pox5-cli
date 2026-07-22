import {
  describePox5Error,
  type EligibilityResult,
} from '@stacks/bitcoin-staking';

export class CliError extends Error {}

export function eligibilityBlockers(result: EligibilityResult): string[] {
  if (result.ok) return [];
  return result.reasons.map((code) => {
    const error = describePox5Error(code);
    return error
      ? `${error.name} (u${error.code}): ${error.description}`
      : `unknown PoX-5 error (u${code})`;
  });
}
