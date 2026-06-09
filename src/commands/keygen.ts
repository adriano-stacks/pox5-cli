import { getAddressFromPrivateKey, privateKeyToPublic, randomPrivateKey } from '@stacks/transactions';
import * as btc from '@scure/btc-signer';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { output, printRows, printSection } from '../output.js';

export type BtcNetworkName = 'regtest' | 'testnet' | 'signet' | 'mainnet';

export const BTC_NETWORK_NAMES: BtcNetworkName[] = ['regtest', 'testnet', 'signet', 'mainnet'];

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

function btcNetwork(name: BtcNetworkName): typeof btc.NETWORK {
  switch (name) {
    case 'mainnet':
      return btc.NETWORK;
    case 'testnet':
    case 'signet':
      return btc.TEST_NETWORK;
    case 'regtest':
      return REGTEST;
    default:
      throw new CliError(`unknown btc network "${name}" (expected ${BTC_NETWORK_NAMES.join(' | ')})`);
  }
}

export interface KeygenOpts {
  btcNetwork: BtcNetworkName;
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
