import { describe, expect, test } from "bun:test";
import { errorRateDisplay } from "../src/ui/error-rate.ts";

describe("tool error rate display", () => {
  test("shows a dash and stays quiet when nothing has been called", () => {
    expect(errorRateDisplay(0, 0)).toEqual({ label: "—", alert: false });
    // A zero denominator still produces a zero rate upstream; neither should alert.
    expect(errorRateDisplay(0, 12.5)).toEqual({ label: "—", alert: false });
  });

  test("stays quiet at a clean zero", () => {
    expect(errorRateDisplay(1000, 0)).toEqual({ label: "0.0%", alert: false });
  });

  test("does not alert on a rate that rounds away to zero", () => {
    // 1 error in 100,000 calls. The card would read "0.0%", and colouring that
    // red is a false alarm the reader cannot distinguish from a real one.
    expect(errorRateDisplay(100_000, 0.001)).toEqual({ label: "0.0%", alert: false });
    expect(errorRateDisplay(100_000, 0.049)).toEqual({ label: "0.0%", alert: false });
  });

  test("alerts as soon as the displayed value is non-zero", () => {
    expect(errorRateDisplay(100_000, 0.05)).toEqual({ label: "0.1%", alert: true });
    expect(errorRateDisplay(500, 3.24)).toEqual({ label: "3.2%", alert: true });
    expect(errorRateDisplay(7, 100)).toEqual({ label: "100.0%", alert: true });
  });

  test("is quiet exactly while the rate displays as a zero, and never flips back", () => {
    // A real property rather than a restatement of the implementation: sweep the
    // rate and assert the alert turns on once, at the point the rendered value
    // stops being a zero, and stays on. Independent of how the rule is written.
    let sawAlert = false;
    let flips = 0;
    for (let hundredths = 0; hundredths <= 500; hundredths += 1) {
      const rate = hundredths / 100;
      const { label, alert } = errorRateDisplay(1000, rate);
      if (alert !== sawAlert) {
        flips += 1;
        sawAlert = alert;
      }
      // The number shown is the thing a reader judges, so the colour must agree
      // with it: a displayed zero is never red, a displayed non-zero always is.
      expect(alert).toBe(!/^0\.0%$/.test(label));
    }
    expect(flips).toBe(1);
    expect(sawAlert).toBe(true);
    expect(errorRateDisplay(1000, 0.05).label).toBe("0.1%");
  });
});
