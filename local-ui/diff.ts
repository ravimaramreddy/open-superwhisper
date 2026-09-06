export interface DiffPart {
  kind: "same" | "remove" | "add";
  text: string;
}

/** Keep text intact, including whitespace; cap the comparison matrix at 1 MB. */
export function diffWords(before: string, after: string): { parts: DiffPart[]; coarse: boolean } {
  const parts: DiffPart[] = [];
  const add = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  if (before === after) {
    add("same", before);
    return { parts, coarse: false };
  }
  if (before.length > 100_000 || after.length > 100_000) {
    add("remove", before);
    add("add", after);
    return { parts, coarse: true };
  }
  const tokenize = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const left = tokenize(before);
  const right = tokenize(after);
  let start = 0;
  let end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  )
    end++;
  add("same", left.slice(0, start).join(""));
  const a = left.slice(start, left.length - end);
  const b = right.slice(start, right.length - end);
  const coarse = (a.length + 1) * (b.length + 1) > 250_000;
  if (coarse) {
    add("remove", a.join(""));
    add("add", b.join(""));
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? 1 + table[(i + 1) * width + j + 1]
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        add("same", a[i++]);
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        add("remove", a[i++]);
      } else add("add", b[j++]);
    }
    add("remove", a.slice(i).join(""));
    add("add", b.slice(j).join(""));
  }
  add("same", left.slice(left.length - end).join(""));
  return { parts, coarse };
}
