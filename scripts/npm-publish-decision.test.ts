import { describe, expect, test } from "bun:test";
import { decidePublish, parseRegistryState } from "./npm-publish-decision";

const state = { latest: "0.2.0", versions: ["0.1.0", "0.1.1", "0.2.0"] };

describe("npm publish decision", () => {
  test("publishes only a version newer than npm's latest", () => {
    expect(decidePublish("0.2.1", state)).toEqual({ publish: true, reason: "0.2.1 is newer than npm's latest (0.2.0)" });
    expect(decidePublish("1.0.0", state).publish).toBe(true);
    expect(decidePublish("0.2.0", state)).toEqual({ publish: false, reason: "0.2.0 is already on npm" });
    expect(decidePublish("0.1.5", state)).toEqual({ publish: false, reason: "0.1.5 is not newer than npm's latest (0.2.0)" });
  });

  test("never republishes an existing version, even one newer than latest", () => {
    expect(decidePublish("0.3.0", { latest: "0.2.0", versions: ["0.2.0", "0.3.0"] }).publish).toBe(false);
  });

  test("rejects versions npm cannot publish", () => {
    for (const version of ["1.0", "v1.0.0", "", "1.0.0.0"]) expect(() => decidePublish(version, state)).toThrow("invalid package version");
  });

  test("reads npm view output, including a single version printed as a string", () => {
    expect(parseRegistryState('{"versions":["0.1.0","0.2.0"],"dist-tags":{"latest":"0.2.0"}}')).toEqual({ latest: "0.2.0", versions: ["0.1.0", "0.2.0"] });
    expect(parseRegistryState('{"versions":"0.1.0","dist-tags":{"latest":"0.1.0"}}')).toEqual({ latest: "0.1.0", versions: ["0.1.0"] });
  });

  test("fails for an unpublished package and for unexpected output", () => {
    expect(() => parseRegistryState('{"error":{"code":"E404","summary":"Not Found"}}')).toThrow("publish its first version by hand");
    for (const json of ['{"versions":[]}', '{"versions":[1],"dist-tags":{"latest":"1"}}', '{"error":{"code":"E500"}}']) {
      expect(() => parseRegistryState(json)).toThrow("unexpected npm view output");
    }
  });
});
