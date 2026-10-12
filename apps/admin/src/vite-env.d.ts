interface ImportMetaEnv {
  readonly VITE_API_ORIGIN?: string;
  readonly VITE_AUTH_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
