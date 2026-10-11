export type Role = "app" | "identity" | "platform";

export type SecretReader = (arn: string, stage: "AWSCURRENT" | "AWSPREVIOUS") => Promise<string>;

export type Checkout<TSql> = <T>(role: Role, run: (sql: TSql) => Promise<T>) => Promise<T>;

type Live<TSql> = {
  sql: TSql;
  password: string;
};

export function createCheckout<TSql>(options: {
  passwords: Record<Role, string>;
  arns: Record<Role, string>;
  open: Record<Role, (password: string) => TSql>;
  readSecret: SecretReader;
  log: (message: string, fields: Record<string, unknown>) => void;
}): Checkout<TSql> {
  const live = new Map<Role, Live<TSql>>();

  return async function checkout<T>(role: Role, run: (sql: TSql) => Promise<T>): Promise<T> {
    const current = live.get(role) ?? remember(role, options.passwords[role]);
    try {
      return await run(current.sql);
    } catch (error) {
      if (sqlState(error) !== "28P01") {
        throw error;
      }
      const currentSecret = await options.readSecret(options.arns[role], "AWSCURRENT");
      const previousSecret = await options.readSecret(options.arns[role], "AWSPREVIOUS");
      const password =
        currentSecret !== current.password
          ? currentSecret
          : previousSecret !== current.password
            ? previousSecret
            : undefined;
      if (password === undefined) {
        throw error;
      }
      const replacement = { sql: options.open[role](password), password };
      const result = await run(replacement.sql);
      live.set(role, replacement);
      return result;
    }
  };

  function remember(role: Role, password: string): Live<TSql> {
    const opened = { sql: options.open[role](password), password };
    live.set(role, opened);
    return opened;
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
