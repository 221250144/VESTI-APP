import { describe, expect, it } from "vitest";
import { getStellarColor, getStellarTemperature } from "./stellarColors";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-14T12:00:00Z").getTime();

describe("getStellarTemperature", () => {
  it("is hottest for activity today and coolest beyond the cooling window", () => {
    expect(getStellarTemperature(NOW, NOW)).toBe(0);
    expect(getStellarTemperature(NOW - 44 * DAY_MS, NOW)).toBeLessThan(1);
    expect(getStellarTemperature(NOW - 45 * DAY_MS, NOW)).toBe(1);
    expect(getStellarTemperature(NOW - 365 * DAY_MS, NOW)).toBe(1);
  });

  it("clamps future timestamps (clock skew) to hottest", () => {
    expect(getStellarTemperature(NOW + 3 * DAY_MS, NOW)).toBe(0);
  });

  it("eases sqrt-wise: recent days differentiate more than distant ones", () => {
    const day1 = getStellarTemperature(NOW - 1 * DAY_MS, NOW);
    const day7 = getStellarTemperature(NOW - 7 * DAY_MS, NOW);
    const day30 = getStellarTemperature(NOW - 30 * DAY_MS, NOW);
    expect(day1).toBeLessThan(day7);
    expect(day7).toBeLessThan(day30);
  });

  it("is quantized to a bounded number of steps", () => {
    const values = new Set<number>();
    for (let days = 0; days <= 400; days += 1) {
      values.add(getStellarTemperature(NOW - days * DAY_MS, NOW));
    }
    expect(values.size).toBeLessThanOrEqual(25);
  });
});

describe("getStellarColor", () => {
  it("returns the hottest waypoint for a conversation active today", () => {
    expect(getStellarColor(NOW, NOW, "dark")).toBe("#A9C2EE");
    expect(getStellarColor(NOW, NOW, "light")).toBe("#6E8FC4");
  });

  it("returns the coolest waypoint for long-dormant conversations", () => {
    expect(getStellarColor(NOW - 90 * DAY_MS, NOW, "dark")).toBe("#E9A08E");
  });

  it("interpolates between waypoints and stays deterministic", () => {
    const mid = getStellarColor(NOW - 12 * DAY_MS, NOW, "dark");
    expect(mid).toMatch(/^#[0-9A-F]{6}$/);
    expect(getStellarColor(NOW - 12 * DAY_MS, NOW, "dark")).toBe(mid);
  });

  it("cools monotonically: blue channel fades, red channel holds or rises", () => {
    const blueAt = (days: number) =>
      Number.parseInt(getStellarColor(NOW - days * DAY_MS, NOW, "dark").slice(5, 7), 16);
    expect(blueAt(0)).toBeGreaterThan(blueAt(20));
    expect(blueAt(20)).toBeGreaterThan(blueAt(60));
  });

  it("has distinct light/dark variants", () => {
    expect(getStellarColor(NOW - 10 * DAY_MS, NOW, "dark")).not.toBe(
      getStellarColor(NOW - 10 * DAY_MS, NOW, "light")
    );
  });
});
