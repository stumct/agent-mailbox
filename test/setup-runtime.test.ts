import { describe, expect, it, vi } from "vitest";
import { findDnsConflicts, listDnsRecords } from "../scripts/setup/dns";
import { withSpinner } from "../scripts/setup/progress";

describe("setup progress", () => {
  it("terminates the spinner before propagating a failed setup step", async () => {
    const spinner = {
      error: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    await expect(
      withSpinner({
        failure: "Could not check DNS names",
        run: async () => {
          throw new Error("Authentication error");
        },
        spinner,
        start: "Checking DNS names",
        success: "DNS names are available",
      }),
    ).rejects.toThrow("Authentication error");

    expect(spinner.start).toHaveBeenCalledWith("Checking DNS names");
    expect(spinner.error).toHaveBeenCalledWith("Could not check DNS names");
    expect(spinner.stop).not.toHaveBeenCalled();
  });
});

describe("public DNS inspection", () => {
  it("finds records through unauthenticated Cloudflare DNS over HTTPS", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const type = new URL(String(input)).searchParams.get("type");
      return Response.json({
        Answer:
          type === "MX"
            ? [{ data: "10 mx.example.net.", name: "mail.example.com.", type: 15 }]
            : [],
        Status: 0,
      });
    });

    await expect(
      listDnsRecords("mail.example.com", {
        fetch: fetchMock,
        types: ["MX", "CNAME"],
      }),
    ).resolves.toEqual([{ content: "10 mx.example.net.", name: "mail.example.com", type: "MX" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => new Headers(init?.headers).get("Accept") === "application/dns-json",
      ),
    ).toBe(true);
  });

  it("allows Cloudflare Email Routing records but reports unsafe conflicts", () => {
    expect(
      findDnsConflicts(
        [
          { content: "10 route1.mx.cloudflare.net.", name: "mail.example.com", type: "MX" },
          { content: "20 mx.example.net.", name: "mail.example.com", type: "MX" },
        ],
        "email",
      ),
    ).toEqual([{ content: "20 mx.example.net.", name: "mail.example.com", type: "MX" }]);
  });
});
