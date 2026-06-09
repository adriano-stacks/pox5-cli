const isTty = process.stdout.isTTY === true;

export function bold(s: string): string {
  return isTty ? `\x1b[1m${s}\x1b[0m` : s;
}

export function dim(s: string): string {
  return isTty ? `\x1b[2m${s}\x1b[0m` : s;
}

export function link(url: string, label: string): string {
  return isTty ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : label;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, bigintReplacer, 2) + '\n');
}

export function output(ctx: { json: boolean }, json: unknown, human: () => void): void {
  if (ctx.json) printJson(json);
  else human();
}

export type Row = [label: string, value: unknown];

export function printRows(rows: Row[]): void {
  const width = rows.reduce((m, [label]) => Math.max(m, label.length), 0);
  for (const [label, value] of rows) {
    process.stdout.write(`${dim((label + ':').padEnd(width + 1))} ${fmt(value)}\n`);
  }
}

export function printSection(title: string): void {
  process.stdout.write(`\n${bold(title)}\n`);
}

export function printNote(message: string): void {
  process.stdout.write(dim(`  ${message}\n`));
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return dim('—');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function group(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatUnits(value: bigint, decimals: number, symbol: string): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const num = `${group(whole.toString())}${frac ? '.' + frac : ''}`;
  return `${neg ? '-' : ''}${num} ${symbol}`;
}

export function stx(ustx: bigint): string {
  return formatUnits(ustx, 6, 'STX');
}

export function sats(value: bigint): string {
  return `${group(value.toString())} sats (${formatUnits(value, 8, 'BTC')})`;
}

export function bps(value: number | bigint): string {
  return `${(Number(value) / 100).toFixed(2)}% (${value} bps)`;
}

export function percent(part: bigint, whole: bigint): string {
  return whole === 0n ? '0%' : `${(Number((part * 10000n) / whole) / 100).toFixed(2)}%`;
}
