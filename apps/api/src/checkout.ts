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
  const refreshing = new Map<Role, Promise<string | undefined>>();

  return async function checkout<T>(role: Role, run: (sql: TSql) => Promise<T>): Promise<T> {
    const current = live.get(role) ?? remember(role, options.passwords[role]);
    try {
      return await run(current.sql);
    } catch (error) {
      if (sqlState(error) !== "28P01") {
        throw error;
      }
      const password = await sharedSecret(role, current.password);
      if (password === undefined) {
        throw error;
      }
      const installed = live.get(role);
      if (installed !== undefined && installed.password === password) {
        return run(installed.sql);
      }
      const replacement: Live<TSql> = { sql: options.open[role](password), password };
      const raced = live.get(role);
      if (raced !== undefined && raced.password === password) {
        await endPool(replacement.sql);
        return run(raced.sql);
      }
      live.set(role, replacement);
      try {
        return await run(replacement.sql);
      } catch (retryError) {
        if (sqlState(retryError) !== "28P01") {
          throw retryError;
        }
        if (live.get(role)?.sql === replacement.sql) {
          live.set(role, current);
        }
        await endPool(replacement.sql);
        throw retryError;
      }
    }
  };

  function sharedSecret(role: Role, used: string): Promise<string | undefined> {
    const existing = refreshing.get(role);
    if (existing !== undefined) {
      return existing;
    }
    const flight = readPassword(role, used).finally(() => {
      refreshing.delete(role);
    });
    refreshing.set(role, flight);
    return flight;
  }

  async function readPassword(role: Role, used: string): Promise<string | undefined> {
    const currentSecret = await options.readSecret(options.arns[role], "AWSCURRENT");
    const previousSecret = await options.readSecret(options.arns[role], "AWSPREVIOUS");
    if (currentSecret !== used) {
      return currentSecret;
    }
    if (previousSecret !== used) {
      return previousSecret;
    }
    return undefined;
  }

  function remember(role: Role, password: string): Live<TSql> {
    const opened = { sql: options.open[role](password), password };
    live.set(role, opened);
    return opened;
  }
}

async function endPool(sql: unknown): Promise<void> {
  if (typeof sql === "object" && sql !== null && "end" in sql && typeof sql.end === "function") {
    await sql.end();
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
