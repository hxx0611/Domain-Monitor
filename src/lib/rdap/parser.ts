/**
 * RDAP JSON parser.
 *
 * Converts a raw RDAP domain response into Domain Monitor's normalized
 * `RdapDomainData`. All dates are normalized to ISO 8601.
 */

import { RdapError } from "./client";
import type { RawRdapResponse, RdapDomainData } from "./types";

const EVENT_ACTION_FIELDS: Record<
  string,
  keyof Pick<RdapDomainData, "registrationDate" | "expirationDate" | "updatedDate">
> = {
  registration: "registrationDate",
  expiration: "expirationDate",
  "last changed": "updatedDate",
};

/**
 * Parse a raw RDAP domain response.
 * Throws `RdapError("invalid-response")` when the payload is not a usable
 * domain object; field-level gaps produce `undefined` / empty arrays.
 */
export function parseRdapDomainResponse(raw: unknown): RdapDomainData {
  if (!isRecord(raw)) {
    throw new RdapError("RDAP response is not an object.", "invalid-response");
  }

  const response = raw as RawRdapResponse;

  const domainName =
    typeof response.ldhName === "string" && response.ldhName.length > 0
      ? response.ldhName
      : typeof response.domainName === "string" && response.domainName.length > 0
        ? response.domainName
        : undefined;

  if (!domainName) {
    throw new RdapError("RDAP response has no domain name.", "invalid-response");
  }

  const dates: Partial<
    Pick<RdapDomainData, "registrationDate" | "expirationDate" | "updatedDate">
  > = {};
  for (const event of response.events ?? []) {
    if (!isRecord(event) || typeof event.eventAction !== "string") {
      continue;
    }
    const field = EVENT_ACTION_FIELDS[event.eventAction];
    if (field) {
      const normalized = normalizeDate(event.eventDate);
      if (normalized && !dates[field]) {
        dates[field] = normalized;
      }
    }
  }

  return {
    domainName,
    registrar: extractRegistrar(response),
    registrationDate: dates.registrationDate,
    expirationDate: dates.expirationDate,
    updatedDate: dates.updatedDate,
    status: parseStringArray(response.status),
    nameservers: (response.nameservers ?? [])
      .filter(
        (ns): ns is { ldhName: string } =>
          isRecord(ns) && typeof ns.ldhName === "string" && ns.ldhName.length > 0,
      )
      .map((ns) => ns.ldhName),
  };
}

/**
 * Normalize a date string to ISO 8601 (UTC, with milliseconds).
 * Returns `undefined` for empty or unparseable input.
 */
export function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

/**
 * Extract the registrar name from the entity list (vCard `fn` / `org` of the
 * entity whose roles include "registrar"). Returns `undefined` when absent.
 */
function extractRegistrar(response: RawRdapResponse): string | undefined {
  for (const entity of response.entities ?? []) {
    if (!isRecord(entity)) {
      continue;
    }
    const roles = entity.roles;
    if (!Array.isArray(roles) || !roles.includes("registrar")) {
      continue;
    }
    const name = extractVcardName(entity.vcardArray);
    if (name) {
      return name;
    }
  }
  return undefined;
}

/**
 * Pull the display name out of an RDAP vCard array.
 * vCard shape: `["vcard", [["fn", {}, "text", "Name"], ["org", {}, "text", "Org"], ...]]`
 */
function extractVcardName(vcardArray: unknown): string | undefined {
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) {
    return undefined;
  }

  const properties = vcardArray[1] as unknown[];
  for (const property of properties) {
    if (!Array.isArray(property)) {
      continue;
    }
    const kind = property[0];
    if (kind !== "fn" && kind !== "org") {
      continue;
    }
    const value = property[3];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
