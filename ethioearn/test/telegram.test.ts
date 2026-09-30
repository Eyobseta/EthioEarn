import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateInitData } from "../src/telegram.js";
const TOKEN = "123456:TEST_TOKEN_VALUE";
function sign(fields: Record<string, string>, token = TOKEN) {
  const dcs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update(dcs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const now = 1_800_000_000_000;
const fields = { auth_date: String(now / 1000 - 10), query_id: "AAH", user: JSON.stringify({ id: 42, first_name: "Abebe" }) };
describe("validateInitData", () => {
  it("accepts correctly signed data", () => expect(validateInitData(sign(fields), TOKEN, 3600, now).user.id).toBe(42));
  it("rejects a wrong bot token", () => expect(() => validateInitData(sign(fields, "9:OTHER_TOKEN_XX"), TOKEN, 3600, now)).toThrow());
  it("rejects tampered fields", () => {
    const p = new URLSearchParams(sign(fields)); p.set("user", JSON.stringify({ id: 99 }));
    expect(() => validateInitData(p.toString(), TOKEN, 3600, now)).toThrow();
  });
  it("rejects missing hash", () => expect(() => validateInitData("auth_date=1", TOKEN, 3600, now)).toThrow());
  it("rejects expired data", () => expect(() => validateInitData(sign({ ...fields, auth_date: String(now / 1000 - 7200) }), TOKEN, 3600, now)).toThrow());
});
