declare global {
  namespace Cloudflare {
    interface Env {
      TEST_APP_KEY_PKCS1: string;
      TEST_APP_KEY_PKCS8: string;
      TEST_APP_PUBLIC_KEY: string;
    }
  }
}
export {};
