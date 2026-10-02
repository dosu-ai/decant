import { describe, expect, test } from "bun:test";
import { roundedPercents } from "../src/ui/format.ts";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("rounded share percents", () => {
  test("never totals 101 when several parts round up", () => {
    // Independent Math.round gives 35+35+31 = 101 here.
    const percents = roundedPercents([34.5, 34.5, 31]);
    expect(sum(percents)).toBe(100);
    expect(percents).toEqual([35, 34, 31]);
  });

  test("never totals 99 when every part rounds down", () => {
    const percents = roundedPercents([1, 1, 1]);
    expect(sum(percents)).toBe(100);
    expect(percents).toEqual([34, 33, 33]);
  });

  test("keeps exact shares unchanged", () => {
    expect(roundedPercents([50, 25, 25, 0])).toEqual([50, 25, 25, 0]);
  });

  test("returns zeros when there is nothing to share", () => {
    expect(roundedPercents([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
    expect(roundedPercents([])).toEqual([]);
  });

  test("ignores negative and non-finite weights", () => {
    expect(roundedPercents([-5, Number.NaN, 3, 1])).toEqual([0, 0, 75, 25]);
  });

  test("sums to 100 across many random splits", () => {
    let seed = 7;
    const next = () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let run = 0; run < 500; run += 1) {
      const values = Array.from({ length: 4 }, () => next() * 1000);
      expect(sum(roundedPercents(values))).toBe(100);
    }
  });
});
