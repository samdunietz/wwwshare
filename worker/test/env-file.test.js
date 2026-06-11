import { describe, it, expect } from "vitest";
import { hasEndpoint, withEndpoint, withNewToken } from "../scripts/env-file.mjs";

const CANONICAL =
  "WWWSHARE_ENDPOINT=https://wwwshare.example.com\nWWWSHARE_UPLOAD_TOKEN=oldtoken\n";

describe("hasEndpoint", () => {
  it("accepts the canonical two-line config", () => {
    expect(hasEndpoint(CANONICAL)).toBe(true);
  });

  it("accepts the dotenv `export KEY = value` spacing form", () => {
    expect(
      hasEndpoint("export WWWSHARE_ENDPOINT = https://wwwshare.example.com\n"),
    ).toBe(true);
  });

  it("rejects an empty file", () => {
    expect(hasEndpoint("")).toBe(false);
  });

  it("rejects an endpoint line with an empty value", () => {
    expect(hasEndpoint("WWWSHARE_ENDPOINT=\n")).toBe(false);
  });

  it("rejects an empty endpoint value even with a token line after it", () => {
    expect(
      hasEndpoint("WWWSHARE_ENDPOINT=\nWWWSHARE_UPLOAD_TOKEN=tok\n"),
    ).toBe(false);
  });

  it("rejects a config with only the token line", () => {
    expect(hasEndpoint("WWWSHARE_UPLOAD_TOKEN=oldtoken\n")).toBe(false);
  });
});

describe("withNewToken", () => {
  it("replaces the token line, keeping the endpoint byte-identical", () => {
    expect(withNewToken(CANONICAL, "newtoken")).toBe(
      "WWWSHARE_ENDPOINT=https://wwwshare.example.com\nWWWSHARE_UPLOAD_TOKEN=newtoken\n",
    );
  });

  it("replaces every token line when duplicates exist (dotenv last-wins)", () => {
    const input =
      "WWWSHARE_UPLOAD_TOKEN=old1\nWWWSHARE_ENDPOINT=https://e.example\nWWWSHARE_UPLOAD_TOKEN=old2\n";
    expect(withNewToken(input, "new")).toBe(
      "WWWSHARE_UPLOAD_TOKEN=new\nWWWSHARE_ENDPOINT=https://e.example\nWWWSHARE_UPLOAD_TOKEN=new\n",
    );
  });

  it("replaces the `export KEY = value` form, keeping the export prefix", () => {
    expect(
      withNewToken(
        "WWWSHARE_ENDPOINT=https://e.example\nexport WWWSHARE_UPLOAD_TOKEN = old\n",
        "new",
      ),
    ).toBe(
      "WWWSHARE_ENDPOINT=https://e.example\nexport WWWSHARE_UPLOAD_TOKEN=new\n",
    );
  });

  it("preserves blank lines before the token line", () => {
    expect(
      withNewToken("WWWSHARE_ENDPOINT=https://e.example\n\nWWWSHARE_UPLOAD_TOKEN=old\n", "new"),
    ).toBe("WWWSHARE_ENDPOINT=https://e.example\n\nWWWSHARE_UPLOAD_TOKEN=new\n");
  });

  it("preserves CRLF line endings", () => {
    expect(
      withNewToken("WWWSHARE_ENDPOINT=https://e.example\r\nWWWSHARE_UPLOAD_TOKEN=old\r\n", "new"),
    ).toBe("WWWSHARE_ENDPOINT=https://e.example\r\nWWWSHARE_UPLOAD_TOKEN=new\r\n");
  });

  it("preserves unrelated extra lines and comments", () => {
    const input =
      "# my deploy\nWWWSHARE_ENDPOINT=https://e.example\nOTHER=1\nWWWSHARE_UPLOAD_TOKEN=old\n";
    expect(withNewToken(input, "new")).toBe(
      "# my deploy\nWWWSHARE_ENDPOINT=https://e.example\nOTHER=1\nWWWSHARE_UPLOAD_TOKEN=new\n",
    );
  });

  it("appends when no token line exists (trailing newline present)", () => {
    expect(withNewToken("WWWSHARE_ENDPOINT=https://e.example\n", "new")).toBe(
      "WWWSHARE_ENDPOINT=https://e.example\nWWWSHARE_UPLOAD_TOKEN=new\n",
    );
  });

  it("appends when no token line exists (no trailing newline)", () => {
    expect(withNewToken("WWWSHARE_ENDPOINT=https://e.example", "new")).toBe(
      "WWWSHARE_ENDPOINT=https://e.example\nWWWSHARE_UPLOAD_TOKEN=new\n",
    );
  });
});

describe("withEndpoint", () => {
  it("replaces the endpoint line, keeping the token byte-identical", () => {
    expect(withEndpoint(CANONICAL, "https://new.example")).toBe(
      "WWWSHARE_ENDPOINT=https://new.example\nWWWSHARE_UPLOAD_TOKEN=oldtoken\n",
    );
  });

  it("replaces an endpoint line with an empty value", () => {
    expect(withEndpoint("WWWSHARE_ENDPOINT=\n", "https://new.example")).toBe(
      "WWWSHARE_ENDPOINT=https://new.example\n",
    );
  });

  it("replaces the `export KEY = value` form, keeping the export prefix", () => {
    expect(
      withEndpoint("export WWWSHARE_ENDPOINT = https://old.example\n", "https://new.example"),
    ).toBe("export WWWSHARE_ENDPOINT=https://new.example\n");
  });

  it("appends when no endpoint line exists", () => {
    expect(withEndpoint("WWWSHARE_UPLOAD_TOKEN=tok\n", "https://new.example")).toBe(
      "WWWSHARE_UPLOAD_TOKEN=tok\nWWWSHARE_ENDPOINT=https://new.example\n",
    );
  });

  it("starts a fresh (empty) file without a leading blank line", () => {
    expect(withEndpoint("", "https://new.example")).toBe(
      "WWWSHARE_ENDPOINT=https://new.example\n",
    );
  });
});
