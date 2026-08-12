// Global type declarations
export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DATABASE_URL?: string;
      NEXT_PUBLIC_APP_URL?: string;
      /** DoH JSON endpoint override (default: Cloudflare public DoH). */
      DNS_DOH_ENDPOINT?: string;
    }
  }
}
