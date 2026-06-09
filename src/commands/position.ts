import {
  fetchAccountStatus,
  fetchBondMembership,
  fetchPoxInfo,
  fetchStakerInfo,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { resolveStxAddress } from '../address.js';
import { output, printRows, printSection, stx } from '../output.js';

export async function positionCommand(ctx: Ctx, addressArg?: string): Promise<void> {
  const address = resolveStxAddress(ctx, addressArg);

  const [pox, account, staker, bond] = await Promise.all([
    fetchPoxInfo(ctx.net),
    fetchAccountStatus({ address, ...ctx.net }),
    fetchStakerInfo({ address, ...ctx.net }),
    fetchBondMembership({ address, ...ctx.net }),
  ]);

  const liquid = account.balance - account.locked;

  output(
    ctx,
    {
      address,
      burnHeight: pox.currentBurnchainBlockHeight,
      account: {
        balance: account.balance,
        locked: account.locked,
        liquid,
        unlockHeight: account.unlockHeight,
        nonce: account.nonce,
      },
      stxOnly: staker.staked ? staker.details : null,
      bond: bond ?? null,
    },
    () => {
      printSection(`Position — ${address}`);
      printRows([
        ['balance', stx(account.balance)],
        ['locked', stx(account.locked)],
        ['liquid', stx(liquid)],
        ['unlock height', account.unlockHeight === 0 ? 'not locked' : account.unlockHeight],
        ['nonce', account.nonce],
      ]);

      printSection('STX-only stake');
      if (staker.staked) {
        const d = staker.details;
        printRows([
          ['amount', stx(d.amountUstx)],
          ['first reward cycle', d.firstRewardCycle],
          ['num cycles', d.numCycles],
          ['signer-manager', d.signer],
        ]);
      } else {
        printRows([['status', 'none']]);
      }

      printSection('Paired bond');
      if (bond) {
        printRows([
          ['bond index', bond.bondIndex],
          ['paired STX', stx(bond.amountUstx)],
          ['signer-manager', bond.signer],
          ['lock type', bond.isL1Lock ? 'native BTC (L1 timelock)' : 'sBTC (L2)'],
        ]);
      } else {
        printRows([['status', 'none']]);
      }
    },
  );
}
