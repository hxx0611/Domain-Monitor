// Global type declarations
export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DATABASE_URL?: string;
      NEXT_PUBLIC_APP_URL?: string;
    }
  }
}
