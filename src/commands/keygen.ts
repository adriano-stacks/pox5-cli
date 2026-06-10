import { getAddressFromPrivateKey, privateKeyToPublic, randomPrivateKey } from '@stacks/transactions';
import * as btc from '@scure/btc-signer';
import type { Ctx } from '../context.js';
import { btcNetwork, BTC_NETWORK_NAMES, type BtcNetworkName } from '../btc.js';
import { output, printRows, printSection } from '../output.js';

export { BTC_NETWORK_NAMES, type BtcNetworkName };

export interface KeygenOpts {
  btcNetwork: BtcNetworkName;
  env?: boolean;
}

export function keygenCommand(ctx: Ctx, opts: KeygenOpts): void {
  const stxNetwork = ctx.config.network.transactionVersion === 0 ? 'mainnet' : 'testnet';
  const stxPrivateKey = randomPrivateKey();
  const stx = {
    network: stxNetwork,
    privateKey: stxPrivateKey,
    publicKey: privateKeyToPublic(stxPrivateKey),
    address: getAddressFromPrivateKey(stxPrivateKey, stxNetwork),
  };

  const net = btcNetwork(opts.btcNetwork);
  const btcPrivate = btc.utils.randomPrivateKeyBytes();
  const bitcoin = {
    network: opts.btcNetwork,
    wif: btc.WIF(net).encode(btcPrivate),
    privateKeyHex: Buffer.from(btcPrivate).toString('hex'),
    address: btc.getAddress('wpkh', btcPrivate, net)!,
  };

  if (opts.env) {
    process.stdout.write(
      `POX5_STX_PRIVATE_KEY=${stx.privateKey}\n` +
        `POX5_STX_ADDRESS=${stx.address}\n` +
        `POX5_BTC_WIF=${bitcoin.wif}\n` +
        `POX5_BTC_ADDRESS=${bitcoin.address}\n`,
    );
    return;
  }

  output(ctx, { stx, btc: bitcoin }, () => {
    printSection(`STX keys (${stx.network})`);
    printRows([
      ['POX5_STX_PRIVATE_KEY', stx.privateKey],
      ['POX5_STX_ADDRESS', stx.address],
      ['public key', stx.publicKey],
    ]);
    printSection(`BTC keys (${bitcoin.network})`);
    printRows([
      ['POX5_BTC_WIF', bitcoin.wif],
      ['address (p2wpkh)', bitcoin.address],
      ['private key (hex)', bitcoin.privateKeyHex],
    ]);
  });
}
