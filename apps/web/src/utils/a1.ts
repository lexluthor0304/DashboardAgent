const A_CODE = "A".charCodeAt(0);

export function colIndexToLetters(colIndex: number) {
  let n = colIndex + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(A_CODE + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function lettersToColIndex(letters: string) {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const v = ch.charCodeAt(0) - A_CODE + 1;
    if (v < 1 || v > 26) throw new Error(`Invalid column letters: ${letters}`);
    n = n * 26 + v;
  }
  return n - 1;
}

export function rowColToA1(rowIndex: number, colIndex: number) {
  return `${colIndexToLetters(colIndex)}${rowIndex + 1}`;
}

export function a1ToRowCol(a1: string) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(a1.trim());
  if (!m) throw new Error(`Invalid A1 ref: ${a1}`);
  const col = lettersToColIndex(m[1]);
  const row = Number(m[2]) - 1;
  if (!Number.isFinite(row) || row < 0) throw new Error(`Invalid A1 row: ${a1}`);
  return { row, col };
}

export function expandA1Range(range: string) {
  const [a, b] = range.split(":");
  if (!a || !b) throw new Error(`Invalid range: ${range}`);
  const start = a1ToRowCol(a);
  const end = a1ToRowCol(b);
  const rows = [];
  const r0 = Math.min(start.row, end.row);
  const r1 = Math.max(start.row, end.row);
  const c0 = Math.min(start.col, end.col);
  const c1 = Math.max(start.col, end.col);
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      rows.push(rowColToA1(r, c));
    }
  }
  return rows;
}

