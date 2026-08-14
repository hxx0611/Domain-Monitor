import { describe, expect, it } from "vitest";
import { classifyHttpStatus, isResponseStatus } from "./normalize";
import type { HttpStatus } from "./types";

describe("classifyHttpStatus", () => {
  it("classifies 2xx as ok", () => {
    expect(classifyHttpStatus(200)).toBe("ok");
    expect(classifyHttpStatus(201)).toBe("ok");
    expect(classifyHttpStatus(204)).toBe("ok");
    expect(classifyHttpStatus(299)).toBe("ok");
  });

  it("classifies 4xx as client_error", () => {
    expect(classifyHttpStatus(400)).toBe("client_error");
    expect(classifyHttpStatus(401)).toBe("client_error");
    expect(classifyHttpStatus(404)).toBe("client_error");
    expect(classifyHttpStatus(499)).toBe("client_error");
  });

  it("classifies 5xx as server_error", () => {
    expect(classifyHttpStatus(500)).toBe("server_error");
    expect(classifyHttpStatus(502)).toBe("server_error");
    expect(classifyHttpStatus(503)).toBe("server_error");
    expect(classifyHttpStatus(599)).toBe("server_error");
  });

  it("classifies 3xx as error (a redirect as final response is an anomaly)", () => {
    expect(classifyHttpStatus(301)).toBe("error");
    expect(classifyHttpStatus(302)).toBe("error");
    expect(classifyHttpStatus(307)).toBe("error");
    expect(classifyHttpStatus(308)).toBe("error");
  });

  it("classifies 1xx as error", () => {
    expect(classifyHttpStatus(100)).toBe("error");
    expect(classifyHttpStatus(199)).toBe("error");
  });

  it("classifies out-of-range codes as error", () => {
    expect(classifyHttpStatus(600)).toBe("error");
    expect(classifyHttpStatus(999)).toBe("error");
  });

  it("classifies non-integer and invalid input as error", () => {
    expect(classifyHttpStatus(200.5)).toBe("error");
    expect(classifyHttpStatus(NaN)).toBe("error");
    expect(classifyHttpStatus(Number.POSITIVE_INFINITY)).toBe("error");
  });

  it("classifies boundary codes precisely", () => {
    // 299 → ok, 300 → error (redirect), 399 → error, 400 → client_error
    expect(classifyHttpStatus(299)).toBe("ok");
    expect(classifyHttpStatus(300)).toBe("error");
    expect(classifyHttpStatus(399)).toBe("error");
    expect(classifyHttpStatus(400)).toBe("client_error");
    expect(classifyHttpStatus(499)).toBe("client_error");
    expect(classifyHttpStatus(500)).toBe("server_error");
    expect(classifyHttpStatus(599)).toBe("server_error");
    expect(classifyHttpStatus(600)).toBe("error");
  });
});

describe("isResponseStatus", () => {
  it("returns true when a response was received", () => {
    const responded: HttpStatus[] = ["ok", "client_error", "server_error"];
    for (const status of responded) {
      expect(isResponseStatus(status)).toBe(true);
    }
  });

  it("returns false for down and error", () => {
    expect(isResponseStatus("down")).toBe(false);
    expect(isResponseStatus("error")).toBe(false);
  });
});
