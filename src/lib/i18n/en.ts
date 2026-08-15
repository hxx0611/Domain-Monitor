/**
 * English translation dictionary (V0.7.x — Phase 2).
 *
 * Pure data only: no server-only, no cookies, no React, no database or
 * service imports — safe to import from Client Components.
 *
 * The shape of this object IS the dictionary contract: zh-CN must satisfy
 * it structurally (same keys, string values). Machine values (pending,
 * dns_record_added, ok, ...) are never dictionary keys or values here.
 */

export const en = {
  common: {
    appName: "Domain Monitor",
    appDescription: "A lightweight, modern, self-hostable domain lifecycle monitoring platform",
    all: "All",
    notAvailable: "Not available",
    lastUpdated: "Last updated",
  },
  nav: {
    backToDashboard: "← Back to dashboard",
    notifications: "Notifications",
  },
  home: {
    tagline: "Open-source domain lifecycle monitoring.",
  },
  actions: {
    view: "View",
    addDomain: "Add Domain",
    adding: "Adding…",
    cancel: "Cancel",
    delete: "Delete",
    deleting: "Deleting…",
    deleteConfirm: "Delete {hostname}?",
    refreshRdap: "Refresh RDAP",
    refreshing: "Refreshing…",
    checkDns: "Check DNS",
    checkSsl: "Check SSL",
    checkHttp: "Check HTTP",
    checking: "Checking…",
    retry: "Retry",
    retrying: "Retrying…",
  },
  domains: {
    listTitle: "Monitored domains",
    col: {
      domain: "Domain",
      status: "Status",
      expiration: "Expiration",
      created: "Created",
      actions: "Actions",
    },
    empty: {
      title: "No domains yet.",
      hint: "Add your first domain to start monitoring it.",
    },
    expires: "Expires: {date}",
    expirationUnavailable: "Expiration unavailable",
    formHint: "Accepts URLs and bare hostnames (e.g. https://example.com/path → example.com).",
  },
  rdap: {
    sectionTitle: "Domain Information",
    registrar: "Registrar",
    registration: "Registration",
    expiration: "Expiration",
    nameservers: "Nameservers",
    status: "Status",
    unavailable: "RDAP information unavailable.",
  },
  dns: {
    sectionTitle: "DNS Monitoring",
    lastChecked: "Last checked:",
    neverChecked: "Never checked",
    changesTitle: "DNS Changes",
    recordsTitle: "DNS Records",
    historyTitle: "DNS History",
    recordAdded: "{type} record added",
    recordRemoved: "{type} record removed",
    empty: {
      records: "No records found.",
      runCheck: "Run a DNS check to see records.",
    },
  },
  ssl: {
    sectionTitle: "SSL Certificate Monitoring",
    certStatus: "Certificate status",
    issuer: "Issuer",
    subject: "Subject",
    san: "SAN",
    tlsVersion: "TLS version",
    cipher: "Cipher",
    fingerprint: "Fingerprint",
    daysRemaining: "{count} days remaining",
    certReplaced: "Certificate replaced",
    historyTitle: "SSL History",
    unavailable: "SSL monitoring unavailable.",
  },
  http: {
    sectionTitle: "HTTP Health Checks",
    httpStatus: "HTTP {code}",
    responseTime: "{ms} ms",
    redirects: "Redirects",
    none: "None",
    finalUrl: "Final URL",
    statusChanged: "Status changed → {status}",
    historyTitle: "HTTP History",
    unavailable: "HTTP monitoring unavailable.",
  },
  status: {
    active: "Active",
    enabled: "Enabled",
    disabled: "Disabled",
    pending: "Pending",
    sending: "Sending",
    sent: "Sent",
    failed: "Failed",
    valid: "Valid",
    expiresSoon: "Expires soon",
    expired: "Expired",
    mismatch: "Hostname mismatch",
    up: "Up",
    clientError: "Client error",
    serverError: "Server error",
    down: "Down",
    error: "Error",
  },
  source: {
    dns: "DNS",
    ssl: "SSL",
    http: "HTTP",
  },
  events: {
    dnsRecordAdded: "DNS record added",
    dnsRecordRemoved: "DNS record removed",
    sslCertReplaced: "SSL certificate replaced",
    sslStatusChanged: "SSL status changed",
    httpStatusChanged: "HTTP status changed",
  },
  history: {
    firstCheck: "First check",
    noChanges: "No changes",
    recordsChanged: "{count} record(s) changed",
    noChecks: "No checks yet.",
  },
  notifications: {
    tagline: "Delivery channels, rules, and event delivery history.",
    channelsTitle: "Notification Channels",
    channelsEmpty: {
      title: "No channels yet.",
      hint: "Notifications are delivered through email or webhook channels.",
    },
    channelsCol: {
      type: "Type",
      name: "Name",
      config: "Config",
      status: "Status",
    },
    channelEmail: "Email",
    channelWebhook: "Webhook",
    invalidConfig: "Invalid config",
    field: {
      to: "To",
      from: "From",
      endpoint: "Endpoint",
      apiKeyRef: "API key ref",
      url: "URL",
      secretRef: "Secret ref",
    },
    rulesTitle: "Notification Rules",
    rulesEmpty: {
      title: "No rules yet.",
      hint: "Rules decide which events are sent to which channels.",
    },
    rulesCol: {
      source: "Source",
      eventType: "Event type",
      domain: "Domain",
      channel: "Channel",
      status: "Status",
    },
  },
  deliveries: {
    title: "Delivery History",
    empty: {
      title: "No deliveries yet.",
      hint: "Events matched by rules will appear here as they are sent.",
    },
    col: {
      event: "Event",
      channel: "Channel",
      status: "Status",
      attempts: "Attempts",
      time: "Time",
      error: "Error",
      actions: "Actions",
    },
    deliveredAt: "Delivered: {date}",
  },
};

/** Structural type of the English dictionary — the contract for zh-CN. */
export type Dictionary = typeof en;
