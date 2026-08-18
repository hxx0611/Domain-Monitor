/**
 * Domain expiration-source / manual-date / reminder persistence (Phase 11A).
 *
 * Covers the Phase 11A-6 hard rule (automatic RDAP refresh must NEVER
 * overwrite manual expiration dates) plus reminder CRUD and the manual ↔
 * automatic transitions.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../test/helpers";
import {
  createDomain,
  deleteDomain,
  getDomainById,
  getExpirationReminders,
  setExpirationReminders,
  updateDomain,
  updateDomainRdap,
} from "./repository";
import { expirationReminders } from "@/db/schema";

const PARENT_OWNERSHIP = "parent" as const;

/** Exact RDAP data for a domain that really exists (e.g. chatgpt.com). */
function exactRdapData(): {
  domainName: string;
  registrar: string;
  registrationDate: string;
  expirationDate: string;
  updatedDate: string;
  status: string[];
  nameservers: string[];
} {
  return {
    domainName: "CHATGPT.COM",
    registrar: "Gname.com Pte. Ltd.",
    registrationDate: "2022-04-08T00:00:00Z",
    expirationDate: "2026-11-30T04:00:00Z",
    updatedDate: "2025-11-20T04:00:00Z",
    status: ["clientTransferProhibited"],
    nameservers: ["ns1.example.net"],
  };
}

describe("createDomain with manual fields", () => {
  it("persists manual source and operator dates; defaults to rdap otherwise", () => {
    const db = createTestDb();

    const manual = createDomain(
      "opusai.eu.cc",
      {
        expirationSource: "manual",
        registrationDate: "2024-05-01",
        expirationDate: "2031-03-26",
        registrationProvider: "gname",
        registrationProviderUrl: "https://www.gname.vip/",
      },
      db,
    );
    expect(manual).toBeDefined();
    expect(manual!.expirationSource).toBe("manual");
    expect(manual!.registrationDate).toBe("2024-05-01");
    expect(manual!.expirationDate).toBe("2031-03-26");
    expect(manual!.registrationProvider).toBe("gname");

    const auto = createDomain("chatgpt.com", undefined, db);
    expect(auto!.expirationSource).toBe("rdap");
    expect(auto!.registrationDate).toBeNull();
    expect(auto!.expirationDate).toBeNull();
  });

  it("manual creation without dates leaves them null", () => {
    const db = createTestDb();
    const domain = createDomain("example.com", { expirationSource: "manual" }, db);
    expect(domain!.expirationSource).toBe("manual");
    expect(domain!.expirationDate).toBeNull();
  });
});

describe("updateDomainRdap manual protection (Phase 11A-6)", () => {
  it("manual + exact: RDAP metadata refreshes, operator dates survive", () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      {
        expirationSource: "manual",
        registrationDate: "2024-05-01",
        expirationDate: "2031-03-26",
      },
      db,
    )!;

    const updated = updateDomainRdap(domain.id, exactRdapData(), "exact", db);
    expect(updated).toBe(true);

    const after = getDomainById(domain.id, db)!;
    expect(after.expirationSource).toBe("manual");
    // Operator dates are untouched by the exact RDAP object.
    expect(after.expirationDate).toBe("2031-03-26");
    expect(after.registrationDate).toBe("2024-05-01");
    // RDAP metadata still refreshed.
    expect(after.registrar).toBe("Gname.com Pte. Ltd.");
    expect(after.nameservers).toEqual(["ns1.example.net"]);
    expect(after.rdapStatus).toEqual(["clientTransferProhibited"]);
    expect(after.rdapUpdatedAt).not.toBeNull();
  });

  it("manual + parent: parent RDAP data never becomes the child's expiration (the 10C bug)", () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      {
        expirationSource: "manual",
        registrationDate: "2024-05-01",
        expirationDate: "2031-03-26",
      },
      db,
    )!;

    // A parent fallback would report eu.cc's data (expiration 2031-03-26
    // in the 10C incident). The manual protection must keep the operator
    // date and clear the RDAP-derived fields.
    updateDomainRdap(domain.id, exactRdapData(), PARENT_OWNERSHIP, db);

    const after = getDomainById(domain.id, db)!;
    expect(after.expirationDate).toBe("2031-03-26");
    expect(after.registrationDate).toBe("2024-05-01");
    expect(after.registrar).toBeNull();
    expect(after.nameservers).toEqual([]);
    expect(after.rdapStatus).toEqual(["no-object"]);
    expect(after.rdapUpdatedAt).not.toBeNull();
  });

  it("rdap source keeps the exact 10D behavior (dates overwritten, parent clears)", () => {
    const db = createTestDb();
    const domain = createDomain("chatgpt.com", undefined, db)!;

    updateDomainRdap(domain.id, exactRdapData(), "exact", db);
    const exact = getDomainById(domain.id, db)!;
    expect(exact.expirationDate).toBe("2026-11-30T04:00:00Z");
    expect(exact.registrar).toBe("Gname.com Pte. Ltd.");

    updateDomainRdap(domain.id, exactRdapData(), PARENT_OWNERSHIP, db);
    const parent = getDomainById(domain.id, db)!;
    expect(parent.expirationDate).toBeNull();
    expect(parent.registrar).toBeNull();
    expect(parent.rdapStatus).toEqual(["no-object"]);
  });

  it("updateDomainRdap on a missing id returns false", () => {
    expect(updateDomainRdap(999, exactRdapData(), "exact", createTestDb())).toBe(false);
  });
});

