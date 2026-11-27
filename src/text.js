export function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const UNITS = ['KiB', 'MiB', 'GiB'];

// A number of bytes in a short form: 900 B, 1.5 KiB, 256 KiB, 9.4 MiB. Below 1024 the bytes themselves; else the number
// in the first unit, of KiB, MiB and GiB, in which it rounds to less than 1024 (GiB however large it is), with one
// decimal below 10 (none when it is 0) and none from 10 up.
export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const rounded = (value) => (value < 10 ? Number(value.toFixed(1)) : Math.round(value));
  let value = bytes / 1024;
  let unit = 0;
  while (rounded(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${rounded(value)} ${UNITS[unit]}`;
}
