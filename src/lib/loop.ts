// BouzéCode loop detection, adapted: it hashed whole tool batches; plugin hooks
// see one call at a time, so we keep a ring buffer of call hashes and detect
// repeating cycles of size 1..maxCycleSize over the recent window.

export interface LoopVerdict {
  looping: boolean;
  cycleSize: number;
  repeats: number;
}

/**
 * Detect whether appending `next` to `history` completes >= `repeatsToBlock`
 * consecutive repetitions of a cycle ending at the newest element.
 */
export function detectLoop(
  history: string[],
  next: string,
  maxCycleSize: number,
  repeatsToBlock: number
): LoopVerdict {
  const seq = [...history, next];
  for (let k = 1; k <= maxCycleSize; k++) {
    if (seq.length < k * repeatsToBlock) continue;
    const tail = seq.slice(-k * repeatsToBlock);
    const cycle = tail.slice(0, k).join("|");
    let ok = true;
    for (let r = 1; r < repeatsToBlock; r++) {
      if (tail.slice(r * k, (r + 1) * k).join("|") !== cycle) { ok = false; break; }
    }
    if (ok) {
      // a cycle of identical elements collapses to size 1; report the smallest k
      return { looping: true, cycleSize: k, repeats: repeatsToBlock };
    }
  }
  return { looping: false, cycleSize: 0, repeats: 0 };
}

export function pushCall(history: string[], hash: string, windowSize: number): string[] {
  const next = [...history, hash];
  return next.length > windowSize ? next.slice(next.length - windowSize) : next;
}

export const LOOP_WARNING = (cycleSize: number, repeats: number) =>
  `[yeschef] LoopWarning: this exact tool call completes a cycle of ${cycleSize} call(s) repeated ${repeats}x with no new information. ` +
  `Stop and change approach: re-read the last error fully, state what you expected vs. what happened in your mise notes, ` +
  `then try a DIFFERENT tool or different inputs. Do not reissue the same call.`;