describe("updateDomain manual ↔ automatic transitions", () => {
  it("manual → rdap clears the operator dates", () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      {
        expirationSource: "manual",
        expirationDate: "2031-03-26",
      },
      db,
    )!;

    expect(updateDomain(domain.id, { expirationSource: "rdap" }, db)).toBe(true);
    const after = getDomainById(domain.id, db)!;
    expect(after.expirationSource).toBe("rdap");
    expect(after.expirationDate).toBeNull();
    expect(after.registrationDate).toBeNull();
  });

  it("rdap → manual applies the supplied dates", () => {
    const db = createTestDb();
    const domain = createDomain("chatgpt.com", undefined, db)!;

    expect(
      updateDomain(
        domain.id,
        {
          expirationSource: "manual",
          registrationDate: "2024-05-01",
          expirationDate: "2031-03-26",
        },
        db,
      ),
    ).toBe(true);
    const after = getDomainById(domain.id, db)!;
    expect(after.expirationSource).toBe("manual");
    expect(after.expirationDate).toBe("2031-03-26");
  });

  it("updateDomain on a missing id returns false", () => {
    expect(updateDomain(999, { expirationSource: "manual" }, createTestDb())).toBe(false);
  });
});

describe("expiration reminders", () => {
  it("set replaces the previous set and get returns ascending days", () => {
    const db = createTestDb();
    const domain = createDomain("opusai.eu.cc", { expirationSource: "manual" }, db)!;

    expect(setExpirationReminders(domain.id, [30, 7, 1], db)).toBe(3);
    let reminders = getExpirationReminders(domain.id, db);
    expect(reminders.map((r) => r.daysBefore)).toEqual([1, 7, 30]);

    // Replace: [90] only; old 30/7/1 gone.
    expect(setExpirationReminders(domain.id, [90], db)).toBe(1);
    reminders = getExpirationReminders(domain.id, db);
    expect(reminders.map((r) => r.daysBefore)).toEqual([90]);
  });

  it("an empty list clears all reminders", () => {
    const db = createTestDb();
    const domain = createDomain("opusai.eu.cc", { expirationSource: "manual" }, db)!;
    setExpirationReminders(domain.id, [30, 7], db);
    expect(setExpirationReminders(domain.id, [], db)).toBe(0);
    expect(getExpirationReminders(domain.id, db)).toEqual([]);
  });

  it("the unique(domain_id, days_before) index rejects duplicate days", () => {
    const db = createTestDb();
    const domain = createDomain("opusai.eu.cc", { expirationSource: "manual" }, db)!;
    setExpirationReminders(domain.id, [30], db);
    expect(() => setExpirationReminders(domain.id, [30], db)).not.toThrow();
    // Direct duplicate insert is rejected by the unique index.
    expect(() =>
      db.insert(expirationReminders).values({ domainId: domain.id, daysBefore: 30 }).run(),
    ).toThrow();
  });

  it("deleting a domain cascades its reminders", () => {
    const db = createTestDb();
    const domain = createDomain("opusai.eu.cc", { expirationSource: "manual" }, db)!;
    setExpirationReminders(domain.id, [30, 7, 1], db);

    expect(deleteDomain(domain.id, db)).toBe(true);
    expect(getExpirationReminders(domain.id, db)).toEqual([]);
    const count = db
      .select({ id: expirationReminders.id })
      .from(expirationReminders)
      .where(eq(expirationReminders.domainId, domain.id))
      .all();
    expect(count).toEqual([]);
  });
});
